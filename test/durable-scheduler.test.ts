import test from 'node:test';
import assert from 'node:assert/strict';
import { DurableScheduler } from '../src/application/durable-scheduler.ts';

test('DurableScheduler validates inputs and creates complete queued records', async () => {
  let sequence = 0;
  const rows = new Map<string, any>();
  const scheduler = new DurableScheduler({
    async enqueue(row) { rows.set(row.idempotencyKey, row); return row; },
    async get(id) { return [...rows.values()].find((row) => row.id === id); },
    async list() { return [...rows.values()]; },
  }, { now: () => new Date('2025-01-01T00:00:00Z') }, { next: () => `HOP-${++sequence}` });
  const input = { projectId: 'p', missionId: 'm', workItemId: 'w', role: 'executor' as const, priority: 1,
    availableAt: '2025-01-02T00:00:00Z', attemptCount: 0, maxAttempts: 3, idempotencyKey: 'key' };
  const hop = await scheduler.enqueue(input);
  assert.equal(hop.status, 'queued');
  assert.equal(hop.id, 'HOP-1');
  assert.equal(hop.createdAt, hop.updatedAt);
  for (const bad of [{ ...input, projectId: ' ' }, { ...input, priority: Infinity },
    { ...input, availableAt: 'bad' }, { ...input, attemptCount: 4 }]) {
    await assert.rejects(scheduler.enqueue(bad));
  }
  assert.equal(rows.size, 1);
});
