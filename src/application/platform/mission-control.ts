import type { Mission, WorkItem, MissionResultBody } from '../../kernel/index.ts';
import { PlatformRuleError, type PlatformContext } from './context.ts';
import { criteriaList } from './agent-view-helpers.ts';
import { validateMissionResultCriteria } from './mission-result-criteria.ts';
import { collectMissionResultAttachments } from './mission-result-attachments.ts';
import { resultDeliveryKey } from '../delivery.ts';

export async function retireWorkItem(
  ctx: PlatformContext,  criteriaFailureStop: (mission: Mission, item: WorkItem) => Promise<void>,
    missionId: string,
    workItemId: string,
    reason: string,
  ): Promise<{ status: string }> {
    const { mission, item } = await ctx.locateItem(missionId, workItemId);
    // 挡两种：已经作废过的，和**已经验收过的**。
    //
    // accepted 不让作废是刻意的：那件事做过、也被验收过了，作废等于抹掉这段
    // 记录（"想反悔"不是作废的理由）。契约改了让它变得多余的话，诚实的说法
    // 是"它在旧契约下被验收过"。
    //
    // 但 blocked 与 rejected **必须**能作废。早先这两个也被挡着，理由写的是
    // "不需要作废"——那句话是错的：它们都会拦着 Mission 交卷。实测 W5 撞上过，
    // 被打回又被新工单取代的那张既不能再验收（没有新结果）也不能作废，卡死。
    if (item.status === 'retired' || item.status === 'accepted') {
      throw new PlatformRuleError(
        'NOT_RETIRABLE',
        item.status === 'retired'
          ? `工作项 ${workItemId} 已经作废过了。`
          : `工作项 ${workItemId} 已经验收通过，不能作废——那是在改历史。`,
      );
    }
    // 走 retire 而不是 recordBlocked：blocked 的含义是"这张工单不成立、
    // 需要有人去改"，会拦住交卷；retired 的含义是"不用做了"，不该拦。
    item.retire(reason);
    await ctx.event(
      mission,
      'work_item.retired',
      {
        reason,
        // 关联标准序号（去重）+ 当时契约修订：统计只认这两个都在的事件。
        criteria: criteriaList(item.order),
        contractRevision: mission.contractRevision,
      },
      workItemId,
    );
    await criteriaFailureStop(mission, item);
    return { status: item.status };
  }

export async function submitMissionResult(
  ctx: PlatformContext,
    missionId: string,
    attemptId: string,
    body: MissionResultBody,
  ): Promise<void> {
    const { mission } = await ctx.requireAttempt(missionId, attemptId, 'coordinator');
    // 逐条结论先校验：形状不对就 throws，**任何状态改动之前**。放在这里而不是
    // recordResult 里，是因为聚合一旦进去了就查不出来那一条缺号是协调者给的
    // 还是平台算错的。旧交卷没有 criteria（那时是自由文本）——那时跳校验。
    validateMissionResultCriteria(body.criteria, mission.contract?.acceptance.length ?? 0);
    if (body.outcome === 'delivered') {
      // 作废掉的不算"没做完"——它是被判定为不用做了，拦着交卷没有道理。
      // 早先只认 accepted，于是任何作废过工作项的 Mission 都永远交不了卷，
      // 只能改用 outcome=blocked 绕过去——那等于对外宣称任务失败了。
      const unfinished = mission.workItems.filter(
        (item) => item.status !== 'accepted' && item.status !== 'retired',
      );
      if (unfinished.length > 0) {
        throw new PlatformRuleError(
          'WORK_ITEMS_UNFINISHED',
          `还有未验收的工作项：${unfinished.map((i) => `${i.id}(${i.status})`).join(', ')}。` +
            '每一张都要么验收通过、要么作废（coagent_retire_work_item）之后才能交卷；' +
            '确实交不出来就用 outcome=blocked。',
        );
      }
    }
    // 附件是平台从记录里搬来的事实，**始终覆盖** caller 给的那一格：
    // 谁说了什么必须对得上，交卷人自称的结果不算数。
    const attachments = await collectMissionResultAttachments(ctx, mission);
    mission.recordResult({ ...body, attachments });
    // **交卷 ≠ 完成。** 改动还躺在未合并的分支上，要等 L3 最终检视。
    // 名额也继续握着——这时候放掉，下一条 Mission 就会从看不见这些改动的
    // 基线上分叉。
    mission.submitForReview();
    await ctx.event(
      mission,
      'mission_result.submitted',
      { outcome: body.outcome, missionStatus: mission.status },
      undefined,
      attemptId,
    );
    const delivery = await ctx.deliveries.create({
      missionId: mission.id,
      projectId: mission.projectId,
      recipient: mission.origin?.conversationRef ?? mission.origin?.clientType ?? 'unknown',
      outcome: body.outcome,
      // 这一次交卷由提交它的协调者 attempt 唯一确定：L3 打回后重新交卷是另一次，照投。
      idempotencyKey: resultDeliveryKey(attemptId),
      summary: body.summary,
    });
    await ctx.event(mission, 'delivery.created', { deliveryId: delivery.id }, undefined, attemptId);
  }

export async function abandonMissionForPlan(
  ctx: PlatformContext,
    missionId: string,
    input: {
      readonly planRunId: string;
      readonly escalationId: string;
      readonly reasons: readonly string[];
      readonly projectRoot?: string;
    },
  ): Promise<{ status: string }> {
    const text = (value: unknown) => typeof value === 'string' && value.trim() !== '';
    if (!text(input.planRunId) || !text(input.escalationId)) {
      throw new PlatformRuleError(
        'PLAN_ABANDON_INVALID',
        '方案放弃必须指向方案运行与那张升级单——否则早上查不到为什么放弃。',
      );
    }
    if (!Array.isArray(input.reasons) || !input.reasons.some(text)) {
      throw new PlatformRuleError('PLAN_ABANDON_INVALID', '方案放弃必须写理由。');
    }
    const { mission } = await ctx.locate(missionId);
    if (mission.status === 'completed' || mission.status === 'blocked') {
      throw new PlatformRuleError(
        'MISSION_ALREADY_TERMINAL',
        `Mission ${missionId} 已经是 ${mission.status}，没什么可放弃的。`,
      );
    }
    mission.block({
      verdict: 'abandon',
      reasons: [...input.reasons],
      authority: Object.freeze({
        kind: 'plan' as const,
        planRunId: input.planRunId,
        escalationId: input.escalationId,
      }),
    });
    await ctx.event(mission, 'final_review.abandoned', {
      reasons: input.reasons,
      authority: 'plan',
      planRunId: input.planRunId,
      escalationId: input.escalationId,
    });
    await ctx.releaseWorkspace(missionId, mission.workspaceRef?.projectRoot ?? input.projectRoot);
    return { status: mission.status };
  }
