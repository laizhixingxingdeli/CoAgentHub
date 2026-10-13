import { PlatformRuleError, type PlatformContext } from './context.ts';
import { isActiveHopLease } from '../durable-scheduler.ts';
import { autoRedispatchEventsFor } from './redispatch-helpers.ts';
import { submittedAttemptReportId } from './standard-validation.ts';
import { PLATFORM_BLOCKED_EVENT_KIND } from './stalled-work-item.ts';

/**
 * 工作项状态恢复（P0：状态一致性）：把「有执行结果、却停在 dispatched、没有活执行者」的工单
 * 收成 blocked，让协调者能依法审查、修订、再派发。
 *
 * 为什么会出现这种工单：机器续派（reject + dispatch）发生在 Mission 已不在 executing 的时候
 * （契约修订把它退回了 planning），调度器只在 executing 阶段跑执行者，于是工单带着上一次的
 * completed 结果和失败的验证报告停在 dispatched。dispatched 只能前进到 submitted / blocked /
 * retired——协调者 reject 它会得到 `dispatched -> rejected is not allowed`，也修订不了，
 * 只能让 L3 作废重建（MiRing-V0-probe 的 W-621）。
 *
 * 与 blockStalledWorkItem 的分工：那个处理「执行者被杀 / 无结果到顶」，要求调用方带着尝试号
 * 与修订号；这里处理「状态与已有成果不一致」，两条来源：
 *   - stranded_dispatch：编排器在叫协调者之前自己发现、自己收，只认可证明的机器续派残留；
 *   - operator_recovery：L3 / 操作员显式触发，必须署名并写理由，进审计。
 * 恢复前一律核实：Standard、仍是 dispatched、所有尝试已结束、没有执行者 hop 的有效租约、
 * 调用方带来的尝试号与修订号（给了就必须一致）。任一不成立无副作用拒绝，不留任何事件。
 * 幂等：已经恢复过的再调一次返回 alreadyRecovered，不重复写事件。
 */

export type StrandedSource = 'stranded_dispatch' | 'operator_recovery';

export interface StrandedRecoveryInput {
  readonly missionId: string;
  readonly workItemId: string;
  readonly source: StrandedSource;
  /** 调用方看到的最后一次执行者尝试 id。给了就必须一致：防止恢复到别人刚动过的工单上。 */
  readonly expectedAttemptId?: string;
  /** 调用方看到的工单修订号，同上。 */
  readonly orderRevision?: string;
  /** 操作员路径必填：谁恢复的、凭什么。 */
  readonly reviewer?: string;
  readonly reason?: string;
}

export interface StrandedRecoveryResult {
  readonly converted: boolean;
  /** 之前已经恢复过：这次什么都没写。 */
  readonly alreadyRecovered?: boolean;
  readonly reason: string;
}

const RECOVERY_SOURCES: readonly string[] = ['stranded_dispatch', 'operator_recovery'];

