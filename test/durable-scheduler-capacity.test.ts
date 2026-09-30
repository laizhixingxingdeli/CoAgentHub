import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DurableScheduler,
  claimHop,
  claimHopWithCandidate,
  compareHopFairness,
  decideCapacityClaim,
  DEFAULT_HOP_CAPACITY_LIMITS,
  hopCapacityLimits,
  hopFitsCapacity,
  isActiveHopLease,
  queuedHopWaitDetail,
  renewHop,
  completeHop,
  validateEligibleHopClaims,
  validateHopCapacityLimits,
  type EligibleHopClaim,
  type HopCapacityCandidate,
  type HopCapacityLimits,
  type QueuedHop,
} from '../src/application/durable-scheduler.ts';
import type { QueuedHopCapacityRepository, QueuedHopRepository } from '../src/application/ports.ts';
import { FileQueuedHopRepository, FileStateStore } from '../src/application/file-store.ts';

const now = '2025-01-01T00:00:00.000Z';
const later = '2025-01-01T00:01:00.000Z';
const candidate: HopCapacityCandidate = { runtimeKind: 'pi', profileId: 'qwen' };

function hop(overrides: Partial<QueuedHop> & Pick<QueuedHop, 'id'>): QueuedHop {
  return {
    projectId: 'p',
    missionId: 'm',
    workItemId: 'w',
    role: 'executor',
    priority: 1,
    availableAt: now,
    attemptCount: 0,
    maxAttempts: 3,
    idempotencyKey: overrides.id,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function active(id: string, extra: Partial<QueuedHop> = {}): QueuedHop {
  return hop({
    id,
    status: 'claimed',
    owner: 'holder',
    leaseUntil: later,
    claimGeneration: 1,
    runtimeKind: 'pi',
    profileId: 'qwen',
    ...extra,
  });
}

function limits(overrides: Partial<HopCapacityLimits> = {}): HopCapacityLimits {
  return hopCapacityLimits({ global: 8, project: 8, role: 8, runtime: 8, profile: 8, ...overrides });
}

function eligible(ids: readonly string[], cand: HopCapacityCandidate = candidate): EligibleHopClaim[] {
  return ids.map((hopId) => ({ hopId, runtimeKind: cand.runtimeKind, profileId: cand.profileId }));
}

function memoryCapacityRepo(rows: QueuedHop[]): QueuedHopCapacityRepository {
  const byId = () => rows;
  return {
    async enqueue(row) { rows.push(row); return row; },
    async get(id) { return byId().find((row) => row.id === id); },
    async list() { return [...byId()]; },
    async claim(id, owner, clock, until) {
      const index = rows.findIndex((row) => row.id === id);
      if (index < 0) return undefined;
      const updated = claimHop(rows[index]!, owner, clock, until);
      if (updated) rows[index] = updated;
      return updated;
    },
    async renew(id, owner, generation, clock, until) {
      const index = rows.findIndex((row) => row.id === id);
      if (index < 0) return undefined;
      const updated = renewHop(rows[index]!, owner, generation, clock, until);
      if (updated) rows[index] = updated;
      return updated;
    },
    async complete(id, owner, generation, clock) {
      const index = rows.findIndex((row) => row.id === id);
      if (index < 0) return undefined;
      const updated = completeHop(rows[index]!, owner, generation, clock);
      if (updated) rows[index] = updated;
      return updated;
    },
    async claimAvailable(input) {
      const decision = decideCapacityClaim(rows, input.now, input.limits, input.eligible);
      if (decision.kind !== 'select') return decision;
      const updated = claimHopWithCandidate(decision.hop, input.owner, input.now, input.leaseUntil, decision.candidate);
      if (!updated) return { kind: 'empty' };
      const index = rows.findIndex((row) => row.id === updated.id);
      if (index >= 0) rows[index] = updated;
      return { kind: 'claimed', hop: updated };
    },
  };
}

test('five-dimension defaults are explicit positive safe integers and validate before storage', () => {
  assert.deepEqual(DEFAULT_HOP_CAPACITY_LIMITS, { global: 8, project: 2, role: 4, runtime: 4, profile: 2 });
  assert.deepEqual(hopCapacityLimits(), DEFAULT_HOP_CAPACITY_LIMITS);
  assert.deepEqual(hopCapacityLimits({ global: 1, project: 1, role: 1, runtime: 1, profile: Number.MAX_SAFE_INTEGER }), {
    global: 1, project: 1, role: 1, runtime: 1, profile: Number.MAX_SAFE_INTEGER,
  });
  const invalid = [Number.NaN, Infinity, -Infinity, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, undefined, null, '2', true];
  for (const dim of ['global', 'project', 'role', 'runtime', 'profile'] as const) {
    for (const value of invalid) {
      assert.throws(() => validateHopCapacityLimits({ ...DEFAULT_HOP_CAPACITY_LIMITS, [dim]: value }), /positive safe integer/);
    }
  }
  assert.throws(() => validateHopCapacityLimits(null));
  assert.throws(() => validateHopCapacityLimits([8, 2, 4, 4, 2]));
  let enqueued = 0;
  const repo: QueuedHopRepository = {
    async enqueue() { enqueued += 1; throw new Error('unreachable'); },
    async get() { return undefined; },
    async list() { return []; },
    async claim() { return undefined; },
    async renew() { return undefined; },
    async complete() { return undefined; },
  };
  assert.throws(
    () => new DurableScheduler(repo, { now: () => new Date(now) }, { next: () => 'HOP-1' }, { ...DEFAULT_HOP_CAPACITY_LIMITS, global: 0 }),
    /positive safe integer/,
  );
  assert.equal(enqueued, 0);
});

test('active leases are claimed with leaseUntil strictly after the clock', () => {
  const live = active('a');
  assert.equal(isActiveHopLease(live, now), true);
  assert.equal(isActiveHopLease({ ...live, leaseUntil: now }, now), false);
  assert.equal(isActiveHopLease({ ...live, leaseUntil: '2024-12-31T23:59:59.000Z' }, now), false);
  assert.equal(isActiveHopLease(hop({ id: 'q' }), now), false);
  assert.equal(isActiveHopLease({ ...live, status: 'completed' }, now), false);
});

test('shared judgment covers five-dimension occupancy and expired-lease release', () => {
  const ready = hop({ id: 'next' });
  const cap = limits({ global: 1, project: 1, role: 1, runtime: 1, profile: 1 });
  assert.equal(hopFitsCapacity([active('g')], ready, now, limits({ global: 1 }), candidate), false);
  assert.equal(hopFitsCapacity([active('p', { projectId: 'p' })], hop({ id: 'next', projectId: 'p' }), now, limits({ project: 1 }), candidate), false);
  assert.equal(hopFitsCapacity([active('p', { projectId: 'p' })], hop({ id: 'next', projectId: 'other' }), now, limits({ project: 1 }), candidate), true);
  assert.equal(hopFitsCapacity([active('r', { role: 'executor' })], hop({ id: 'next', role: 'executor' }), now, limits({ role: 1 }), candidate), false);
  assert.equal(hopFitsCapacity([active('r', { role: 'executor' })], hop({ id: 'next', role: 'coordinator' }), now, limits({ role: 1 }), candidate), true);
  assert.equal(hopFitsCapacity([active('rt')], ready, now, limits({ runtime: 1 }), candidate), false);
  assert.equal(hopFitsCapacity([active('rt')], ready, now, limits({ runtime: 1 }), { runtimeKind: 'spawn', profileId: 'qwen' }), true);
  assert.equal(hopFitsCapacity([active('pr')], ready, now, limits({ profile: 1 }), candidate), false);
  assert.equal(hopFitsCapacity([active('pr')], ready, now, limits({ profile: 1 }), { runtimeKind: 'pi', profileId: 'other' }), true);
  const legacy = active('legacy');
  delete (legacy as { runtimeKind?: string }).runtimeKind;
  delete (legacy as { profileId?: string }).profileId;
  assert.equal(hopFitsCapacity([legacy], ready, now, limits({ runtime: 1, profile: 1 }), candidate), true);
  assert.equal(hopFitsCapacity([legacy], ready, now, limits({ global: 1 }), candidate), false);
  const expired = active('old', { leaseUntil: now });
  assert.equal(hopFitsCapacity([expired], hop({ id: 'next', projectId: 'p' }), now, cap, candidate), true);
  assert.equal(decideCapacityClaim([expired, ready], now, cap, eligible(['next'])).kind, 'select');
});

test('fair order is priority then createdAt FIFO then stable id, skipping capacity-blocked hops', () => {
  const lowEarly = hop({ id: 'b', priority: 1, createdAt: '2025-01-01T00:00:00.000Z', projectId: 'free' });
  const highLate = hop({ id: 'a', priority: 9, createdAt: '2025-01-01T00:00:10.000Z', projectId: 'full' });
  const sameTimeLeft = hop({ id: 'c', priority: 1, createdAt: lowEarly.createdAt, projectId: 'free' });
  assert.ok(compareHopFairness(highLate, lowEarly) < 0);
  assert.ok(compareHopFairness(lowEarly, sameTimeLeft) < 0);
  const occupying = active('hold', { projectId: 'full' });
  const snapshot = [lowEarly, highLate, occupying];
  const before = JSON.stringify(snapshot);
  const decided = decideCapacityClaim(snapshot, now, limits({ project: 1 }), eligible(['a', 'b']));
  assert.equal(JSON.stringify(snapshot), before);
  assert.equal(decided.kind, 'select');
  if (decided.kind !== 'select') throw new Error('expected select');
  assert.equal(decided.hop.id, 'b');
  assert.equal(decided.candidate.runtimeKind, 'pi');
  assert.equal(highLate.status, 'queued');
  const blocked = decideCapacityClaim([highLate, occupying], now, limits({ project: 1 }), eligible(['a']));
  assert.deepEqual(blocked, { kind: 'waiting', hop: highLate, wait: 'capacity' });
  const leased = active('live');
  assert.equal(decideCapacityClaim([leased], now, limits(), eligible(['live'])).wait, 'lease');
  const delayed = hop({ id: 'later', availableAt: later });
  assert.equal(decideCapacityClaim([delayed], now, limits(), eligible(['later'])).wait, 'available_at');
  assert.equal(queuedHopWaitDetail({ kind: 'waiting', hop: highLate, wait: 'capacity' }).includes('容量'), true);
  assert.equal(queuedHopWaitDetail({ kind: 'waiting', hop: leased, wait: 'lease' }).includes('租约'), true);
  assert.notEqual(
    queuedHopWaitDetail({ kind: 'waiting', hop: highLate, wait: 'capacity' }),
    queuedHopWaitDetail({ kind: 'waiting', hop: leased, wait: 'lease' }),
  );
});

test('capacity repository contract claims with candidate identity and keeps single-id claim/renew/complete', async () => {
  const rows = [hop({ id: 'h1' }), hop({ id: 'h2', priority: 0, projectId: 'p2' })];
  const repo = memoryCapacityRepo(rows);
  const claimed = await repo.claimAvailable({
    owner: 'runner', now, leaseUntil: later, limits: limits({ project: 1 }), eligible: eligible(['h1', 'h2']),
  });
  assert.equal(claimed.kind, 'claimed');
  if (claimed.kind !== 'claimed') throw new Error('expected claimed');
  assert.equal(claimed.hop.id, 'h1');
  assert.equal(claimed.hop.runtimeKind, 'pi');
  assert.equal(claimed.hop.profileId, 'qwen');
  assert.equal(claimed.hop.status, 'claimed');
  assert.equal(rows.find((row) => row.id === 'h2')?.status, 'queued');
  const blocked = await repo.claimAvailable({
    owner: 'runner', now, leaseUntil: later, limits: limits({ global: 1 }), eligible: eligible(['h1', 'h2']),
  });
  assert.equal(blocked.kind, 'waiting');
  if (blocked.kind !== 'waiting') throw new Error('expected waiting');
  assert.equal(blocked.wait, 'capacity');
  assert.equal(rows.find((row) => row.id === 'h2')?.status, 'queued');
  const byId = await repo.claim('h2', 'other', now, later);
  assert.equal(byId?.status, 'claimed');
  const renewed = await repo.renew('h2', 'other', 1, now, '2025-01-01T00:02:00.000Z');
  assert.equal(renewed?.leaseUntil, '2025-01-01T00:02:00.000Z');
  const finished = await repo.complete('h2', 'other', 1, now);
  assert.equal(finished?.status, 'completed');
  const oldPort: QueuedHopRepository = repo;
  assert.equal(typeof oldPort.claim, 'function');
  const newPort: QueuedHopCapacityRepository = repo;
  assert.equal(typeof newPort.claimAvailable, 'function');
});

test('scheduler capacity entry uses durable decision; unconfigured single-id claim stays compatible', async () => {
  const rows: QueuedHop[] = [];
  const repo = memoryCapacityRepo(rows);
  const clock = { now: () => new Date(now) };
  const scheduler = new DurableScheduler(repo, clock, { next: () => `HOP-${rows.length + 1}` }, limits({ global: 1 }));
  const input = {
    projectId: 'p', missionId: 'm', workItemId: 'w', role: 'executor' as const, priority: 1,
    availableAt: now, attemptCount: 0, maxAttempts: 3, idempotencyKey: 'k1',
  };
  const queued = await scheduler.enqueue(input);
  const first = await scheduler.claimAvailable('runner', 60_000, eligible([queued.id]));
  assert.equal(first.kind, 'claimed');
  if (first.kind !== 'claimed') throw new Error('expected claimed');
  assert.equal(first.hop.runtimeKind, 'pi');
  const queued2 = await scheduler.enqueue({ ...input, idempotencyKey: 'k2' });
  const waiting = await scheduler.claimAvailable('runner', 60_000, eligible([queued2.id]));
  assert.equal(waiting.kind, 'waiting');
  if (waiting.kind !== 'waiting') throw new Error('expected waiting');
  assert.equal(waiting.wait, 'capacity');
  const unconfigured = new DurableScheduler(repo, clock, { next: () => 'unused' });
  const overLimit = hop({ id: 'legacy-claim', idempotencyKey: 'k3' });
  rows.push(overLimit);
  const still = await unconfigured.claim('legacy-claim', 'owner', 1000);
  assert.equal(still?.status, 'claimed');
  assert.equal(still?.runtimeKind, undefined);
  const plain: QueuedHopRepository = {
    async enqueue(row) { rows.push(row); return row; },
    async get(id) { return rows.find((row) => row.id === id); },
    async list() { return rows; },
    async claim() { return undefined; },
    async renew() { return undefined; },
    async complete() { return undefined; },
  };
  const withoutCapacity = new DurableScheduler(plain, clock, { next: () => 'x' });
  await assert.rejects(withoutCapacity.claimAvailable('runner', 1000, eligible(['x'])), /does not support capacity claim/);
});

test('A blocked by runtime/profile stays queued unlabeled; B with another candidate claims; unrelated mission hop is not selected', async () => {
  const occupying = active('hold', { missionId: 'm-hold', runtimeKind: 'pi', profileId: 'qwen' });
  const hopA = hop({ id: 'A', missionId: 'm-a', priority: 9, createdAt: '2025-01-01T00:00:00.000Z' });
  const hopB = hop({ id: 'B', missionId: 'm-b', priority: 1, createdAt: '2025-01-01T00:00:10.000Z' });
  const hopUnrelated = hop({ id: 'C', missionId: 'm-c', priority: 99, createdAt: '2024-12-01T00:00:00.000Z' });
  const snapshot = [occupying, hopA, hopB, hopUnrelated];
  const cap = limits({ runtime: 1, profile: 1 });
  const identities: EligibleHopClaim[] = [
    { hopId: 'A', runtimeKind: 'pi', profileId: 'qwen' },
    { hopId: 'B', runtimeKind: 'spawn', profileId: 'other' },
  ];
  const decided = decideCapacityClaim(snapshot, now, cap, identities);
  assert.equal(decided.kind, 'select');
  if (decided.kind !== 'select') throw new Error('expected select');
  assert.equal(decided.hop.id, 'B');
  assert.equal(decided.hop.missionId, 'm-b');
  assert.deepEqual(decided.candidate, { runtimeKind: 'spawn', profileId: 'other' });
  assert.equal(hopA.status, 'queued');
  assert.equal(hopA.runtimeKind, undefined);
  assert.equal(hopA.profileId, undefined);

  const onlyA = decideCapacityClaim(snapshot, now, cap, [{ hopId: 'A', runtimeKind: 'pi', profileId: 'qwen' }]);
  assert.deepEqual(onlyA, { kind: 'waiting', hop: hopA, wait: 'capacity' });

  const freeA = hop({ id: 'A2', missionId: 'm-a', priority: 1 });
  const highOther = hop({ id: 'C2', missionId: 'm-c', priority: 99, createdAt: '2024-01-01T00:00:00.000Z' });
  const requested = decideCapacityClaim([freeA, highOther], now, limits(), eligible(['A2']));
  assert.equal(requested.kind, 'select');
  if (requested.kind !== 'select') throw new Error('expected select');
  assert.equal(requested.hop.id, 'A2');
  assert.equal(requested.hop.missionId, 'm-a');
  assert.notEqual(requested.hop.id, 'C2');

  assert.throws(
    () => validateEligibleHopClaims([
      { hopId: 'A', runtimeKind: 'pi', profileId: 'qwen' },
      { hopId: 'A', runtimeKind: 'spawn', profileId: 'other' },
    ]),
    /duplicated/,
  );
  assert.throws(() => validateEligibleHopClaims({ hopId: 'A', runtimeKind: 'pi', profileId: 'qwen' }), /array/);

  const rows = [occupying, hopA, hopB, hopUnrelated];
  const repo = memoryCapacityRepo(rows);
  const claimed = await repo.claimAvailable({
    owner: 'runner', now, leaseUntil: later, limits: cap, eligible: identities,
  });
  assert.equal(claimed.kind, 'claimed');
  if (claimed.kind !== 'claimed') throw new Error('expected claimed');
  assert.equal(claimed.hop.id, 'B');
  assert.equal(claimed.hop.missionId, 'm-b');
  assert.equal(claimed.hop.runtimeKind, 'spawn');
  assert.equal(claimed.hop.profileId, 'other');
  const stillA = rows.find((row) => row.id === 'A');
  assert.equal(stillA?.status, 'queued');
  assert.equal(stillA?.missionId, 'm-a');
  assert.equal(stillA?.runtimeKind, undefined);
  assert.equal(stillA?.profileId, undefined);
  assert.equal(rows.find((row) => row.id === 'C')?.status, 'queued');
  assert.equal(rows.find((row) => row.id === 'C')?.runtimeKind, undefined);

  const againA = await repo.claimAvailable({
    owner: 'runner', now, leaseUntil: later, limits: cap,
    eligible: [{ hopId: 'A', runtimeKind: 'pi', profileId: 'qwen' }],
  });
  assert.equal(againA.kind, 'waiting');
  if (againA.kind !== 'waiting') throw new Error('expected waiting');
  assert.equal(againA.wait, 'capacity');
  assert.equal(againA.hop.id, 'A');
  assert.equal(rows.find((row) => row.id === 'A')?.status, 'queued');
  assert.equal(rows.find((row) => row.id === 'C')?.status, 'queued');
});

function fileQueueRepo(dir: string): { path: string; store: FileStateStore; repo: FileQueuedHopRepository } {
  const path = join(dir, 'state.json');
  const store = new FileStateStore(path);
  return { path, store, repo: new FileQueuedHopRepository(store) };
}

test('file claimAvailable selects in one transaction by eligible, occupancy and fairness; waiters stay queued', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'queued-capacity-tx-'));
  try {
    const { repo } = fileQueueRepo(dir);
    const empty = await repo.claimAvailable({
      owner: 'runner', now, leaseUntil: later, limits: limits(), eligible: eligible(['missing']),
    });
    assert.equal(empty.kind, 'empty');
    assert.deepEqual(await repo.list(), []);

    await repo.enqueue(hop({ id: 'low', priority: 1, createdAt: '2025-01-01T00:00:00.000Z', projectId: 'free' }));
    await repo.enqueue(hop({ id: 'high-full', priority: 9, createdAt: '2025-01-01T00:00:10.000Z', projectId: 'full' }));
    await repo.enqueue(hop({ id: 'hold', projectId: 'full' }));
    await repo.enqueue(hop({ id: 'unrelated', missionId: 'other', priority: 99, createdAt: '2024-01-01T00:00:00.000Z' }));
    const occupied = await repo.claimAvailable({
      owner: 'holder', now, leaseUntil: later, limits: limits(), eligible: eligible(['hold']),
    });
    assert.equal(occupied.kind, 'claimed');

    const claimed = await repo.claimAvailable({
      owner: 'runner', now, leaseUntil: later, limits: limits({ project: 1 }),
      eligible: eligible(['low', 'high-full']),
    });
    assert.equal(claimed.kind, 'claimed');
    if (claimed.kind !== 'claimed') throw new Error('expected claimed');
    assert.equal(claimed.hop.id, 'low');
    assert.equal(claimed.hop.runtimeKind, 'pi');
    assert.equal(claimed.hop.profileId, 'qwen');
    assert.equal(claimed.hop.status, 'claimed');
    const blocked = await repo.get('high-full');
    assert.equal(blocked?.status, 'queued');
    assert.equal(blocked?.runtimeKind, undefined);
    assert.equal(blocked?.profileId, undefined);
    assert.equal((await repo.get('unrelated'))?.status, 'queued');

    const waiting = await repo.claimAvailable({
      owner: 'runner', now, leaseUntil: later, limits: limits({ project: 1 }),
      eligible: eligible(['high-full']),
    });
    assert.equal(waiting.kind, 'waiting');
    if (waiting.kind !== 'waiting') throw new Error('expected waiting');
    assert.equal(waiting.wait, 'capacity');
    assert.equal(waiting.hop.id, 'high-full');
    const afterWait = await repo.get('high-full');
    assert.equal(afterWait?.status, 'queued');
    assert.equal(afterWait?.runtimeKind, undefined);
    assert.equal((await repo.get('unrelated'))?.status, 'queued');

    const byId = await repo.claim('unrelated', 'other', now, later);
    assert.equal(byId?.status, 'claimed');
    assert.equal(byId?.runtimeKind, undefined);
    const renewed = await repo.renew('unrelated', 'other', 1, now, '2025-01-01T00:02:00.000Z');
    assert.equal(renewed?.leaseUntil, '2025-01-01T00:02:00.000Z');
    const finished = await repo.complete('unrelated', 'other', 1, now);
    assert.equal(finished?.status, 'completed');
    const asOld: QueuedHopRepository = repo;
    assert.equal(typeof asOld.claim, 'function');
    const asNew: QueuedHopCapacityRepository = repo;
    assert.equal(typeof asNew.claimAvailable, 'function');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('file occupancy survives reopen; complete or expired leases free a slot; concurrent claims take at most one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'queued-capacity-reopen-'));
  try {
    const { path, repo } = fileQueueRepo(dir);
    await repo.enqueue(hop({ id: 'first' }));
    await repo.enqueue(hop({ id: 'second', createdAt: '2025-01-01T00:00:01.000Z' }));
    const first = await repo.claimAvailable({
      owner: 'runner', now, leaseUntil: later, limits: limits({ global: 1 }), eligible: eligible(['first', 'second']),
    });
    assert.equal(first.kind, 'claimed');
    if (first.kind !== 'claimed') throw new Error('expected claimed');
    assert.equal(first.hop.id, 'first');

    const reopened = new FileQueuedHopRepository(new FileStateStore(path));
    const stillHeld = await reopened.claimAvailable({
      owner: 'other', now, leaseUntil: later, limits: limits({ global: 1 }), eligible: eligible(['first', 'second']),
    });
    assert.equal(stillHeld.kind, 'waiting');
    if (stillHeld.kind !== 'waiting') throw new Error('expected waiting');
    assert.equal(stillHeld.wait, 'capacity');
    assert.equal((await reopened.get('second'))?.status, 'queued');
    assert.equal((await reopened.get('first'))?.runtimeKind, 'pi');

    const afterExpire = await reopened.claimAvailable({
      owner: 'other', now: later, leaseUntil: '2025-01-01T00:02:00.000Z', limits: limits({ global: 1 }),
      eligible: eligible(['first', 'second']),
    });
    assert.equal(afterExpire.kind, 'claimed');
    if (afterExpire.kind !== 'claimed') throw new Error('expected claimed');
    assert.equal(afterExpire.hop.id, 'first');
    assert.equal(afterExpire.hop.claimGeneration, 2);
    await reopened.complete('first', 'other', 2, later);

    const afterComplete = await reopened.claimAvailable({
      owner: 'next', now: later, leaseUntil: '2025-01-01T00:03:00.000Z', limits: limits({ global: 1 }),
      eligible: eligible(['second']),
    });
    assert.equal(afterComplete.kind, 'claimed');
    if (afterComplete.kind !== 'claimed') throw new Error('expected claimed');
    assert.equal(afterComplete.hop.id, 'second');
    await reopened.complete('second', 'next', 1, later);

    await reopened.enqueue(hop({ id: 'race-a', idempotencyKey: 'race-a' }));
    await reopened.enqueue(hop({ id: 'race-b', idempotencyKey: 'race-b', createdAt: '2025-01-01T00:00:01.000Z' }));
    const raced = await Promise.all([
      reopened.claimAvailable({
        owner: 'a', now, leaseUntil: later, limits: limits({ global: 1 }), eligible: eligible(['race-a', 'race-b']),
      }),
      reopened.claimAvailable({
        owner: 'b', now, leaseUntil: later, limits: limits({ global: 1 }), eligible: eligible(['race-a', 'race-b']),
      }),
    ]);
    assert.equal(raced.filter((row) => row.kind === 'claimed').length, 1);
    assert.equal(raced.filter((row) => row.kind === 'waiting').length, 1);
    const claimedIds = raced.filter((row) => row.kind === 'claimed').map((row) => row.kind === 'claimed' ? row.hop.id : '');
    assert.equal(claimedIds.length, 1);
    const claimedId = claimedIds[0]!;
    const otherId = claimedId === 'race-a' ? 'race-b' : 'race-a';
    assert.equal((await reopened.get(otherId))?.status, 'queued');
    assert.equal((await reopened.get(claimedId))?.status, 'claimed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('file claimAvailable five-dimension skip, FIFO, high priority, A/B candidate identity, and old snapshots', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'queued-capacity-dims-'));
  try {
    const { path, repo } = fileQueueRepo(dir);
    await repo.enqueue(hop({ id: 'hold-rt' }));
    const occupiedRt = await repo.claimAvailable({
      owner: 'holder', now, leaseUntil: later, limits: limits(), eligible: eligible(['hold-rt']),
    });
    assert.equal(occupiedRt.kind, 'claimed');
    await repo.enqueue(hop({ id: 'A', missionId: 'm-a', priority: 9, createdAt: '2025-01-01T00:00:00.000Z' }));
    await repo.enqueue(hop({ id: 'B', missionId: 'm-b', priority: 1, createdAt: '2025-01-01T00:00:10.000Z' }));
    await repo.enqueue(hop({ id: 'C', missionId: 'm-c', priority: 99, createdAt: '2024-12-01T00:00:00.000Z' }));

    const identities: EligibleHopClaim[] = [
      { hopId: 'A', runtimeKind: 'pi', profileId: 'qwen' },
      { hopId: 'B', runtimeKind: 'spawn', profileId: 'other' },
    ];
    const claimedB = await repo.claimAvailable({
      owner: 'runner', now, leaseUntil: later, limits: limits({ runtime: 1, profile: 1 }), eligible: identities,
    });
    assert.equal(claimedB.kind, 'claimed');
    if (claimedB.kind !== 'claimed') throw new Error('expected claimed');
    assert.equal(claimedB.hop.id, 'B');
    assert.equal(claimedB.hop.runtimeKind, 'spawn');
    assert.equal(claimedB.hop.profileId, 'other');
    const stillA = await repo.get('A');
    assert.equal(stillA?.status, 'queued');
    assert.equal(stillA?.runtimeKind, undefined);
    assert.equal(stillA?.profileId, undefined);
    assert.equal((await repo.get('C'))?.status, 'queued');
    assert.equal((await repo.get('C'))?.runtimeKind, undefined);

    const againA = await repo.claimAvailable({
      owner: 'runner', now, leaseUntil: later, limits: limits({ runtime: 1, profile: 1 }),
      eligible: [{ hopId: 'A', runtimeKind: 'pi', profileId: 'qwen' }],
    });
    assert.equal(againA.kind, 'waiting');
    if (againA.kind !== 'waiting') throw new Error('expected waiting');
    assert.equal(againA.wait, 'capacity');
    assert.equal(againA.hop.id, 'A');
    assert.equal((await repo.get('A'))?.status, 'queued');

    const fifoDir = mkdtempSync(join(tmpdir(), 'queued-capacity-fifo-'));
    try {
      const fifo = fileQueueRepo(fifoDir).repo;
      await fifo.enqueue(hop({ id: 'late', priority: 5, createdAt: '2025-01-01T00:00:10.000Z' }));
      await fifo.enqueue(hop({ id: 'early', priority: 5, createdAt: '2025-01-01T00:00:00.000Z' }));
      const fifoClaim = await fifo.claimAvailable({
        owner: 'runner', now, leaseUntil: later, limits: limits({ global: 1 }), eligible: eligible(['late', 'early']),
      });
      assert.equal(fifoClaim.kind, 'claimed');
      if (fifoClaim.kind !== 'claimed') throw new Error('expected claimed');
      assert.equal(fifoClaim.hop.id, 'early');
      assert.equal((await fifo.get('late'))?.status, 'queued');

      const high = new FileQueuedHopRepository(new FileStateStore(join(fifoDir, 'high.json')));
      await high.enqueue(hop({ id: 'low-early', priority: 1, createdAt: '2025-01-01T00:00:00.000Z' }));
      await high.enqueue(hop({ id: 'high-late', priority: 9, createdAt: '2025-01-01T00:00:10.000Z' }));
      const highClaim = await high.claimAvailable({
        owner: 'runner', now, leaseUntil: later, limits: limits({ global: 1 }), eligible: eligible(['low-early', 'high-late']),
      });
      assert.equal(highClaim.kind, 'claimed');
      if (highClaim.kind !== 'claimed') throw new Error('expected claimed');
      assert.equal(highClaim.hop.id, 'high-late');
    } finally {
      rmSync(fifoDir, { recursive: true, force: true });
    }

    for (const dim of ['global', 'project', 'role', 'runtime', 'profile'] as const) {
      const dimDir = mkdtempSync(join(tmpdir(), `queued-capacity-${dim}-`));
      try {
        const dimRepo = fileQueueRepo(dimDir).repo;
        await dimRepo.enqueue(hop({ id: 'occ' }));
        const held = await dimRepo.claimAvailable({
          owner: 'holder', now, leaseUntil: later, limits: limits(), eligible: eligible(['occ']),
        });
        assert.equal(held.kind, 'claimed');
        await dimRepo.enqueue(hop({ id: 'next' }));
        const blocked = await dimRepo.claimAvailable({
          owner: 'runner', now, leaseUntil: later,
          limits: limits({ [dim]: 1 }),
          eligible: eligible(['next']),
        });
        assert.equal(blocked.kind, 'waiting');
        if (blocked.kind !== 'waiting') throw new Error(`expected waiting for ${dim}`);
        assert.equal(blocked.wait, 'capacity');
        assert.equal((await dimRepo.get('next'))?.status, 'queued');
      } finally {
        rmSync(dimDir, { recursive: true, force: true });
      }
    }

    const legacy = hop({ id: 'legacy' });
    await repo.enqueue(legacy);
    const reopened = new FileQueuedHopRepository(new FileStateStore(path));
    const listed = await reopened.get('legacy');
    assert.equal(listed?.status, 'queued');
    assert.equal(listed?.runtimeKind, undefined);
    const claimedLegacy = await reopened.claim('legacy', 'owner', now, later);
    assert.equal(claimedLegacy?.status, 'claimed');
    assert.equal(claimedLegacy?.runtimeKind, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
