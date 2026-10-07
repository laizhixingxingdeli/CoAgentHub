import type { QueueClaimIdentity } from './types.ts';
import type { PlatformContext } from './context.ts';

/**
 * 平台把「已无活执行者的 dispatched 工作项」收成 blocked（W-523）。
 *
 * 与 reportBlocked 的区别：reportBlocked 是**执行者自己**在 attempt 里说工单不成立，
 * 它顺带跑 criteriaFailureStop（同一条验收连续几个工作项没过就升级）。平台收尾发生在
 * 执行者已经不在之后——被掐断的跑飞、或连续无结构化结果到顶——此时没有人能替它表达
 * "哪条验收过不了"，把平台收尾计进那条失败计数会让升级凭空变多。所以这里只写
 * work_item.platform_blocked，不复用 blocked.reported、不调 criteriaFailureStop。
 */

export type StalledSource = 'runaway' | 'no_result_limit';

export interface StalledWorkItemInput {
  readonly missionId: string;
  readonly workItemId: string;
  readonly source: StalledSource;
  /** 调用方看到的最后一次执行者尝试 id（迟到快照一律不写）。 */
  readonly expectedAttemptId: string;
  /** 调用方看到的工单修订号。 */
  readonly orderRevision: string;
  readonly consecutive?: number;
  readonly minutes?: number;
}

export interface StalledWorkItemResult {
  readonly converted: boolean;
  readonly reason: string;
}

export const PLATFORM_BLOCKED_EVENT_KIND = 'work_item.platform_blocked';

/** 给上游看的理由。数字缺失时不写 NaN，也不编一个具体数字。 */
export function stallReason(
  source: StalledSource,
  consecutive: number | undefined,
  minutes: number | undefined,
): string {
  return source === 'runaway'
    ? `平台掐断：一跳连续跑了 ${describeValue(minutes)} 分钟没有交结果，改动留在工作区没有回滚`
    : `平台放弃重跑：同一工作项连续 ${describeValue(consecutive)} 次没有结构化结果`;
}

function describeValue(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '若干';
}

export async function blockStalledWorkItem(
  ctx: PlatformContext,
  input: StalledWorkItemInput,
  claim?: QueueClaimIdentity,
): Promise<StalledWorkItemResult> {
  // locateItem / 校验 / 写都在同一个围栏事务里：事务外预检会在核对和提交之间被别人接手，
  // 那时"没有活执行者"这个前提已经不成立了。
  return ctx.txFenced(claim, async () => {
    const { mission, item } = await ctx.locateItem(input.missionId, input.workItemId);
    const skip = (reason: string): StalledWorkItemResult => ({ converted: false, reason });

    // 只有 Standard 有协调者能修订再派；Lightweight 没有这条恢复路径，收尾只会把项焊死。
    if (mission.executionMode !== 'standard') {
      return skip(`Mission ${mission.id} 的 executionMode 是 ${mission.executionMode}，只有 Standard 工作项能由平台收成卡住。`);
    }
    if (item.status !== 'dispatched') {
      return skip(`工作项 ${item.id} 当前是 ${item.status}，不是 dispatched：已经收过尾或被别人处理过，本次不动。`);
    }
    if (input.source !== 'runaway' && input.source !== 'no_result_limit') {
      return skip(`来源 ${String(input.source)} 不是平台收尾认的 runaway / no_result_limit。`);
    }
    const attemptIds = item.attempts.map((attempt) => attempt.id);
    const latest = attemptIds[attemptIds.length - 1];
    if (latest === undefined) {
      return skip(`工作项 ${item.id} 还没有执行者尝试，谈不上被卡住。`);
    }
    // 调用快照：迟到的收尾（工单已修订、或又开了新一次尝试）一律不写。
    if (input.expectedAttemptId !== latest) {
      return skip(`快照已过期：调用方以为最后一次尝试是 ${input.expectedAttemptId}，平台这里是 ${latest}。`);
    }
    const currentRevision = item.order?.orderRevision ?? 'r1';
    if (input.orderRevision !== currentRevision) {
      return skip(`工单已修订：调用方拿的是 ${input.orderRevision}，当前是 ${currentRevision}。`);
    }
    // 还有活执行者就不动：它可能正在交结果，平台替它写卡住等于把一次成功抹掉。
    for (const id of attemptIds) {
      const attempt = mission.attempt(id);
      if (!attempt) {
        return skip(`尝试 ${id} 列在工作项 ${item.id} 上，但 Mission 里查不到。`);
      }
      if (attempt.status === 'in_progress') {
        return skip(`尝试 ${id} 还是 in_progress：还有活执行者，先终止它再收尾。`);
      }
    }

    const reason = stallReason(input.source, input.consecutive, input.minutes);
    item.recordBlocked({
      attemptId: latest,
      reason,
      whatWasTried: attemptIds.map((id) => `${id}（${mission.attempt(id)?.endedBy ?? 'unknown'}）`),
      needsFromUpstream: '核对工单是否过大或不清楚，改对后 coagent_revise_work_order 再派发，或作废',
    });
    await ctx.event(
      mission,
      PLATFORM_BLOCKED_EVENT_KIND,
      { source: input.source, orderRevision: currentRevision, attemptId: latest, reason },
      item.id,
      latest,
    );
    return { converted: true, reason };
  });
}
