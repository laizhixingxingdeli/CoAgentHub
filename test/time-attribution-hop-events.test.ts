/**
 * COM5 T3 —— hop 入队 / 首次认领 / 退避时点落库。
 *
 * 关键是「认领时点必须冻在事件里」：`QueuedHop.updatedAt` 会被 renew 覆盖，
 * 所以这条用例先认领、记事件，再 renew 让它变，最后断言事件里的 `claimedAt`
 * 仍是首次认领那一刻。幂等入队同样只留一条事件。
 *
 * 轻量隔离：内存仓储 + DurableScheduler + 独立 Platform（FixedClock），
 * 不启动任何真实 agent/service。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import { Platform } from '../src/application/platform.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import {
  DurableScheduler,
  claimHop,
  completeHop,
  hopCapacityLimits,
  renewHop,
  reportHopFailure,
  type QueuedHop,
  type QueuedHopRepository,
} from '../src/application/durable-scheduler.ts';

const CONTRACT = {
  intent: '把 X 修好',
  acceptance: ['测试全绿'],
  constraints: [],
  nonGoals: [],
  guardrails: ['不得改 Contract'],
};

const AT = '2026-01-01T00:00:00.000Z';

/** 够用的内存队列行仓储：只实现本用例会走的那几条迁移。 */
function memoryRepo(rows: QueuedHop[]): QueuedHopRepository {
  return {
    async enqueue(hop) {
      const existing = rows.find((row) => row.idempotencyKey === hop.idempotencyKey);
      if (existing) return { ...existing };
      rows.push({ ...hop });
      return { ...hop };
    },
    async get(id) {
      const row = rows.find((item) => item.id === id);
      return row ? { ...row } : undefined;
    },
    async list() {
      return rows.map((row) => ({ ...row }));
    },
    async claim(id, owner, now, until) {
      const index = rows.findIndex((row) => row.id === id);
      if (index < 0) return undefined;
      const updated = claimHop(rows[index]!, owner, now, until);
      if (updated) rows[index] = updated;
      return updated ? { ...updated } : undefined;
    },
    async renew(id, owner, generation, now, until) {
      const index = rows.findIndex((row) => row.id === id);
      if (index < 0) return undefined;
      const updated = renewHop(rows[index]!, owner, generation, now, until);
      if (updated) rows[index] = updated;
      return updated ? { ...updated } : undefined;
    },
    async complete(id, owner, generation, now) {
      const index = rows.findIndex((row) => row.id === id);
      if (index < 0) return undefined;
      const updated = completeHop(rows[index]!, owner, generation, now);
      if (updated) rows[index] = updated;
      return updated ? { ...updated } : undefined;
    },
    async reportFailure(input) {
      const index = rows.findIndex((row) => row.id === input.id);
      if (index < 0) return undefined;
      const updated = reportHopFailure(rows[index]!, input);
      if (!updated) return undefined;
      if (updated !== rows[index]) rows[index] = updated;
      return updated.lastFailure
        ? { ...updated, lastFailure: { ...updated.lastFailure } }
        : { ...updated };
    },
  };
}

