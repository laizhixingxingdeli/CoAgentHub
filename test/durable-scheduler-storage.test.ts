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
