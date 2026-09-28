import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStateStore, FileQueuedHopRepository } from '../src/application/file-store.ts';
import {
  hopCapacityLimits,
  hopFailureBackoffMs,
  type EligibleHopClaim,
  type HopCapacityCandidate,
  type HopCapacityLimits,
  type QueuedHop,
  type ReportHopFailureInput,
} from '../src/application/durable-scheduler.ts';
import type { QueuedHopCapacityRepository, QueuedHopRepository } from '../src/application/ports.ts';
import { PgProjectRepository, PgStateStore, PgQueuedHopRepository } from '../src/application/pg-store.ts';
import { Project } from '../src/kernel/index.ts';
import { ensureTestDatabase } from './helpers/pg.ts';

test('file queue is idempotent, durable, cloned, old snapshots compatible and transactional', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'queued-hop-'));
  try {
    const path = join(dir, 'state.json');
    const store = new FileStateStore(path);
    const repo = new FileQueuedHopRepository(store);
    const hop: QueuedHop = { id: 'h1', projectId: 'p', missionId: 'm', workItemId: 'w', role: 'executor',
      priority: 1, availableAt: '2025-01-01T00:00:00Z', attemptCount: 0, maxAttempts: 2,
      idempotencyKey: 'key', status: 'queued', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' };
    const first = await repo.enqueue(hop);
    const duplicate = await repo.enqueue({ ...hop, id: 'other', updatedAt: '2026-01-01T00:00:00Z' });
    assert.deepEqual(duplicate, first);
    const second = { ...hop, id: 'h2', idempotencyKey: 'key-2' };
    await repo.enqueue(second);
    assert.deepEqual(await repo.list(), [first, second]);
    for (const invalid of [
      { ...hop, projectId: ' ' },
      { ...hop, idempotencyKey: '' },
      { ...hop, availableAt: 'invalid' },
      { ...hop, priority: Infinity },
      { ...hop, attemptCount: hop.maxAttempts + 1 },
    ]) await assert.rejects(repo.enqueue(invalid));
    assert.deepEqual(await repo.list(), [first, second]);
    const copy = await repo.get('h1');
    assert.ok(copy);
    (copy as any).missionId = 'modified';
    assert.equal((await repo.get('h1'))?.missionId, 'm');
    assert.equal((await new FileQueuedHopRepository(new FileStateStore(path)).list()).length, 2);

    writeFileSync(path, JSON.stringify({ version: 1, projects: [], deliveries: [], events: [], idCounters: {} }));
    assert.deepEqual(await new FileQueuedHopRepository(new FileStateStore(path)).list(), []);
    const restored = new FileStateStore(path);
    const restoredRepo = new FileQueuedHopRepository(restored);
    await assert.rejects(restored.run(async () => { await restoredRepo.enqueue(hop); throw new Error('rollback'); }));
    assert.equal((await restoredRepo.list()).length, 0);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).queuedHops ?? [], []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('file queue lease transitions enforce ownership, boundaries, rollback, and reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'queued-lease-'));
  try {
    const path = join(dir, 'state.json');
    const store = new FileStateStore(path);
    const repo = new FileQueuedHopRepository(store);
    const hop: QueuedHop = { id: 'lease', projectId: 'p', missionId: 'm', workItemId: 'w', role: 'executor', priority: 1,
      availableAt: '2025-01-01T00:00:00Z', attemptCount: 0, maxAttempts: 2, idempotencyKey: 'lease-key', status: 'queued',
      createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' };
    await repo.enqueue(hop);
    const later = '2025-01-01T00:00:01Z';
    assert.equal(await repo.claim('lease', 'early', '2024-12-31T23:59:59Z', later), undefined);
    const claimed = await repo.claim('lease', 'owner', '2025-01-01T00:00:00Z', later);
    assert.equal(claimed?.claimGeneration, 1);
    assert.deepEqual(await repo.enqueue({ ...hop, id: 'duplicate', updatedAt: later }), claimed);
    const renewedUntil = '2025-01-01T00:00:02Z';
    const renewed = await repo.renew('lease', 'owner', 1, '2025-01-01T00:00:00.500Z', renewedUntil);
    assert.equal(renewed?.leaseUntil, renewedUntil);
    assert.ok(Date.parse(renewed!.leaseUntil!) > Date.parse(claimed!.leaseUntil!));
    assert.equal(await repo.claim('lease', 'intruder', later, '2025-01-01T00:00:03Z'), undefined);
    const beforeReject = readFileSync(path);
    assert.equal(await repo.renew('lease', 'wrong', 1, '2025-01-01T00:00:00.500Z', '2025-01-01T00:00:02Z'), undefined);
    assert.deepEqual(readFileSync(path), beforeReject);
    assert.equal(await repo.complete('lease', 'owner', 0, '2025-01-01T00:00:00.500Z'), undefined);
    assert.deepEqual(readFileSync(path), beforeReject);
    assert.equal(await repo.renew('lease', 'owner', 1, later, '2025-01-01T00:00:02Z'), undefined);
    assert.deepEqual(readFileSync(path), beforeReject);
    assert.equal(await repo.renew('lease', 'owner', 0, later, '2025-01-01T00:00:03Z'), undefined);
    assert.deepEqual(readFileSync(path), beforeReject);
    const renewedReopen = new FileQueuedHopRepository(new FileStateStore(path));
    assert.deepEqual(await renewedReopen.get('lease'), renewed);
    const taken = await repo.claim('lease', 'next', renewedUntil, '2025-01-01T00:00:03Z');
    assert.equal(taken?.claimGeneration, 2);
    assert.equal(await repo.complete('lease', 'owner', 1, later), undefined);
    assert.ok(await repo.complete('lease', 'next', 2, '2025-01-01T00:00:02Z'));
    assert.equal(await repo.claim('lease', 'third', '2025-01-01T00:00:03Z', '2025-01-01T00:00:04Z'), undefined);
    assert.deepEqual(await repo.enqueue({ ...hop, id: 'duplicate', updatedAt: later }), await repo.get('lease'));
    const reopened = new FileQueuedHopRepository(new FileStateStore(path));
    assert.deepEqual(await reopened.get('lease'), await repo.get('lease'));

    writeFileSync(path, JSON.stringify({ version: 1, projects: [], deliveries: [], events: [], idCounters: {}, queuedHops: [{ ...hop, claimGeneration: undefined }] }));
    const oldRepo = new FileQueuedHopRepository(new FileStateStore(path));
    assert.equal((await oldRepo.claim('lease', 'legacy', '2025-01-01T00:00:00Z', later))?.claimGeneration, 1);
    const race = await Promise.all([oldRepo.claim('lease', 'a', later, '2025-01-01T00:00:02Z'), oldRepo.claim('lease', 'b', later, '2025-01-01T00:00:02Z')]);
    assert.equal(race.filter(Boolean).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Postgres queue persists and deduplicates queued hops', async (t) => {
  const connectionString = await ensureTestDatabase('durable_scheduler');
  if (!connectionString) { t.skip('Postgres unavailable; PG queue not verified'); return; }
  const store = await PgStateStore.open({ connectionString });
  try {
    await store.pool.query('TRUNCATE queued_hops');
    const repo = new PgQueuedHopRepository(store);
    const hop: QueuedHop = { id: 'pg-h1', projectId: 'p', missionId: 'm', workItemId: 'w', role: 'executor', priority: 1, availableAt: '2025-01-01T00:00:00Z', attemptCount: 0, maxAttempts: 2, idempotencyKey: 'pg-key', status: 'queued', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' };
    const first = await repo.enqueue(hop);
    assert.deepEqual(await repo.enqueue({ ...hop, id: 'pg-other', updatedAt: '2026-01-01T00:00:00Z' }), first);
    const second = { ...hop, id: 'pg-h2', idempotencyKey: 'pg-key-2' };
    await repo.enqueue(second);
    assert.deepEqual(await repo.get(hop.id), first);
    assert.deepEqual(await repo.list(), [first, second]);
    for (const invalid of [
      { ...hop, id: '' }, { ...hop, status: 'running' as 'queued' }, { ...hop, createdAt: 'bad' },
      { ...hop, updatedAt: 'bad' }, { ...hop, projectId: '' }, { ...hop, missionId: '' },
      { ...hop, workItemId: '' }, { ...hop, idempotencyKey: '' }, { ...hop, role: 'invalid' as 'executor' },
      { ...hop, priority: -1 }, { ...hop, priority: 1.5 }, { ...hop, availableAt: 'bad' },
      { ...hop, attemptCount: -1 }, { ...hop, attemptCount: 3 }, { ...hop, maxAttempts: 0 },
    ]) await assert.rejects(repo.enqueue(invalid));
    const racedHop = { ...hop, id: 'pg-race-1', idempotencyKey: 'pg-race' };
    const raced = await Promise.all(Array.from({ length: 8 }, (_, index) => repo.enqueue({
      ...racedHop, id: `pg-race-${index}`, updatedAt: `2025-01-01T00:00:0${index}Z`,
    })));
    assert.ok(raced.every((item) => item.id === raced[0]?.id));
    assert.equal((await repo.list()).filter((item) => item.idempotencyKey === 'pg-race').length, 1);
    assert.deepEqual(await repo.list(), [first, second, raced[0]]);

  } finally { await store.close(); }
  const reopened = await PgStateStore.open({ connectionString });
  try { assert.equal((await new PgQueuedHopRepository(reopened).list()).length, 3); }
  finally { await reopened.close(); }
});

test('Postgres queue lease transitions serialize claims and persist ownership', async (t) => {
  const connectionString = await ensureTestDatabase('durable_scheduler');
  if (!connectionString) { t.skip('Postgres unavailable; PG lease behavior not verified'); return; }
  const store = await PgStateStore.open({ connectionString });
  try {
    await store.pool.query('TRUNCATE queued_hops');
    const repo = new PgQueuedHopRepository(store);
    const hop: QueuedHop = { id: 'pg-lease', projectId: 'p', missionId: 'm', workItemId: 'w', role: 'executor', priority: 1,
      availableAt: '2025-01-01T00:00:00Z', attemptCount: 0, maxAttempts: 2, idempotencyKey: 'pg-lease-key', status: 'queued',
      createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' };
    await repo.enqueue(hop);
    const future = { ...hop, id: 'pg-future', idempotencyKey: 'pg-future-key', availableAt: '2025-01-01T00:00:02Z' };
    await repo.enqueue(future);
    const futureBefore = await repo.get(future.id);
    assert.equal(await repo.claim(future.id, 'early', hop.availableAt, '2025-01-01T00:00:01Z'), undefined);
    assert.deepEqual(await repo.get(future.id), futureBefore);
    const claims = await Promise.all([repo.claim(hop.id, 'a', hop.availableAt, '2025-01-01T00:00:01Z'),
      repo.claim(hop.id, 'b', hop.availableAt, '2025-01-01T00:00:01Z')]);
    assert.equal(claims.filter(Boolean).length, 1);
    const winner = claims.find(Boolean)!;
    assert.equal(winner.claimGeneration, 1);
    assert.deepEqual(await repo.enqueue({ ...hop, id: 'duplicate' }), winner);
    const snapshot = await repo.get(hop.id);
    assert.equal(await repo.renew(hop.id, 'wrong', 1, '2025-01-01T00:00:00.500Z', '2025-01-01T00:00:02Z'), undefined);
    assert.deepEqual(await repo.get(hop.id), snapshot);
    const renewedUntil = '2025-01-01T00:00:02Z';
    const renewed = await repo.renew(hop.id, winner.owner!, 1, '2025-01-01T00:00:00.500Z', renewedUntil);
    assert.equal(renewed?.leaseUntil, renewedUntil);
    assert.ok(Date.parse(renewed!.leaseUntil!) > Date.parse(winner.leaseUntil!));
    assert.equal(await repo.claim(hop.id, 'late', winner.leaseUntil!, '2025-01-01T00:00:03Z'), undefined);
    const beforeExpiredRenew = await repo.get(hop.id);
    assert.equal(await repo.renew(hop.id, winner.owner!, 1, renewedUntil, '2025-01-01T00:00:04Z'), undefined);
    assert.deepEqual(await repo.get(hop.id), beforeExpiredRenew);
    const takeover = await repo.claim(hop.id, 'late', renewedUntil, '2025-01-01T00:00:03Z');
    assert.equal(takeover?.claimGeneration, 2);
    const beforeStale = await repo.get(hop.id);
    assert.equal(await repo.complete(hop.id, winner.owner!, 1, '2025-01-01T00:00:01Z'), undefined);
    assert.deepEqual(await repo.get(hop.id), beforeStale);
    assert.equal(await repo.renew(hop.id, winner.owner!, 1, '2025-01-01T00:00:01Z', '2025-01-01T00:00:04Z'), undefined);
    assert.deepEqual(await repo.get(hop.id), beforeStale);
    assert.equal(await repo.renew(hop.id, winner.owner!, 1, renewedUntil, '2025-01-01T00:00:04Z'), undefined);
    assert.deepEqual(await repo.get(hop.id), beforeStale);
    assert.ok(await repo.complete(hop.id, 'late', 2, '2025-01-01T00:00:01.500Z'));
    assert.deepEqual(await repo.enqueue({ ...hop, id: 'duplicate' }), await repo.get(hop.id));
  } finally { await store.close(); }
  const reopened = await PgStateStore.open({ connectionString });
  try {
    const repo = new PgQueuedHopRepository(reopened);
    const persisted = await repo.get('pg-lease');
    assert.equal(persisted?.status, 'completed');
    assert.equal(persisted?.claimGeneration, 2);
    assert.equal(persisted?.owner, 'late');
    assert.equal(persisted?.availableAt, '2025-01-01T00:00:00Z');
    assert.equal(persisted?.leaseUntil, '2025-01-01T00:00:03Z');
    assert.equal(persisted?.updatedAt, '2025-01-01T00:00:01.500Z');
    const beforeStaleReject = await repo.get('pg-lease');
    assert.equal(await repo.renew('pg-lease', 'late', 1, '2025-01-01T00:00:01.600Z', '2025-01-01T00:00:04Z'), undefined);
    assert.deepEqual(await repo.get('pg-lease'), beforeStaleReject);
    assert.equal(await repo.complete('pg-lease', 'late', 1, '2025-01-01T00:00:01.600Z'), undefined);
    assert.deepEqual(await repo.get('pg-lease'), beforeStaleReject);
    assert.equal(await repo.claim('pg-lease', 'third', '2025-01-01T00:00:02Z', '2025-01-01T00:00:03Z'), undefined);
  } finally { await reopened.close(); }
});

const FENCE_NOW = '2025-01-01T00:00:00Z';
const FENCE_LEASE = '2025-01-01T00:00:10Z';
const FENCE_LATER = '2025-01-01T00:00:20Z';
const FENCE_CONTRACT = { intent: 'x', acceptance: ['a'], constraints: [], nonGoals: [], guardrails: [] };

function fenceHop(overrides: Partial<QueuedHop> = {}): QueuedHop {
  return {
    id: 'pg-fence', projectId: 'p', missionId: 'm', workItemId: 'w', role: 'executor', priority: 1,
    availableAt: FENCE_NOW, attemptCount: 0, maxAttempts: 2, idempotencyKey: 'pg-fence-key',
    status: 'queued', createdAt: FENCE_NOW, updatedAt: FENCE_NOW, ...overrides,
  };
}

async function openFenceStore(): Promise<{ connectionString: string; store: PgStateStore } | undefined> {
  const connectionString = await ensureTestDatabase('durable_scheduler_fencing');
  if (!connectionString) return undefined;
  const store = await PgStateStore.open({ connectionString });
  await store.pool.query('TRUNCATE queued_hops, projects');
  return { connectionString, store };
}

test('Postgres fenced command commits live claim writes and rejects stale fences without mutation', async (t) => {
  const opened = await openFenceStore();
  if (!opened) { t.skip('Postgres unavailable; PG claim fencing not verified'); return; }
  const { connectionString, store } = opened;
  try {
    const repo = new PgQueuedHopRepository(store);
    const projects = new PgProjectRepository(store);
    await repo.enqueue(fenceHop());
    const claimed = await repo.claim('pg-fence', 'owner', FENCE_NOW, FENCE_LEASE);
    assert.equal(claimed?.claimGeneration, 1);
    const seed = Project.create({ id: 'P-seed' });
    await projects.save(seed);
    const queueBefore = structuredClone(await repo.get('pg-fence'));
    const projectBefore = JSON.stringify((await projects.get('P-seed'))!.toSnapshot());

    await store.runFenced({ id: 'pg-fence', owner: 'owner', claimGeneration: 1, now: FENCE_NOW }, async () => {
      await projects.save(Project.create({ id: 'P-fence' }));
    });
    assert.equal((await projects.get('P-fence'))?.id, 'P-fence');
    assert.deepEqual(await repo.get('pg-fence'), queueBefore);

    const writeInCallback = async () => {
      (await projects.get('P-seed'))!.createMission({
        id: 'M-no',
        contract: FENCE_CONTRACT,
      });
      await projects.save((await projects.get('P-seed'))!);
      await projects.save(Project.create({ id: 'P-rejected' }));
    };
    const rejects = [
      { id: 'pg-fence', owner: 'owner', claimGeneration: 0, now: FENCE_NOW },
      { id: 'pg-fence', owner: 'intruder', claimGeneration: 1, now: FENCE_NOW },
      { id: 'pg-fence', owner: 'owner', claimGeneration: 1, now: FENCE_LEASE },
      { id: 'missing', owner: 'owner', claimGeneration: 1, now: FENCE_NOW },
    ] as const;
    for (const fence of rejects) {
      await assert.rejects(store.runFenced(fence, writeInCallback), /claim fence rejected/);
      assert.deepEqual(await repo.get('pg-fence'), queueBefore);
      assert.equal(JSON.stringify((await projects.get('P-seed'))!.toSnapshot()), projectBefore);
      assert.equal(await projects.get('P-rejected'), undefined);
    }

    await assert.rejects(
      store.runFenced({ id: 'missing', owner: 'owner', claimGeneration: 1, now: FENCE_NOW }, async () => undefined),
      /claim fence rejected/,
    );
    assert.deepEqual(await repo.get('pg-fence'), queueBefore);
    assert.equal((await projects.get('P-fence'))?.id, 'P-fence');
  } finally { await store.close(); }
  const reopened = await PgStateStore.open({ connectionString });
  try {
    const projects = new PgProjectRepository(reopened);
    const repo = new PgQueuedHopRepository(reopened);
    assert.equal((await projects.get('P-fence'))?.id, 'P-fence');
    assert.equal(await projects.get('P-rejected'), undefined);
    assert.equal((await projects.get('P-seed'))!.missions.length, 0);
    assert.equal((await repo.get('pg-fence'))?.claimGeneration, 1);
    assert.equal((await repo.get('pg-fence'))?.owner, 'owner');
  } finally { await reopened.close(); }
});

test('Postgres fenced command loses the race when Q is taken over after the callback starts', async (t) => {
  const opened = await openFenceStore();
  if (!opened) { t.skip('Postgres unavailable; PG claim fencing race not verified'); return; }
  const { connectionString, store } = opened;
  try {
    const repo = new PgQueuedHopRepository(store);
    const projects = new PgProjectRepository(store);
    await repo.enqueue(fenceHop());
    assert.equal((await repo.claim('pg-fence', 'owner', FENCE_NOW, FENCE_LEASE))?.claimGeneration, 1);

    await assert.rejects(
      store.runFenced({ id: 'pg-fence', owner: 'owner', claimGeneration: 1, now: FENCE_NOW }, async () => {
        await projects.save(Project.create({ id: 'P-lost' }));
        // 回调已开始、#commit 尚未 BEGIN：此时接管必须能完成。若实现在 fn 里锁行，claim 会卡住直到陈旧写提交。
        const taken = await Promise.race([
          repo.claim('pg-fence', 'next', FENCE_LEASE, FENCE_LATER),
          new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 2000)),
        ]);
        assert.ok(taken, 'takeover must proceed during the callback; a row lock held across fn would block claim until after commit');
        assert.equal(taken.claimGeneration, 2);
        assert.equal(taken.owner, 'next');
      }),
      /claim fence rejected/,
    );
    assert.equal(await projects.get('P-lost'), undefined);
    const hop = await repo.get('pg-fence');
    assert.equal(hop?.owner, 'next');
    assert.equal(hop?.claimGeneration, 2);
  } finally { await store.close(); }
  const reopened = await PgStateStore.open({ connectionString });
  try {
    assert.equal(await new PgProjectRepository(reopened).get('P-lost'), undefined);
    const hop = await new PgQueuedHopRepository(reopened).get('pg-fence');
    assert.equal(hop?.owner, 'next');
    assert.equal(hop?.claimGeneration, 2);
  } finally { await reopened.close(); }
});

test('Postgres reclaim after expiry strictly increases generation; reopen still rejects the old generation', async (t) => {
  const opened = await openFenceStore();
  if (!opened) { t.skip('Postgres unavailable; PG reclaim fencing not verified'); return; }
  const { connectionString, store } = opened;
  try {
    const repo = new PgQueuedHopRepository(store);
    const projects = new PgProjectRepository(store);
    await repo.enqueue(fenceHop());
    const first = await repo.claim('pg-fence', 'owner', FENCE_NOW, FENCE_LEASE);
    assert.equal(first?.claimGeneration, 1);
    const taken = await repo.claim('pg-fence', 'next', FENCE_LEASE, FENCE_LATER);
    assert.equal(taken?.claimGeneration, 2);
    assert.ok((taken?.claimGeneration ?? 0) > (first?.claimGeneration ?? 0));

    await assert.rejects(
      store.runFenced({ id: 'pg-fence', owner: 'owner', claimGeneration: 1, now: FENCE_LEASE }, async () => {
        await projects.save(Project.create({ id: 'P-stale' }));
      }),
      /claim fence rejected/,
    );
    assert.equal(await projects.get('P-stale'), undefined);
    assert.equal((await repo.get('pg-fence'))?.claimGeneration, 2);

    await store.runFenced({ id: 'pg-fence', owner: 'next', claimGeneration: 2, now: FENCE_LEASE }, async () => {
      await projects.save(Project.create({ id: 'P-live' }));
    });
    assert.equal((await projects.get('P-live'))?.id, 'P-live');
  } finally { await store.close(); }

  const reopened = await PgStateStore.open({ connectionString });
  try {
    const repo = new PgQueuedHopRepository(reopened);
    const projects = new PgProjectRepository(reopened);
    assert.equal((await repo.get('pg-fence'))?.claimGeneration, 2);
    assert.ok(((await repo.get('pg-fence'))?.claimGeneration ?? 0) > 1);
    await assert.rejects(
      reopened.runFenced({ id: 'pg-fence', owner: 'next', claimGeneration: 1, now: FENCE_LEASE }, async () => {
        await projects.save(Project.create({ id: 'P-old-gen' }));
      }),
      /claim fence rejected/,
    );
    assert.equal(await projects.get('P-old-gen'), undefined);
    await reopened.runFenced({ id: 'pg-fence', owner: 'next', claimGeneration: 2, now: FENCE_LEASE }, async () => {
      await projects.save(Project.create({ id: 'P-reopen' }));
    });
    assert.equal((await projects.get('P-reopen'))?.id, 'P-reopen');
    assert.equal((await projects.get('P-live'))?.id, 'P-live');
  } finally { await reopened.close(); }
});

const CAP_NOW = '2025-01-01T00:00:00.000Z';
const CAP_LATER = '2025-01-01T00:01:00.000Z';
const capCandidate: HopCapacityCandidate = { runtimeKind: 'pi', profileId: 'qwen' };

function capHop(overrides: Partial<QueuedHop> & Pick<QueuedHop, 'id'>): QueuedHop {
  return {
    projectId: 'p', missionId: 'm', workItemId: 'w', role: 'executor', priority: 1,
    availableAt: CAP_NOW, attemptCount: 0, maxAttempts: 3, idempotencyKey: overrides.id,
    status: 'queued', createdAt: CAP_NOW, updatedAt: CAP_NOW, ...overrides,
  };
}

function capLimits(overrides: Partial<HopCapacityLimits> = {}): HopCapacityLimits {
  return hopCapacityLimits({ global: 8, project: 8, role: 8, runtime: 8, profile: 8, ...overrides });
}

function capEligible(ids: readonly string[], cand: HopCapacityCandidate = capCandidate): EligibleHopClaim[] {
  return ids.map((hopId) => ({ hopId, runtimeKind: cand.runtimeKind, profileId: cand.profileId }));
}

async function openCapacityStore(isolated: string): Promise<{ connectionString: string; store: PgStateStore } | undefined> {
  const connectionString = await ensureTestDatabase(isolated);
  if (!connectionString) return undefined;
  const store = await PgStateStore.open({ connectionString });
  await store.pool.query('TRUNCATE queued_hops');
  return { connectionString, store };
}

test('Postgres claimAvailable selects in one transaction by eligible, occupancy and fairness; waiters stay queued', async (t) => {
  const opened = await openCapacityStore('durable_scheduler_capacity_tx');
  if (!opened) { t.skip('Postgres unavailable; PG capacity claim not verified'); return; }
  const { store } = opened;
  try {
    const repo = new PgQueuedHopRepository(store);
    const empty = await repo.claimAvailable({
      owner: 'runner', now: CAP_NOW, leaseUntil: CAP_LATER, limits: capLimits(), eligible: capEligible(['missing']),
    });
    assert.equal(empty.kind, 'empty');
    assert.deepEqual(await repo.list(), []);

    await repo.enqueue(capHop({ id: 'low', priority: 1, createdAt: '2025-01-01T00:00:00.000Z', projectId: 'free' }));
    await repo.enqueue(capHop({ id: 'high-full', priority: 9, createdAt: '2025-01-01T00:00:10.000Z', projectId: 'full' }));
    await repo.enqueue(capHop({ id: 'hold', projectId: 'full' }));
    await repo.enqueue(capHop({ id: 'unrelated', missionId: 'other', priority: 99, createdAt: '2024-01-01T00:00:00.000Z' }));
    const occupied = await repo.claimAvailable({
      owner: 'holder', now: CAP_NOW, leaseUntil: CAP_LATER, limits: capLimits(), eligible: capEligible(['hold']),
    });
    assert.equal(occupied.kind, 'claimed');

    const claimed = await repo.claimAvailable({
      owner: 'runner', now: CAP_NOW, leaseUntil: CAP_LATER, limits: capLimits({ project: 1 }),
      eligible: capEligible(['low', 'high-full']),
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
      owner: 'runner', now: CAP_NOW, leaseUntil: CAP_LATER, limits: capLimits({ project: 1 }),
      eligible: capEligible(['high-full']),
    });
    assert.equal(waiting.kind, 'waiting');
    if (waiting.kind !== 'waiting') throw new Error('expected waiting');
    assert.equal(waiting.wait, 'capacity');
    assert.equal(waiting.hop.id, 'high-full');
    const afterWait = await repo.get('high-full');
    assert.equal(afterWait?.status, 'queued');
    assert.equal(afterWait?.runtimeKind, undefined);
    assert.equal((await repo.get('unrelated'))?.status, 'queued');

    const byId = await repo.claim('unrelated', 'other', CAP_NOW, CAP_LATER);
    assert.equal(byId?.status, 'claimed');
    assert.equal(byId?.runtimeKind, undefined);
    const renewed = await repo.renew('unrelated', 'other', 1, CAP_NOW, '2025-01-01T00:02:00.000Z');
    assert.equal(renewed?.leaseUntil, '2025-01-01T00:02:00.000Z');
    const finished = await repo.complete('unrelated', 'other', 1, CAP_NOW);
    assert.equal(finished?.status, 'completed');
    const asOld: QueuedHopRepository = repo;
    assert.equal(typeof asOld.claim, 'function');
    const asNew: QueuedHopCapacityRepository = repo;
    assert.equal(typeof asNew.claimAvailable, 'function');
  } finally { await store.close(); }
});

test('Postgres occupancy survives reopen; complete or expired leases free a slot; concurrent claims take at most one', async (t) => {
  const opened = await openCapacityStore('durable_scheduler_capacity_reopen');
  if (!opened) { t.skip('Postgres unavailable; PG capacity reopen not verified'); return; }
  const { connectionString, store } = opened;
  try {
    const repo = new PgQueuedHopRepository(store);
    await repo.enqueue(capHop({ id: 'first' }));
    await repo.enqueue(capHop({ id: 'second', createdAt: '2025-01-01T00:00:01.000Z' }));
    const first = await repo.claimAvailable({
      owner: 'runner', now: CAP_NOW, leaseUntil: CAP_LATER, limits: capLimits({ global: 1 }),
      eligible: capEligible(['first', 'second']),
    });
    assert.equal(first.kind, 'claimed');
    if (first.kind !== 'claimed') throw new Error('expected claimed');
    assert.equal(first.hop.id, 'first');
  } finally { await store.close(); }

  const reopened = await PgStateStore.open({ connectionString });
  try {
    const repo = new PgQueuedHopRepository(reopened);
    const stillHeld = await repo.claimAvailable({
      owner: 'other', now: CAP_NOW, leaseUntil: CAP_LATER, limits: capLimits({ global: 1 }),
      eligible: capEligible(['first', 'second']),
    });
    assert.equal(stillHeld.kind, 'waiting');
    if (stillHeld.kind !== 'waiting') throw new Error('expected waiting');
    assert.equal(stillHeld.wait, 'capacity');
    assert.equal((await repo.get('second'))?.status, 'queued');
    assert.equal((await repo.get('first'))?.runtimeKind, 'pi');
    assert.equal((await repo.get('first'))?.profileId, 'qwen');

    const afterExpire = await repo.claimAvailable({
      owner: 'other', now: CAP_LATER, leaseUntil: '2025-01-01T00:02:00.000Z', limits: capLimits({ global: 1 }),
      eligible: capEligible(['first', 'second']),
    });
    assert.equal(afterExpire.kind, 'claimed');
    if (afterExpire.kind !== 'claimed') throw new Error('expected claimed');
    assert.equal(afterExpire.hop.id, 'first');
    assert.equal(afterExpire.hop.claimGeneration, 2);
    await repo.complete('first', 'other', 2, CAP_LATER);

    const afterComplete = await repo.claimAvailable({
      owner: 'next', now: CAP_LATER, leaseUntil: '2025-01-01T00:03:00.000Z', limits: capLimits({ global: 1 }),
      eligible: capEligible(['second']),
    });
    assert.equal(afterComplete.kind, 'claimed');
    if (afterComplete.kind !== 'claimed') throw new Error('expected claimed');
    assert.equal(afterComplete.hop.id, 'second');
    await repo.complete('second', 'next', 1, CAP_LATER);

    await repo.enqueue(capHop({ id: 'race-a', idempotencyKey: 'race-a' }));
    await repo.enqueue(capHop({ id: 'race-b', idempotencyKey: 'race-b', createdAt: '2025-01-01T00:00:01.000Z' }));
    const raced = await Promise.all([
      repo.claimAvailable({
        owner: 'a', now: CAP_NOW, leaseUntil: CAP_LATER, limits: capLimits({ global: 1 }),
        eligible: capEligible(['race-a', 'race-b']),
      }),
      repo.claimAvailable({
        owner: 'b', now: CAP_NOW, leaseUntil: CAP_LATER, limits: capLimits({ global: 1 }),
        eligible: capEligible(['race-a', 'race-b']),
      }),
    ]);
    assert.equal(raced.filter((row) => row.kind === 'claimed').length, 1);
    assert.equal(raced.filter((row) => row.kind === 'waiting').length, 1);
    const claimedId = raced.find((row) => row.kind === 'claimed');
    assert.ok(claimedId && claimedId.kind === 'claimed');
    const otherId = claimedId.hop.id === 'race-a' ? 'race-b' : 'race-a';
    assert.equal((await repo.get(otherId))?.status, 'queued');
    assert.equal((await repo.get(claimedId.hop.id))?.status, 'claimed');
  } finally { await reopened.close(); }
});

test('Postgres claimAvailable five-dimension skip, FIFO, high priority, A/B candidate identity, and old snapshots', async (t) => {
  const opened = await openCapacityStore('durable_scheduler_capacity_dims');
  if (!opened) { t.skip('Postgres unavailable; PG capacity dimensions not verified'); return; }
  const { connectionString, store } = opened;
  try {
    const repo = new PgQueuedHopRepository(store);
    await repo.enqueue(capHop({ id: 'hold-rt' }));
    const occupiedRt = await repo.claimAvailable({
      owner: 'holder', now: CAP_NOW, leaseUntil: CAP_LATER, limits: capLimits(), eligible: capEligible(['hold-rt']),
    });
    assert.equal(occupiedRt.kind, 'claimed');
    await repo.enqueue(capHop({ id: 'A', missionId: 'm-a', priority: 9, createdAt: '2025-01-01T00:00:00.000Z' }));
    await repo.enqueue(capHop({ id: 'B', missionId: 'm-b', priority: 1, createdAt: '2025-01-01T00:00:10.000Z' }));
    await repo.enqueue(capHop({ id: 'C', missionId: 'm-c', priority: 99, createdAt: '2024-12-01T00:00:00.000Z' }));

    const identities: EligibleHopClaim[] = [
      { hopId: 'A', runtimeKind: 'pi', profileId: 'qwen' },
      { hopId: 'B', runtimeKind: 'spawn', profileId: 'other' },
    ];
    const claimedB = await repo.claimAvailable({
      owner: 'runner', now: CAP_NOW, leaseUntil: CAP_LATER, limits: capLimits({ runtime: 1, profile: 1 }), eligible: identities,
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
      owner: 'runner', now: CAP_NOW, leaseUntil: CAP_LATER, limits: capLimits({ runtime: 1, profile: 1 }),
      eligible: [{ hopId: 'A', runtimeKind: 'pi', profileId: 'qwen' }],
    });
    assert.equal(againA.kind, 'waiting');
    if (againA.kind !== 'waiting') throw new Error('expected waiting');
    assert.equal(againA.wait, 'capacity');
    assert.equal(againA.hop.id, 'A');
    assert.equal((await repo.get('A'))?.status, 'queued');

    await store.pool.query('TRUNCATE queued_hops');
    await repo.enqueue(capHop({ id: 'late', priority: 5, createdAt: '2025-01-01T00:00:10.000Z' }));
    await repo.enqueue(capHop({ id: 'early', priority: 5, createdAt: '2025-01-01T00:00:00.000Z' }));
    const fifoClaim = await repo.claimAvailable({
      owner: 'runner', now: CAP_NOW, leaseUntil: CAP_LATER, limits: capLimits({ global: 1 }),
      eligible: capEligible(['late', 'early']),
    });
    assert.equal(fifoClaim.kind, 'claimed');
    if (fifoClaim.kind !== 'claimed') throw new Error('expected claimed');
    assert.equal(fifoClaim.hop.id, 'early');
    assert.equal((await repo.get('late'))?.status, 'queued');

    await store.pool.query('TRUNCATE queued_hops');
    await repo.enqueue(capHop({ id: 'low-early', priority: 1, createdAt: '2025-01-01T00:00:00.000Z' }));
    await repo.enqueue(capHop({ id: 'high-late', priority: 9, createdAt: '2025-01-01T00:00:10.000Z' }));
    const highClaim = await repo.claimAvailable({
      owner: 'runner', now: CAP_NOW, leaseUntil: CAP_LATER, limits: capLimits({ global: 1 }),
      eligible: capEligible(['low-early', 'high-late']),
    });
    assert.equal(highClaim.kind, 'claimed');
    if (highClaim.kind !== 'claimed') throw new Error('expected claimed');
    assert.equal(highClaim.hop.id, 'high-late');

    for (const dim of ['global', 'project', 'role', 'runtime', 'profile'] as const) {
      await store.pool.query('TRUNCATE queued_hops');
      await repo.enqueue(capHop({ id: 'occ' }));
      const held = await repo.claimAvailable({
        owner: 'holder', now: CAP_NOW, leaseUntil: CAP_LATER, limits: capLimits(), eligible: capEligible(['occ']),
      });
      assert.equal(held.kind, 'claimed');
      await repo.enqueue(capHop({ id: 'next' }));
      const blocked = await repo.claimAvailable({
        owner: 'runner', now: CAP_NOW, leaseUntil: CAP_LATER,
        limits: capLimits({ [dim]: 1 }),
        eligible: capEligible(['next']),
      });
      assert.equal(blocked.kind, 'waiting');
      if (blocked.kind !== 'waiting') throw new Error(`expected waiting for ${dim}`);
      assert.equal(blocked.wait, 'capacity');
      assert.equal((await repo.get('next'))?.status, 'queued');
    }
  } finally { await store.close(); }

  const reopened = await PgStateStore.open({ connectionString });
  try {
    const repo = new PgQueuedHopRepository(reopened);
    await reopened.pool.query('TRUNCATE queued_hops');
    const legacy = capHop({ id: 'legacy' });
    await repo.enqueue(legacy);
    const listed = await repo.get('legacy');
    assert.equal(listed?.status, 'queued');
    assert.equal(listed?.runtimeKind, undefined);
    const claimedLegacy = await repo.claim('legacy', 'owner', CAP_NOW, CAP_LATER);
    assert.equal(claimedLegacy?.status, 'claimed');
    assert.equal(claimedLegacy?.runtimeKind, undefined);
  } finally { await reopened.close(); }
});

test('Postgres claimAvailable serializes different hops across instances so one dimension cannot exceed the limit', async (t) => {
  const opened = await openCapacityStore('durable_scheduler_capacity_instances');
  if (!opened) { t.skip('Postgres unavailable; PG multi-instance capacity race not verified'); return; }
  const { connectionString, store } = opened;
  const other = await PgStateStore.open({ connectionString });
  try {
    const repoA = new PgQueuedHopRepository(store);
    const repoB = new PgQueuedHopRepository(other);
    await repoA.enqueue(capHop({ id: 'hop-a', missionId: 'm-a' }));
    await repoA.enqueue(capHop({ id: 'hop-b', missionId: 'm-b', createdAt: '2025-01-01T00:00:01.000Z' }));
    const raced = await Promise.all([
      repoA.claimAvailable({
        owner: 'inst-a', now: CAP_NOW, leaseUntil: CAP_LATER, limits: capLimits({ global: 1 }),
        eligible: capEligible(['hop-a']),
      }),
      repoB.claimAvailable({
        owner: 'inst-b', now: CAP_NOW, leaseUntil: CAP_LATER, limits: capLimits({ global: 1 }),
        eligible: capEligible(['hop-b']),
      }),
    ]);
    assert.equal(raced.filter((row) => row.kind === 'claimed').length, 1);
    assert.equal(raced.filter((row) => row.kind === 'waiting').length, 1);
    const claimed = raced.find((row) => row.kind === 'claimed');
    assert.ok(claimed && claimed.kind === 'claimed');
    const waiting = raced.find((row) => row.kind === 'waiting');
    assert.ok(waiting && waiting.kind === 'waiting');
    assert.equal(waiting.wait, 'capacity');
    assert.notEqual(claimed.hop.id, waiting.hop.id);
    assert.equal((await repoA.get(waiting.hop.id))?.status, 'queued');
    assert.equal((await repoA.get(claimed.hop.id))?.status, 'claimed');
    assert.equal((await repoA.list()).filter((row) => row.status === 'claimed').length, 1);
  } finally {
    await other.close();
    await store.close();
  }
});

const FAIL_NOW = '2025-01-01T00:00:00.000Z';
const FAIL_LEASE = '2025-01-01T00:01:00.000Z';
const FAIL_AT = '2025-01-01T00:00:30.000Z';

function failHop(overrides: Partial<QueuedHop> = {}): QueuedHop {
  return {
    id: 'fail-h1', projectId: 'p', missionId: 'm', workItemId: 'w', role: 'executor', priority: 1,
    availableAt: FAIL_NOW, attemptCount: 0, maxAttempts: 2, idempotencyKey: 'fail-key', status: 'queued',
    createdAt: FAIL_NOW, updatedAt: FAIL_NOW, ...overrides,
  };
}

function failReport(overrides: Partial<ReportHopFailureInput> = {}): ReportHopFailureInput {
  return {
    id: 'fail-h1', claimGeneration: 1, attemptId: 'A-1', failedAt: FAIL_AT,
    classification: 'upstream_5xx', disposition: 'backoff', retryable: true, ...overrides,
  };
}

async function claimThenFail(
  repo: FileQueuedHopRepository | PgQueuedHopRepository,
  hop: QueuedHop,
  input: ReportHopFailureInput,
) {
  await repo.enqueue(hop);
  const claimed = await repo.claim(hop.id, 'owner', FAIL_NOW, FAIL_LEASE);
  assert.equal(claimed?.claimGeneration, 1);
  return repo.reportFailure(input);
}

test('file queue retry_wait then dead_letter; replay and stale generation do not recount', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'queued-fail-'));
  try {
    const path = join(dir, 'state.json');
    const store = new FileStateStore(path);
    const repo = new FileQueuedHopRepository(store);
    const first = await claimThenFail(repo, failHop(), failReport());
    assert.equal(first?.status, 'retry_wait');
    assert.equal(first?.attemptCount, 1);
    assert.ok(Date.parse(first!.availableAt) > Date.parse(FAIL_AT));
    assert.equal(Date.parse(first!.availableAt), Date.parse(FAIL_AT) + hopFailureBackoffMs(1));
    assert.equal(await repo.claim('fail-h1', 'owner', FAIL_AT, '2025-01-01T00:02:00.000Z'), undefined);
    const due = first!.availableAt;
    const reclaimed = await repo.claim('fail-h1', 'owner', due, '2025-01-01T00:03:00.000Z');
    assert.equal(reclaimed?.claimGeneration, 2);
    assert.equal(reclaimed?.status, 'claimed');
    const second = await repo.reportFailure(failReport({ claimGeneration: 2, attemptId: 'A-2', failedAt: due }));
    assert.equal(second?.status, 'dead_letter');
    assert.equal(second?.attemptCount, 2);
    assert.equal(await repo.claim('fail-h1', 'later', due, '2025-01-01T00:04:00.000Z'), undefined);
    const snapshot = structuredClone(await repo.get('fail-h1'));
    const deadLetters = (await repo.list()).filter((row) => row.status === 'dead_letter');
    assert.equal(deadLetters.length, 1);
    const beforeReplay = readFileSync(path);
    const replay = await repo.reportFailure(failReport({ claimGeneration: 2, attemptId: 'A-2', failedAt: due }));
    assert.deepEqual(replay, snapshot);
    assert.deepEqual(await repo.get('fail-h1'), snapshot);
    assert.equal((await repo.list()).filter((row) => row.status === 'dead_letter').length, 1);
    assert.deepEqual(readFileSync(path), beforeReplay);
    const late = await repo.reportFailure(failReport({ claimGeneration: 1, attemptId: 'A-1' }));
    assert.equal(late, undefined);
    assert.deepEqual(await repo.get('fail-h1'), snapshot);
    assert.deepEqual(readFileSync(path), beforeReplay);
    const listed = await repo.list();
    assert.equal(listed[0]?.missionId, 'm');
    assert.equal(listed[0]?.id, 'fail-h1');
    assert.equal(listed[0]?.lastFailure?.at, due);
    assert.equal(listed[0]?.lastFailure?.classification, 'upstream_5xx');
    assert.equal(listed[0]?.lastFailure?.disposition, 'backoff');
    const reopened = new FileQueuedHopRepository(new FileStateStore(path));
    assert.deepEqual(await reopened.get('fail-h1'), snapshot);
    assert.deepEqual(await reopened.list(), listed);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('file queue non-retryable failure dead-letters without a future availableAt; rollback leaves no row change', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'queued-fail-rule-'));
  try {
    const path = join(dir, 'state.json');
    const store = new FileStateStore(path);
    const repo = new FileQueuedHopRepository(store);
    await repo.enqueue(failHop({ id: 'rule', idempotencyKey: 'rule-key' }));
    await repo.claim('rule', 'owner', FAIL_NOW, FAIL_LEASE);
    const dead = await repo.reportFailure(failReport({
      id: 'rule', retryable: false, classification: 'rule', disposition: 'do_not_retry',
    }));
    assert.equal(dead?.status, 'dead_letter');
    assert.equal(dead?.attemptCount, 1);
    assert.equal(dead?.availableAt, FAIL_NOW);
    assert.equal(await repo.claim('rule', 'owner', '2099-01-01T00:00:00.000Z', '2099-01-01T00:01:00.000Z'), undefined);
    const got = await repo.get('rule');
    assert.equal(got?.lastFailure?.classification, 'rule');
    assert.equal(got?.lastFailure?.disposition, 'do_not_retry');
    assert.equal(got?.missionId, 'm');
    const reopened = new FileQueuedHopRepository(new FileStateStore(path));
    assert.deepEqual(await reopened.get('rule'), got);

    await repo.enqueue(failHop({ id: 'tx', idempotencyKey: 'tx-key' }));
    await repo.claim('tx', 'owner', FAIL_NOW, FAIL_LEASE);
    const before = await repo.get('tx');
    await assert.rejects(store.run(async () => {
      await repo.reportFailure(failReport({ id: 'tx' }));
      throw new Error('rollback');
    }));
    assert.deepEqual(await repo.get('tx'), before);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).queuedHops.find((row: QueuedHop) => row.id === 'tx').status, 'claimed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Postgres queue failure backoff, dead letter, idempotency, and reopen match file semantics', async (t) => {
  const connectionString = await ensureTestDatabase('durable_scheduler_dead_letter');
  if (!connectionString) { t.skip('Postgres unavailable; PG dead letter not verified'); return; }
  const store = await PgStateStore.open({ connectionString });
  try {
    await store.pool.query('TRUNCATE queued_hops');
    const repo = new PgQueuedHopRepository(store);
    const first = await claimThenFail(repo, failHop(), failReport());
    assert.equal(first?.status, 'retry_wait');
    assert.equal(first?.attemptCount, 1);
    assert.ok(Date.parse(first!.availableAt) > Date.parse(FAIL_AT));
    assert.equal(await repo.claim('fail-h1', 'owner', FAIL_AT, '2025-01-01T00:02:00.000Z'), undefined);
    const due = first!.availableAt;
    const reclaimed = await repo.claim('fail-h1', 'owner', due, '2025-01-01T00:03:00.000Z');
    assert.equal(reclaimed?.claimGeneration, 2);
    const second = await repo.reportFailure(failReport({ claimGeneration: 2, attemptId: 'A-2', failedAt: due }));
    assert.equal(second?.status, 'dead_letter');
    assert.equal(second?.attemptCount, 2);
    assert.equal(await repo.claim('fail-h1', 'later', due, '2025-01-01T00:04:00.000Z'), undefined);
    const snapshot = structuredClone(await repo.get('fail-h1'));
    assert.equal((await repo.list()).filter((row) => row.status === 'dead_letter').length, 1);
    const replay = await repo.reportFailure(failReport({ claimGeneration: 2, attemptId: 'A-2', failedAt: due }));
    assert.deepEqual(replay, snapshot);
    assert.deepEqual(await repo.get('fail-h1'), snapshot);
    const late = await repo.reportFailure(failReport({ claimGeneration: 1, attemptId: 'A-1' }));
    assert.equal(late, undefined);
    assert.deepEqual(await repo.get('fail-h1'), snapshot);
    await repo.enqueue(failHop({ id: 'rule', idempotencyKey: 'rule-key' }));
    await repo.claim('rule', 'owner', FAIL_NOW, FAIL_LEASE);
    const dead = await repo.reportFailure(failReport({
      id: 'rule', retryable: false, classification: 'rule', disposition: 'do_not_retry',
    }));
    assert.equal(dead?.status, 'dead_letter');
    assert.equal(dead?.availableAt, FAIL_NOW);
    assert.equal(dead?.lastFailure?.classification, 'rule');
    assert.equal(dead?.lastFailure?.disposition, 'do_not_retry');
    const listed = await repo.list();
    assert.ok(listed.every((row) => row.missionId === 'm'));
    assert.equal(listed.filter((row) => row.status === 'dead_letter').length, 2);
  } finally { await store.close(); }
  const reopened = await PgStateStore.open({ connectionString });
  try {
    const repo = new PgQueuedHopRepository(reopened);
    const persisted = await repo.get('fail-h1');
    assert.equal(persisted?.status, 'dead_letter');
    assert.equal(persisted?.attemptCount, 2);
    assert.equal(persisted?.lastFailure?.attemptId, 'A-2');
    assert.equal(persisted?.missionId, 'm');
    const rule = await repo.get('rule');
    assert.equal(rule?.status, 'dead_letter');
    assert.equal(rule?.lastFailure?.classification, 'rule');
    assert.equal((await repo.list()).filter((row) => row.status === 'dead_letter').length, 2);
    const before = structuredClone(persisted);
    assert.equal(await repo.reportFailure(failReport({ claimGeneration: 1, attemptId: 'A-late' })), undefined);
    assert.deepEqual(await repo.get('fail-h1'), before);
  } finally { await reopened.close(); }
});
