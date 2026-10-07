import type { PlatformContext } from './context.ts';
import type { QueuedHop } from '../durable-scheduler.ts';

/**
 * 队列 hop 的入队 / 首次认领 / 退避事实（COM5 T3）。
 *
 * 为什么另起一个模块：`durable-scheduler` 是纯函数与仓储契约，不许它顺手写
 * 活动——那条路会在重试、续租、多 runner 抢同一行时写出重复事实，而且测试
 * 里跑纯函数也会带出落盘。事件只能由 orchestrator 在「确实发生了一次状态
 * 迁移」的邻接处让 platform 写。
 *
 * 为什么认领时点进 data 而不是改 `QueuedHop`：`updatedAt` 会被续租和失败
 * 覆盖，加一个 `claimedAt` 字段也一样会被下一次 `renew` 改写——可覆盖的
 * 字段当不了历史。这里写下的 `claimedAt` 是**本次认领返回行**上的
 * `updatedAt`，随后无论 renew 怎么改行，这条事件都不动。
 *
 * `at` 一律由平台落盘时钟给出（ctx.event 内部），调用方不得传时间。
 */

interface HopEventDedupe {
  readonly kind: string;
  /** 只有同键的既有事件才算重复；键由各方法按契约字段拼出。 */
  readonly key: (data: Record<string, unknown>) => string | undefined;
}

function asRecord(data: unknown): Record<string, unknown> {
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return {};
}

/** 已落盘的同 kind 事件里，是否已经有一条键完全相同的。 */
async function alreadyRecorded(
  ctx: PlatformContext,
  missionId: string,
  dedupe: HopEventDedupe,
  wantedKey: string,
): Promise<boolean> {
  const events = await ctx.activity.list(missionId);
  return events.some((event) => {
    if (event.kind !== dedupe.kind) return false;
    return dedupe.key(asRecord(event.data)) === wantedKey;
  });
}

export async function recordHopEnqueued(
  ctx: PlatformContext,
  missionId: string,
  hop: QueuedHop,
): Promise<void> {
  const { mission } = await ctx.locate(missionId);
  const key = hop.id;
  const duplicate = await alreadyRecorded(
    ctx,
    missionId,
    { kind: 'hop.enqueued', key: (data) => (typeof data.hopId === 'string' ? data.hopId : undefined) },
    key,
  );
  // 幂等命中的旧行不补事件：补一条等于把「这次没人入队」说成「入队了」，
  // 而排障要的正是「这个 slot 为什么没重开一档」。
  if (duplicate) return;
  await ctx.event(
    mission,
    'hop.enqueued',
    {
      hopId: hop.id,
      role: hop.role,
      workItemId: hop.workItemId,
      availableAt: hop.availableAt,
      enqueuedAt: hop.createdAt,
    },
  );
}

export async function recordHopClaimed(
  ctx: PlatformContext,
  missionId: string,
  hop: QueuedHop,
): Promise<void> {
  const { mission } = await ctx.locate(missionId);
  const generation = hop.claimGeneration;
  if (generation === undefined) return;
  const key = `${hop.id}\u0000${generation}`;
  const duplicate = await alreadyRecorded(
    ctx,
    missionId,
    {
      kind: 'hop.claimed',
      key: (data) =>
        typeof data.hopId === 'string' && typeof data.claimGeneration === 'number'
          ? `${data.hopId}\u0000${data.claimGeneration}`
          : undefined,
    },
    key,
  );
  if (duplicate) return;
  await ctx.event(
    mission,
    'hop.claimed',
    {
      hopId: hop.id,
      claimGeneration: generation,
      enqueuedAt: hop.createdAt,
      claimedAt: hop.updatedAt,
    },
  );
}

export async function recordHopBackoff(
  ctx: PlatformContext,
  missionId: string,
  hop: QueuedHop,
): Promise<void> {
  const last = hop.lastFailure;
  // 没有失败记录就没有退避事实——这条只在 reportFailure 返回 retry_wait 时发。
  if (last === undefined) return;
  const { mission } = await ctx.locate(missionId);
  const key = `${hop.id}\u0000${last.at}\u0000${hop.attemptCount}`;
  const duplicate = await alreadyRecorded(
    ctx,
    missionId,
    {
      kind: 'hop.backoff',
      key: (data) =>
        typeof data.hopId === 'string' && typeof data.failedAt === 'string'
          ? `${data.hopId}\u0000${data.failedAt}\u0000${String(data.attemptCount)}`
          : undefined,
    },
    key,
  );
  if (duplicate) return;
  await ctx.event(
    mission,
    'hop.backoff',
    {
      hopId: hop.id,
      failedAt: last.at,
      availableAt: hop.availableAt,
      attemptCount: hop.attemptCount,
    },
  );
}
