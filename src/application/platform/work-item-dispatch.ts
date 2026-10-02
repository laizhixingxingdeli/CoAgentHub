import type { Mission, Project } from '../../kernel/index.ts';
import { PlatformContext, PlatformRuleError } from './context.ts';
import { runDecisionShadow } from '../decision-shadow-runner.ts';

export async function dispatchWorkItems(
  ctx: PlatformContext,
  requireNoOpenDiagnosticEscalation: (mission: Mission) => Promise<void>,
  acquireMutationSlotForDispatch: (mission: Mission, project: Project) => Promise<void>,
    missionId: string,
    attemptId: string,
    workItemIds: readonly string[],
  ): Promise<{ dispatched: readonly string[] }> {
    const { mission, project } = await ctx.requireAttempt(missionId, attemptId, 'coordinator');
    if (workItemIds.length === 0) {
      throw new PlatformRuleError('EMPTY_DISPATCH', '没有指定任何工作项。');
    }
    // 必须挡在任何状态改动之前：半套流转会把「已经停了」变成「停了一半」。
    await requireNoOpenDiagnosticEscalation(mission);
    const items = workItemIds.map((id) => {
      const item = mission.workItem(id);
      if (!item) throw new PlatformRuleError('UNKNOWN_WORK_ITEM', `工作项 ${id} 不存在`);
      return item;
    });
    // 先全部校验再统一改状态：被拒绝的调用不留下半套流转。
    for (const item of items) {
      const dispatchable = ['created', 'rejected', 'blocked', 'accepted'];
      if (!dispatchable.includes(item.status)) {
        throw new PlatformRuleError(
          'NOT_DISPATCHABLE',
          `工作项 ${item.id} 当前是 ${item.status}，不能派发`,
        );
      }
    }
    // 门禁（W-292）：执行者曾报 blocked 或交 partial/blocked 结果的工作项，
    // 未修订不得原样重派。查「最近一次」相关事件（不是只看当前状态），
    // 与当前 orderRevision 比较；修订后不相等即可派发，旧快照没记则兼容放行。
    // 必须在 #acquireMutationSlotForDispatch / PRE_DISPATCH shadow / 状态修改之前判定，
    // 否则被拒的调用会留下半套流转。
    const history = await ctx.activity.list(mission.id);
    for (const item of items) {
      const lastRelevant = [...history].reverse().find((event) => {
        if (event.workItemId !== item.id) return false;
        if (event.kind === 'blocked.reported') return true;
        if (event.kind === 'execution_result.submitted') {
          const outcome = (event.data as { outcome?: string } | undefined)?.outcome;
          return outcome === 'blocked' || outcome === 'partial';
        }
        return false;
      });
      if (!lastRelevant) continue;
      const recorded = (lastRelevant.data as { orderRevision?: string } | undefined)?.orderRevision;
      if (recorded === undefined) continue; // 老快照未记，兼容放行
      const current = item.order?.orderRevision ?? 'r1';
      if (recorded === current) {
        throw new PlatformRuleError(
          'WORK_ORDER_REVISION_REQUIRED',
          `工作项 ${item.id} 最近一次被报 blocked 或提交 partial/blocked 结果时工单仍是 ${recorded}，` +
            '未修订的同一张工单不能原样重派。请先做其一：' +
            '(1) 用 coagent_revise_work_order 修订工单（修订号递增）后重派；' +
            '(2) 若这张工单已无意义，用 retire/作废取代重派；' +
            '(3) 若重派不成立，升级给 L3 重新判断。',
        );
      }
    }
    // 契约核对门禁（W-334）：Standard 的第一次派发前必须先落一条核对结论。
    // 会话被压缩或换人接手后，「核过没有、核出什么」只能从事件里恢复，所以查的是
    // 事件而不是某个内存标志。只认**当前契约修订**的结论：改过契约之后，旧修订的
    // ok 或旧升级的答复都给不了新修订的解闸——那正是「拿旧结论派新契约」的漏洞。
    // 与 W-292 一样必须在抢名额 / PRE_DISPATCH shadow / 状态修改之前，否则被拒的
    // 调用会留下半套流转。轻量路径不经过协调者派发，不受此门禁影响。
    if (mission.executionMode === 'standard') {
      const check = [...history].reverse().find((event) => {
        if (event.kind !== 'contract_check.submitted') return false;
        const data = event.data as { contractRevision?: number } | undefined;
        return data?.contractRevision === mission.contractRevision;
      });
      if (!check) {
        throw new PlatformRuleError(
          'CONTRACT_CHECK_REQUIRED',
          `Mission ${mission.id} 当前契约修订是 r${mission.contractRevision}，派发前必须先提交契约核对。` +
            '先逐条核对：验收涉及的文件是否都在范围内、提到的输入是否存在、诊断与假设是否证实、' +
            '验收之间是否矛盾。核对通过用 verdict=ok 提交；发现问题用 verdict=issues 提交，平台会升级给 L3。',
        );
      }
      const checkData = check.data as { verdict?: string; escalationIndex?: number } | undefined;
      if (checkData?.verdict === 'issues') {
        // 只认这次 issues 自己那条升级的答复：另有一条旧升级被答复过，不能替这次解闸。
        const index = checkData.escalationIndex;
        const escalation = index === undefined ? undefined : mission.escalations[index];
        if (escalation?.answer?.trim() !== '照原契约做') {
          throw new PlatformRuleError(
            'CONTRACT_CHECK_ISSUES_PENDING',
            `契约核对（r${mission.contractRevision}）判为 issues：在 L3 对这次升级明确答复「照原契约做」` +
              '之前不能派发。请把问题升级给 L3，等答复后再按原契约继续。',
          );
        }
      }
    }
    // Standard 调用顺序保持原样：先 startExecuting/处理 PROJECT_BUSY，
    // 再 PRE_DISPATCH shadow，再 item.dispatch。
    await acquireMutationSlotForDispatch(mission, project);

    // PRE_DISPATCH shadow：确认硬规则全部通过之后、真实 dispatch 之前。
    // 信号 / provider 失败 / shadow append 失败都不改变后续 item.dispatch。
    if (ctx.decisionProvider && ctx.decisionHooks.has('PRE_DISPATCH')) {
      const soleWorkItemId = workItemIds.length === 1 ? workItemIds[0] : undefined;
      await runDecisionShadow({
        provider: ctx.decisionProvider,
        activity: ctx.activity,
        clock: ctx.clock,
        stateInput: {
          hook: 'PRE_DISPATCH',
          projectId: mission.projectId,
          missionId: mission.id,
          attemptId,
          ...(soleWorkItemId !== undefined ? { workItemId: soleWorkItemId } : {}),
        },
        workItemIds: [...workItemIds],
      });
    }

    for (const item of items) item.dispatch();
    await ctx.event(mission, 'work_item.dispatched', { ids: [...workItemIds] }, undefined, attemptId);
    return { dispatched: [...workItemIds] };
  }
