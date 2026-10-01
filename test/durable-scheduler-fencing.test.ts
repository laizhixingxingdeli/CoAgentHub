import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileActivityLog,
  FileDeliveryRepository,
  FileProjectRepository,
  FileQueuedHopRepository,
  FileStateStore,
  PersistentIds,
} from '../src/application/file-store.ts';
import { holdsCurrentClaim, type ClaimFence, type QueuedHop } from '../src/application/durable-scheduler.ts';
import { Project } from '../src/kernel/index.ts';
import type { WorkOrder } from '../src/kernel/index.ts';
import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import { Platform, PlatformRuleError, type QueueClaimIdentity } from '../src/application/platform.ts';
import type { CommandTransaction, FencedCommandTransaction } from '../src/application/ports.ts';
import {
  PgActivityLog,
  PgDeliveryRepository,
  PgIds,
  PgProjectRepository,
  PgQueuedHopRepository,
  PgStateStore,
} from '../src/application/pg-store.ts';
import { ensureTestDatabase } from './helpers/pg.ts';

const NOW = '2025-01-01T00:00:00Z';
const LEASE = '2025-01-01T00:00:10Z';
const LATER = '2025-01-01T00:00:20Z';

function queuedHop(overrides: Partial<QueuedHop> = {}): QueuedHop {
  return {
    id: 'h1',
    projectId: 'p',
    missionId: 'm',
    workItemId: 'w',
    role: 'executor',
    priority: 1,
    availableAt: NOW,
    attemptCount: 0,
    maxAttempts: 2,
    idempotencyKey: 'fence-key',
    status: 'queued',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function claimedHop(overrides: Partial<QueuedHop> = {}): QueuedHop {
  return queuedHop({
    status: 'claimed',
    owner: 'owner',
    leaseUntil: LEASE,
    claimGeneration: 1,
    ...overrides,
  });
}

test('holdsCurrentClaim accepts only a live claimed hop with matching owner and generation', () => {
  const hop = claimedHop();
  const fence: ClaimFence = { id: hop.id, owner: 'owner', claimGeneration: 1, now: NOW };
  assert.equal(holdsCurrentClaim(hop, fence), true);
  assert.equal(holdsCurrentClaim(undefined, fence), false);
  assert.equal(holdsCurrentClaim(hop, { ...fence, id: 'other' }), false);
  assert.equal(holdsCurrentClaim(hop, { ...fence, owner: 'intruder' }), false);
  assert.equal(holdsCurrentClaim(hop, { ...fence, claimGeneration: 0 }), false);
  assert.equal(holdsCurrentClaim(hop, { ...fence, now: LEASE }), false);
  assert.equal(holdsCurrentClaim(hop, { ...fence, now: '2025-01-01T00:00:10.001Z' }), false);
  assert.equal(holdsCurrentClaim({ ...hop, status: 'queued' }, fence), false);
  assert.equal(holdsCurrentClaim({ ...hop, status: 'completed' }, fence), false);
  assert.equal(holdsCurrentClaim({ ...hop, leaseUntil: undefined }, fence), false);
});

test('file fenced command commits test project writes for a live matching claim', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hop-fence-ok-'));
  try {
    const path = join(dir, 'state.json');
    const store = new FileStateStore(path);
    const repo = new FileQueuedHopRepository(store);
    const projects = new FileProjectRepository(store);
    await repo.enqueue(queuedHop());
    const claimed = await repo.claim('h1', 'owner', NOW, LEASE);
    assert.equal(claimed?.claimGeneration, 1);
    const queueBefore = await repo.get('h1');
    await store.runFenced({ id: 'h1', owner: 'owner', claimGeneration: 1, now: NOW }, async () => {
      const project = Project.create({ id: 'P-fence' });
      await projects.save(project);
    });
    assert.equal((await projects.get('P-fence'))?.id, 'P-fence');
    assert.deepEqual(await repo.get('h1'), queueBefore);
    const reopened = new FileStateStore(path);
    assert.equal((await new FileProjectRepository(reopened).get('P-fence'))?.id, 'P-fence');
    assert.deepEqual(await new FileQueuedHopRepository(reopened).get('h1'), queueBefore);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('file fenced command rejects stale generation, wrong owner, expired lease, and missing hop without mutation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hop-fence-reject-'));
  try {
    const path = join(dir, 'state.json');
    const store = new FileStateStore(path);
    const repo = new FileQueuedHopRepository(store);
    const projects = new FileProjectRepository(store);
    await repo.enqueue(queuedHop());
    const claimed = await repo.claim('h1', 'owner', NOW, LEASE);
    assert.ok(claimed);
    const seed = Project.create({ id: 'P-seed' });
    await projects.save(seed);
    const queueBefore = structuredClone(await repo.get('h1'));
    const diskBefore = readFileSync(path);
    const projectBefore = JSON.stringify((await projects.get('P-seed'))!.toSnapshot());

    const writeInCallback = async () => {
      (await projects.get('P-seed'))!.createMission({
        id: 'M-no',
        contract: { intent: 'x', acceptance: ['a'], constraints: [], nonGoals: [], guardrails: [] },
      });
      await projects.save((await projects.get('P-seed'))!);
      await projects.save(Project.create({ id: 'P-rejected' }));
    };

    const rejects = [
      { id: 'h1', owner: 'owner', claimGeneration: 0, now: NOW },
      { id: 'h1', owner: 'intruder', claimGeneration: 1, now: NOW },
      { id: 'h1', owner: 'owner', claimGeneration: 1, now: LEASE },
      { id: 'missing', owner: 'owner', claimGeneration: 1, now: NOW },
    ] as const;
    for (const fence of rejects) {
      await assert.rejects(store.runFenced(fence, writeInCallback), /claim fence rejected/);
      assert.deepEqual(await repo.get('h1'), queueBefore);
      assert.equal(JSON.stringify((await projects.get('P-seed'))!.toSnapshot()), projectBefore);
      assert.equal(await projects.get('P-rejected'), undefined);
      assert.deepEqual(readFileSync(path), diskBefore);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reclaim after expiry strictly increases generation; reopen still rejects the old generation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hop-fence-reclaim-'));
  try {
    const path = join(dir, 'state.json');
    const store = new FileStateStore(path);
    const repo = new FileQueuedHopRepository(store);
    const projects = new FileProjectRepository(store);
    await repo.enqueue(queuedHop());
    const first = await repo.claim('h1', 'owner', NOW, LEASE);
    assert.equal(first?.claimGeneration, 1);
    const taken = await repo.claim('h1', 'next', LEASE, LATER);
    assert.equal(taken?.claimGeneration, 2);
    assert.ok((taken?.claimGeneration ?? 0) > (first?.claimGeneration ?? 0));

    await assert.rejects(
      store.runFenced({ id: 'h1', owner: 'owner', claimGeneration: 1, now: LEASE }, async () => {
        await projects.save(Project.create({ id: 'P-stale' }));
      }),
      /claim fence rejected/,
    );
    assert.equal(await projects.get('P-stale'), undefined);
    assert.equal((await repo.get('h1'))?.claimGeneration, 2);

    await store.runFenced({ id: 'h1', owner: 'next', claimGeneration: 2, now: LEASE }, async () => {
      await projects.save(Project.create({ id: 'P-live' }));
    });
    assert.equal((await projects.get('P-live'))?.id, 'P-live');

    const reopened = new FileStateStore(path);
    const reopenedRepo = new FileQueuedHopRepository(reopened);
    const reopenedProjects = new FileProjectRepository(reopened);
    assert.equal((await reopenedRepo.get('h1'))?.claimGeneration, 2);
    await assert.rejects(
      reopened.runFenced({ id: 'h1', owner: 'next', claimGeneration: 1, now: LEASE }, async () => {
        await reopenedProjects.save(Project.create({ id: 'P-old-gen' }));
      }),
      /claim fence rejected/,
    );
    assert.equal(await reopenedProjects.get('P-old-gen'), undefined);
    await reopened.runFenced({ id: 'h1', owner: 'next', claimGeneration: 2, now: LEASE }, async () => {
      await reopenedProjects.save(Project.create({ id: 'P-reopen' }));
    });
    assert.equal((await reopenedProjects.get('P-reopen'))?.id, 'P-reopen');
    assert.equal((await reopenedProjects.get('P-live'))?.id, 'P-live');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nested fenced rejection rolls back the enclosing command transaction', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hop-fence-nested-'));
  try {
    const path = join(dir, 'state.json');
    const store = new FileStateStore(path);
    const repo = new FileQueuedHopRepository(store);
    const projects = new FileProjectRepository(store);
    await repo.enqueue(queuedHop());
    await repo.claim('h1', 'owner', NOW, LEASE);
    await projects.save(Project.create({ id: 'P-outer' }));
    const diskBefore = readFileSync(path);
    const queueBefore = structuredClone(await repo.get('h1'));

    await assert.rejects(
      store.run(async () => {
        const live = (await projects.get('P-outer'))!;
        live.createMission({
          id: 'M-nested',
          contract: { intent: 'x', acceptance: ['a'], constraints: [], nonGoals: [], guardrails: [] },
        });
        await projects.save(live);
        await store.runFenced({ id: 'h1', owner: 'owner', claimGeneration: 99, now: NOW }, async () => {
          await projects.save(Project.create({ id: 'P-inner' }));
        });
      }),
      /claim fence rejected/,
    );

    assert.deepEqual(readFileSync(path), diskBefore);
    assert.deepEqual(await repo.get('h1'), queueBefore);
    assert.equal((await projects.get('P-outer'))!.missions.length, 0);
    assert.equal(await projects.get('P-inner'), undefined);

    await assert.rejects(
      store.runFenced({ id: 'h1', owner: 'owner', claimGeneration: 1, now: NOW }, async () => {
        await store.run(async () => {
          await projects.save(Project.create({ id: 'P-throw' }));
          throw new Error('callback failed');
        });
      }),
      /callback failed/,
    );
    assert.equal(await projects.get('P-throw'), undefined);
    assert.deepEqual(await repo.get('h1'), queueBefore);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const CONTRACT = {
  intent: 'fence',
  acceptance: ['a'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
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
  findings: '查到了',
  rejectedHypotheses: [] as string[],
  decisions: [] as string[],
  direction: '这么改',
  risks: [] as string[],
};
const origin = { clientType: 'cli', conversationRef: 'me' };

function spyFenced(store: CommandTransaction & FencedCommandTransaction) {
  let run = 0;
  let fenced = 0;
  let lastFence: ClaimFence | undefined;
  const origRun = store.run.bind(store);
  const origFenced = store.runFenced.bind(store);
  store.run = ((fn) => {
    run += 1;
    return origRun(fn);
  }) as typeof store.run;
  store.runFenced = ((fence, fn) => {
    fenced += 1;
    lastFence = fence;
    return origFenced(fence, fn);
  }) as typeof store.runFenced;
  return {
    get run() {
      return run;
    },
    get fenced() {
      return fenced;
    },
    get lastFence() {
      return lastFence;
    },
    reset() {
      run = 0;
      fenced = 0;
      lastFence = undefined;
    },
  };
}

async function snapshotOf(
  projects: { get(id: string): Promise<Project | undefined> },
  activity: { list(missionId: string): Promise<readonly unknown[]> },
  deliveries: { listForMission(missionId: string): Promise<readonly unknown[]> },
) {
  const project = await projects.get('P');
  return {
    project: JSON.stringify(project?.toSnapshot()),
    events: (await activity.list('M')).length,
    deliveries: (await deliveries.listForMission('M')).length,
  };
}

test('platform queue writes fail closed without FencedCommandTransaction and leave no state, events, or deliveries', async () => {
  const clock = new FixedClock(NOW);
  const activity = new InMemoryActivityLog(clock);
  const projects = new InMemoryProjectRepository();
  const ids = new SequentialIds();
  const deliveries = new InMemoryDeliveryRepository(clock, ids);
  const platform = new Platform({ projects, deliveries, activity, clock, ids });
  await platform.createMission({ projectId: 'P', missionId: 'M', contract: CONTRACT, origin });
  const { attemptId } = await platform.startCoordinatorAttempt('M');
  const before = await snapshotOf(projects, activity, deliveries);
  const claim: QueueClaimIdentity = { id: 'h1', owner: 'owner', claimGeneration: 1 };

  await assert.rejects(
    () => platform.updateFindings('M', attemptId, '不该落下', undefined, claim),
    (e: unknown) => e instanceof PlatformRuleError && e.code === 'CLAIM_FENCE_UNAVAILABLE',
  );
  await assert.rejects(
    () => platform.escalateToL3('M', attemptId, { question: 'q', why: 'w', optionsConsidered: ['a'] }, claim),
    (e: unknown) => e instanceof PlatformRuleError && e.code === 'CLAIM_FENCE_UNAVAILABLE',
  );
  await assert.rejects(
    () => platform.finishAttempt('M', attemptId, { endedBy: 'structured_submit' }, claim),
    (e: unknown) => e instanceof PlatformRuleError && e.code === 'CLAIM_FENCE_UNAVAILABLE',
  );
  assert.deepEqual(await snapshotOf(projects, activity, deliveries), before);

  const runOnly: CommandTransaction = { run: (fn) => fn() };
  const gated = new Platform({
    projects,
    deliveries,
    activity,
    clock,
    ids,
    transaction: runOnly,
  });
  await assert.rejects(
    () => gated.updatePlan('M', attemptId, PLAN, claim),
    (e: unknown) => e instanceof PlatformRuleError && e.code === 'CLAIM_FENCE_UNAVAILABLE',
  );
  assert.deepEqual(await snapshotOf(projects, activity, deliveries), before);

  await platform.updateFindings('M', attemptId, '无领取身份仍可写');
  assert.equal((await projects.get('P'))!.missions[0]!.plan?.findings, '无领取身份仍可写');
});

test('platform queue writes without claim keep using transaction.run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plat-fence-run-'));
  try {
    const store = new FileStateStore(join(dir, 'state.json'));
    const clock = new FixedClock(NOW);
    const ids = new PersistentIds(store);
    const projects = new FileProjectRepository(store);
    const activity = new FileActivityLog(store, clock);
    const deliveries = new FileDeliveryRepository(store, clock, ids);
    const spy = spyFenced(store);
    const platform = new Platform({
      projects,
      deliveries,
      activity,
      clock,
      ids,
      transaction: store,
    });
    spy.reset();
    await platform.createMission({ projectId: 'P', missionId: 'M', contract: CONTRACT, origin });
    assert.ok(spy.run >= 1);
    assert.equal(spy.fenced, 0);
    spy.reset();
    const { attemptId } = await platform.startCoordinatorAttempt('M');
    assert.ok(spy.run >= 1);
    assert.equal(spy.fenced, 0);
    spy.reset();
    await platform.updateFindings('M', attemptId, '非队列');
    assert.ok(spy.run >= 1);
    assert.equal(spy.fenced, 0);
    assert.equal((await projects.get('P'))!.missions[0]!.plan?.findings, '非队列');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function filePlatformFence() {
  const dir = mkdtempSync(join(tmpdir(), 'plat-fence-'));
  const store = new FileStateStore(join(dir, 'state.json'));
  const clock = new FixedClock(NOW);
  const ids = new PersistentIds(store);
  const projects = new FileProjectRepository(store);
  const activity = new FileActivityLog(store, clock);
  const deliveries = new FileDeliveryRepository(store, clock, ids);
  const hops = new FileQueuedHopRepository(store);
  const platform = new Platform({
    projects,
    deliveries,
    activity,
    clock,
    ids,
    transaction: store,
  });
  return { dir, store, clock, projects, activity, deliveries, hops, platform, ids };
}

async function claimLive(hops: FileQueuedHopRepository, id = 'h1') {
  await hops.enqueue(queuedHop({ id, projectId: 'P', missionId: 'M' }));
  const claimed = await hops.claim(id, 'owner', NOW, LEASE);
  assert.equal(claimed?.claimGeneration, 1);
  return { id, owner: 'owner', claimGeneration: 1 } satisfies QueueClaimIdentity;
}

test('file platform fenced writes reject stale or expired claims after takeover; live generation commits', async () => {
  const ctx = await filePlatformFence();
  try {
    const { platform, hops, projects, activity, deliveries, clock, store } = ctx;
    const live = await claimLive(hops);
    await platform.createMission({ projectId: 'P', missionId: 'M', contract: CONTRACT, origin });
    const { attemptId } = await platform.startCoordinatorAttempt('M');
    const spy = spyFenced(store);

    spy.reset();
    await platform.updateFindings('M', attemptId, 'live', undefined, live);
    assert.equal(spy.fenced, 1);
    assert.equal(spy.lastFence?.now, clock.now().toISOString());
    assert.equal(spy.lastFence?.id, live.id);
    assert.equal(spy.lastFence?.owner, live.owner);
    assert.equal(spy.lastFence?.claimGeneration, 1);
    assert.equal((await projects.get('P'))!.missions[0]!.plan?.findings, 'live');

    const sneaky = { ...live, now: '1999-01-01T00:00:00.000Z' };
    spy.reset();
    await platform.updateFindings('M', attemptId, 'clock-now', undefined, sneaky);
    assert.equal(spy.lastFence?.now, clock.now().toISOString());
    assert.notEqual(spy.lastFence?.now, sneaky.now);

    const taken = await hops.claim(live.id, 'next', LEASE, LATER);
    assert.equal(taken?.claimGeneration, 2);
    const before = await snapshotOf(projects, activity, deliveries);
    spy.reset();
    await assert.rejects(
      () => platform.updateFindings('M', attemptId, 'stale-gen', undefined, live),
      (e: unknown) => e instanceof PlatformRuleError && e.code === 'CLAIM_FENCE_REJECTED',
    );
    assert.equal(spy.fenced, 1);
    assert.deepEqual(await snapshotOf(projects, activity, deliveries), before);
    assert.equal((await projects.get('P'))!.missions[0]!.plan?.findings, 'live\n\n—— 第 2 次补充\nclock-now');
    assert.equal((await hops.get(live.id))?.claimGeneration, 2);

    clock.advance(Date.parse(LEASE) - Date.parse(NOW));
    const expired: QueueClaimIdentity = { id: live.id, owner: 'next', claimGeneration: 2 };
    // clock == LEASE, leaseUntil == LATER still live; expire by writing at LATER.
    clock.advance(Date.parse(LATER) - Date.parse(LEASE));
    const beforeExpired = await snapshotOf(projects, activity, deliveries);
    await assert.rejects(
      () => platform.escalateToL3('M', attemptId, { question: 'q', why: 'w', optionsConsidered: ['a'] }, expired),
      (e: unknown) => e instanceof PlatformRuleError && e.code === 'CLAIM_FENCE_REJECTED',
    );
    assert.deepEqual(await snapshotOf(projects, activity, deliveries), beforeExpired);
    assert.equal((await deliveries.listForMission('M')).length, beforeExpired.deliveries);

    // Reclaim after expiry; current generation writes findings + delivery together.
    const reclaimed = await hops.claim(live.id, 'third', LATER, '2025-01-01T00:00:30Z');
    assert.equal(reclaimed?.claimGeneration, 3);
    const current: QueueClaimIdentity = { id: live.id, owner: 'third', claimGeneration: 3 };
    await platform.escalateToL3('M', attemptId, { question: '要不要拆？', why: '两种设计', optionsConsidered: ['拆'] }, current);
    assert.equal((await deliveries.listForMission('M')).length, beforeExpired.deliveries + 1);
    assert.ok((await activity.list('M')).some((e) => e.kind === 'escalated'));
    await platform.finishAttempt('M', attemptId, { endedBy: 'structured_submit' }, current);
    const attempt = (await projects.get('P'))!.missions[0]!.coordinatorAttempts[0]!;
    assert.notEqual(attempt.status, 'in_progress');
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('file platform routes every listed queue write through runFenced', async () => {
  const ctx = await filePlatformFence();
  try {
    const { platform, hops, store } = ctx;
    const live = await claimLive(hops);
    await platform.createMission({ projectId: 'P', missionId: 'M', contract: CONTRACT, origin });
    const { attemptId: coord } = await platform.startCoordinatorAttempt('M');
    const spy = spyFenced(store);
    const listed: Array<{ name: string; run: () => Promise<unknown> }> = [
      { name: 'updateFindings', run: () => platform.updateFindings('M', coord, 'f', undefined, live) },
      { name: 'updatePlan', run: () => platform.updatePlan('M', coord, PLAN, live) },
      {
        name: 'createWorkItem',
        run: () => platform.createWorkItem('M', coord, { title: 'W', order: ORDER, workItemId: 'W1' }, live),
      },
      { name: 'dispatchWorkItems', run: () => platform.dispatchWorkItems('M', coord, ['W1'], live) },
      {
        name: 'submitEvidence',
        run: () =>
          platform.submitEvidence(
            'M',
            'missing-exec',
            { kind: 'test', summary: 's', command: 'node --test', exitCode: 0 },
            live,
          ),
      },
      {
        name: 'submitExecutionResult',
        run: () =>
          platform.submitExecutionResult(
            'M',
            'missing-exec',
            { outcome: 'partial', summary: 's', changedFiles: [], evidenceIds: [], notes: '' },
            live,
          ),
      },
      {
        name: 'reportBlocked',
        run: () =>
          platform.reportBlocked('M', 'missing-exec', { reason: '工单前提不成立', whatWasTried: [], needsFromUpstream: 'x' }, live),
      },
      {
        name: 'reviewExecutionResult',
        run: () =>
          platform.reviewExecutionResult(
            'M',
            coord,
            {
              workItemId: 'W1',
              verdict: 'accept',
              reasons: ['ok'],
              requiredChanges: [],
              acceptanceResults: ORDER.acceptance.map((criterion) => ({
                criterion,
                status: 'pass',
                evidence: 'e',
              })),
            },
            live,
          ),
      },
      {
        name: 'escalateToL3',
        run: () => platform.escalateToL3('M', coord, { question: 'q', why: 'w', optionsConsidered: ['a'] }, live),
      },
      {
        name: 'submitMissionResult',
        run: () =>
          platform.submitMissionResult(
            'M',
            coord,
            {
              outcome: 'blocked',
              summary: 's',
              acceptanceEvidence: [],
              memoryDelta: [],
              openRisks: [],
            },
            live,
          ),
      },
      {
        name: 'submitIndependentReview',
        run: () => platform.submitIndependentReview('M', coord, { verdict: 'send_back', reasons: ['r'] }, live),
      },
      { name: 'finishAttempt', run: () => platform.finishAttempt('M', coord, { endedBy: 'structured_submit' }, live) },
    ];
    for (const row of listed) {
      spy.reset();
      await row.run().catch(() => undefined);
      assert.equal(spy.fenced, 1, `${row.name} must check the claim inside runFenced`);
      assert.equal(spy.lastFence?.id, live.id);
      assert.equal(spy.lastFence?.claimGeneration, live.claimGeneration);
    }
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

async function openPlatformPgFence(): Promise<{ connectionString: string; store: PgStateStore } | undefined> {
  const connectionString = await ensureTestDatabase('platform_claim_fence');
  if (!connectionString) return undefined;
  const store = await PgStateStore.open({ connectionString });
  await store.pool.query(
    'TRUNCATE queued_hops, projects, activity, deliveries, id_counters',
  );
  // open 会先 hydrate 上一轮留下的行；先清库再 refresh，否则活对象里还有旧 Mission。
  await store.refresh();
  return { connectionString, store };
}

test('Postgres platform fenced writes reject stale or expired claims after takeover; live generation commits', async (t) => {
  const opened = await openPlatformPgFence();
  if (!opened) {
    t.skip('Postgres unavailable; PG platform claim fencing not verified');
    return;
  }
  const { connectionString, store } = opened;
  try {
    const clock = new FixedClock(NOW);
    const ids = new PgIds(store);
    await ids.reserve(['D', 'W', 'M', 'E']);
    const projects = new PgProjectRepository(store);
    const activity = new PgActivityLog(store, clock);
    const deliveries = new PgDeliveryRepository(store, clock, ids);
    const hops = new PgQueuedHopRepository(store);
    const platform = new Platform({
      projects,
      deliveries,
      activity,
      clock,
      ids,
      transaction: store,
    });
    await hops.enqueue(queuedHop({ id: 'h1', projectId: 'P', missionId: 'M', idempotencyKey: 'plat-pg-fence' }));
    assert.equal((await hops.claim('h1', 'owner', NOW, LEASE))?.claimGeneration, 1);
    const live: QueueClaimIdentity = { id: 'h1', owner: 'owner', claimGeneration: 1 };
    await platform.createMission({ projectId: 'P', missionId: 'M', contract: CONTRACT, origin });
    const { attemptId } = await platform.startCoordinatorAttempt('M');
    await platform.updateFindings('M', attemptId, 'pg-live', undefined, live);
    assert.equal((await projects.get('P'))!.missions[0]!.plan?.findings, 'pg-live');

    const taken = await hops.claim('h1', 'next', LEASE, LATER);
    assert.equal(taken?.claimGeneration, 2);
    const before = await snapshotOf(projects, activity, deliveries);
    await assert.rejects(
      () => platform.updateFindings('M', attemptId, 'pg-stale', undefined, live),
      (e: unknown) => e instanceof PlatformRuleError && e.code === 'CLAIM_FENCE_REJECTED',
    );
    assert.deepEqual(await snapshotOf(projects, activity, deliveries), before);
    assert.equal((await projects.get('P'))!.missions[0]!.plan?.findings, 'pg-live');
    assert.equal((await hops.get('h1'))?.claimGeneration, 2);

    clock.advance(Date.parse(LATER) - Date.parse(NOW));
    const expired: QueueClaimIdentity = { id: 'h1', owner: 'next', claimGeneration: 2 };
    const beforeExpired = await snapshotOf(projects, activity, deliveries);
    await assert.rejects(
      () => platform.escalateToL3('M', attemptId, { question: 'q', why: 'w', optionsConsidered: ['a'] }, expired),
      (e: unknown) => e instanceof PlatformRuleError && e.code === 'CLAIM_FENCE_REJECTED',
    );
    assert.deepEqual(await snapshotOf(projects, activity, deliveries), beforeExpired);

    const reclaimed = await hops.claim('h1', 'third', LATER, '2025-01-01T00:00:30Z');
    assert.equal(reclaimed?.claimGeneration, 3);
    const current: QueueClaimIdentity = { id: 'h1', owner: 'third', claimGeneration: 3 };
    await platform.escalateToL3('M', attemptId, { question: '要不要拆？', why: '两种设计', optionsConsidered: ['拆'] }, current);
    assert.equal((await deliveries.listForMission('M')).length, beforeExpired.deliveries + 1);
    await platform.finishAttempt('M', attemptId, { endedBy: 'structured_submit' }, current);
    assert.notEqual((await projects.get('P'))!.missions[0]!.coordinatorAttempts[0]!.status, 'in_progress');
  } finally {
    await store.close();
  }
  const reopened = await PgStateStore.open({ connectionString });
  try {
    const projects = new PgProjectRepository(reopened);
    const hops = new PgQueuedHopRepository(reopened);
    assert.equal((await projects.get('P'))!.missions[0]!.plan?.findings, 'pg-live');
    assert.equal((await hops.get('h1'))?.claimGeneration, 3);
    assert.equal((await hops.get('h1'))?.owner, 'third');
  } finally {
    await reopened.close();
  }
});
