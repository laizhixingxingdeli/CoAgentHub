/**
 * Direct 主控模式：外部 controller 会话主控，不 spawn 模型，经平台执行单条主控操作。
 * 业务门禁不复制：plan / contract_check / work_item / dispatch / review / submit 复用 platform
 * 同名函数，requireAttempt 等门禁照常生效；本模块只做 direct 前置校验、host Attempt 生命周期
 * 与 direct.controller_action 事件。每条命令开一张短 host coordinator Attempt 留痕，与命令
 * 同事务：有事务抛错整体回滚，无事务尽力收尾，绝不让 host Attempt 卡在 in_progress。
 * review accept 必须核当前提交真实通过的机器验收报告（passed、commands 非空、规格与工单全等）：
 * direct 入口与 legacy accept 走同一道门禁，都不相信 caller 自报的 passed。
 */
import type {
  AttemptEndReason,
  Mission,
  Project,
  UsedProfile,
  WorkItem,
  WorkOrderValidationCommand,
} from '../../kernel/index.ts';
import { PlatformRuleError, type PlatformContext } from './context.ts';
import { parseDirectControlCommand, type DirectControlCommand } from './direct-control-command.ts';
import * as attempts from './attempts.ts';
import * as planning from './planning.ts';
import * as escalations from './escalations.ts';
import * as workOrders from './work-orders.ts';
import * as workItemDispatch from './work-item-dispatch.ts';
import * as workItemReview from './work-item-review.ts';
import * as missionControl from './mission-control.ts';
import {
  getAgentValidationReport,
  reportReuseSpecMatches,
} from './validation-report-views.ts';


export type { DirectControlCommand };

/** direct 主控命令的执行结果。各 action 把底层公开方法的返回原样交回。 */
export type DirectControlResult =
  | { readonly action: 'plan'; readonly planRevision: number }
  | {
      readonly action: 'contract_check';
      readonly contractRevision: number;
      readonly verdict: 'ok' | 'issues';
    }
  | {
      readonly action: 'create_work_item';
      readonly workItemId: string;
    }
  | {
      readonly action: 'revise_work_order';
      readonly workItemId: string;
      readonly revision: string;
      readonly changedFields: readonly string[];
    }
  | { readonly action: 'dispatch'; readonly dispatched: readonly string[] }
  | { readonly action: 'review'; readonly status: string }
  | { readonly action: 'submit' };

/** direct-control 复用 Platform 私有门禁需要的回调（由 Platform 薄方法注入）。 */
export interface DirectControlCallbacks {
  /** 派发前的诊断升级门禁（W-292 等）。复用 Platform.#requireNoOpenDiagnosticEscalation。 */
  readonly requireNoOpenDiagnosticEscalation: (mission: Mission) => Promise<void>;
  /** 派发前占 Project mutation slot（不变量 C）。复用 Platform.#acquireMutationSlotForDispatch。 */
  readonly acquireMutationSlotForDispatch: (mission: Mission, project: Project) => Promise<void>;
  /** review reject 后的连续失败诊断卡。复用 Platform.#criteriaFailureStop。 */
  readonly criteriaFailureStop: (mission: Mission, item: WorkItem) => Promise<void>;
}

const HOST_PROFILE: Readonly<UsedProfile> = Object.freeze({
  profileId: 'external-controller',
  endpoint: 'host',
});

/**
 * 执行一条 direct 主控命令。
 *
 * 流程：前置校验 → 在同一命令事务里开 host coordinator Attempt、发 direct.controller_action、
 * 分发到底层模块函数、finish structured_submit。失败时有 transaction 则整体回滚，无 transaction
 * 则尽力把自己开的 host Attempt 收成 interrupted，不留 in_progress。底层模块函数各自
 * requireAttempt('coordinator')，host Attempt 满足。
 */