describe('COM5 T3 hop time-point facts', () => {
  test('入队/首次认领/退避各落一条，renew 改 updatedAt 后 claimedAt 不变', async () => {
    const clock = new FixedClock(AT);
    const activity = new InMemoryActivityLog(clock);
    const ids = new SequentialIds();
    const platform = new Platform({
      projects: new InMemoryProjectRepository(),
      deliveries: new InMemoryDeliveryRepository(clock, ids),
      workspace: new InPlaceWorkspaceManager(),
      activity,
      clock,
      ids,
    });
    await platform.createMission({ projectId: 'P', missionId: 'M-hop', contract: CONTRACT });

    const rows: QueuedHop[] = [];
    const repo = memoryRepo(rows);
    const scheduler = new DurableScheduler(
      repo,
      clock,
      ids,
      hopCapacityLimits({ global: 8, project: 8, role: 8, runtime: 8, profile: 8 }),
    );

    const input = {
      projectId: 'P',
      missionId: 'M-hop',
      workItemId: '-',
      role: 'executor' as const,
      priority: 10,
      availableAt: clock.now().toISOString(),
      attemptCount: 0,
      maxAttempts: 3,
      idempotencyKey: 'M-hop:executor:-:r1:n0',
    };

    // enqueue：新行 → 一条 hop.enqueued。
    const hop = await scheduler.enqueue(input);
    await platform.recordHopEnqueued('M-hop', hop);

    // 幂等命中旧行（同 idempotencyKey）→ 不得第二条。
    const dup = await scheduler.enqueue(input);
    assert.equal(dup.id, hop.id, '同 idempotencyKey 应命中同一行');
    await platform.recordHopEnqueued('M-hop', dup);

    const afterEnqueue = (await platform.getActivity('M-hop')).filter(
      (e) => e.kind === 'hop.enqueued',
    );
    assert.equal(afterEnqueue.length, 1, '幂等入队不产生第二条 hop.enqueued');
    assert.deepEqual(afterEnqueue[0]!.data, {
      hopId: hop.id,
      role: 'executor',
      workItemId: '-',
      availableAt: hop.availableAt,
      enqueuedAt: hop.createdAt,
    });

    // claim：queued → claimed，记下返回行的 updatedAt 作为认领时点。
    clock.advance(30_000);
    const claimed = await scheduler.claim(hop.id, 'runner', 60_000);
    assert.ok(claimed, '应能领到刚入队的行');
    const firstClaimedAt = claimed!.updatedAt;
    await platform.recordHopClaimed('M-hop', claimed!);

    // renew 覆盖 updatedAt（且不产生新的认领事件）。
    clock.advance(30_000);
    const renewed = await scheduler.renew(hop.id, 'runner', claimed!.claimGeneration!, 60_000);
    assert.notEqual(renewed.updatedAt, firstClaimedAt, 'renew 必须真的改了 updatedAt');
    await platform.recordHopClaimed('M-hop', renewed);

    const claimedEvents = (await platform.getActivity('M-hop')).filter(
      (e) => e.kind === 'hop.claimed',
    );
    assert.equal(claimedEvents.length, 1, 'renew 不发 hop.claimed，也不得重复一条');
    assert.equal(
      (claimedEvents[0]!.data as { claimedAt: string }).claimedAt,
      firstClaimedAt,
      'renew 覆盖 updatedAt 之后，事件里的 claimedAt 仍是首次认领那刻',
    );

    // backoff：报告失败得 retry_wait → 一条 hop.backoff。
    clock.advance(30_000);
    const reported = await scheduler.reportFailure({
      id: hop.id,
      claimGeneration: renewed.claimGeneration!,
      attemptId: 'A-1',
      failedAt: clock.now().toISOString(),
      classification: 'upstream',
      disposition: 'retry_then_dead_letter',
      retryable: true,
    });
    assert.equal(reported.status, 'retry_wait');
    await platform.recordHopBackoff('M-hop', reported);
    // 幂等重放同一失败（同 lastFailure.at + attemptCount）不得第二条。
    await platform.recordHopBackoff('M-hop', reported);

    const backoffEvents = (await platform.getActivity('M-hop')).filter(
      (e) => e.kind === 'hop.backoff',
    );
    assert.equal(backoffEvents.length, 1, '同一失败重放不产生第二条 hop.backoff');
    assert.deepEqual(backoffEvents[0]!.data, {
      hopId: hop.id,
      failedAt: reported.lastFailure!.at,
      availableAt: reported.availableAt,
      attemptCount: reported.attemptCount,
    });
    // 事件 at 是落盘时钟（本次写入时刻），不是 failedAt 那种发生时点。
    assert.equal(backoffEvents[0]!.at, clock.now().toISOString());
  });
});
