/**
 * HTTP 面的端到端：走真实的 node:http，不 mock。
 *
 * 重点不是路由拼对了没有，是**身份不能靠调用方自述** —— 执行者拿着自己的
 * run token 去调协调者的工具，必须被挡。
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createApi } from '../src/api/server.ts';
import { RunTokenRegistry } from '../src/api/run-tokens.ts';
import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import { Platform, PlatformRuleError, type QueueClaimIdentity } from '../src/application/platform.ts';
import { listenLoopback } from '../src/application/loopback-listen.ts';
import {
  FileActivityLog,
  FileDeliveryRepository,
  FileProjectRepository,
  FileQueuedHopRepository,
  FileStateStore,
  PersistentIds,
} from '../src/application/file-store.ts';
import type { ClaimFence } from '../src/application/durable-scheduler.ts';
import {
  PgActivityLog,
  PgDeliveryRepository,
  PgIds,
  PgProjectRepository,
  PgQueuedHopRepository,
  PgStateStore,
} from '../src/application/pg-store.ts';
import { ensureTestDatabase } from './helpers/pg.ts';

const CONTRACT = {
  intent: '把 X 修好',
  acceptance: ['测试全绿'],
  constraints: [],
  nonGoals: [],
  guardrails: ['不得改 Contract'],
};

const ORDER = {
  objective: '改 foo',
  allowedScope: ['src/foo.ts'],
  requiredBehaviour: 'foo 返回 1',
  constraints: [],
  acceptance: ['foo() === 1'],
  verification: ['node --test'],
  doNot: [],
  contextRefs: [],
};

let base: string;
let server: ReturnType<typeof createApi>;

before(async () => {
  const clock = new FixedClock();
  const ids = new SequentialIds();
  const deliveries = new InMemoryDeliveryRepository(clock, ids);
  const platform = new Platform({
    projects: new InMemoryProjectRepository(),
    deliveries,
    activity: new InMemoryActivityLog(clock),
    clock,
    ids,
  });
  server = createApi({ platform, tokens: new RunTokenRegistry(), deliveries });
  await listenLoopback(server, 0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

async function call(
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; json: Record<string, never> }> {
  const res = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-coagent-run': token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, never> };
}

describe('HTTP 面', () => {
  test('健康检查', async () => {
    const { status, json } = await call('/api/health');
    assert.equal(status, 200);
    assert.equal((json as { ok: boolean }).ok, true);
  });

  test('没有 run token 的工具调用一律 401', async () => {
    const { status, json } = await call('/api/agent/coagent_get_mission', {});
    assert.equal(status, 401);
    assert.equal((json as { error: string }).error, 'UNKNOWN_RUN_TOKEN');
  });

  test('完整一趟：建 Mission → 协调者规划派发 → 执行者提交 → 协调者验收 → 交卷', async () => {
    const created = await call('/api/missions', {
      projectId: 'P',
      missionId: 'M-api',
      contract: CONTRACT,
    });
    assert.equal(created.status, 201);

    const coord = await call('/api/missions/M-api/coordinator-attempts', {});
    const coordToken = (coord.json as { token: string }).token;
    const coordAttempt = (coord.json as { attemptId: string }).attemptId;

    // 没 Plan 先拒绝——规则在平台，不在 prompt。
    const tooEarly = await call(
      '/api/agent/coagent_create_work_item',
      { title: 'W', ...ORDER },
      coordToken,
    );
    assert.equal(tooEarly.status, 409);
    assert.equal((tooEarly.json as { error: string }).error, 'PLAN_REQUIRED');

    const planned = await call(
      '/api/agent/coagent_update_plan',
      {
        findings: '查到了',
        rejectedHypotheses: [],
        decisions: [],
        direction: '这么改',
        risks: [],
      },
      coordToken,
    );
    assert.equal(planned.status, 200);
    assert.equal((planned.json as { planRevision: number }).planRevision, 1);

    const wi = await call(
      '/api/agent/coagent_create_work_item',
      { title: 'W', ...ORDER },
      coordToken,
    );
    assert.equal(wi.status, 200);
    const workItemId = (wi.json as { workItemId: string }).workItemId;

    const dispatched = await call(
      '/api/agent/coagent_dispatch_work_item',
      { workItemIds: [workItemId] },
      coordToken,
    );
    assert.equal(dispatched.status, 200);

    const exec = await call(
      `/api/missions/M-api/work-items/${workItemId}/executor-attempts`,
      {},
    );
    const execToken = (exec.json as { token: string }).token;
    const execAttempt = (exec.json as { attemptId: string }).attemptId;

    const order = await call('/api/agent/coagent_get_work_order', {}, execToken);
    assert.equal(order.status, 200);
    assert.equal((order.json as { workItemId: string }).workItemId, workItemId);

    const evidence = await call(
      '/api/agent/coagent_submit_evidence',
      { kind: 'test', summary: 'node --test 全绿', command: 'node --test', exitCode: 0 },
      execToken,
    );
    assert.equal(evidence.status, 200);

    const submitted = await call(
      '/api/agent/coagent_submit_execution_result',
      {
        outcome: 'completed',
        summary: '改好了',
        changedFiles: ['src/foo.ts'],
        evidenceIds: [(evidence.json as { evidenceId: string }).evidenceId],
        notes: '无',
      },
      execToken,
    );
    assert.equal(submitted.status, 200);
    assert.equal((submitted.json as { status: string }).status, 'submitted');

    await call(`/api/missions/M-api/attempts/${execAttempt}/finish`, {
      endedBy: 'structured_submit',
      usage: { input: 10, output: 5, cacheRead: 900, cacheWrite: 0, total: 915, quality: 'reported' },
    });

    // finish 不需要调用方回传 token；平台按 attemptId 吊销后，迟到调用仍必须被拒绝。
    const late = await call('/api/agent/coagent_submit_evidence', { kind: 'test', summary: '迟到' }, execToken);
    assert.equal(late.status, 401);

    const reviewed = await call(
      '/api/agent/coagent_review_execution_result',
      { workItemId, verdict: 'accept', acceptanceResults: ORDER.acceptance.map((criterion) => ({ criterion, status: 'pass' as const, evidence: '测试替身：逐条核过' })), reasons: ['自己跑过 node --test'], requiredChanges: [] },
      coordToken,
    );
    assert.equal(reviewed.status, 200);
    assert.equal((reviewed.json as { status: string }).status, 'accepted');

    const delivered = await call(
      '/api/agent/coagent_submit_mission_result',
      {
        outcome: 'delivered',
        summary: '交付',
        acceptanceEvidence: ['node --test 退出码 0'],
        memoryDelta: [],
        openRisks: [],
      },
      coordToken,
    );
    assert.equal(delivered.status, 200);

    await call(`/api/missions/M-api/attempts/${coordAttempt}/finish`, {
      endedBy: 'structured_submit',
      token: coordToken,
    });

    const view = await call('/api/missions/M-api');
    const json = view.json as unknown as {
      workItems: { status: string }[];
      result: { outcome: string };
      usage: { cacheRead: number };
    };
    assert.equal(json.workItems[0].status, 'accepted');
    assert.equal(json.result.outcome, 'delivered');
    assert.equal(json.usage.cacheRead, 900, '用量按分项聚合');
  });

  test('执行者拿自己的 token 调协调者的工具会被挡', async () => {
    await call('/api/missions', { projectId: 'P2', missionId: 'M-guard', contract: CONTRACT });
    const coord = await call('/api/missions/M-guard/coordinator-attempts', {});
    const coordToken = (coord.json as { token: string }).token;
    await call(
      '/api/agent/coagent_update_plan',
      { findings: 'f', rejectedHypotheses: [], decisions: [], direction: 'd', risks: [] },
      coordToken,
    );
    const wi = await call('/api/agent/coagent_create_work_item', { title: 'W', ...ORDER }, coordToken);
    const workItemId = (wi.json as { workItemId: string }).workItemId;
    await call('/api/agent/coagent_dispatch_work_item', { workItemIds: [workItemId] }, coordToken);
    const exec = await call(`/api/missions/M-guard/work-items/${workItemId}/executor-attempts`, {});
    const execToken = (exec.json as { token: string }).token;

    const stolen = await call(
      '/api/agent/coagent_update_plan',
      { findings: '我想改计划', rejectedHypotheses: [], decisions: [], direction: 'x', risks: [] },
      execToken,
    );
    assert.equal(stolen.status, 409);
    assert.equal((stolen.json as { error: string }).error, 'WRONG_ROLE');
  });

  test('agent 请求体自述身份不被采信，错误体不回显 run token', async () => {
    await call('/api/missions', { projectId: 'P3', missionId: 'M-spoof', contract: CONTRACT });
    const coord = await call('/api/missions/M-spoof/coordinator-attempts', {});
    const coordToken = (coord.json as { token: string }).token;
    await call(
      '/api/agent/coagent_update_plan',
      { findings: 'f', rejectedHypotheses: [], decisions: [], direction: 'd', risks: [] },
      coordToken,
    );
    const wi = await call('/api/agent/coagent_create_work_item', { title: 'W', ...ORDER }, coordToken);
    const workItemId = (wi.json as { workItemId: string }).workItemId;
    await call('/api/agent/coagent_dispatch_work_item', { workItemIds: [workItemId] }, coordToken);
    const exec = await call(`/api/missions/M-spoof/work-items/${workItemId}/executor-attempts`, {});
    const execToken = (exec.json as { token: string }).token;

    const stolen = await call(
      '/api/agent/coagent_update_plan',
      {
        role: 'coordinator',
        attemptId: (coord.json as { attemptId: string }).attemptId,
        missionId: 'M-spoof',
        findings: '自述协调者',
        rejectedHypotheses: [],
        decisions: [],
        direction: 'x',
        risks: [],
      },
      execToken,
    );
    assert.equal(stolen.status, 409);
    assert.equal((stolen.json as { error: string }).error, 'WRONG_ROLE');
    const echoed = JSON.stringify(stolen.json);
    assert.equal(echoed.includes(execToken), false);
    assert.equal(echoed.includes(coordToken), false);
  });
});

const QUEUE_NOW = '2025-01-01T00:00:00Z';
const QUEUE_LEASE = '2025-01-01T00:00:10Z';
const QUEUE_LATER = '2025-01-01T00:00:20Z';
const QUEUE_ORIGIN = { clientType: 'cli' as const, conversationRef: 'me' };

const AGENT_QUEUE_WRITES: readonly { tool: string; body: Record<string, unknown> }[] = [
  { tool: 'coagent_update_findings', body: { findings: 'stale' } },
  {
    tool: 'coagent_update_plan',
    body: { findings: 'stale', rejectedHypotheses: [], decisions: [], direction: 'd', risks: [] },
  },
  { tool: 'coagent_create_work_item', body: { title: 'W', ...ORDER } },
  { tool: 'coagent_dispatch_work_item', body: { workItemIds: ['nope'] } },
  {
    tool: 'coagent_review_execution_result',
    body: { workItemId: 'nope', verdict: 'accept', reasons: ['x'], requiredChanges: [], acceptanceResults: [] },
  },
  { tool: 'coagent_escalate_to_l3', body: { question: 'q', why: 'w', optionsConsidered: ['a'] } },
  {
    tool: 'coagent_submit_mission_result',
    body: { outcome: 'blocked', summary: 's', acceptanceEvidence: [], memoryDelta: [], openRisks: [] },
  },
  { tool: 'coagent_submit_evidence', body: { kind: 'test', summary: 's', command: 'x', exitCode: 0 } },
  {
    tool: 'coagent_submit_execution_result',
    body: { outcome: 'partial', summary: 's', changedFiles: [], evidenceIds: [], notes: '' },
  },
  {
    tool: 'coagent_report_blocked',
    body: { reason: '工单前提不成立', whatWasTried: [], needsFromUpstream: 'x' },
  },
  { tool: 'coagent_submit_independent_review', body: { verdict: 'send_back', reasons: ['r'] } },
];

async function postJson(
  base: string,
  path: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; json: { error?: string } }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-coagent-run': token } : {}),
    },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, json: (await res.json()) as { error?: string } };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function snapshotMission(
  projects: FileProjectRepository | PgProjectRepository,
  activity: FileActivityLog | PgActivityLog,
  deliveries: FileDeliveryRepository | PgDeliveryRepository,
) {
  return {
    project: JSON.stringify((await projects.get('P'))?.toSnapshot()),
    events: (await activity.list('M')).length,
    deliveries: (await deliveries.listForMission('M')).length,
  };
}

async function enqueueAndClaim(
  hops: FileQueuedHopRepository | PgQueuedHopRepository,
  id = 'h1',
): Promise<QueueClaimIdentity> {
  await hops.enqueue({
    id,
    projectId: 'P',
    missionId: 'M',
    workItemId: 'w',
    role: 'coordinator',
    priority: 1,
    availableAt: QUEUE_NOW,
    attemptCount: 0,
    maxAttempts: 2,
    idempotencyKey: `http-fence-${id}`,
    status: 'queued',
    createdAt: QUEUE_NOW,
    updatedAt: QUEUE_NOW,
  });
  const claimed = await hops.claim(id, 'owner', QUEUE_NOW, QUEUE_LEASE);
  assert.equal(claimed?.claimGeneration, 1);
  return { id, owner: 'owner', claimGeneration: 1 };
}

const QUEUE_PLAN = {
  findings: '查到了',
  rejectedHypotheses: [] as string[],
  decisions: [] as string[],
  direction: '这么改',
  risks: [] as string[],
};

describe('HTTP 队列 Attempt 身份', () => {
  test('三类 start 与 attempt.started 同事务写入按 attemptId 可查的队列标记；非队列不变', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'http-queue-mark-'));
    try {
      const store = new FileStateStore(join(dir, 'state.json'));
      const clock = new FixedClock(QUEUE_NOW);
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
      await platform.createMission({
        projectId: 'P',
        missionId: 'M',
        contract: CONTRACT,
        origin: QUEUE_ORIGIN,
      });
      const live = await enqueueAndClaim(hops);
      const unmarked = await platform.startCoordinatorAttempt('M');
      assert.equal(await platform.attemptRequiresQueueClaim('M', unmarked.attemptId), false);
      await platform.finishAttempt('M', unmarked.attemptId, { endedBy: 'structured_submit' });

      const queued = await platform.startCoordinatorAttempt('M', undefined, live);
      assert.equal(await platform.attemptRequiresQueueClaim('M', queued.attemptId), true);
      const started = (await activity.list('M')).filter(
        (event) => event.kind === 'attempt.started' && event.attemptId === queued.attemptId,
      );
      assert.equal(started.length, 1);
      assert.equal((started[0]!.data as { queue?: unknown }).queue, true);

      await assert.rejects(
        () => platform.updateFindings('M', queued.attemptId, 'no-claim'),
        (error: unknown) => error instanceof PlatformRuleError && error.code === 'QUEUE_CLAIM_REQUIRED',
      );
      await platform.updateFindings('M', queued.attemptId, 'queued-ok', undefined, live);
      await platform.updatePlan('M', queued.attemptId, QUEUE_PLAN, live);
      const { workItemId } = await platform.createWorkItem(
        'M',
        queued.attemptId,
        { title: 'W', order: ORDER, workItemId: 'W1' },
        live,
      );
      await platform.dispatchWorkItems('M', queued.attemptId, [workItemId], live);
      const exec = await platform.startExecutorAttempt('M', workItemId, undefined, live);
      assert.equal(await platform.attemptRequiresQueueClaim('M', exec.attemptId), true);

      await assert.rejects(
        () => platform.startIndependentReviewerAttempt('M', [], live),
        (error: unknown) => error instanceof PlatformRuleError && error.code !== 'CLAIM_FENCE_UNAVAILABLE',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('真实 HTTP：旧代次 11 个写 handler 非 2xx 且快照不变，请求体伪造身份无效，当前代次仍可写', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'http-queue-writes-'));
    const store = new FileStateStore(join(dir, 'state.json'));
    const clock = new FixedClock(QUEUE_NOW);
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
    const tokens = new RunTokenRegistry();
    const server = createApi({ platform, tokens, deliveries });
    try {
      await listenLoopback(server, 0);
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      await platform.createMission({
        projectId: 'P',
        missionId: 'M',
        contract: CONTRACT,
        origin: QUEUE_ORIGIN,
      });
      const live = await enqueueAndClaim(hops);
      const { attemptId } = await platform.startCoordinatorAttempt('M', undefined, live);
      const stale = tokens.issue({ missionId: 'M', attemptId, role: 'coordinator', claim: live });
      await platform.updateFindings('M', attemptId, 'live', undefined, live);

      const taken = await hops.claim(live.id, 'next', QUEUE_LEASE, QUEUE_LATER);
      assert.equal(taken?.claimGeneration, 2);
      const current: QueueClaimIdentity = { id: live.id, owner: 'next', claimGeneration: 2 };
      const fresh = tokens.issue({ missionId: 'M', attemptId, role: 'coordinator', claim: current });
      const before = await snapshotMission(projects, activity, deliveries);
      assert.equal(AGENT_QUEUE_WRITES.length, 11);

      for (const row of AGENT_QUEUE_WRITES) {
        const spoofed = {
          ...row.body,
          role: 'coordinator',
          owner: 'next',
          claimGeneration: 2,
          id: live.id,
        };
        const res = await postJson(base, `/api/agent/${row.tool}`, spoofed, stale.token);
        assert.notEqual(res.status, 200, `${row.tool} stale token must not succeed`);
        assert.ok(res.status >= 400, `${row.tool} must be non-2xx`);
        assert.equal(res.json.error, 'CLAIM_FENCE_REJECTED', row.tool);
        assert.equal(JSON.stringify(res.json).includes(stale.token), false);
        assert.deepEqual(await snapshotMission(projects, activity, deliveries), before);
      }

      const ok = await postJson(
        base,
        '/api/agent/coagent_update_findings',
        { findings: 'current-gen' },
        fresh.token,
      );
      assert.equal(ok.status, 200);
      assert.equal((await projects.get('P'))!.missions[0]!.plan?.findings, 'current-gen');
      assert.equal(tokens.resolve(fresh.token)?.attemptId, attemptId);
    } finally {
      await closeServer(server);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('真实 HTTP：入口解析后写事务前接管，事务内核对拒绝旧代次', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'http-queue-race-'));
    const store = new FileStateStore(join(dir, 'state.json'));
    const clock = new FixedClock(QUEUE_NOW);
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
    const tokens = new RunTokenRegistry();
    const server = createApi({ platform, tokens, deliveries });
    try {
      await listenLoopback(server, 0);
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      await platform.createMission({
        projectId: 'P',
        missionId: 'M',
        contract: CONTRACT,
        origin: QUEUE_ORIGIN,
      });
      const live = await enqueueAndClaim(hops);
      const { attemptId } = await platform.startCoordinatorAttempt('M', undefined, live);
      const run = tokens.issue({ missionId: 'M', attemptId, role: 'coordinator', claim: live });
      await platform.updateFindings('M', attemptId, 'before-race', undefined, live);

      const orig = store.runFenced.bind(store);
      let hijacked = false;
      store.runFenced = ((fence: ClaimFence, fn: () => Promise<unknown>) => {
        hijacked = true;
        return hops.claim(live.id, 'next', QUEUE_LEASE, QUEUE_LATER).then((taken) => {
          assert.equal(taken?.claimGeneration, 2);
          return orig(fence, fn);
        });
      }) as typeof store.runFenced;

      const before = await snapshotMission(projects, activity, deliveries);
      const res = await postJson(
        base,
        '/api/agent/coagent_update_findings',
        { findings: 'should-not-land' },
        run.token,
      );
      assert.equal(hijacked, true);
      assert.notEqual(res.status, 200);
      assert.equal(res.json.error, 'CLAIM_FENCE_REJECTED');
      assert.deepEqual(await snapshotMission(projects, activity, deliveries), before);
      assert.equal((await projects.get('P'))!.missions[0]!.plan?.findings, 'before-race');
      assert.equal((await hops.get(live.id))?.claimGeneration, 2);
      assert.equal(tokens.resolve(run.token)?.token, run.token);
    } finally {
      await closeServer(server);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('队列 HTTP finish：旧代次、失租、重启缺牌拒绝且不收尾不吊销；当前代次可收尾；非队列旧路径不变', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'http-queue-finish-'));
    const store = new FileStateStore(join(dir, 'state.json'));
    const clock = new FixedClock(QUEUE_NOW);
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
    const tokens = new RunTokenRegistry();
    let server = createApi({ platform, tokens, deliveries });
    try {
      await listenLoopback(server, 0);
      let base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      await platform.createMission({
        projectId: 'P',
        missionId: 'M',
        contract: CONTRACT,
        origin: QUEUE_ORIGIN,
      });
      const live = await enqueueAndClaim(hops);
      const { attemptId } = await platform.startCoordinatorAttempt('M', undefined, live);
      const stale = tokens.issue({ missionId: 'M', attemptId, role: 'coordinator', claim: live });

      const taken = await hops.claim(live.id, 'next', QUEUE_LEASE, QUEUE_LATER);
      assert.equal(taken?.claimGeneration, 2);
      const gen2: QueueClaimIdentity = { id: live.id, owner: 'next', claimGeneration: 2 };
      const current = tokens.issue({ missionId: 'M', attemptId, role: 'coordinator', claim: gen2 });

      const staleFinish = await postJson(
        base,
        `/api/missions/M/attempts/${attemptId}/finish`,
        { endedBy: 'structured_submit', owner: 'next', claimGeneration: 2 },
        stale.token,
      );
      assert.notEqual(staleFinish.status, 200);
      assert.equal(staleFinish.json.error, 'CLAIM_FENCE_REJECTED');
      assert.equal((await projects.get('P'))!.missions[0]!.coordinatorAttempts[0]!.status, 'in_progress');
      assert.equal(tokens.resolve(current.token)?.attemptId, attemptId);

      clock.advance(Date.parse(QUEUE_LATER) - Date.parse(QUEUE_NOW));
      const expiredFinish = await postJson(
        base,
        `/api/missions/M/attempts/${attemptId}/finish`,
        { endedBy: 'structured_submit' },
        current.token,
      );
      assert.notEqual(expiredFinish.status, 200);
      assert.equal(expiredFinish.json.error, 'CLAIM_FENCE_REJECTED');
      assert.equal((await projects.get('P'))!.missions[0]!.coordinatorAttempts[0]!.status, 'in_progress');
      assert.equal(tokens.resolve(current.token)?.attemptId, attemptId);

      await closeServer(server);
      const restarted = new RunTokenRegistry();
      server = createApi({ platform, tokens: restarted, deliveries });
      await listenLoopback(server, 0);
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const missing = await postJson(base, `/api/missions/M/attempts/${attemptId}/finish`, {
        endedBy: 'structured_submit',
      });
      assert.equal(missing.status, 401);
      assert.equal(missing.json.error, 'UNKNOWN_RUN_TOKEN');
      assert.equal((await projects.get('P'))!.missions[0]!.coordinatorAttempts[0]!.status, 'in_progress');

      const reclaimed = await hops.claim(live.id, 'third', QUEUE_LATER, '2025-01-01T00:00:30Z');
      assert.equal(reclaimed?.claimGeneration, 3);
      const gen3: QueueClaimIdentity = { id: live.id, owner: 'third', claimGeneration: 3 };
      const liveToken = restarted.issue({ missionId: 'M', attemptId, role: 'coordinator', claim: gen3 });
      const ok = await postJson(
        base,
        `/api/missions/M/attempts/${attemptId}/finish`,
        { endedBy: 'structured_submit' },
        liveToken.token,
      );
      assert.equal(ok.status, 200);
      assert.notEqual((await projects.get('P'))!.missions[0]!.coordinatorAttempts[0]!.status, 'in_progress');
      assert.equal(restarted.resolve(liveToken.token), undefined);

      await platform.createMission({
        projectId: 'P',
        missionId: 'M-nq',
        contract: CONTRACT,
        origin: QUEUE_ORIGIN,
      });
      const nq = await postJson(base, '/api/missions/M-nq/coordinator-attempts', {});
      assert.equal(nq.status, 201);
      const nqAttempt = (nq.json as { attemptId?: string }).attemptId;
      assert.ok(nqAttempt);
      const nqFinish = await postJson(base, `/api/missions/M-nq/attempts/${nqAttempt}/finish`, {
        endedBy: 'structured_submit',
      });
      assert.equal(nqFinish.status, 200);
    } finally {
      await closeServer(server);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Postgres 可用时真实 HTTP 解析后接管竞态在事务内拒绝', async (t) => {
    const connectionString = await ensureTestDatabase('http_queue_fence');
    if (!connectionString) {
      t.skip('Postgres unavailable; PG HTTP claim-fence race not verified');
      return;
    }
    const store = await PgStateStore.open({ connectionString });
    await store.pool.query('TRUNCATE queued_hops, projects, activity, deliveries, id_counters');
    await store.refresh();
    const clock = new FixedClock(QUEUE_NOW);
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
    const tokens = new RunTokenRegistry();
    const server = createApi({ platform, tokens, deliveries });
    try {
      await listenLoopback(server, 0);
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      await hops.enqueue({
        id: 'h1',
        projectId: 'P',
        missionId: 'M',
        workItemId: 'w',
        role: 'coordinator',
        priority: 1,
        availableAt: QUEUE_NOW,
        attemptCount: 0,
        maxAttempts: 2,
        idempotencyKey: 'http-pg-fence',
        status: 'queued',
        createdAt: QUEUE_NOW,
        updatedAt: QUEUE_NOW,
      });
      assert.equal((await hops.claim('h1', 'owner', QUEUE_NOW, QUEUE_LEASE))?.claimGeneration, 1);
      const live: QueueClaimIdentity = { id: 'h1', owner: 'owner', claimGeneration: 1 };
      await platform.createMission({
        projectId: 'P',
        missionId: 'M',
        contract: CONTRACT,
        origin: QUEUE_ORIGIN,
      });
      const { attemptId } = await platform.startCoordinatorAttempt('M', undefined, live);
      const run = tokens.issue({ missionId: 'M', attemptId, role: 'coordinator', claim: live });
      await platform.updateFindings('M', attemptId, 'pg-before', undefined, live);

      const orig = store.runFenced.bind(store);
      let hijacked = false;
      store.runFenced = ((fence: ClaimFence, fn: () => Promise<unknown>) => {
        hijacked = true;
        return hops.claim('h1', 'next', QUEUE_LEASE, QUEUE_LATER).then((taken) => {
          assert.equal(taken?.claimGeneration, 2);
          return orig(fence, fn);
        });
      }) as typeof store.runFenced;

      const before = await snapshotMission(projects, activity, deliveries);
      const res = await postJson(
        base,
        '/api/agent/coagent_update_findings',
        { findings: 'pg-stale', owner: 'next', claimGeneration: 2 },
        run.token,
      );
      assert.equal(hijacked, true);
      assert.notEqual(res.status, 200);
      assert.equal(res.json.error, 'CLAIM_FENCE_REJECTED');
      assert.deepEqual(await snapshotMission(projects, activity, deliveries), before);
      assert.equal((await projects.get('P'))!.missions[0]!.plan?.findings, 'pg-before');
    } finally {
      await closeServer(server);
      await store.close();
    }
  });
});
