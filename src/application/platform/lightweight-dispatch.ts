import type { Mission, Project, WorkOrder } from '../../kernel/index.ts';
import { PlatformContext, PlatformRuleError } from './context.ts';
import { runDecisionShadow } from '../decision-shadow-runner.ts';

export async function createLightweightWorkItem(
  ctx: PlatformContext,
  requireLightweightMutationLane: (mission: Mission) => void,
  requireNoOpenDiagnosticEscalation: (mission: Mission) => Promise<void>,
  acquireMutationSlotForDispatch: (mission: Mission, project: Project) => Promise<void>,
    missionId: string,
    input: { readonly order: WorkOrder; readonly title?: string; readonly workItemId?: string },
  ): Promise<{ workItemId: string }> {
    const { mission } = await ctx.locate(missionId);
    requireLightweightMutationLane(mission);

    if (mission.status !== 'investigating' && mission.status !== 'planning') {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_BAD_STATUS',
        `Lightweight create 要求 mission.status=investigating|planning，当前是 ${mission.status}。`,
      );
    }
    if (mission.coordinatorAttempts.length !== 0) {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_COORDINATOR_FORBIDDEN',
        'Lightweight create 要求 coordinatorAttempts 为空（零 Coordinator）。',
      );
    }
    if (mission.workItems.length !== 0) {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_SINGLE_WORK_ITEM',
        'Lightweight Mission 恰好只能有一个 WorkItem；已有 WorkItem，拒绝再建。',
      );
    }

    const title = input.title ?? input.order.objective;
    const workItemId = input.workItemId ?? ctx.ids.next('W');
    // WorkItem 构造器 strict normalize/freeze validation；create 不另验 commands 非空。
    mission.createWorkItem({ id: workItemId, title, order: input.order });
    await ctx.event(
      mission,
      'work_item.created',
      { title, executionMode: 'lightweight' },
      workItemId,
      // attemptId 留空：无 Coordinator reviewer。
    );
    return { workItemId };
  }

export async function dispatchLightweightWorkItem(
  ctx: PlatformContext,
  requireLightweightMutationLane: (mission: Mission) => void,
  requireNoOpenDiagnosticEscalation: (mission: Mission) => Promise<void>,
  acquireMutationSlotForDispatch: (mission: Mission, project: Project) => Promise<void>,
    missionId: string,
    workItemId: string,
  ): Promise<{ dispatched: string }> {
    const { mission, project } = await ctx.locate(missionId);
    requireLightweightMutationLane(mission);

    if (mission.coordinatorAttempts.length !== 0) {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_COORDINATOR_FORBIDDEN',
        'Lightweight dispatch 要求 coordinatorAttempts 仍为空。',
      );
    }

    const item = mission.workItem(workItemId);
    if (!item) {
      throw new PlatformRuleError('UNKNOWN_WORK_ITEM', `工作项 ${workItemId} 不存在`);
    }
    if (mission.workItems.length !== 1 || mission.workItems[0]?.id !== workItemId) {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_SINGLE_WORK_ITEM',
        'Lightweight dispatch 要求该 WorkItem 是 mission 唯一 WorkItem。',
      );
    }
    if (item.status !== 'created') {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_NOT_DISPATCHABLE',
        `工作项 ${workItemId} 当前是 ${item.status}，Lightweight 只能从 created 派发。`,
      );
    }
    // 同上：未答复的诊断卡期间不派，且必须早于抢名额（无副作用）。
    await requireNoOpenDiagnosticEscalation(mission);

    // 与 Standard 相同顺序：mutation-slot → shadow → item.dispatch。
    await acquireMutationSlotForDispatch(mission, project);

    // PRE_DISPATCH shadow：observational；provider/activity 失败不阻断 dispatch。
    // attemptId 省略——绝不伪造 Coordinator attempt。
    if (ctx.decisionProvider && ctx.decisionHooks.has('PRE_DISPATCH')) {
      await runDecisionShadow({
        provider: ctx.decisionProvider,
        activity: ctx.activity,
        clock: ctx.clock,
        stateInput: {
          hook: 'PRE_DISPATCH',
          projectId: mission.projectId,
          missionId: mission.id,
          workItemId,
        },
        workItemIds: [workItemId],
      });
    }

    item.dispatch();
    await ctx.event(
      mission,
      'work_item.dispatched',
      { ids: [workItemId], executionMode: 'lightweight' },
      workItemId,
      // attemptId 留空
    );
    return { dispatched: workItemId };
  }
