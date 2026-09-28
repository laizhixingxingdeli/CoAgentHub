import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DurableScheduler,
  canClaimHop,
  claimHop,
  cloneQueuedHop,
  completeHop,
  decideCapacityClaim,
  hopCapacityLimits,
  hopFailureBackoffMs,
  HOP_FAILURE_BACKOFF_CAP_MS,
  nextLogicalHopCycle,
  renewHop,
  reportHopFailure,
  validateReportHopFailure,
  type EligibleHopClaim,
  type QueuedHop,
  type ReportHopFailureInput,
} from '../src/application/durable-scheduler.ts';
import type { QueuedHopRepository } from '../src/application/ports.ts';

const now = '2025-01-01T00:00:00.000Z';
const leaseUntil = '2025-01-01T00:01:00.000Z';
const failedAt = '2025-01-01T00:00:30.000Z';

function hop(overrides: Partial<QueuedHop> = {}): QueuedHop {
  return {
    id: 'h1',
    projectId: 'p',
    missionId: 'm',
    workItemId: 'w',
    role: 'executor',
    priority: 1,
    availableAt: now,
    attemptCount: 0,
    maxAttempts: 2,
    idempotencyKey: 'm:executor:w:r1:n0',
    status: 'claimed',
    owner: 'runner',
    leaseUntil,
    claimGeneration: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function report(overrides: Partial<ReportHopFailureInput> = {}): ReportHopFailureInput {
  return {
    id: 'h1',
    claimGeneration: 1,
    attemptId: 'A-1',
    failedAt,
    classification: 'upstream_5xx',
    disposition: 'retry_then_dead_letter',
    retryable: true,
    ...overrides,
  };
}

function eligible(ids: readonly string[]): EligibleHopClaim[] {
  return ids.map((hopId) => ({ hopId, runtimeKind: 'pi', profileId: 'qwen' }));
}

function memoryRepo(rows: QueuedHop[]): QueuedHopRepository {
  const put = (row: QueuedHop) => {
    const index = rows.findIndex((item) => item.id === row.id);
    if (index >= 0) rows[index] = row;
    else rows.push(row);
  };
  return {
    async enqueue(row) {
      const existing = rows.find((item) => item.idempotencyKey === row.idempotencyKey);
      if (existing) return cloneQueuedHop(existing);
      rows.push(row);
      return cloneQueuedHop(row);
    },
    async get(id) {
      const row = rows.find((item) => item.id === id);
      return row ? cloneQueuedHop(row) : undefined;
    },
    async list() {
      return rows.map((row) => cloneQueuedHop(row));
    },
    async claim(id, owner, clock, until) {
      const index = rows.findIndex((item) => item.id === id);
      if (index < 0) return undefined;
      const updated = claimHop(rows[index]!, owner, clock, until);
      if (updated) rows[index] = updated;
      return updated ? cloneQueuedHop(updated) : undefined;
    },
    async renew(id, owner, generation, clock, until) {
      const index = rows.findIndex((item) => item.id === id);
      if (index < 0) return undefined;
      const updated = renewHop(rows[index]!, owner, generation, clock, until);
      if (updated) rows[index] = updated;
      return updated ? cloneQueuedHop(updated) : undefined;
    },
    async complete(id, owner, generation, clock) {
      const index = rows.findIndex((item) => item.id === id);
      if (index < 0) return undefined;
      const updated = completeHop(rows[index]!, owner, generation, clock);
      if (updated) rows[index] = updated;
      return updated ? cloneQueuedHop(updated) : undefined;
    },
    async reportFailure(input) {
      const index = rows.findIndex((item) => item.id === input.id);
      if (index < 0) return undefined;
      const current = rows[index]!;
      const updated = reportHopFailure(current, input);
      if (!updated) return undefined;
      if (updated !== current) rows[index] = updated;
      return cloneQueuedHop(updated);
    },
  };
}

test('backoff is deterministic, capped, and strictly later than the failure instant', () => {
  assert.equal(hopFailureBackoffMs(1), 1_000);
  assert.equal(hopFailureBackoffMs(2), 2_000);
  assert.equal(hopFailureBackoffMs(10), 512_000);
  assert.equal(hopFailureBackoffMs(11), HOP_FAILURE_BACKOFF_CAP_MS);
  assert.equal(hopFailureBackoffMs(99), HOP_FAILURE_BACKOFF_CAP_MS);
  assert.throws(() => hopFailureBackoffMs(0));
  const first = reportHopFailure(hop(), report())!;
  assert.equal(first.status, 'retry_wait');
  assert.ok(Date.parse(first.availableAt) > Date.parse(failedAt));
  assert.equal(Date.parse(first.availableAt), Date.parse(failedAt) + hopFailureBackoffMs(1));
});

test('caller cannot choose attemptCount, availableAt, or maxAttempts on a failure report', () => {
  assert.throws(() => validateReportHopFailure({ ...report(), attemptCount: 9 }), /cannot be set/);
  assert.throws(() => validateReportHopFailure({ ...report(), availableAt: now }), /cannot be set/);
  assert.throws(() => validateReportHopFailure({ ...report(), maxAttempts: 99 }), /cannot be set/);
  assert.throws(() => reportHopFailure(hop(), { ...report(), attemptCount: 9 } as ReportHopFailureInput));
});

test('first retryable failure waits; due claim raises generation; second valid failure dead-letters', () => {
  const first = reportHopFailure(hop(), report())!;
  assert.equal(first.status, 'retry_wait');
  assert.equal(first.attemptCount, 1);
  assert.equal(first.owner, undefined);
  assert.equal(first.leaseUntil, undefined);
  assert.equal(canClaimHop(first, failedAt), false);
  assert.equal(canClaimHop(first, first.availableAt), true);
  const limits = hopCapacityLimits({ global: 8, project: 8, role: 8, runtime: 8, profile: 8 });
  const delayed = decideCapacityClaim([first], failedAt, limits, eligible(['h1']));
  assert.equal(delayed.kind, 'waiting');
  if (delayed.kind !== 'waiting') throw new Error('expected waiting');
  assert.equal(delayed.wait, 'available_at');
  const reclaimed = claimHop(first, 'runner', first.availableAt, '2025-01-01T00:02:00.000Z');
  assert.equal(reclaimed?.claimGeneration, 2);
  assert.equal(reclaimed?.status, 'claimed');
  const second = reportHopFailure(reclaimed!, report({ claimGeneration: 2, attemptId: 'A-2', failedAt: first.availableAt }))!;
  assert.equal(second.status, 'dead_letter');
  assert.equal(second.attemptCount, 2);
  assert.equal(canClaimHop(second, first.availableAt), false);
  assert.equal(canClaimHop(second, '2099-01-01T00:00:00.000Z'), false);
  assert.equal(decideCapacityClaim([second], first.availableAt, limits, eligible(['h1'])).kind, 'empty');
});

test('same triple replay and stale generation leave the row identity-equal', () => {
  const original = hop();
  const first = reportHopFailure(original, report())!;
  const replay = reportHopFailure(first, report());
  assert.equal(replay, first);
  const stale = reportHopFailure(first, report({ claimGeneration: 0, attemptId: 'A-late' }));
  assert.equal(stale, undefined);
  const otherAttempt = reportHopFailure(first, report({ attemptId: 'A-2' }));
  assert.equal(otherAttempt, undefined);
  assert.equal(first.status, 'retry_wait');
  assert.equal(first.attemptCount, 1);
  assert.equal(first.lastFailure?.attemptId, 'A-1');
});

test('non-retryable rule failure dead-letters immediately without scheduling a retry', () => {
  const dead = reportHopFailure(hop(), report({ retryable: false, classification: 'rule', disposition: 'do_not_retry' }))!;
  assert.equal(dead.status, 'dead_letter');
  assert.equal(dead.attemptCount, 1);
  assert.equal(dead.availableAt, now);
  assert.equal(canClaimHop(dead, failedAt), false);
  assert.deepEqual(dead.lastFailure, {
    attemptId: 'A-1',
    claimGeneration: 1,
    at: failedAt,
    classification: 'rule',
    disposition: 'do_not_retry',
    retryable: false,
  });
});

test('single-id and capacity claim skip dead letters; retry_wait reuses the logical slot', () => {
  const waiting = reportHopFailure(hop(), report())!;
  const dead = reportHopFailure(hop({ id: 'h-dead', idempotencyKey: 'm:executor:w:r1:n0' }), report({
    id: 'h-dead', retryable: false,
  }))!;
  assert.equal(canClaimHop(waiting, failedAt), false);
  assert.equal(canClaimHop(dead, now), false);
  const slot = { missionId: 'm', role: 'executor' as const, workItemId: 'w', contractRevision: 1 };
  assert.equal(nextLogicalHopCycle([waiting], slot), 0);
  assert.equal(nextLogicalHopCycle([dead], slot), 0);
  assert.equal(nextLogicalHopCycle([{ ...waiting, status: 'completed' }], slot), 1);
  const limits = hopCapacityLimits({ global: 1, project: 1, role: 1, runtime: 1, profile: 1 });
  const ready = hop({ id: 'h2', status: 'queued', owner: undefined, leaseUntil: undefined, claimGeneration: undefined });
  assert.equal(decideCapacityClaim([dead, ready], now, limits, eligible(['h-dead', 'h2'])).kind, 'select');
  const selected = decideCapacityClaim([dead, ready], now, limits, eligible(['h-dead', 'h2']));
  if (selected.kind !== 'select') throw new Error('expected select');
  assert.equal(selected.hop.id, 'h2');
});

test('DurableScheduler.reportFailure persists through the repository and rejects an unconfigured adapter', async () => {
  const rows: QueuedHop[] = [hop()];
  const scheduler = new DurableScheduler(
    memoryRepo(rows),
    { now: () => new Date(now) },
    { next: () => 'unused' },
  );
  const updated = await scheduler.reportFailure(report());
  assert.equal(updated.status, 'retry_wait');
  assert.equal(updated.attemptCount, 1);
  assert.equal(rows[0]?.status, 'retry_wait');
  const again = await scheduler.reportFailure(report());
  assert.equal(again.attemptCount, 1);
  assert.equal(again.availableAt, updated.availableAt);
  await assert.rejects(scheduler.reportFailure(report({ claimGeneration: 9, attemptId: 'A-stale' })), /cannot be reported/);
  const plain: QueuedHopRepository = {
    async enqueue(row) { return row; },
    async get() { return undefined; },
    async list() { return []; },
    async claim() { return undefined; },
    async renew() { return undefined; },
    async complete() { return undefined; },
  };
  const unsupported = new DurableScheduler(plain, { now: () => new Date(now) }, { next: () => 'x' });
  await assert.rejects(unsupported.reportFailure(report()), /does not support failure reporting/);
});