export async function performDirectControl(
  ctx: PlatformContext,
  callbacks: DirectControlCallbacks,
  missionId: string,
  actor: string,
  command: DirectControlCommand,
): Promise<DirectControlResult> {
  if (typeof actor !== 'string' || actor.trim().length === 0) {
    throw new PlatformRuleError(
      'DIRECT_ACTOR_REQUIRED',
      'direct 主控必须给出非空 actor（谁在主控）。',
    );
  }
  // 形状解析只有一处（direct-control-command.ts）：未知 action、白名单外顶层字段、
  // 缺必填、类型不符都在开 host Attempt 之前拒，事务里只剩业务门禁。
  const parsed = parseDirectControlCommand(command);

  // host Attempt 的开 / 收尾必须与命令在同一事务里：否则中途崩溃会留下 in_progress host Attempt，
  // 下一条命令会被 #hasInProgressCoordinatorAttempt 挡住。
  // 不在事务外保存 mission 引用，也不在事务提交后再 finish。
  return ctx.tx(async () => {
    const { mission } = await ctx.locate(missionId);
    assertDirectMission(mission);

    // 不变量 B：同一 Mission 同一时刻只能有一个 in_progress coordinator attempt。
    // direct 模式下不应有别的 coordinator attempt 在跑——有的话说明上一条 direct 命令没收尾干净，
    // 或 hierarchical 模式的协调者还在跑（direct 模式不允许两者并存）。
    if (mission.coordinatorAttempts.some((a) => a.status === 'in_progress')) {
      throw new PlatformRuleError(
        'CONCURRENT_COORDINATOR_ATTEMPT',
        `Mission ${missionId} 已有 in_progress coordinator attempt，direct 主控不能并发。`,
      );
    }
    const { attemptId } = await attempts.startCoordinatorAttempt(ctx, missionId, HOST_PROFILE);

    try {
      await ctx.event(
        mission,
        'direct.controller_action',
        { actor, action: parsed.action, source: 'host' },
        undefined,
        attemptId,
      );

      const result = await dispatchCommand(ctx, callbacks, missionId, attemptId, parsed);
      // 成功收尾：structured_submit。成本未知不造 0——不传 usage。
      await finishHostAttempt(ctx, missionId, attemptId, 'structured_submit');
      return result;
    } catch (error) {
      // 有 transaction：抛错即整体回滚，host Attempt 随事务消失，不再 finish（不能 finish 一个不存在的 Attempt）。
      // 无 transaction：ctx.tx 直接跑 fn，Attempt 已落盘在 in_progress，只能尽力结束自己的 host Attempt，
      // 绝不宣称原子。
      if (!ctx.transaction) {
        try {
          await finishHostAttempt(
            ctx,
            missionId,
            attemptId,
            'interrupted',
            error instanceof Error ? error.message : String(error),
          );
        } catch {
          // 尽力收尾，收尾失败不覆盖原始错误。
        }
      }
      throw error;
    }
  });
}

function assertDirectMission(mission: Mission): void {
  if (mission.coordinationMode !== 'direct') {
    throw new PlatformRuleError(
      'NOT_DIRECT_MODE',
      `Mission ${mission.id} 的 coordinationMode 是 ${mission.coordinationMode}，direct 主控只允许 direct 模式。`,
    );
  }
  if (mission.executionMode !== 'standard') {
    throw new PlatformRuleError(
      'DIRECT_STANDARD_ONLY',
      `direct 主控只允许 executionMode=standard 的 Mission，${mission.id} 是 ${mission.executionMode}。`,
    );
  }
  if (mission.runKind !== 'mutation') {
    throw new PlatformRuleError(
      'DIRECT_MUTATION_ONLY',
      `direct 主控只允许 runKind=mutation 的 Mission，${mission.id} 是 ${mission.runKind}。`,
    );
  }
  if (mission.isPaused) {
    throw new PlatformRuleError('MISSION_PAUSED', `Mission ${mission.id} 已暂停，不能 direct 主控。`);
  }
  if (mission.isParked) {
    throw new PlatformRuleError('MISSION_PARKED', `Mission ${mission.id} 已挂起，不能 direct 主控。`);
  }
  if (mission.status === 'completed' || mission.status === 'blocked') {
    throw new PlatformRuleError(
      'MISSION_TERMINAL',
      `Mission ${mission.id} 已是终态 ${mission.status}，不能 direct 主控。`,
    );
  }
  // direct 模式下不允许有活动执行者：外部 controller 是唯一主控方，平台不应在派执行者。
  const activeExecutor = mission.workItems.find((item) =>
    item.attempts.some((a) => a.status === 'in_progress'),
  );
  if (activeExecutor) {
    throw new PlatformRuleError(
      'ACTIVE_EXECUTOR_PRESENT',
      `工作项 ${activeExecutor.id} 上有 in_progress 执行者 attempt，direct 主控不允许与活动执行者并存。`,
    );
  }
}

