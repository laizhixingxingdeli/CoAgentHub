import test from 'node:test';
import assert from 'node:assert/strict';
import { DurableScheduler, claimHop, completeHop, renewHop, type QueuedHop } from '../src/application/durable-scheduler.ts';

test('DurableScheduler validates inputs and creates complete queued records', async () => {
  let sequence = 0;
  const rows = new Map<string, QueuedHop>();
  const repository = {
    async enqueue(row: QueuedHop) {
      const existing = [...rows.values()].find((item) => item.idempotencyKey === row.idempotencyKey);
      if (existing) return existing;
      rows.set(row.idempotencyKey, row);
      return row;
    },
    async get(id: string) { return [...rows.values()].find((row) => row.id === id); },
    async list() { return [...rows.values()]; },
    async claim(id: string, owner: string, now: string, until: string) {
      const row = await this.get(id); if (!row) return undefined;
      const updated = claimHop(row, owner, now, until); if (updated) rows.set(row.idempotencyKey, updated); return updated;
    },
    async renew(id: string, owner: string, generation: number, now: string, until: string) {
      const row = await this.get(id); if (!row) return undefined;
      const updated = renewHop(row, owner, generation, now, until); if (updated) rows.set(row.idempotencyKey, updated); return updated;
    },
    async complete(id: string, owner: string, generation: number, now: string) {
      const row = await this.get(id); if (!row) return undefined;
      const updated = completeHop(row, owner, generation, now); if (updated) rows.set(row.idempotencyKey, updated); return updated;
    },
  };
  let current = new Date('2025-01-01T00:00:00Z');
  const scheduler = new DurableScheduler(repository, { now: () => current }, { next: () => `HOP-${++sequence}` });
  const input = { projectId: 'p', missionId: 'm', workItemId: 'w', role: 'executor' as const, priority: 1,
    availableAt: '2025-01-01T00:00:00Z', attemptCount: 0, maxAttempts: 3, idempotencyKey: 'key' };
  const hop = await scheduler.enqueue(input);
  assert.equal(hop.status, 'queued');
  assert.equal(hop.id, 'HOP-1');
  assert.equal(hop.createdAt, hop.updatedAt);
  for (const bad of [{ ...input, projectId: ' ' }, { ...input, priority: Infinity },
    { ...input, availableAt: 'bad' }, { ...input, attemptCount: 4 }]) await assert.rejects(scheduler.enqueue(bad));
  assert.equal(rows.size, 1);
  const duplicate = await scheduler.enqueue(input);
  assert.equal(duplicate.id, hop.id);
  await assert.rejects(scheduler.enqueue({ ...input, owner: 'injected' } as never));
  await assert.rejects(scheduler.enqueue({ ...input, leaseUntil: '2025-01-01T00:01:00Z' } as never));
  await assert.rejects(scheduler.enqueue({ ...input, claimGeneration: 9 } as never));
  assert.equal((await repository.get(hop.id))?.status, 'queued');
  const future = await scheduler.enqueue({ ...input, availableAt: '2025-01-02T00:00:00Z', idempotencyKey: 'future' });
  assert.equal(await scheduler.claim(future.id, 'owner', 1000), undefined);
  const claimed = await scheduler.claim(hop.id, 'owner', 1000);
  assert.equal(claimed?.claimGeneration, 1);
  assert.equal(await scheduler.claim(hop.id, 'other', 1000), undefined);
  const beforeRejectedOps = JSON.stringify(await repository.get(hop.id));
  await assert.rejects(scheduler.renew(hop.id, 'other', 1, 1000));
  await assert.rejects(scheduler.renew(hop.id, 'owner', 2, 1000));
  await assert.rejects(scheduler.complete(hop.id, 'other', 1));
  assert.equal(JSON.stringify(await repository.get(hop.id)), beforeRejectedOps);
  const renewed = await scheduler.renew(hop.id, 'owner', 1, 2000);
  assert.equal(renewed.leaseUntil, '2025-01-01T00:00:02.000Z');
  current = new Date('2025-01-01T00:00:02Z');
  const reclaimed = await scheduler.claim(hop.id, 'other', 1000);
  assert.equal(reclaimed?.claimGeneration, 2);
  await assert.rejects(scheduler.complete(hop.id, 'other', 1));
  await scheduler.complete(hop.id, 'other', 2);
  assert.equal(await scheduler.claim(hop.id, 'third', 1000), undefined);
});

test('expired current lease rejects renew and complete without mutating the full record', async () => {
  const original: QueuedHop = { id: 'x', projectId: 'p', missionId: 'm', workItemId: 'w', role: 'executor', priority: 0,
    availableAt: '2025-01-01T00:00:00Z', attemptCount: 0, maxAttempts: 1, idempotencyKey: 'k', status: 'claimed',
    owner: 'a', leaseUntil: '2025-01-01T00:00:10Z', claimGeneration: 7, createdAt: 'created', updatedAt: 'updated' };
  let row = original;
  const repository = {
    async enqueue(hop: QueuedHop) { row = hop; return row; },
    async get() { return row; },
    async list() { return [row]; },
    async claim(id: string, owner: string, now: string, until: string) {
      const next = claimHop(row, owner, now, until); if (next) row = next; return next;
    },
    async renew(id: string, owner: string, generation: number, now: string, until: string) {
      const next = renewHop(row, owner, generation, now, until); if (next) row = next; return next;
    },
    async complete(id: string, owner: string, generation: number, now: string) {
      const next = completeHop(row, owner, generation, now); if (next) row = next; return next;
    },
  };
  const scheduler = new DurableScheduler(repository, { now: () => new Date('2025-01-01T00:00:10Z') }, { next: () => 'unused' });
  const beforeRenew = structuredClone(row);
  await assert.rejects(scheduler.renew('x', 'a', 7, 1000));
  assert.deepEqual(row, beforeRenew);
  const beforeComplete = structuredClone(row);
  await assert.rejects(scheduler.complete('x', 'a', 7));
  assert.deepEqual(row, beforeComplete);
});

test('renewal requires active matching lease and moves expiry forward', () => {
  const row = { id: 'x', projectId: 'p', missionId: 'm', workItemId: 'w', role: 'executor' as const, priority: 0,
    availableAt: '2025-01-01T00:00:00Z', attemptCount: 0, maxAttempts: 1, idempotencyKey: 'k', status: 'claimed' as const,
    owner: 'a', leaseUntil: '2025-01-01T00:00:10Z', claimGeneration: 1, createdAt: '', updatedAt: '' };
  assert.equal(renewHop(row, 'a', 1, '2025-01-01T00:00:00Z', '2025-01-01T00:00:10Z'), undefined);
  assert.equal(renewHop(row, 'a', 2, '2025-01-01T00:00:00Z', '2025-01-01T00:00:20Z'), undefined);
  assert.equal(renewHop(row, 'a', 1, '2025-01-01T00:00:10Z', '2025-01-01T00:00:20Z'), undefined);
  assert.equal(renewHop(row, 'a', 1, '2025-01-01T00:00:00Z', '2025-01-01T00:00:20Z')?.leaseUntil, '2025-01-01T00:00:20Z');
});
