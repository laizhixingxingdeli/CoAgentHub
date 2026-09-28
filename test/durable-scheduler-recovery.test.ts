/**
 * MissionRunner / Orchestrator hop queue: enqueue+claim before runtime.start,
 * same-Mission recovery, and no-queue fixtures staying on the old path.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApi } from '../src/api/server.ts';
import { RunTokenRegistry } from '../src/api/run-tokens.ts';
import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import { Orchestrator } from '../src/application/orchestrator.ts';
import { MissionRunner } from '../src/application/mission-runner.ts';
import { Platform } from '../src/application/platform.ts';
import { buildPersistentPlatform, makeIssuer } from '../src/main.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import {
  acquireQueuedHop,
  claimHop,
  completeHop,
  DurableScheduler,
  hopIdempotencyKey,
  nextLogicalHopCycle,
  queuedHopWaitDetail,
  renewHop,
  reportHopFailure,
  type QueuedHop,
} from '../src/application/durable-scheduler.ts';
import type { AgentRuntime, QueuedHopRepository } from '../src/application/ports.ts';
import { ScriptedRuntime } from '../src/runtime/scripted.ts';
import { createMemoryFencedTransaction } from './helpers/fenced-transaction.ts';
import type { ScriptTable } from '../src/runtime/scripted.ts';
import { listenLoopback } from '../src/application/loopback-listen.ts';
import type { MissionContract, WorkOrder } from '../src/kernel/index.ts';

const CONTRACT: MissionContract = {
  intent: '把 X 修好',
  acceptance: ['测试全绿'],
  constraints: [],
  nonGoals: [],
  guardrails: ['不得改 Contract'],
};

const ORDER: WorkOrder = {
  objective: '改 foo',
  allowedScope: ['src/foo.ts'],
  requiredBehaviour: 'foo 返回 1',
  constraints: [],
  acceptance: ['foo() === 1'],
  verification: ['node --test'],
  doNot: [],
  contextRefs: [],
};

const PLAN = {
  findings: 'foo 一直返回 0',
  rootCause: '初始值写错了',
  rejectedHypotheses: ['不是调用方传错'],
  decisions: ['直接改初始值'],
  direction: '改 src/foo.ts',
  risks: [],
};

const COORDINATOR_HAPPY: ScriptTable = {
  'coordinator:-:0': {
    steps: [
      { tool: 'coagent_get_mission', body: {} },
      { tool: 'coagent_update_plan', body: PLAN },
      { tool: 'coagent_create_work_item', body: { title: '修 foo', ...ORDER } },
      {
        tool: 'coagent_dispatch_work_item',
        body: (previous) => ({ workItemIds: [previous.workItemId] }),
      },
    ],
  },
  'coordinator:-:1': {
    steps: [
      { tool: 'coagent_get_mission', body: {} },
      {
        tool: 'coagent_review_execution_result',
        body: {
          workItemId: 'W-1',
          verdict: 'accept',
          acceptanceResults: ORDER.acceptance.map((criterion) => ({
            criterion,
            status: 'pass' as const,
            evidence: '测试替身：逐条核过',
          })),
          reasons: ['自己复跑过 node --test，退出码 0'],
          requiredChanges: [],
        },
      },
      {
        tool: 'coagent_submit_mission_result',
        body: {
          outcome: 'delivered',
          summary: '改好了并验证过',
          acceptanceEvidence: ['node --test 退出码 0'],
          memoryDelta: [],
          openRisks: [],
        },
      },
    ],
  },
};

const EXECUTOR_HAPPY: ScriptTable = {
  'executor:W-1': {
    steps: [
      { tool: 'coagent_get_work_order', body: {} },
      {
        tool: 'coagent_submit_evidence',
        body: { kind: 'test', summary: 'node --test 全绿', command: 'node --test', exitCode: 0 },
      },
      {
        tool: 'coagent_submit_execution_result',
        body: (previous) => ({
          outcome: 'completed',
          summary: '改了初始值',
          changedFiles: ['src/foo.ts'],
          evidenceIds: [previous.evidenceId],
          notes: '无',
        }),
      },
    ],
  },
};

function memoryQueuedHops(): QueuedHopRepository {
  const rows = new Map<string, QueuedHop>();
  return {
    async enqueue(hop) {
      const existing = [...rows.values()].find((row) => row.idempotencyKey === hop.idempotencyKey);
      if (existing) return { ...existing };
      rows.set(hop.id, { ...hop });
      return { ...hop };
    },
    async get(id) {
      const row = rows.get(id);
      return row ? { ...row } : undefined;
    },
    async list() {
      return [...rows.values()].map((row) => ({ ...row }));
    },
    async claim(id, owner, now, until) {
      const row = rows.get(id);
      if (!row) return undefined;
      const updated = claimHop(row, owner, now, until);
      if (updated) rows.set(id, updated);
      return updated ? { ...updated } : undefined;
    },
    async renew(id, owner, generation, now, until) {
      const row = rows.get(id);
      if (!row) return undefined;
      const updated = renewHop(row, owner, generation, now, until);
      if (updated) rows.set(id, updated);
      return updated ? { ...updated } : undefined;
    },
    async complete(id, owner, generation, now) {
      const row = rows.get(id);
      if (!row) return undefined;
      const updated = completeHop(row, owner, generation, now);
      if (updated) rows.set(id, updated);
      return updated ? { ...updated } : undefined;
    },
    async reportFailure(input) {
      const row = rows.get(input.id);
      if (!row) return undefined;
      const updated = reportHopFailure(row, input);
      if (!updated) return undefined;
      if (updated !== row) rows.set(input.id, updated);
      return updated.lastFailure
        ? { ...updated, lastFailure: { ...updated.lastFailure } }
        : { ...updated };
    },
  };
}

function trackingQueue(
  inner: QueuedHopRepository,
  log: string[],
): QueuedHopRepository {
  return {
    enqueue: async (hop) => {
      log.push('enqueue');
      return inner.enqueue(hop);
    },
    get: (id) => inner.get(id),
    list: () => inner.list(),
    claim: async (id, owner, now, until) => {
      log.push('claim');
      return inner.claim(id, owner, now, until);
    },
    renew: (id, owner, generation, now, until) => inner.renew(id, owner, generation, now, until),
    complete: async (id, owner, generation, now) => {
      log.push('complete');
      return inner.complete(id, owner, generation, now);
    },
    reportFailure: inner.reportFailure
      ? async (input) => {
          log.push('reportFailure');
          return inner.reportFailure!(input);
        }
      : undefined,
  };
}

function trackingRuntime(inner: AgentRuntime, log: string[], starts: { count: number }): AgentRuntime {
  return {
    kind: inner.kind,
    start: async (spec) => {
      log.push(`start:${spec.role}`);
      starts.count += 1;
      return inner.start(spec);
    },
  };
}

const servers: Server[] = [];
const tempDirs: string[] = [];
after(() => {
  for (const server of servers) server.close();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

async function harness(opts: {
  coordinator: AgentRuntime;
  executor: AgentRuntime;
  queuedHops?: QueuedHopRepository;
  owner?: string;
  hopIds?: SequentialIds;
  hopClock?: FixedClock;
  executorMaxAttempts?: number;
}) {
  const clock = new FixedClock();
  const activity = new InMemoryActivityLog(clock);
  const ids = new SequentialIds();
  const deliveries = new InMemoryDeliveryRepository(clock, ids);
  const platform = new Platform({
    projects: new InMemoryProjectRepository(),
    deliveries,
    workspace: new InPlaceWorkspaceManager(),
    activity,
    clock,
    ids,
    ...(opts.queuedHops
      ? { transaction: createMemoryFencedTransaction(opts.queuedHops) }
      : {}),
  });
  const tokens = new RunTokenRegistry();
  const server: Server = createApi({ platform, tokens, deliveries });
  await listenLoopback(server, 0);
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  servers.push(server);
  const deps = {
    platform,
    tokens: makeIssuer(platform, tokens),
    baseUrl,
    workspace: new InPlaceWorkspaceManager(),
    coordinator: {
      runtime: opts.coordinator,
      candidates: [{ endpoint: 'local' as const, profileId: 'coordinator-a' }],
    },
    executor: {
      runtime: opts.executor,
      candidates: [{ endpoint: 'local' as const, profileId: 'exec-a' }],
      maxAttempts: opts.executorMaxAttempts,
    },
    queuedHops: opts.queuedHops,
    owner: opts.owner,
    hopIds: opts.hopIds,
    hopClock: opts.hopClock,
  };
  return {
    platform,
    makeOrchestrator: () => new Orchestrator(deps),
    makeRunner: () => new MissionRunner(deps),
  };
}

async function seedQueued(repo: QueuedHopRepository, hop: QueuedHop): Promise<QueuedHop> {
  return repo.enqueue(hop);
}

function coordinatorKey(missionId: string, revision = 1, cycle = 0): string {
  return hopIdempotencyKey({
    missionId,
    role: 'coordinator',
    workItemId: '-',
    contractRevision: revision,
    attemptCycle: cycle,
  });
}

function queuedRow(overrides: Partial<QueuedHop> & Pick<QueuedHop, 'id' | 'missionId' | 'idempotencyKey'>): QueuedHop {
  return {
    projectId: 'P',
    workItemId: '-',
    role: 'coordinator',
    priority: 0,
    availableAt: '2020-01-01T00:00:00.000Z',
    attemptCount: 0,
    maxAttempts: 3,
    status: 'queued',
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('unfinished logical hop keeps its slot when Attempt count grows; completed hops free the next slot', () => {
  const open = queuedRow({
    id: 'h0',
    missionId: 'M-slot',
    idempotencyKey: coordinatorKey('M-slot'),
    status: 'claimed',
    owner: 'dead',
    claimGeneration: 1,
  });
  const slot = { missionId: 'M-slot', role: 'coordinator' as const, workItemId: '-', contractRevision: 1 };
  assert.equal(nextLogicalHopCycle([open], slot), 0);
  assert.equal(nextLogicalHopCycle([{ ...open, status: 'completed' }], slot), 1);
  assert.equal(
    nextLogicalHopCycle(
      [
        { ...open, status: 'completed' },
        queuedRow({
          id: 'h1',
          missionId: 'M-slot',
          idempotencyKey: coordinatorKey('M-slot', 1, 1),
          status: 'claimed',
        }),
      ],
      slot,
    ),
    1,
  );
  assert.equal(
    nextLogicalHopCycle(
      [queuedRow({ id: 'other', missionId: 'M-other', idempotencyKey: coordinatorKey('M-other') })],
      slot,
    ),
    0,
  );
});

test('enqueue+claim happen before runtime.start; later hops are not blocked by the first key', async () => {
  const log: string[] = [];
  const starts = { count: 0 };
  const queuedHops = trackingQueue(memoryQueuedHops(), log);
  const env = await harness({
    coordinator: trackingRuntime(new ScriptedRuntime(COORDINATOR_HAPPY), log, starts),
    executor: trackingRuntime(new ScriptedRuntime(EXECUTOR_HAPPY), log, starts),
    queuedHops,
    owner: 'runner-a',
  });
  await env.platform.createMission({ projectId: 'P', missionId: 'M-order', contract: CONTRACT });
  const result = await env.makeRunner().run('M-order', { projectRoot: process.cwd() });
  assert.deepEqual(result.outcome, { kind: 'awaiting_l3_review' });
  const firstStart = log.indexOf('start:coordinator');
  assert.ok(firstStart > 0);
  assert.deepEqual(log.slice(firstStart - 2, firstStart), ['enqueue', 'claim']);
  assert.equal(log.filter((item) => item === 'start:coordinator').length, 2);
  assert.equal(log.filter((item) => item === 'start:executor').length, 1);
  const rows = await queuedHops.list();
  assert.equal(rows.length, 3);
  assert.equal(new Set(rows.map((row) => row.idempotencyKey)).size, 3);
  assert.ok(rows.every((row) => row.status === 'completed'));
});

test('same pending hop re-entry is idempotent; completed hops do not call runtime.start again', async () => {
  const starts = { count: 0 };
  const queuedHops = memoryQueuedHops();
  const env = await harness({
    coordinator: trackingRuntime(new ScriptedRuntime(COORDINATOR_HAPPY), [], starts),
    executor: trackingRuntime(new ScriptedRuntime(EXECUTOR_HAPPY), [], starts),
    queuedHops,
    owner: 'runner-a',
  });
  await env.platform.createMission({ projectId: 'P', missionId: 'M-idem', contract: CONTRACT });
  const first = await env.makeRunner().run('M-idem', { projectRoot: process.cwd() });
  assert.deepEqual(first.outcome, { kind: 'awaiting_l3_review' });
  assert.equal(starts.count, 3);
  const snapshot = await queuedHops.list();
  const second = await env.makeRunner().run('M-idem', { projectRoot: process.cwd() });
  assert.equal(second.outcome.kind, 'awaiting_l3_review');
  assert.equal(starts.count, 3);
  assert.equal((await queuedHops.list()).length, snapshot.length);
});

test('valid lease and future availableAt return waiting with queryable detail and start=0', async () => {
  const starts = { count: 0 };
  const queuedHops = memoryQueuedHops();
  const env = await harness({
    coordinator: trackingRuntime(new ScriptedRuntime(COORDINATOR_HAPPY), [], starts),
    executor: trackingRuntime(new ScriptedRuntime(EXECUTOR_HAPPY), [], starts),
    queuedHops,
    owner: 'runner-b',
    hopIds: new SequentialIds(),
  });
  await env.platform.createMission({ projectId: 'P', missionId: 'M-lease', contract: CONTRACT });
  const key = coordinatorKey('M-lease');
  const seeded = await seedQueued(queuedHops, {
    id: 'seed-lease',
    projectId: 'P',
    missionId: 'M-lease',
    workItemId: '-',
    role: 'coordinator',
    priority: 0,
    availableAt: '2020-01-01T00:00:00.000Z',
    attemptCount: 0,
    maxAttempts: 3,
    idempotencyKey: key,
    status: 'queued',
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
  });
  const claimed = await queuedHops.claim(
    seeded.id,
    'other-owner',
    '2020-01-01T00:00:00.000Z',
    '2099-01-01T00:00:00.000Z',
  );
  assert.equal(claimed?.claimGeneration, 1);

  const outcome = await env.makeRunner().run('M-lease', { projectRoot: process.cwd() });
  assert.equal(outcome.outcome.kind, 'waiting');
  assert.equal(starts.count, 0);
  const view = await env.platform.getMissionView('M-lease');
  assert.equal(view.status, 'investigating');
  assert.equal(view.waitReason, 'project_busy');
  assert.match(view.waitDetail ?? '', /有效租约/);
  const held = await queuedHops.get('seed-lease');
  assert.equal(held?.owner, 'other-owner');
  assert.equal(held?.claimGeneration, 1);

  const futureRepo = memoryQueuedHops();
  const futureStarts = { count: 0 };
  const futureEnv = await harness({
    coordinator: trackingRuntime(new ScriptedRuntime(COORDINATOR_HAPPY), [], futureStarts),
    executor: trackingRuntime(new ScriptedRuntime(EXECUTOR_HAPPY), [], futureStarts),
    queuedHops: futureRepo,
    owner: 'runner-b',
  });
  await futureEnv.platform.createMission({ projectId: 'P', missionId: 'M-future', contract: CONTRACT });
  await seedQueued(futureRepo, {
    id: 'seed-future',
    projectId: 'P',
    missionId: 'M-future',
    workItemId: '-',
    role: 'coordinator',
    priority: 0,
    availableAt: '2099-01-01T00:00:00.000Z',
    attemptCount: 0,
    maxAttempts: 3,
    idempotencyKey: coordinatorKey('M-future'),
    status: 'queued',
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
  });
  const futureOutcome = await futureEnv.makeRunner().run('M-future', { projectRoot: process.cwd() });
  assert.equal(futureOutcome.outcome.kind, 'waiting');
  assert.equal(futureStarts.count, 0);
  const futureView = await futureEnv.platform.getMissionView('M-future');
  assert.match(futureView.waitDetail ?? '', /availableAt/);
});

test('pause, terminal, and contract revision do not start old queue items', async () => {
  const starts = { count: 0 };
  const queuedHops = memoryQueuedHops();
  const env = await harness({
    coordinator: trackingRuntime(new ScriptedRuntime(COORDINATOR_HAPPY), [], starts),
    executor: trackingRuntime(new ScriptedRuntime(EXECUTOR_HAPPY), [], starts),
    queuedHops,
    owner: 'runner-c',
  });
  await env.platform.createMission({ projectId: 'P', missionId: 'M-pause', contract: CONTRACT });
  await seedQueued(queuedHops, {
    id: 'old-pause',
    projectId: 'P',
    missionId: 'M-pause',
    workItemId: '-',
    role: 'coordinator',
    priority: 0,
    availableAt: '2020-01-01T00:00:00.000Z',
    attemptCount: 0,
    maxAttempts: 3,
    idempotencyKey: coordinatorKey('M-pause'),
    status: 'queued',
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
  });
  await env.platform.pauseMission('M-pause');
  const paused = await env.makeRunner().run('M-pause', { projectRoot: process.cwd() });
  assert.equal(paused.outcome.kind, 'waiting');
  if (paused.outcome.kind === 'waiting') {
    assert.equal(paused.outcome.reason, 'cancelled_by_user');
    assert.match(paused.outcome.detail, /暂停/);
  }
  assert.equal(starts.count, 0);
  assert.equal((await queuedHops.get('old-pause'))?.status, 'queued');
  const pausedView = await env.platform.getMissionView('M-pause');
  assert.equal(pausedView.waitReason, 'cancelled_by_user');
  assert.match(pausedView.waitDetail ?? '', /暂停/);

  const cancelStarts = { count: 0 };
  const cancelQueue = memoryQueuedHops();
  const cancelEnv = await harness({
    coordinator: trackingRuntime(new ScriptedRuntime(COORDINATOR_HAPPY), [], cancelStarts),
    executor: trackingRuntime(new ScriptedRuntime(EXECUTOR_HAPPY), [], cancelStarts),
    queuedHops: cancelQueue,
    owner: 'runner-c',
  });
  await cancelEnv.platform.createMission({ projectId: 'P', missionId: 'M-cancel', contract: CONTRACT });
  await seedQueued(cancelQueue, queuedRow({ id: 'old-cancel', missionId: 'M-cancel', idempotencyKey: coordinatorKey('M-cancel') }));
  await cancelEnv.platform.cancelMission('M-cancel', '不要了');
  const cancelled = await cancelEnv.makeRunner().run('M-cancel', { projectRoot: process.cwd() });
  assert.equal(cancelled.outcome.kind, 'blocked');
  assert.equal(cancelStarts.count, 0);
  assert.equal((await cancelQueue.get('old-cancel'))?.status, 'queued');
  const cancelView = await cancelEnv.platform.getMissionView('M-cancel');
  assert.equal(cancelView.status, 'blocked');
  assert.equal(cancelView.waitReason, 'cancelled_by_user');

  const blockStarts = { count: 0 };
  const blockQueue = memoryQueuedHops();
  const blockEnv = await harness({
    coordinator: trackingRuntime(new ScriptedRuntime(COORDINATOR_HAPPY), [], blockStarts),
    executor: trackingRuntime(new ScriptedRuntime(EXECUTOR_HAPPY), [], blockStarts),
    queuedHops: blockQueue,
    owner: 'runner-c',
  });
  await blockEnv.platform.createMission({ projectId: 'P', missionId: 'M-block', contract: CONTRACT });
  await seedQueued(blockQueue, queuedRow({ id: 'old-block', missionId: 'M-block', idempotencyKey: coordinatorKey('M-block') }));
  const coord = await blockEnv.platform.startCoordinatorAttempt('M-block');
  await blockEnv.platform.submitMissionResult('M-block', coord.attemptId, {
    outcome: 'blocked',
    summary: '前提不成立，做不下去',
    acceptanceEvidence: [],
    memoryDelta: [],
    openRisks: ['blocked'],
  });
  const blocked = await blockEnv.makeRunner().run('M-block', { projectRoot: process.cwd() });
  assert.equal(blocked.outcome.kind, 'blocked');
  if (blocked.outcome.kind === 'blocked') {
    assert.match(blocked.outcome.reason, /前提不成立/);
  }
  assert.equal(blockStarts.count, 0);
  assert.equal((await blockQueue.get('old-block'))?.status, 'queued');
  const blockView = await blockEnv.platform.getMissionView('M-block');
  assert.equal(blockView.status, 'awaiting_review');
  assert.equal(blockView.result?.outcome, 'blocked');

  const doneStarts = { count: 0 };
  const doneQueue = memoryQueuedHops();
  const done = await harness({
    coordinator: trackingRuntime(new ScriptedRuntime(COORDINATOR_HAPPY), [], doneStarts),
    executor: trackingRuntime(new ScriptedRuntime(EXECUTOR_HAPPY), [], doneStarts),
    queuedHops: doneQueue,
    owner: 'runner-c',
  });
  await done.platform.createMission({ projectId: 'P', missionId: 'M-term', contract: CONTRACT });
  const delivered = await done.makeRunner().run('M-term', { projectRoot: process.cwd() });
  assert.deepEqual(delivered.outcome, { kind: 'awaiting_l3_review' });
  const afterFirst = doneStarts.count;
  await done.platform.finalizeMission('M-term', {
    verdict: 'merge',
    reasons: ['ok'],
    projectRoot: process.cwd(),
  });
  const terminal = await done.makeRunner().run('M-term', { projectRoot: process.cwd() });
  assert.equal(terminal.outcome.kind, 'delivered');
  assert.equal(doneStarts.count, afterFirst);
  assert.equal((await done.platform.getMissionView('M-term')).status, 'completed');

  const revStarts = { count: 0 };
  const revQueue = memoryQueuedHops();
  const rev = await harness({
    coordinator: trackingRuntime(new ScriptedRuntime(COORDINATOR_HAPPY), [], revStarts),
    executor: trackingRuntime(new ScriptedRuntime(EXECUTOR_HAPPY), [], revStarts),
    queuedHops: revQueue,
    owner: 'runner-new',
  });
  await rev.platform.createMission({ projectId: 'P', missionId: 'M-rev', contract: CONTRACT });
  const old = await seedQueued(revQueue, {
    id: 'old-rev',
    projectId: 'P',
    missionId: 'M-rev',
    workItemId: '-',
    role: 'coordinator',
    priority: 0,
    availableAt: '2020-01-01T00:00:00.000Z',
    attemptCount: 0,
    maxAttempts: 3,
    idempotencyKey: coordinatorKey('M-rev', 1),
    status: 'queued',
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z',
  });
  await revQueue.claim(old.id, 'old-owner', '2020-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z');
  await rev.platform.reviseContract('M-rev', { ...CONTRACT, intent: '按新契约修' });
  const revised = await rev.makeRunner().run('M-rev', { projectRoot: process.cwd() });
  assert.deepEqual(revised.outcome, { kind: 'awaiting_l3_review' });
  assert.ok(revStarts.count > 0);
  const leftover = await revQueue.get('old-rev');
  assert.equal(leftover?.owner, 'old-owner');
  assert.equal(leftover?.claimGeneration, 1);
  assert.equal(leftover?.status, 'claimed');
  assert.ok((await revQueue.list()).some((row) => row.idempotencyKey === coordinatorKey('M-rev', 2)));
});

test('runtime exception does not mark an unrun hop completed', async () => {
  const queuedHops = memoryQueuedHops();
  const boom: AgentRuntime = {
    kind: 'boom',
    start: async () => {
      throw new Error('adapter exploded');
    },
  };
  const env = await harness({
    coordinator: boom,
    executor: new ScriptedRuntime(EXECUTOR_HAPPY),
    queuedHops,
    owner: 'runner-x',
  });
  await env.platform.createMission({ projectId: 'P', missionId: 'M-boom', contract: CONTRACT });
  await env.makeRunner().run('M-boom', { projectRoot: process.cwd() });
  const rows = await queuedHops.list();
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0]?.status, 'completed');
});

async function crashAfterClaimAndAttempt(input: {
  statePath: string;
  missionId: string;
  hopId: string;
  owner: string;
  leaseUntil: string;
}): Promise<{ key: string; generation: number }> {
  const first = await buildPersistentPlatform(input.statePath, {
    workspace: new InPlaceWorkspaceManager(),
    reconcile: false,
  });
  await first.platform.createMission({ projectId: 'P', missionId: input.missionId, contract: CONTRACT });
  const key = coordinatorKey(input.missionId);
  await first.queuedHops.enqueue(queuedRow({ id: input.hopId, missionId: input.missionId, idempotencyKey: key }));
  const claimed = await first.queuedHops.claim(
    input.hopId,
    input.owner,
    '2020-01-01T00:00:00.000Z',
    input.leaseUntil,
  );
  await first.platform.startCoordinatorAttempt(input.missionId);
  first.persist();
  return { key, generation: claimed?.claimGeneration ?? 0 };
}

async function reopenFileRunner(statePath: string, starts: { count: number }, owner: string) {
  const built = await buildPersistentPlatform(statePath, {
    workspace: new InPlaceWorkspaceManager(),
  });
  const server: Server = createApi({
    platform: built.platform,
    tokens: built.tokens,
    deliveries: built.deliveries,
    onMutation: built.persist,
  });
  await listenLoopback(server, 0);
  servers.push(server);
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const runner = new MissionRunner({
    platform: built.platform,
    tokens: makeIssuer(built.platform, built.tokens),
    baseUrl,
    workspace: new InPlaceWorkspaceManager(),
    coordinator: {
      runtime: trackingRuntime(new ScriptedRuntime(COORDINATOR_HAPPY), [], starts),
      candidates: [{ endpoint: 'local' as const, profileId: 'coordinator-a' }],
    },
    executor: {
      runtime: trackingRuntime(new ScriptedRuntime(EXECUTOR_HAPPY), [], starts),
      candidates: [{ endpoint: 'local' as const, profileId: 'exec-a' }],
    },
    queuedHops: built.queuedHops,
    owner,
  });
  return { built, runner };
}

test('file store: same Mission crash after claim+attempt; expired takeover vs live lease', async () => {
  const expiredDir = mkdtempSync(join(tmpdir(), 'hop-expired-'));
  tempDirs.push(expiredDir);
  const expiredPath = join(expiredDir, 'state.json');
  const expiredKey = coordinatorKey('M-file-exp');
  const crashedExp = await crashAfterClaimAndAttempt({
    statePath: expiredPath,
    missionId: 'M-file-exp',
    hopId: 'file-exp',
    owner: 'dead-owner',
    leaseUntil: '2020-01-01T00:00:01.000Z',
  });
  assert.equal(crashedExp.key, expiredKey);
  assert.equal(crashedExp.generation, 1);

  const expStarts = { count: 0 };
  const exp = await reopenFileRunner(expiredPath, expStarts, 'runner-reopen');
  assert.equal(exp.built.reconciled.interrupted.length, 1);
  const expResult = await exp.runner.run('M-file-exp', { projectRoot: process.cwd() });
  assert.deepEqual(expResult.outcome, { kind: 'awaiting_l3_review' });
  assert.equal((await exp.built.platform.getMissionView('M-file-exp')).status, 'awaiting_review');
  assert.equal(expStarts.count, 3);
  const expRows = await exp.built.queuedHops.list();
  assert.equal(expRows.length, 3);
  const taken = expRows.find((row) => row.id === 'file-exp');
  assert.equal(taken?.idempotencyKey, expiredKey);
  assert.ok((taken?.claimGeneration ?? 0) > 1);
  assert.equal(taken?.status, 'completed');
  assert.equal(expRows.filter((row) => row.idempotencyKey === expiredKey).length, 1);
  assert.equal(new Set(expRows.map((row) => row.idempotencyKey)).size, 3);

  const liveDir = mkdtempSync(join(tmpdir(), 'hop-live-'));
  tempDirs.push(liveDir);
  const livePath = join(liveDir, 'state.json');
  const liveKey = coordinatorKey('M-file-live');
  const crashedLive = await crashAfterClaimAndAttempt({
    statePath: livePath,
    missionId: 'M-file-live',
    hopId: 'file-live',
    owner: 'still-alive',
    leaseUntil: '2099-01-01T00:00:00.000Z',
  });
  assert.equal(crashedLive.generation, 1);

  const liveStarts = { count: 0 };
  const live = await reopenFileRunner(livePath, liveStarts, 'runner-reopen');
  const liveResult = await live.runner.run('M-file-live', { projectRoot: process.cwd() });
  assert.equal(liveResult.outcome.kind, 'waiting');
  assert.equal(liveStarts.count, 0);
  const liveRows = await live.built.queuedHops.list();
  assert.equal(liveRows.length, 1);
  const still = liveRows[0];
  assert.equal(still?.id, 'file-live');
  assert.equal(still?.idempotencyKey, liveKey);
  assert.equal(still?.owner, 'still-alive');
  assert.equal(still?.claimGeneration, 1);
  assert.equal(still?.status, 'claimed');
  const liveView = await live.built.platform.getMissionView('M-file-live');
  assert.equal(liveView.status, 'investigating');
  assert.equal(liveView.waitReason, 'project_busy');
  assert.match(liveView.waitDetail ?? '', /有效租约/);
});

test('acquireQueuedHop parks dead_letter instead of misreporting a lease wait', async () => {
  const repo = memoryQueuedHops();
  const clock = new FixedClock('2020-01-01T00:00:00.000Z');
  const hop = await repo.enqueue(queuedRow({
    id: 'h-dead',
    missionId: 'M-dead',
    idempotencyKey: coordinatorKey('M-dead'),
  }));
  const claimed = await repo.claim(
    hop.id,
    'runner',
    '2020-01-01T00:00:00.000Z',
    '2020-01-01T00:01:00.000Z',
  );
  assert.equal(claimed?.claimGeneration, 1);
  const dead = await repo.reportFailure!({
    id: hop.id,
    claimGeneration: 1,
    attemptId: 'A-1',
    failedAt: '2020-01-01T00:00:30.000Z',
    classification: 'rule',
    disposition: 'do_not_retry',
    retryable: false,
  });
  assert.equal(dead?.status, 'dead_letter');
  const scheduler = new DurableScheduler(repo, clock, { next: (prefix) => `${prefix}-x` });
  const acquired = await acquireQueuedHop({
    scheduler,
    repository: repo,
    owner: 'runner-b',
    leaseMs: 60_000,
    nowIso: clock.now().toISOString(),
    input: {
      projectId: 'P',
      missionId: 'M-dead',
      workItemId: '-',
      role: 'coordinator',
      priority: 0,
      availableAt: clock.now().toISOString(),
      attemptCount: 0,
      maxAttempts: 3,
      idempotencyKey: coordinatorKey('M-dead'),
    },
  });
  assert.equal(acquired.kind, 'waiting');
  if (acquired.kind === 'waiting') {
    assert.equal(acquired.wait, 'dead_letter');
    assert.match(queuedHopWaitDetail(acquired), /死信/);
  }
  assert.equal((await repo.get(hop.id))?.status, 'dead_letter');
});

test('single-id queue: retryable failure waits, due reclaim dead-letters, missing reporter does not complete',
  async () => {
    const hopClock = new FixedClock('2026-01-01T00:00:00.000Z');
    const starts = { count: 0 };
    const queuedHops = memoryQueuedHops();
    const env = await harness({
      coordinator: trackingRuntime(new ScriptedRuntime(COORDINATOR_HAPPY), [], starts),
      executor: trackingRuntime(new ScriptedRuntime({
        'executor:W-1': { steps: [], upstreamFailure: 'HTTP 503 Service Unavailable' },
      }), [], starts),
      queuedHops,
      owner: 'runner-fail',
      hopClock,
      executorMaxAttempts: 2,
    });
    await env.platform.createMission({ projectId: 'P', missionId: 'M-sid', contract: CONTRACT });
    const first = await env.makeOrchestrator().runMission('M-sid', { projectRoot: process.cwd() });
    assert.equal(first.kind, 'waiting');
    if (first.kind === 'waiting') {
      assert.equal(first.reason, 'project_busy');
      assert.match(first.detail, /退避/);
    }
    const exec1 = (await queuedHops.list()).filter((row) => row.role === 'executor');
    assert.equal(exec1.length, 1);
    assert.equal(exec1[0]?.status, 'retry_wait');
    assert.equal(exec1[0]?.attemptCount, 1);
    const startsAfterFirst = starts.count;

    const early = await env.makeOrchestrator().runMission('M-sid', { projectRoot: process.cwd() });
    assert.equal(early.kind, 'waiting');
    assert.equal(starts.count, startsAfterFirst);
    assert.equal((await queuedHops.list()).find((row) => row.role === 'executor')?.attemptCount, 1);

    hopClock.advance(Date.parse(exec1[0]!.availableAt) - Date.parse('2026-01-01T00:00:00.000Z'));
    const second = await env.makeOrchestrator().runMission('M-sid', { projectRoot: process.cwd() });
    assert.equal(second.kind, 'waiting');
    if (second.kind === 'waiting') {
      assert.equal(second.reason, 'attempt_limit_reached');
      assert.match(second.detail, /死信/);
    }
    const exec2 = (await queuedHops.list()).filter((row) => row.role === 'executor');
    assert.equal(exec2.length, 1);
    assert.equal(exec2[0]?.status, 'dead_letter');
    assert.equal(exec2[0]?.attemptCount, 2);
    assert.notEqual((await env.platform.getMissionView('M-sid')).status, 'completed');

    const bare = memoryQueuedHops();
    const unsupported: QueuedHopRepository = {
      enqueue: (hop) => bare.enqueue(hop),
      get: (id) => bare.get(id),
      list: () => bare.list(),
      claim: (id, owner, now, until) => bare.claim(id, owner, now, until),
      renew: (id, owner, generation, now, until) => bare.renew(id, owner, generation, now, until),
      complete: (id, owner, generation, now) => bare.complete(id, owner, generation, now),
    };
    const boom: AgentRuntime = {
      kind: 'boom',
      start: async () => {
        throw new Error('adapter exploded');
      },
    };
    const missing = await harness({
      coordinator: boom,
      executor: new ScriptedRuntime(EXECUTOR_HAPPY),
      queuedHops: unsupported,
      owner: 'runner-missing',
    });
    await missing.platform.createMission({ projectId: 'P', missionId: 'M-missing', contract: CONTRACT });
    await assert.rejects(
      missing.makeOrchestrator().runMission('M-missing', { projectRoot: process.cwd() }),
      /does not support failure reporting/,
    );
    const leftover = await unsupported.list();
    assert.equal(leftover.length, 1);
    assert.notEqual(leftover[0]?.status, 'completed');
  });