async function dispatchCommand(
  ctx: PlatformContext,
  callbacks: DirectControlCallbacks,
  missionId: string,
  attemptId: string,
  command: DirectControlCommand,
): Promise<DirectControlResult> {
  switch (command.action) {
    case 'plan': {
      const { planRevision } = await planning.updatePlan(ctx, missionId, attemptId, command.plan);
      return { action: 'plan', planRevision };
    }
    case 'contract_check': {
      const { contractRevision, verdict } = await escalations.submitContractCheck(
        ctx,
        missionId,
        attemptId,
        command.check,
      );
      return { action: 'contract_check', contractRevision, verdict };
    }
    case 'create_work_item': {
      // viaCoordinatorTool=true：工单标准软警告照 coordinator 工具路径产出（只审计不硬拒）。
      const { workItemId } = await workOrders.createWorkItem(
        ctx,
        missionId,
        attemptId,
        { title: command.title, order: command.order, ...(command.workItemId ? { workItemId: command.workItemId } : {}) },
        { viaCoordinatorTool: true },
      );
      return { action: 'create_work_item', workItemId };
    }
    case 'revise_work_order': {
      const { workItemId, revision, changedFields } = await workOrders.reviseWorkOrder(
        ctx,
        missionId,
        attemptId,
        command.workItemId,
        command.order,
        { viaCoordinatorTool: true },
      );
      return { action: 'revise_work_order', workItemId, revision, changedFields };
    }
    case 'dispatch': {
      const { dispatched } = await workItemDispatch.dispatchWorkItems(
        ctx,
        callbacks.requireNoOpenDiagnosticEscalation,
        callbacks.acquireMutationSlotForDispatch,
        missionId,
        attemptId,
        command.workItemIds,
      );
      return { action: 'dispatch', dispatched };
    }
    case 'review': {
      if (command.verdict === 'accept') {
        // direct 模式 review accept 的额外门禁：必须有一份机器验收报告，它 passed，
        // 工单 commands 非空，且报告规格（commands / allowedScope）与当前工单全等。
        // 不能相信 caller 自报的 acceptanceResults——它可能把没跑过验收的提交判成 pass。
        await requireDirectAcceptValidation(ctx, missionId, command.workItemId);
      }
      const { status } = await workItemReview.reviewExecutionResult(
        ctx,
        callbacks.criteriaFailureStop,
        missionId,
        attemptId,
        {
          workItemId: command.workItemId,
          verdict: command.verdict,
          reasons: command.reasons,
          requiredChanges: command.requiredChanges,
          ...(command.acceptanceResults ? { acceptanceResults: command.acceptanceResults } : {}),
        },
      );
      return { action: 'review', status };
    }
    case 'submit': {
      await missionControl.submitMissionResult(ctx, missionId, attemptId, command.result);
      return { action: 'submit' };
    }
    default: {
      // exhaustiveness check：新增 action 没在这里登记会编译失败。
      const exhaustive: never = command;
      throw new PlatformRuleError(
        'DIRECT_UNKNOWN_ACTION',
        `direct 主控不认识的 action：${(exhaustive as { action: string }).action}`,
      );
    }
  }
}

/**
 * direct 模式 review accept 的机器验收门禁。
 *
 * 公开 reviewExecutionResult 在 accept 时只靠 caller 给的 acceptanceResults（accept 不能含 fail）。
 * direct 模式下，外部 controller 没有「自己看过了」这个事实可采信——它必须先有一份机器验收报告，
 * 报告 passed，工单 commands 非空（纯 changed-paths 的工单没有可复用的事实），且报告的 commands /
 * allowedScope 与当前工单全等（reportReuseSpecMatches）。三条都满足才放行给原 reviewExecutionResult。
 *
 * 导出是给 Platform.#reviewExecutionResult 用的：legacy 公开 review 入口也要过同一道门禁，
 * 否则绕过 direct 主控直接调 reviewExecutionResult 就跳过了机器验收报告。
 */
