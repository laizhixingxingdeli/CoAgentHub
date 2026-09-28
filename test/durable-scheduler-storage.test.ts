import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStateStore, FileQueuedHopRepository } from '../src/application/file-store.ts';
import type { QueuedHop } from '../src/application/durable-scheduler.ts';
import { PgStateStore, PgQueuedHopRepository } from '../src/application/pg-store.ts';
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
