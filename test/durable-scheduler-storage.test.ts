import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStateStore, FileQueuedHopRepository } from '../src/application/file-store.ts';
import type { QueuedHop } from '../src/application/durable-scheduler.ts';
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