export async function recoverStrandedWorkItem(
  ctx: PlatformContext,
  input: StrandedRecoveryInput,
): Promise<StrandedRecoveryResult> {
  if (input.source === 'operator_recovery') {
    if (!input.reviewer?.trim() || !input.reason?.trim()) {
      throw new PlatformRuleError(
        'RECOVERY_SIGNATURE_REQUIRED',
        '状态恢复需要署名与理由：reviewer 说明是谁恢复的，reason 说明凭什么（核对过哪些尝试、租约与验证报告）。',
      );
    }
  }
  // 校验、读事件、写状态在同一个事务里：事务外预检会在核对和提交之间被别人接手。
  return ctx.tx(async () => {
    const { mission, item } = await ctx.locateItem(input.missionId, input.workItemId);
    const skip = (reason: string): StrandedRecoveryResult => ({ converted: false, reason });
    const events = await ctx.activity.list(mission.id);

    if (mission.executionMode !== 'standard') {
      return skip(`Mission ${mission.id} 的 executionMode 是 ${mission.executionMode}，只有 Standard 才有协调者能接手恢复后的工单。`);
    }
    if (item.status === 'blocked') {
      const last = lastStateEvent(events, item.id);
      if (last?.kind === PLATFORM_BLOCKED_EVENT_KIND && RECOVERY_SOURCES.includes(String(last.data?.source))) {
        return { converted: false, alreadyRecovered: true, reason: String(last.data?.reason ?? '') };
      }
    }
    if (item.status !== 'dispatched') {
      return skip(`工作项 ${item.id} 当前是 ${item.status}，不是 dispatched：已经恢复或被别人处理过，本次不动。`);
    }
    const attempts = item.attempts;
    const latest = attempts[attempts.length - 1];
    if (!latest) {
      return skip(`工作项 ${item.id} 还没有执行者尝试，谈不上状态不一致。`);
    }
    if (input.expectedAttemptId !== undefined && input.expectedAttemptId !== latest.id) {
      return skip(`快照已过期：调用方以为最后一次尝试是 ${input.expectedAttemptId}，平台这里是 ${latest.id}。`);
    }
    const currentRevision = item.order?.orderRevision ?? 'r1';
    if (input.orderRevision !== undefined && input.orderRevision !== currentRevision) {
      return skip(`工单已修订：调用方拿的是 ${input.orderRevision}，当前是 ${currentRevision}。`);
    }
    const live = attempts.find((attempt) => attempt.status === 'in_progress');
    if (live) {
      return skip(`尝试 ${live.id} 还是 in_progress：真正在执行的工单不能强行转换。`);
    }
    const lease = await activeExecutorLease(ctx, mission.id, item.id);
    if (lease) {
      return skip(`队列 Hop ${lease.id} 仍有有效租约（持有者 ${lease.owner ?? '(unknown)'}，到期 ${lease.leaseUntil ?? '(none)'}）：执行者可能还在启动，先等它收尾。`);
    }

    const submittedAttemptId = item.submittedAttemptId;
    const redispatch = submittedAttemptId
      ? autoRedispatchEventsFor(events, item.id).find((row) => row.attemptId === submittedAttemptId)
      : undefined;
    if (input.source === 'stranded_dispatch') {
      // 自动路径只认可证明的残留：Mission 不会再跑它（不在 executing），并且确实是
      // 「这次提交已被机器续派」留下的。其余情形不是平台能替人判断的。
      if (mission.status === 'executing') {
        return skip(`Mission ${mission.id} 仍在 executing：执行者会接着跑这张工单，不收尾。`);
      }
      if (!item.hasResult || !redispatch) {
        return skip(`工作项 ${item.id} 没有「已有结果又被机器续派」的记录，不是平台能自动判定的残留。`);
      }
    }

    const reportId = submittedAttemptId
      ? await submittedAttemptReportId(ctx, mission.id, item.id, submittedAttemptId)
      : undefined;
    const reason = describeStranded(input, mission.status, redispatch?.summary, reportId);
    item.recordBlocked({
      attemptId: latest.id,
      reason,
      whatWasTried: attempts.map((attempt) => `${attempt.id}（${attempt.endedBy ?? 'unknown'}）`),
      needsFromUpstream:
        '先看已有的执行结果与验证报告：问题在工单就 coagent_revise_work_order 修订同一张单再派发；' +
        '问题在工作区（越界改动、验证副作用）就新建一张范围精确的恢复单。成果与改动原样保留，没有回滚。',
    });
    // 不带 orderRevision：卡住的是状态不是工单正文，派发门禁不要求先改工单（见 work-item-dispatch 的 W-292 门禁）。
    await ctx.event(
      mission,
      PLATFORM_BLOCKED_EVENT_KIND,
      {
        source: input.source,
        attemptId: latest.id,
        reason,
        staleResult: item.hasResult,
        ...(reportId !== undefined ? { reportId } : {}),
        ...(input.source === 'operator_recovery'
          ? { reviewer: input.reviewer!.trim(), operatorReason: input.reason!.trim() }
          : {}),
      },
      item.id,
      latest.id,
    );
    return { converted: true, reason };
  });
}

/** 这张工单最近一条决定它状态的事件：被平台 / 执行者收成卡住，或被（重新）派发。 */
function lastStateEvent(
  events: readonly { kind: string; workItemId?: string; data: unknown }[],
  workItemId: string,
): { kind: string; data: Record<string, unknown> | undefined } | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    const data = (event.data ?? undefined) as Record<string, unknown> | undefined;
    if (event.kind === 'work_item.dispatched') {
      const ids = data?.ids;
      if (Array.isArray(ids) && ids.includes(workItemId)) return { kind: event.kind, data };
      continue;
    }
    if (event.workItemId !== workItemId) continue;
    if (event.kind === PLATFORM_BLOCKED_EVENT_KIND || event.kind === 'blocked.reported') {
      return { kind: event.kind, data };
    }
  }
  return undefined;
}

async function activeExecutorLease(ctx: PlatformContext, missionId: string, workItemId: string) {
  const repository = ctx.queuedHops;
  if (!repository) return undefined;
  const nowIso = ctx.clock.now().toISOString();
  return (await repository.list()).find(
    (hop) =>
      hop.missionId === missionId &&
      hop.role === 'executor' &&
      hop.workItemId === workItemId &&
      isActiveHopLease(hop, nowIso),
  );
}

function describeStranded(
  input: StrandedRecoveryInput,
  missionStatus: string,
  redispatchSummary: string | undefined,
  reportId: string | undefined,
): string {
  const report = reportId ? `和验证报告 ${reportId}` : '';
  const failure = redispatchSummary ? `（机器续派的依据：${redispatchSummary}）` : '';
  if (input.source === 'operator_recovery') {
    return (
      `状态恢复（${input.reviewer!.trim()}）：${input.reason!.trim()}。` +
      `工单已有执行结果${report}却停在 dispatched，没有活执行者，平台收成 blocked 交回协调者${failure}。`
    );
  }
  return (
    `状态恢复：工单已有执行结果${report}，却被机器续派回了 dispatched；而 Mission 现在是 ${missionStatus}，` +
    `调度器不会再为它启动执行者，协调者也无法对 dispatched 工单 reject 或修订。平台把它收成 blocked 交回协调者${failure}。`
  );
}