export async function requireDirectAcceptValidation(
  ctx: PlatformContext,
  missionId: string,
  workItemId: string,
): Promise<void> {
  const { mission } = await ctx.locate(missionId);
  const item = mission.workItem(workItemId);
  if (!item) {
    throw new PlatformRuleError('UNKNOWN_WORK_ITEM', `工作项 ${workItemId} 不存在。`);
  }
  const order = item.order;
  if (!order) {
    throw new PlatformRuleError(
      'DIRECT_ACCEPT_NO_ORDER',
      `工作项 ${workItemId} 没有工单，无法核对机器验收报告。`,
    );
  }
  const commands = order.validation?.commands ?? [];
  if (commands.length === 0) {
    throw new PlatformRuleError(
      'DIRECT_ACCEPT_COMMANDS_REQUIRED',
      `direct 模式 review accept 要求工单 ${workItemId} 的 validation.commands 非空：没有可复用的机器验收事实，不接受 caller 自报通过。`,
    );
  }
  const report = await getAgentValidationReport(ctx, missionId, workItemId);
  if (!report) {
    throw new PlatformRuleError(
      'DIRECT_ACCEPT_REPORT_REQUIRED',
      `direct 模式 review accept 要求当前提交有一份机器验收报告，工作项 ${workItemId} 没有。`,
    );
  }
  if (report.passed !== true) {
    throw new PlatformRuleError(
      'DIRECT_ACCEPT_REPORT_NOT_PASSED',
      `direct 模式 review accept 要求机器验收报告 passed，工作项 ${workItemId} 的报告不是 passed。`,
    );
  }
  // 报告本身存的是 checks，但 commands/allowedScope 的「当时那版工单」快照在 validation.reported 事件里。
  // 找当前提交对应的那条事件，把 data 喂给 reportReuseSpecMatches 做全等比对。
  const eventData = await directAcceptReportEventData(ctx, mission, workItemId, item.submittedAttemptId);
  if (eventData === undefined) {
    throw new PlatformRuleError(
      'DIRECT_ACCEPT_REPORT_EVENT_MISSING',
      `direct 模式 review accept 找不到工作项 ${workItemId} 当前提交的 validation.reported 事件，无法证明报告规格与当前工单一致。`,
    );
  }
  const matches = reportReuseSpecMatches({
    eventData,
    report,
    orderAllowedScope: order.allowedScope,
    orderCommands: commands as readonly WorkOrderValidationCommand[],
  });
  if (!matches) {
    throw new PlatformRuleError(
      'DIRECT_ACCEPT_REPORT_SPEC_MISMATCH',
      `工作项 ${workItemId} 的机器验收报告规格（commands/allowedScope）与当前工单不一致，不能复用为 accept 依据。`,
    );
  }
}

/** 找当前 submittedAttemptId 对应的那条 validation.reported 事件的 data。 */
async function directAcceptReportEventData(
  ctx: PlatformContext,
  mission: Mission,
  workItemId: string,
  submittedAttemptId: string | undefined,
): Promise<unknown> {
  if (submittedAttemptId === undefined) return undefined;
  const events = await ctx.activity.list(mission.id);
  // 倒序：同一提交重跑机器验收时，最新那条才是这次交付的依据。
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.kind !== 'validation.reported') continue;
    if (event.workItemId !== workItemId) continue;
    const data = event.data;
    if (data == null || typeof data !== 'object' || Array.isArray(data)) continue;
    if ((data as { submittedAttemptId?: unknown }).submittedAttemptId !== submittedAttemptId) continue;
    return data;
  }
  return undefined;
}

/**
 * 收尾 host Attempt。已终态（重入）静默跳过 succeed/fail，但事件照发——
 * 与 attempts.finishAttempt 的 alreadyTerminal 语义一致。
 */
async function finishHostAttempt(
  ctx: PlatformContext,
  missionId: string,
  attemptId: string,
  endedBy: AttemptEndReason,
  failureMessage?: string,
): Promise<void> {
  // 不传 usage：direct 主控不启动模型，成本由外部 controller 自负，平台不造 0。
  await attempts.finishAttempt(ctx, missionId, attemptId, {
    endedBy,
    ...(failureMessage !== undefined ? { failureMessage } : {}),
  });
}
