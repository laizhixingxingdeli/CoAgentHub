import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DurableScheduler,
  hopIdempotencyKey,
  nextLogicalHopCycle,
  type QueuedHop,
} from '../src/application/durable-scheduler.ts';
import type { QueuedHopCapacityRepository } from '../src/application/ports.ts';
import { FileQueuedHopRepository, FileStateStore } from '../src/application/file-store.ts';

const now = '2025-01-01T00:00:00.000Z';

function row(overrides: Partial<QueuedHop> & Pick<QueuedHop, 'id' | 'idempotencyKey'>): QueuedHop {
  return {
    projectId: 'p',
    missionId: 'm',
    workItemId: 'w',
    role: 'coordinator',
    priority: 0,
    availableAt: now,
    attemptCount: 0,
    maxAttempts: 3,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const plain = { missionId: 'm', role: 'coordinator' as const, workItemId: 'w', contractRevision: 1 };
const impact = (changeId: string) => ({ ...plain, purpose: 'impact' as const, changeId });

const baseInput = {
  projectId: 'p',
  missionId: 'm',
  workItemId: 'w',
  role: 'coordinator' as const,
  priority: 0,
  availableAt: now,
  attemptCount: 0,
  maxAttempts: 3,
};

function stubRepo(): QueuedHopCapacityRepository {
  return {
    async enqueue() { throw new Error('unused'); },
    async get() { return undefined; },
    async list() { return []; },
    async claim() { return undefined; },
    async renew() { return undefined; },
    async complete() { return undefined; },
    async claimAvailable() { return { kind: 'empty' as const }; },
  };
}

/** validateEnqueueHop is not exported; the scheduler entry is the third entry point. */
async function rejectEnqueue(input: Record<string, unknown>): Promise<void> {
  const scheduler = new DurableScheduler(stubRepo(), { now: () => new Date(now) }, { next: () => 'HOP-1' });
  await assert.rejects(scheduler.enqueue({ ...baseInput, idempotencyKey: 'k', ...input } as never));
}

test('impact identity is validated at all three entries and never reuses the ordinary slot', async () => {
  assert.equal(hopIdempotencyKey({ ...plain, attemptCycle: 0 }), 'm:coordinator:w:r1:n0');
  // Ordinary keys interpolate attemptCycle verbatim: no extra cycle validation may be added.
  assert.equal(hopIdempotencyKey({ ...plain, attemptCycle: -1 }), 'm:coordinator:w:r1:n-1');
  assert.equal(nextLogicalHopCycle([row({ id: 'h0', idempotencyKey: 'm:coordinator:w:r1:n0' })], plain), 0);
  assert.equal(nextLogicalHopCycle([row({ id: 'h0', idempotencyKey: 'm:coordinator:w:r1:n0', status: 'completed' })], plain), 1);

  for (const bad of [
    { purpose: 'impact' as const },
    { changeId: 'c1' },
    { purpose: 'impact' as const, changeId: ' ' },
    { purpose: 'impact' as const, changeId: 'c1', role: 'executor' as const },
  ]) {
    assert.throws(() => hopIdempotencyKey({ ...plain, ...bad, attemptCycle: 0 }));
    assert.throws(() => nextLogicalHopCycle([], { ...plain, ...bad }));
    await rejectEnqueue(bad);
  }

  // A changeId carrying the separator must not forge another change's key.
  assert.notEqual(hopIdempotencyKey({ ...impact('a:b'), attemptCycle: 0 }), hopIdempotencyKey({ ...impact('a'), attemptCycle: 0 }));
  const keyA = hopIdempotencyKey({ ...impact('a'), attemptCycle: 0 });
  const keyB = hopIdempotencyKey({ ...impact('b'), attemptCycle: 0 });
  assert.notEqual(keyA, keyB);
  assert.notEqual(keyA, hopIdempotencyKey({ ...plain, attemptCycle: 0 }));

  // Ordinary rows must not be mistaken for impact rows, in either direction.
  assert.equal(nextLogicalHopCycle([row({ id: 'p0', idempotencyKey: 'm:coordinator:w:r1:n0' })], impact('c1')), 0);
  assert.equal(nextLogicalHopCycle([row({ id: 'i0', idempotencyKey: keyA })], plain), 0);

  // Every unfinished status holds only its own changeId slot; completed releases it.
  for (const status of ['queued', 'claimed', 'retry_wait', 'dead_letter'] as const) {
    assert.equal(nextLogicalHopCycle([row({ id: 'i0', idempotencyKey: keyA, status })], impact('a')), 0);
    assert.equal(nextLogicalHopCycle([row({ id: 'i0', idempotencyKey: keyB, status })], impact('a')), 0);
  }
  assert.equal(nextLogicalHopCycle([row({ id: 'i0', idempotencyKey: keyA, status: 'completed' })], impact('a')), 1);
  assert.equal(nextLogicalHopCycle([row({ id: 'i0', idempotencyKey: keyB, status: 'completed' })], impact('a')), 0);
});

function mapRepo(rows = new Map<string, QueuedHop>()): QueuedHopCapacityRepository & { rows: Map<string, QueuedHop> } {
  const repo = {
    rows,
    async enqueue(hop: QueuedHop) {
      const existing = [...rows.values()].find((item) => item.idempotencyKey === hop.idempotencyKey);
      if (existing) return { ...existing };
      rows.set(hop.id, hop);
      return { ...hop };
    },
    async get(id: string) { return rows.get(id); },
    async list() { return [...rows.values()]; },
    async claim(id: string, owner: string, at: string, until: string) {
      const current = rows.get(id);
      if (!current || current.status === 'completed' || Date.parse(current.availableAt) > Date.parse(at)) return undefined;
      const updated = { ...current, status: 'claimed' as const, owner, leaseUntil: until, claimGeneration: (current.claimGeneration ?? 0) + 1 };
      rows.set(id, updated);
      return updated;
    },
    async renew(id: string, owner: string, generation: number, _at: string, until: string) {
      const current = rows.get(id);
      if (!current || current.status !== 'claimed' || current.owner !== owner || current.claimGeneration !== generation) return undefined;
      const updated = { ...current, leaseUntil: until };
      rows.set(id, updated);
      return updated;
    },
    async complete(id: string, owner: string, generation: number) {
      const current = rows.get(id);
      if (!current || current.status !== 'claimed' || current.owner !== owner || current.claimGeneration !== generation) return undefined;
      const updated = { ...current, status: 'completed' as const };
      rows.set(id, updated);
      return updated;
    },
    async claimAvailable() { return { kind: 'empty' as const }; },
    async reportFailure() { return undefined; },
  };
  return repo as QueuedHopCapacityRepository & { rows: Map<string, QueuedHop> };
}

test('impact identity survives duplicate enqueue, reopen and completion in map and file repositories', async () => {
  const cycle0 = hopIdempotencyKey({ ...impact('c1'), attemptCycle: 0 });
  const cycle1 = hopIdempotencyKey({ ...impact('c1'), attemptCycle: 1 });

  let sequence = 0;
  const repo = mapRepo();
  const scheduler = new DurableScheduler(repo, { now: () => new Date(now) }, { next: () => `HOP-${++sequence}` });
  const first = await scheduler.enqueue({ ...baseInput, purpose: 'impact', changeId: 'c1', idempotencyKey: cycle0 });
  assert.equal(first.purpose, 'impact');
  assert.equal(first.changeId, 'c1');
  const again = await scheduler.enqueue({ ...baseInput, purpose: 'impact', changeId: 'c1', idempotencyKey: cycle0 });
  assert.equal(again.id, first.id);
  const sibling = await scheduler.enqueue({
    ...baseInput, purpose: 'impact', changeId: 'c2', idempotencyKey: hopIdempotencyKey({ ...impact('c2'), attemptCycle: 0 }),
  });
  assert.notEqual(sibling.id, first.id);
  assert.equal(nextLogicalHopCycle(await repo.list(), impact('c1')), 0);

  const claimed = await scheduler.claim(first.id, 'owner', 60_000);
  assert.ok(claimed);
  assert.equal(claimed.purpose, 'impact');
  assert.equal(claimed.changeId, 'c1');
  const renewed = await scheduler.renew(first.id, 'owner', claimed.claimGeneration!, 60_000);
  assert.equal(renewed.changeId, 'c1');
  const completed = await scheduler.complete(first.id, 'owner', claimed.claimGeneration!);
  assert.equal(completed.changeId, 'c1');
  assert.equal(nextLogicalHopCycle(await repo.list(), impact('c1')), 1);
  assert.equal(nextLogicalHopCycle(await repo.list(), impact('c2')), 0);
  const nextCycle = await scheduler.enqueue({ ...baseInput, purpose: 'impact', changeId: 'c1', idempotencyKey: cycle1 });
  assert.notEqual(nextCycle.id, first.id);

  const dir = mkdtempSync(join(tmpdir(), 'impact-hop-'));
  try {
    const path = join(dir, 'state.json');
    const fresh = new FileQueuedHopRepository(new FileStateStore(path));
    const stored = await fresh.enqueue({ ...row({ id: 'f1', idempotencyKey: cycle0 }), purpose: 'impact', changeId: 'c1' });
    assert.equal(stored.changeId, 'c1');
    const reopened = new FileQueuedHopRepository(new FileStateStore(path));
    assert.deepEqual(await reopened.get('f1'), stored);
    assert.equal((await reopened.list()).length, 1);
    const duplicate = await reopened.enqueue({ ...row({ id: 'f2', idempotencyKey: cycle0 }), purpose: 'impact', changeId: 'c1' });
    assert.equal(duplicate.id, 'f1');

    const reopenedScheduler = new DurableScheduler(reopened, { now: () => new Date(now) }, { next: () => 'HOP-f' });
    const fromFile = await reopenedScheduler.claim('f1', 'owner', 60_000);
    assert.ok(fromFile);
    assert.equal(fromFile.changeId, 'c1');
    assert.equal(fromFile.purpose, 'impact');

    // Capacity path stays intact: a leased slot waits, and the next cycle is claimable.
    const held = await reopenedScheduler.claimAvailable('other', 60_000, [{ hopId: 'f1', runtimeKind: 'pi', profileId: 'qwen' }]);
    assert.equal(held.kind, 'waiting');
    if (held.kind !== 'waiting') throw new Error('expected waiting');
    assert.equal(held.wait, 'lease');

    await reopenedScheduler.complete('f1', 'owner', fromFile.claimGeneration!);
    assert.equal(nextLogicalHopCycle(await reopened.list(), impact('c1')), 1);
    assert.equal(nextLogicalHopCycle(await reopened.list(), impact('c2')), 0);

    const pending = await reopened.enqueue({ ...row({ id: 'f3', idempotencyKey: cycle1 }), purpose: 'impact', changeId: 'c1' });
    const taken = await new DurableScheduler(reopened, { now: () => new Date(now) }, { next: () => 'HOP-g' })
      .claimAvailable('owner', 60_000, [{ hopId: pending.id, runtimeKind: 'pi', profileId: 'qwen' }]);
    assert.equal(taken.kind, 'claimed');
    if (taken.kind !== 'claimed') throw new Error('expected claimed');
    assert.equal(taken.hop.changeId, 'c1');
    assert.equal(taken.hop.claimGeneration, 1);
    assert.equal(taken.hop.runtimeKind, 'pi');
    assert.equal(taken.hop.profileId, 'qwen');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
