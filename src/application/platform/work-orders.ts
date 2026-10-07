import type { WorkOrder } from '../../kernel/index.ts';
import type { WorkOrderStandardWarning } from './types.ts';
import { PlatformContext, PlatformRuleError } from './context.ts';
import { REVISE_BLOCKED_HINT, orderChangedFields, checkWorkOrderCriteria, checkWorkOrderValidationArgv, checkWorkOrderStandard } from './work-order-helpers.ts';
import { enforceMissionTicketGates } from './ticket-budget.ts';

export async function createWorkItem(
  ctx: PlatformContext,
    missionId: string,
    attemptId: string,
    input: { title: string; order: WorkOrder; workItemId?: string },
    options?: { viaCoordinatorTool?: boolean },
  ): Promise<{ workItemId: string; warnings: readonly WorkOrderStandardWarning[] }> {
    const { mission } = await ctx.requireAttempt(missionId, attemptId, 'coordinator');
    if (mission.planRevision === 0) {
      throw new PlatformRuleError(
        'PLAN_REQUIRED',
        '还没有 Plan：先把调查结论写回平台（update_plan），再创建工作项。',
      );
    }
    // 先校验再生成 id / 落状态：不合法就整份拒绝，不留下一半变更。
    checkWorkOrderCriteria(input.order, mission);
    checkWorkOrderValidationArgv(input.order);
    const workItemId = input.workItemId ?? ctx.ids.next('W');
    mission.createWorkItem({ id: workItemId, title: input.title, order: input.order });
    // 软警告只经两个 coordinator HTTP 工具路径：直接调用不传该标志，保持原语义。
    // 只审计、不硬拒——超限的工单照常建出来，由协调者照建议拆单/补引用。
    const warnings = options?.viaCoordinatorTool ? checkWorkOrderStandard(input.order) : undefined;
    await ctx.event(
      mission,
      'work_item.created',
      { title: input.title, ...(warnings ? { warnings } : {}) },
      workItemId,
      attemptId,
    );
    // 票级检查点（W-430）：第 15 个工作项照常建出来，同时停等升级等批准，
    // 所以这里不抛错、不改变返回值——它跟进来的是外层 attemptWrite 的事务，
    // 抛出去会把刚落的 created 事件和这次停等一起回滚。
    await enforceMissionTicketGates(ctx, missionId, attemptId);
    return warnings ? { workItemId, warnings } : { workItemId };
  }

export async function reviseWorkOrder(
  ctx: PlatformContext,
    missionId: string,
    attemptId: string,
    workItemId: string,
    order: WorkOrder,
    options?: { viaCoordinatorTool?: boolean },
  ): Promise<{
    workItemId: string;
    revision: string;
    changedFields: readonly string[];
    warnings: readonly WorkOrderStandardWarning[];
  }> {
    const { mission } = await ctx.requireAttempt(missionId, attemptId, 'coordinator');
    const item = mission.workItem(workItemId);
    if (!item) {
      throw new PlatformRuleError('UNKNOWN_WORK_ITEM', `工作项 ${workItemId} 不存在`);
    }
    // 运行中 / 已有结果的工单不能就地改：执行者手上那份是冻结的，改了它就会
    // 出现「按旧工单交的结果对不上新验收标准」。kernel 也挡这些状态（抛
    // ILLEGAL_TRANSITION），这里先挡一次是为了给协调者一句能照做的下一步。
    const hint = REVISE_BLOCKED_HINT[item.status];
    if (hint) {
      throw new PlatformRuleError('WORK_ITEM_NOT_REVISABLE', `工作项 ${workItemId} ${hint}`);
    }
    // 同上：校验先行，不合法时工单与修订号都不动。
    checkWorkOrderCriteria(order, mission);
    checkWorkOrderValidationArgv(order);
    // 差异取调用方提交的整份工单 vs 修订前的整份工单；orderRevision 是
    // kernel 机械递增的，不算「协调者改了哪个字段」，单独由 revision 事件字段给出。
    const changedFields = orderChangedFields(item.order, order);
    item.reviseOrder(order);
    const revision = item.order?.orderRevision ?? 'r1';
    // 软警告只经两个 coordinator HTTP 工具路径：直接调用不传该标志，保持原语义。
    // 只审计、不硬拒——超限的修订照常生效，由协调者照建议拆单/补引用。
    const warnings = options?.viaCoordinatorTool ? checkWorkOrderStandard(order) : undefined;
    // 只记修订号与字段名，不把工单全文写进事件：事件流是给人看的，
    // 全文会在每条时间线上重复一遍工单。超工单标准的警告一并带上，不另造事件种类。
    await ctx.event(
      mission,
      'work_item.order_revised',
      { revision, changedFields, ...(warnings ? { warnings } : {}) },
      workItemId,
      attemptId,
    );
    return warnings
      ? { workItemId, revision, changedFields, warnings }
      : { workItemId, revision, changedFields };
  }
