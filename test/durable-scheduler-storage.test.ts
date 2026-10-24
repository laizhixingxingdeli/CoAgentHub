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
import { Project } from '../src/kernel/index.ts';

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
  repo: FileQueuedHopRepository,
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

