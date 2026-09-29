/**
 * HTTP 面的端到端：走真实的 node:http，不 mock。
 *
 * 重点不是路由拼对了没有，是**身份不能靠调用方自述** —— 执行者拿着自己的
 * run token 去调协调者的工具，必须被挡。
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import { request as httpRequest } from 'node:http';

import {
  API_VERSION,
  createApi,
  drainApi,
  HOSTED_RUN_HEARTBEAT_IDLE_MS,
  type HostedRunHandler,
} from '../src/api/server.ts';
import {
  LoopbackHttpError,
  LoopbackIdentityError,
  loopbackRunRequest,
} from '../src/application/loopback-control-client.ts';
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

const BRIEF_SHA256 = /^[0-9a-f]{64}$/;
const BRIEF_RULES = '# 架构约束\n\nkernel 不得依赖任何第三方包。\n';
const BRIEF_SPEC_BODY = '# HTTP brief spec\n\nSPEC-BODY-MUST-NOT-PREFETCH\n';
const BRIEF_CONTRACT_R2 = {
  ...CONTRACT,
  intent: '把 X 修好（r2）',
};
const BRIEF_PLAN = {
  findings: '第三次规划',
  rejectedHypotheses: [] as string[],
  decisions: [] as string[],
  direction: '按 r3 改',
  risks: [] as string[],
};
const BRIEF_REFS = [
  'src/does-not-exist-w1.ts',
  { kind: 'living_spec' as const, ref: 'http-brief', why: '规格在这儿' },
  { kind: 'contract' as const, ref: 'contract', why: '验收标准在这儿' },
  { kind: 'previous_result' as const, ref: 'W-prev', why: '上一工单结果' },
];
const BRIEF_ORDER = {
  ...ORDER,
  contextRefs: BRIEF_REFS,
};
const EXPECTED_ENV_NOTES =
  process.platform === 'win32'
    ? [
        'Windows：bash 的 `/tmp` 和 Node 的 `/tmp` **不是同一个目录**（前者在 ' +
          '%LOCALAPPDATA%\\Temp，后者是 C:\\tmp）。要落临时文件就用工作区里的相对路径，' +
          '跨这两者传文件必须用绝对路径——弄错不会报错，只会读到一个旧文件或空文件。',
        'Windows：Git Bash 里没有 `pgrep`。`if ! pgrep -f x` 这类判据**恒为真**，' +
          '不会报"命令不存在"，只会让你以为进程已经没了。判进程死活用 tasklist，' +
          '或者干脆改判产物（文件 mtime、库里的记录）。',
      ]
    : [];

async function getJson(
  base: string,
  path: string,
  token?: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method: 'GET',
    headers: token ? { 'x-coagent-run': token } : {},
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('HTTP 简报与按需引用权限',
  () => {
    test('同一 Mission：角色 Bundle、旧简报字段、get_work_order/get_context 形状与权限',
      async () => {
        const dir = mkdtempSync(join(tmpdir(), 'http-brief-bundle-'));
        mkdirSync(join(dir, '.coagent', 'specs'), { recursive: true });
        writeFileSync(join(dir, '.coagent', 'project.md'), BRIEF_RULES, 'utf8');
        writeFileSync(join(dir, '.coagent', 'specs', 'http-brief.md'), BRIEF_SPEC_BODY, 'utf8');

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
        const tokens = new RunTokenRegistry();
        const server = createApi({ platform, tokens, deliveries });
        try {
          await listenLoopback(server, 0);
          const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

          const created = await postJson(base, '/api/missions', {
            projectId: 'P-brief',
            missionId: 'M-brief',
            contract: CONTRACT,
          });
          assert.equal(created.status, 201);
          await platform.recordWorkspace('M-brief', {
            projectRoot: dir,
            branch: 'b',
            baseRevision: 'x',
          });

          const coord = await postJson(base, '/api/missions/M-brief/coordinator-attempts', {});
          assert.equal(coord.status, 201);
          const coordToken = (coord.json as { token?: string }).token;
          assert.equal(typeof coordToken, 'string');

          for (const findings of ['r1', 'r2', '第三次规划']) {
            const planned = await postJson(
              base,
              '/api/agent/coagent_update_plan',
              { ...BRIEF_PLAN, findings },
              coordToken,
            );
            assert.equal(planned.status, 200);
          }

          const wi = await postJson(
            base,
            '/api/agent/coagent_create_work_item',
            { title: 'W1', ...BRIEF_ORDER },
            coordToken,
          );
          assert.equal(wi.status, 200);
          const workItemId = (wi.json as { workItemId?: string }).workItemId;
          assert.equal(typeof workItemId, 'string');

          const dispatched = await postJson(
            base,
            '/api/agent/coagent_dispatch_work_item',
            { workItemIds: [workItemId] },
            coordToken,
          );
          assert.equal(dispatched.status, 200);

          const exec = await postJson(
            base,
            `/api/missions/M-brief/work-items/${workItemId}/executor-attempts`,
            {},
          );
          assert.equal(exec.status, 201);
          const execToken = (exec.json as { token?: string }).token;
          assert.equal(typeof execToken, 'string');

          const revised = await platform.reviseContract('M-brief', BRIEF_CONTRACT_R2);
          assert.equal(revised.contractRevision, 2);

          const coordBriefRes = await getJson(base, '/api/run/brief', coordToken);
          const execBriefRes = await getJson(base, '/api/run/brief', execToken);
          assert.equal(coordBriefRes.status, 200);
          assert.equal(execBriefRes.status, 200);

          type BundleEntry = {
            source: string;
            revision?: number;
            hash?: string;
            reason?: string;
            estimatedTokens?: number;
            content?: unknown;
          };
          type Brief = {
            role?: string;
            projectRules?: string;
            environmentNotes?: unknown;
            contract?: { intent?: string };
            contractRevision?: number;
            plan?: { direction?: string; findings?: string };
            planRevision?: number;
            workItem?: { id?: string; title?: string; order?: { contextRefs?: unknown } };
            finalReview?: { verdict?: string; reasons?: string[] };
            contextBundle?: { role?: string; entries?: BundleEntry[] };
          };
          const coordBrief = coordBriefRes.json as Brief;
          const execBrief = execBriefRes.json as Brief;

          assert.equal(coordBrief.role, 'coordinator');
          assert.equal(coordBrief.contract?.intent, BRIEF_CONTRACT_R2.intent);
          assert.equal(coordBrief.contractRevision, 2);
          assert.equal(coordBrief.plan?.direction, BRIEF_PLAN.direction);
          assert.equal(coordBrief.plan?.findings, '第三次规划');
          assert.equal(coordBrief.planRevision, 3);
          assert.equal(coordBrief.workItem, undefined);
          assert.equal(coordBrief.finalReview?.verdict, 'send_back');
          assert.match(coordBrief.finalReview?.reasons?.[0] ?? '', /Contract 已更新到 r2/);
          assert.equal(coordBrief.projectRules, BRIEF_RULES);
          assert.deepEqual(coordBrief.environmentNotes, EXPECTED_ENV_NOTES);
          assert.equal(coordBrief.contextBundle?.role, 'coordinator');
          assert.deepEqual(
            coordBrief.contextBundle?.entries?.map((e) => e.source),
            ['project_rules', 'environment_notes', 'contract', 'plan', 'final_review'],
          );
          const coordContract = coordBrief.contextBundle?.entries?.find((e) => e.source === 'contract');
          const coordPlan = coordBrief.contextBundle?.entries?.find((e) => e.source === 'plan');
          assert.equal(coordContract?.revision, 2);
          assert.equal(coordContract?.hash, undefined);
          assert.equal(coordPlan?.revision, 3);
          assert.equal(coordPlan?.hash, undefined);
          const coordRules = coordBrief.contextBundle?.entries?.find((e) => e.source === 'project_rules');
          assert.equal(coordRules?.revision, undefined);
          assert.match(coordRules?.hash ?? '', BRIEF_SHA256);

          assert.equal(execBrief.role, 'executor');
          assert.equal(execBrief.workItem?.id, workItemId);
          assert.equal(execBrief.workItem?.title, 'W1');
          assert.deepEqual(execBrief.workItem?.order?.contextRefs, BRIEF_REFS);
          assert.equal(execBrief.contract, undefined);
          assert.equal(execBrief.plan, undefined);
          assert.equal(execBrief.finalReview, undefined);
          assert.equal(execBrief.contractRevision, undefined);
          assert.equal(execBrief.planRevision, undefined);
          assert.equal(execBrief.projectRules, BRIEF_RULES);
          assert.deepEqual(execBrief.environmentNotes, EXPECTED_ENV_NOTES);
          assert.equal(execBrief.contextBundle?.role, 'executor');
          assert.deepEqual(
            execBrief.contextBundle?.entries?.map((e) => e.source),
            ['project_rules', 'environment_notes', 'work_order'],
          );
          const execDumped = JSON.stringify(execBrief);
          assert.equal(execDumped.includes('SPEC-BODY-MUST-NOT-PREFETCH'), false);
          assert.equal(execDumped.includes(BRIEF_CONTRACT_R2.intent), false);
          assert.equal(execDumped.includes('executionResult'), false);
          assert.equal(JSON.stringify(execBrief.workItem).includes('"body"'), false);

          const order = await postJson(base, '/api/agent/coagent_get_work_order', {}, execToken);
          assert.equal(order.status, 200);
          const orderJson = order.json as {
            workItemId?: string;
            title?: string;
            status?: string;
            order?: { contextRefs?: unknown; objective?: string };
            missionIntent?: string;
            guardrails?: unknown;
            previousRequiredChanges?: unknown;
          };
          assert.deepEqual(Object.keys(order.json).sort(), [
            'guardrails',
            'missionIntent',
            'order',
            'previousRequiredChanges',
            'status',
            'title',
            'workItemId',
          ]);
          assert.equal(orderJson.workItemId, workItemId);
          assert.equal(orderJson.title, 'W1');
          assert.equal(orderJson.order?.objective, BRIEF_ORDER.objective);
          assert.deepEqual(orderJson.order?.contextRefs, BRIEF_REFS);
          assert.equal(orderJson.missionIntent, BRIEF_CONTRACT_R2.intent);
          assert.deepEqual(orderJson.guardrails, BRIEF_CONTRACT_R2.guardrails);
          assert.deepEqual(orderJson.previousRequiredChanges, []);
          assert.equal(JSON.stringify(orderJson.order).includes('SPEC-BODY-MUST-NOT-PREFETCH'), false);

          const coordOrder = await postJson(base, '/api/agent/coagent_get_work_order', {}, coordToken);
          assert.equal(coordOrder.status, 409);
          assert.equal(coordOrder.json.error, 'ATTEMPT_NOT_BOUND');

          const undeclared = await postJson(
            base,
            '/api/agent/coagent_get_context',
            { ref: 'src/not-in-order.ts' },
            execToken,
          );
          assert.equal(undeclared.status, 200);
          assert.equal((undeclared.json as { found?: boolean }).found, false);
          assert.equal((undeclared.json as { body?: string }).body, undefined);
          assert.match(String((undeclared.json as { note?: string }).note ?? ''), /没有声明/);

          const fileRef = await postJson(
            base,
            '/api/agent/coagent_get_context',
            { ref: 'src/does-not-exist-w1.ts' },
            execToken,
          );
          assert.equal(fileRef.status, 200);
          assert.equal((fileRef.json as { found?: boolean }).found, true);
          assert.equal((fileRef.json as { kind?: string }).kind, 'file');
          assert.equal((fileRef.json as { body?: string }).body, undefined);
          assert.match(String((fileRef.json as { note?: string }).note ?? ''), /file/);

          const specRef = await postJson(
            base,
            '/api/agent/coagent_get_context',
            { ref: 'http-brief' },
            execToken,
          );
          assert.equal(specRef.status, 200);
          assert.equal((specRef.json as { found?: boolean }).found, true);
          assert.equal((specRef.json as { kind?: string }).kind, 'living_spec');
          assert.match(String((specRef.json as { body?: string }).body ?? ''), /SPEC-BODY-MUST-NOT-PREFETCH/);

          const contractRef = await postJson(
            base,
            '/api/agent/coagent_get_context',
            { ref: 'contract' },
            execToken,
          );
          assert.equal(contractRef.status, 200);
          assert.equal((contractRef.json as { found?: boolean }).found, true);
          assert.equal((contractRef.json as { kind?: string }).kind, 'contract');
          assert.match(String((contractRef.json as { body?: string }).body ?? ''), /把 X 修好（r2）/);

          const prevRef = await postJson(
            base,
            '/api/agent/coagent_get_context',
            { ref: 'W-prev' },
            execToken,
          );
          assert.equal(prevRef.status, 200);
          assert.equal((prevRef.json as { found?: boolean }).found, false);
          assert.equal((prevRef.json as { body?: string }).body, undefined);
          assert.match(String((prevRef.json as { note?: string }).note ?? ''), /还没有执行结果/);

          const coordCtx = await postJson(
            base,
            '/api/agent/coagent_get_context',
            { ref: 'contract' },
            coordToken,
          );
          assert.equal(coordCtx.status, 409);
          assert.equal(coordCtx.json.error, 'WRONG_ROLE');

          const coordMission = await postJson(base, '/api/agent/coagent_get_mission', {}, coordToken);
          const execMission = await postJson(base, '/api/agent/coagent_get_mission', {}, execToken);
          assert.equal(coordMission.status, 200);
          assert.equal(execMission.status, 200);
          assert.equal((coordMission.json as { contractRevision?: number }).contractRevision, 2);
          assert.equal((coordMission.json as { planRevision?: number }).planRevision, 3);
          assert.equal((execMission.json as { contractRevision?: number }).contractRevision, 2);

          const coordContractTool = await postJson(
            base,
            '/api/agent/coagent_get_contract',
            {},
            coordToken,
          );
          const execContractTool = await postJson(
            base,
            '/api/agent/coagent_get_contract',
            {},
            execToken,
          );
          assert.equal(coordContractTool.status, 200);
          assert.equal(execContractTool.status, 200);
          assert.deepEqual(Object.keys(coordContractTool.json).sort(), [
            'contract',
            'contractRevision',
          ]);
          assert.equal(
            (coordContractTool.json as { contractRevision?: number }).contractRevision,
            2,
          );
          assert.equal(
            (coordContractTool.json as { contract?: { intent?: string } }).contract?.intent,
            BRIEF_CONTRACT_R2.intent,
          );
          assert.equal(
            (execContractTool.json as { contractRevision?: number }).contractRevision,
            2,
          );

          const coordProject = await postJson(
            base,
            '/api/agent/coagent_get_project_context',
            {},
            coordToken,
          );
          const execProject = await postJson(
            base,
            '/api/agent/coagent_get_project_context',
            {},
            execToken,
          );
          assert.equal(coordProject.status, 200);
          assert.equal(execProject.status, 200);
          assert.equal((coordProject.json as { available?: boolean }).available, true);
          assert.equal((coordProject.json as { projectProfile?: string }).projectProfile, BRIEF_RULES);
          const specIndex = (coordProject.json as { specs?: { slug: string }[] }).specs ?? [];
          assert.equal(specIndex.some((s) => s.slug === 'http-brief'), true);
          assert.equal(JSON.stringify(coordProject.json).includes('SPEC-BODY-MUST-NOT-PREFETCH'), false);
          assert.equal((execProject.json as { available?: boolean }).available, true);

          const specDoc = await postJson(
            base,
            '/api/agent/coagent_get_project_context',
            { slug: 'http-brief' },
            coordToken,
          );
          assert.equal(specDoc.status, 200);
          assert.equal((specDoc.json as { available?: boolean }).available, true);
          assert.match(String((specDoc.json as { body?: string }).body ?? ''), /SPEC-BODY-MUST-NOT-PREFETCH/);
        } finally {
          await closeServer(server);
          rmSync(dir, { recursive: true, force: true });
        }
      },
    );
  },
);

type BriefEntry = {
  source: string;
  estimatedTokens?: number;
  content?: unknown;
};
type BriefBudgetReport = {
  budget?: number;
  estimatedBefore?: number;
  estimatedAfter?: number;
  omittedSources?: string[];
  overflow?: boolean;
  remainingOverBudget?: number;
};
type BriefBody = {
  role?: string;
  projectRules?: string;
  environmentNotes?: unknown;
  contract?: { intent?: string };
  contractRevision?: number;
  plan?: { direction?: string; findings?: string };
  planRevision?: number;
  workItem?: { id?: string; order?: { contextRefs?: unknown } };
  finalReview?: unknown;
  contextBundle?: {
    role?: string;
    entries?: BriefEntry[];
    budgetReport?: BriefBudgetReport;
  };
};
type ActivityRow = {
  kind?: string;
  missionId?: string;
  attemptId?: string;
  workItemId?: string;
  correlationId?: string;
  causationId?: string;
  data?: Record<string, unknown>;
};

function briefTokenTotal(brief: BriefBody): number {
  return (brief.contextBundle?.entries ?? []).reduce(
    (sum, entry) => sum + (entry.estimatedTokens ?? 0),
    0,
  );
}

function truncatedEvents(rows: unknown): ActivityRow[] {
  return (rows as ActivityRow[]).filter((row) => row.kind === 'context.truncated');
}

function assertSafeTruncationData(data: Record<string, unknown> | undefined, forbidden: string[]): void {
  assert.ok(data);
  const keys = Object.keys(data).sort();
  assert.deepEqual(
    keys.filter((key) => key !== 'remainingOverBudget'),
    ['budget', 'estimatedAfter', 'estimatedBefore', 'omittedSources', 'overflow', 'role'].sort(),
  );
  const dumped = JSON.stringify(data);
  for (const needle of forbidden) {
    assert.equal(dumped.includes(needle), false, `审计 data 不得含正文：${needle}`);
  }
}

async function startCoordWithPlan(
  base: string,
  platform: Platform,
  missionId: string,
): Promise<string> {
  const coord = await postJson(base, `/api/missions/${missionId}/coordinator-attempts`, {});
  assert.equal(coord.status, 201);
  const token = (coord.json as { token?: string }).token;
  assert.equal(typeof token, 'string');
  const planned = await postJson(
    base,
    '/api/agent/coagent_update_plan',
    BRIEF_PLAN,
    token,
  );
  assert.equal(planned.status, 200);
  await platform.reviseContract(missionId, BRIEF_CONTRACT_R2);
  return token;
}

describe('HTTP 简报显式预算与事务化裁剪审计', () => {
  test('恰好预算与无预算全留且零审计；N-1 保留顺序/必需字段；同 Attempt 去重、异 Attempt 各一条',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'http-brief-budget-'));
      mkdirSync(join(dir, '.coagent'), { recursive: true });
      writeFileSync(join(dir, '.coagent', 'project.md'), BRIEF_RULES, 'utf8');
      const store = new FileStateStore(join(dir, 'state.json'));
      const clock = new FixedClock();
      const ids = new PersistentIds(store);
      const projects = new FileProjectRepository(store);
      const activity = new FileActivityLog(store, clock);
      const deliveries = new FileDeliveryRepository(store, clock, ids);
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
        const created = await postJson(base, '/api/missions', {
          projectId: 'P-budget',
          missionId: 'M-budget',
          contract: CONTRACT,
        });
        assert.equal(created.status, 201);
        await platform.recordWorkspace('M-budget', {
          projectRoot: dir,
          branch: 'b',
          baseRevision: 'x',
        });
        const coordToken = await startCoordWithPlan(base, platform, 'M-budget');
        const coordAttemptId = tokens.resolve(coordToken)?.attemptId;
        assert.equal(typeof coordAttemptId, 'string');

        const noneRes = await getJson(base, '/api/run/brief', coordToken);
        assert.equal(noneRes.status, 200);
        const none = noneRes.json as BriefBody;
        const N = briefTokenTotal(none);
        assert.ok(N >= 2);
        assert.equal(none.contextBundle?.budgetReport, undefined);
        assert.deepEqual(
          none.contextBundle?.entries?.map((e) => e.source),
          ['project_rules', 'environment_notes', 'contract', 'plan', 'final_review'],
        );
        assert.equal(none.contract?.intent, BRIEF_CONTRACT_R2.intent);
        assert.equal(none.plan?.direction, BRIEF_PLAN.direction);
        assert.equal(none.projectRules, BRIEF_RULES);

        const exactRes = await getJson(base, `/api/run/brief?budget=${N}`, coordToken);
        assert.equal(exactRes.status, 200);
        const exact = exactRes.json as BriefBody;
        assert.deepEqual(
          exact.contextBundle?.entries?.map((e) => e.source),
          none.contextBundle?.entries?.map((e) => e.source),
        );
        assert.deepEqual(exact.contextBundle?.budgetReport?.omittedSources, []);
        assert.equal(exact.contextBundle?.budgetReport?.budget, N);
        assert.equal(exact.contextBundle?.budgetReport?.overflow, false);
        assert.equal(exact.plan?.direction, BRIEF_PLAN.direction);

        const activityNone = await getJson(base, '/api/missions/M-budget/activity');
        assert.equal(activityNone.status, 200);
        assert.equal(truncatedEvents(activityNone.json).length, 0);

        const planTokens =
          none.contextBundle?.entries?.find((e) => e.source === 'plan')?.estimatedTokens ?? 0;
        assert.ok(planTokens >= 1);
        const cutRes = await getJson(base, `/api/run/brief?budget=${N - 1}`, coordToken);
        assert.equal(cutRes.status, 200);
        const cut = cutRes.json as BriefBody;
        assert.deepEqual(cut.contextBundle?.entries?.map((e) => e.source), [
          'project_rules',
          'environment_notes',
          'contract',
          'final_review',
        ]);
        assert.deepEqual(cut.contextBundle?.budgetReport?.omittedSources, ['plan']);
        assert.equal(cut.contextBundle?.budgetReport?.estimatedBefore, N);
        assert.equal(cut.contextBundle?.budgetReport?.estimatedAfter, N - planTokens);
        assert.equal(cut.contextBundle?.budgetReport?.estimatedAfter, briefTokenTotal(cut));
        assert.equal(cut.contextBundle?.budgetReport?.overflow, false);
        assert.equal(cut.contract?.intent, BRIEF_CONTRACT_R2.intent);
        assert.equal(cut.contractRevision, 2);
        assert.equal(cut.projectRules, BRIEF_RULES);
        assert.equal(cut.plan, undefined);
        assert.equal(cut.planRevision, undefined);

        const again = await getJson(base, `/api/run/brief?budget=${N - 1}`, coordToken);
        assert.equal(again.status, 200);

        const wi = await postJson(
          base,
          '/api/agent/coagent_create_work_item',
          { title: 'W1', ...BRIEF_ORDER },
          coordToken,
        );
        assert.equal(wi.status, 200);
        const workItemId = (wi.json as { workItemId?: string }).workItemId;
        const dispatched = await postJson(
          base,
          '/api/agent/coagent_dispatch_work_item',
          { workItemIds: [workItemId] },
          coordToken,
        );
        assert.equal(dispatched.status, 200);
        const exec = await postJson(
          base,
          `/api/missions/M-budget/work-items/${workItemId}/executor-attempts`,
          {},
        );
        assert.equal(exec.status, 201);
        const execToken = (exec.json as { token?: string }).token;
        assert.equal(typeof execToken, 'string');
        const execAttemptId = tokens.resolve(execToken)?.attemptId;
        assert.equal(typeof execAttemptId, 'string');

        const execFullRes = await getJson(base, '/api/run/brief', execToken);
        assert.equal(execFullRes.status, 200);
        const execFull = execFullRes.json as BriefBody;
        const execN = briefTokenTotal(execFull);
        const execNotes =
          execFull.contextBundle?.entries?.find((e) => e.source === 'environment_notes')
            ?.estimatedTokens ?? 0;
        assert.ok(execNotes >= 1);
        const execCutRes = await getJson(
          base,
          `/api/run/brief?budget=${execN - execNotes}`,
          execToken,
        );
        assert.equal(execCutRes.status, 200);
        const execCut = execCutRes.json as BriefBody;
        assert.deepEqual(execCut.contextBundle?.budgetReport?.omittedSources, [
          'environment_notes',
        ]);
        assert.equal(execCut.projectRules, BRIEF_RULES);
        assert.deepEqual(execCut.workItem?.order?.contextRefs, BRIEF_REFS);
        assert.equal(execCut.environmentNotes, undefined);

        const overflowRes = await getJson(base, '/api/run/brief?budget=0', coordToken);
        assert.equal(overflowRes.status, 200);
        const overflow = overflowRes.json as BriefBody;
        assert.equal(overflow.contextBundle?.budgetReport?.overflow, true);
        assert.equal(
          overflow.contextBundle?.budgetReport?.remainingOverBudget,
          briefTokenTotal(overflow),
        );
        assert.equal(overflow.contract?.intent, BRIEF_CONTRACT_R2.intent);
        assert.equal(overflow.projectRules, BRIEF_RULES);
        assert.deepEqual(overflow.contextBundle?.budgetReport?.omittedSources, [
          'plan',
          'environment_notes',
        ]);

        for (const bad of ['-1', '1.5', 'abc', '01', '1e2', '', '+1']) {
          const rejected = await getJson(base, `/api/run/brief?budget=${bad}`, coordToken);
          assert.equal(rejected.status, 400, bad);
          assert.equal(rejected.json.error, 'INVALID_BUDGET', bad);
        }

        const activityCut = await getJson(base, '/api/missions/M-budget/activity');
        assert.equal(activityCut.status, 200);
        const trunc = truncatedEvents(activityCut.json);
        assert.equal(trunc.length, 2);
        const coordEvt = trunc.find((row) => row.attemptId === coordAttemptId);
        const execEvt = trunc.find((row) => row.attemptId === execAttemptId);
        assert.ok(coordEvt);
        assert.ok(execEvt);
        assert.equal(coordEvt.missionId, 'M-budget');
        assert.equal(coordEvt.correlationId, 'M-budget');
        assert.equal(coordEvt.causationId, coordAttemptId);
        assert.equal(coordEvt.workItemId, undefined);
        assertSafeTruncationData(coordEvt.data, [
          BRIEF_RULES,
          BRIEF_CONTRACT_R2.intent,
          BRIEF_PLAN.direction,
          BRIEF_PLAN.findings,
          'SPEC-BODY-MUST-NOT-PREFETCH',
        ]);
        assert.equal(coordEvt.data?.role, 'coordinator');
        assert.equal(coordEvt.data?.omittedSources?.[0], 'plan');
        assert.equal(execEvt.missionId, 'M-budget');
        assert.equal(execEvt.correlationId, 'M-budget');
        assert.equal(execEvt.causationId, execAttemptId);
        assertSafeTruncationData(execEvt.data, [BRIEF_RULES, BRIEF_CONTRACT_R2.intent]);
        assert.equal(execEvt.data?.role, 'executor');
      } finally {
        await closeServer(server);
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test('FileStateStore 事务路径：事件写入失败不返回裁剪简报；成功可重启后读到',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'http-brief-budget-fail-'));
      mkdirSync(join(dir, '.coagent'), { recursive: true });
      writeFileSync(join(dir, '.coagent', 'project.md'), BRIEF_RULES, 'utf8');
      const statePath = join(dir, 'state.json');
      const store = new FileStateStore(statePath);
      const clock = new FixedClock();
      const ids = new PersistentIds(store);
      const projects = new FileProjectRepository(store);
      const innerActivity = new FileActivityLog(store, clock);
      const injected = {
        fail: true,
        async append(event: { kind: string }): Promise<void> {
          if (this.fail && event.kind === 'context.truncated') {
            throw new Error('injected context.truncated persist failure');
          }
          await innerActivity.append(event as Parameters<FileActivityLog['append']>[0]);
        },
        list: (missionId: string) => innerActivity.list(missionId),
      };
      const deliveries = new FileDeliveryRepository(store, clock, ids);
      const platform = new Platform({
        projects,
        deliveries,
        activity: injected,
        clock,
        ids,
        transaction: store,
      });
      const tokens = new RunTokenRegistry();
      const server = createApi({ platform, tokens, deliveries });
      try {
        await listenLoopback(server, 0);
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const created = await postJson(base, '/api/missions', {
          projectId: 'P-fail',
          missionId: 'M-fail',
          contract: CONTRACT,
        });
        assert.equal(created.status, 201);
        await platform.recordWorkspace('M-fail', {
          projectRoot: dir,
          branch: 'b',
          baseRevision: 'x',
        });
        const coordToken = await startCoordWithPlan(base, platform, 'M-fail');
        const none = (await getJson(base, '/api/run/brief', coordToken)).json as BriefBody;
        const N = briefTokenTotal(none);
        const failed = await getJson(base, `/api/run/brief?budget=${N - 1}`, coordToken);
        assert.notEqual(failed.status, 200);
        assert.equal(failed.json.error, 'INTERNAL');
        const liveEvents = truncatedEvents(await innerActivity.list('M-fail'));
        assert.equal(liveEvents.length, 0);

        const reopenAfterFail = new FileStateStore(statePath);
        const persistedFail = new FileActivityLog(reopenAfterFail, clock);
        assert.equal(truncatedEvents(await persistedFail.list('M-fail')).length, 0);

        injected.fail = false;
        const ok = await getJson(base, `/api/run/brief?budget=${N - 1}`, coordToken);
        assert.equal(ok.status, 200);
        const cut = ok.json as BriefBody;
        assert.deepEqual(cut.contextBundle?.budgetReport?.omittedSources, ['plan']);
        assert.equal(truncatedEvents(await innerActivity.list('M-fail')).length, 1);
      } finally {
        await closeServer(server);
      }

      const restarted = new FileStateStore(statePath);
      const restartedActivity = new FileActivityLog(restarted, clock);
      const persisted = truncatedEvents(await restartedActivity.list('M-fail'));
      assert.equal(persisted.length, 1);
      assert.equal(persisted[0]?.missionId, 'M-fail');
      assert.equal(persisted[0]?.correlationId, 'M-fail');
      assert.equal(typeof persisted[0]?.attemptId, 'string');
      assert.equal(persisted[0]?.causationId, persisted[0]?.attemptId);
      assertSafeTruncationData(persisted[0]?.data, [BRIEF_RULES, BRIEF_CONTRACT_R2.intent, BRIEF_PLAN.direction]);
      rmSync(dir, { recursive: true, force: true });
    },
  );

  test('队列 Attempt 裁剪写入必须带 claim，不得绕过 #attemptWrite',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'http-brief-budget-queue-'));
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
        const queued = await platform.startCoordinatorAttempt('M', undefined, live);
        await platform.updatePlan('M', queued.attemptId, QUEUE_PLAN, live);
        const full = await platform.getStartupBrief('M', queued.attemptId);
        const N = briefTokenTotal(full);
        assert.ok(N >= 2);
        await assert.rejects(
          () => platform.getStartupBrief('M', queued.attemptId, N - 1),
          (error: unknown) =>
            error instanceof PlatformRuleError && error.code === 'QUEUE_CLAIM_REQUIRED',
        );
        assert.equal(
          (await activity.list('M')).filter((event) => event.kind === 'context.truncated').length,
          0,
        );
        const trimmed = await platform.getStartupBrief('M', queued.attemptId, N - 1, live);
        assert.ok((trimmed.contextBundle.budgetReport?.omittedSources.length ?? 0) > 0);
        await platform.getStartupBrief('M', queued.attemptId, N - 1, live);
        const trunc = (await activity.list('M')).filter((event) => event.kind === 'context.truncated');
        assert.equal(trunc.length, 1);
        assert.equal(trunc[0]?.attemptId, queued.attemptId);
        assert.equal(trunc[0]?.missionId, 'M');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

async function request(
  base: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown>; headers: Headers }> {
  const res = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: res.status,
    json: (await res.json()) as Record<string, unknown>,
    headers: res.headers,
  };
}

function tapPlatform(
  platform: Platform,
  method: 'finalizeMission' | 'finalizeMissionByReviewer' | 'finalizeMissionByHaAuthority',
): unknown[][] {
  const calls: unknown[][] = [];
  const orig = platform[method].bind(platform) as (...args: unknown[]) => unknown;
  (platform as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
    calls.push(args);
    return orig(...args);
  };
  return calls;
}

async function openApi(options?: {
  onMutation?: () => void | Promise<void>;
  identity?: { instanceId: string; stateId: string };
  runMission?: HostedRunHandler;
  runPlan?: HostedRunHandler;
}): Promise<{
  server: Server;
  base: string;
  platform: Platform;
  projects: InMemoryProjectRepository;
}> {
  const clock = new FixedClock();
  const ids = new SequentialIds();
  const deliveries = new InMemoryDeliveryRepository(clock, ids);
  const projects = new InMemoryProjectRepository();
  const platform = new Platform({
    projects,
    deliveries,
    activity: new InMemoryActivityLog(clock),
    clock,
    ids,
  });
  const server = createApi({
    platform,
    tokens: new RunTokenRegistry(),
    deliveries,
    ...(options?.onMutation ? { onMutation: options.onMutation } : {}),
    ...(options?.identity ? { identity: options.identity } : {}),
    ...(options?.runMission ? { runMission: options.runMission } : {}),
    ...(options?.runPlan ? { runPlan: options.runPlan } : {}),
  });
  await listenLoopback(server, 0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, base, platform, projects };
}

async function seedAwaitingReview(base: string, missionId: string, projectId = 'P'): Promise<string> {
  const created = await request(base, '/api/missions', {
    projectId,
    missionId,
    contract: CONTRACT,
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const coord = await request(base, `/api/missions/${missionId}/coordinator-attempts`, {});
  assert.equal(coord.status, 201, JSON.stringify(coord.json));
  const coordToken = coord.json.token as string;
  const planned = await postJson(base, '/api/agent/coagent_update_plan', {
    findings: 'f',
    rejectedHypotheses: [],
    decisions: [],
    direction: 'd',
    risks: [],
  }, coordToken);
  assert.equal(planned.status, 200, JSON.stringify(planned.json));
  const wi = await postJson(base, '/api/agent/coagent_create_work_item', { title: 'W', ...ORDER }, coordToken);
  assert.equal(wi.status, 200, JSON.stringify(wi.json));
  const workItemId = (wi.json as { workItemId?: string }).workItemId as string;
  const dispatched = await postJson(base, '/api/agent/coagent_dispatch_work_item', { workItemIds: [workItemId] }, coordToken);
  assert.equal(dispatched.status, 200, JSON.stringify(dispatched.json));
  const exec = await request(base, `/api/missions/${missionId}/work-items/${workItemId}/executor-attempts`, {});
  assert.equal(exec.status, 201, JSON.stringify(exec.json));
  const execToken = exec.json.token as string;
  const evidence = await postJson(
    base,
    '/api/agent/coagent_submit_evidence',
    { kind: 'test', summary: 'ok', command: 'node --test', exitCode: 0 },
    execToken,
  );
  assert.equal(evidence.status, 200, JSON.stringify(evidence.json));
  const submitted = await postJson(
    base,
    '/api/agent/coagent_submit_execution_result',
    {
      outcome: 'completed',
      summary: 'ok',
      changedFiles: ['src/foo.ts'],
      evidenceIds: [(evidence.json as { evidenceId?: string }).evidenceId],
      notes: '无',
    },
    execToken,
  );
  assert.equal(submitted.status, 200, JSON.stringify(submitted.json));
  const finished = await request(base, `/api/missions/${missionId}/attempts/${exec.json.attemptId as string}/finish`, {
    endedBy: 'structured_submit',
  });
  assert.equal(finished.status, 200, JSON.stringify(finished.json));
  const reviewed = await postJson(
    base,
    '/api/agent/coagent_review_execution_result',
    {
      workItemId,
      verdict: 'accept',
      acceptanceResults: ORDER.acceptance.map((criterion) => ({
        criterion,
        status: 'pass',
        evidence: '测过',
      })),
      reasons: ['ok'],
      requiredChanges: [],
    },
    coordToken,
  );
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.json));
  const delivered = await postJson(
    base,
    '/api/agent/coagent_submit_mission_result',
    {
      outcome: 'delivered',
      summary: '交付',
      acceptanceEvidence: ['ok'],
      memoryDelta: [],
      openRisks: [],
    },
    coordToken,
  );
  assert.equal(delivered.status, 200, JSON.stringify(delivered.json));
  const view = await request(base, `/api/missions/${missionId}`);
  assert.equal(view.json.status, 'awaiting_review', JSON.stringify(view.json));
  return workItemId;
}

describe('L3 写路由与落盘后应答', () => {
  test('人签名 / reviewer / HA reviewer merge 分别打到对应 Platform 入口', async () => {
    const { server, base, platform, projects } = await openApi();
    try {
      const humanCalls = tapPlatform(platform, 'finalizeMission');
      const reviewerCalls = tapPlatform(platform, 'finalizeMissionByReviewer');
      const haCalls = tapPlatform(platform, 'finalizeMissionByHaAuthority');

      await seedAwaitingReview(base, 'M-human', 'P-human');
      const human = await request(base, '/api/missions/M-human/finalize', {
        verdict: 'send_back',
        reasons: ['边界不够'],
      });
      assert.equal(human.status, 200);
      assert.equal(human.json.status, 'planning');
      assert.equal(humanCalls.length, 1);
      assert.equal(reviewerCalls.length, 0);
      assert.equal(haCalls.length, 0);

      await seedAwaitingReview(base, 'M-reviewer', 'P-reviewer');
      const reviewer = await request(base, '/api/missions/M-reviewer/finalize/reviewer', {
        verdict: 'send_back',
        reasons: ['检视者打回'],
        reviewerId: 'claude',
        confirmedBy: 'echo',
      });
      assert.equal(reviewer.status, 200, JSON.stringify(reviewer.json));
      assert.equal(reviewer.json.status, 'planning');
      assert.equal(reviewerCalls.length, 1);
      assert.equal(haCalls.length, 0);

      const project = await projects.ensure('P');
      project.createMission({
        id: 'M-ha',
        contract: CONTRACT,
        executionMode: 'high_assurance',
      });
      await projects.save(project);
      const ha = await request(base, '/api/missions/M-ha/finalize/reviewer', {
        verdict: 'merge',
        reasons: ['ok'],
        reviewerId: 'claude',
        confirmedBy: 'echo',
      });
      assert.notEqual(ha.status, 200);
      assert.equal(haCalls.length, 1);
      assert.equal((haCalls[0] as unknown[])[0], 'M-ha');
      assert.equal(reviewerCalls.length, 1, 'HA merge 不得再走普通 reviewer 入口');
    } finally {
      await closeServer(server);
    }
  });

  test('retire / rerun / answer / revise / control / ack 成功与规则拒绝', async () => {
    const { server, base } = await openApi();
    try {
      const created = await request(base, '/api/missions', {
        projectId: 'P',
        missionId: 'M-l3',
        contract: CONTRACT,
      });
      assert.equal(created.status, 201);

      const coord = await request(base, '/api/missions/M-l3/coordinator-attempts', {});
      const coordToken = coord.json.token as string;
      await postJson(
        base,
        '/api/agent/coagent_update_plan',
        { findings: 'f', rejectedHypotheses: [], decisions: [], direction: 'd', risks: [] },
        coordToken,
      );
      const wi = await postJson(
        base,
        '/api/agent/coagent_create_work_item',
        { title: 'W', ...ORDER },
        coordToken,
      );
      const workItemId = (wi.json as { workItemId?: string }).workItemId as string;

      const retired = await request(base, `/api/missions/M-l3/work-items/${workItemId}/retire`, {
        reason: '契约改了，不用做了',
      });
      assert.equal(retired.status, 200, JSON.stringify(retired.json));
      assert.equal(retired.json.status, 'retired');
      const retiredAgain = await request(base, `/api/missions/M-l3/work-items/${workItemId}/retire`, {
        reason: '再作废一次',
      });
      assert.equal(retiredAgain.status, 409);
      assert.equal(retiredAgain.json.error, 'NOT_RETIRABLE');

      const rerun = await request(base, '/api/missions/M-l3/rerun', { newMissionId: 'M-l3-b' });
      assert.equal(rerun.status, 200, JSON.stringify(rerun.json));
      assert.equal(rerun.json.missionId, 'M-l3-b');
      const rerunMissing = await request(base, '/api/missions/no-such/rerun', {});
      assert.notEqual(rerunMissing.status, 200);
      assert.equal(typeof rerunMissing.json.error, 'string');

      const noEscalation = await request(base, '/api/missions/M-l3/escalations/answer', {
        answer: '先答',
      });
      assert.equal(noEscalation.status, 409);
      assert.equal(noEscalation.json.error, 'NO_OPEN_ESCALATION');
      await postJson(
        base,
        '/api/agent/coagent_escalate_to_l3',
        {
          question: '边界是什么',
          why: '范围不清楚',
          optionsConsidered: ['只改 foo', '全盘重做'],
        },
        coordToken,
      );
      const answered = await request(base, '/api/missions/M-l3/escalations/answer', {
        answer: '只改 foo',
      });
      assert.equal(answered.status, 200, JSON.stringify(answered.json));
      assert.equal(answered.json.answer, '只改 foo');

      const revised = await request(base, '/api/missions/M-l3/contract', {
        intent: '改过的意图',
        acceptance: ['测试全绿'],
        constraints: [],
        nonGoals: [],
        guardrails: ['不得改 Contract'],
      });
      assert.equal(revised.status, 200, JSON.stringify(revised.json));
      assert.equal(revised.json.contractRevision, 2);

      const paused = await request(base, '/api/missions/M-l3/pause', {});
      assert.equal(paused.status, 200);
      assert.equal(paused.json.paused, true);
      const resumed = await request(base, '/api/missions/M-l3/resume', {});
      assert.equal(resumed.status, 200);
      assert.equal(resumed.json.paused, false);
      const cancelled = await request(base, '/api/missions/M-l3/cancel', { reason: '停' });
      assert.equal(cancelled.status, 200);
      assert.equal(cancelled.json.status, 'blocked');
      const cancelAgain = await request(base, '/api/missions/M-l3/cancel', { reason: '再停' });
      assert.notEqual(cancelAgain.status, 200);

      const inbox = await request(base, '/api/inbox');
      assert.equal(inbox.status, 200);
      const pending = inbox.json.pending as Array<{ id: string }>;
      assert.ok(pending.length >= 1);
      const acked = await request(base, `/api/deliveries/${pending[0].id}/ack`, {});
      assert.equal(acked.status, 200);
      const ackMissing = await request(base, '/api/deliveries/no-such/ack', {});
      assert.equal(ackMissing.status, 404);
      assert.equal(ackMissing.json.error, 'UNKNOWN_DELIVERY');
    } finally {
      await closeServer(server);
    }
  });

  test('onMutation 拒绝时 POST 不得 2xx；成功落盘后可被读到', async () => {
    const rejecting = await openApi({
      onMutation: () => {
        throw new Error('disk full');
      },
    });
    try {
      const failed = await request(rejecting.base, '/api/missions', {
        projectId: 'P',
        missionId: 'M-persist-fail',
        contract: CONTRACT,
      });
      assert.notEqual(failed.status, 200);
      assert.ok(failed.status < 200 || failed.status >= 300);
      assert.equal(failed.json.error, 'PERSIST_FAILED');
      assert.match(String(failed.json.message), /结果不确定/);
    } finally {
      await closeServer(rejecting.server);
    }

    const dir = mkdtempSync(join(tmpdir(), 'http-l3-persist-'));
    const statePath = join(dir, 'state.json');
    const store = new FileStateStore(statePath);
    const clock = new FixedClock();
    const ids = new PersistentIds(store);
    const projects = new FileProjectRepository(store);
    const deliveries = new FileDeliveryRepository(store, clock, ids);
    const platform = new Platform({
      projects,
      deliveries,
      activity: new FileActivityLog(store, clock),
      clock,
      ids,
      transaction: store,
    });
    const server = createApi({
      platform,
      tokens: new RunTokenRegistry(),
      deliveries,
      onMutation: () => store.flush(),
    });
    try {
      await listenLoopback(server, 0);
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const created = await request(base, '/api/missions', {
        projectId: 'P-file',
        missionId: 'M-file',
        contract: CONTRACT,
      });
      assert.equal(created.status, 201);
      const restarted = new FileStateStore(statePath);
      const names = (await new FileProjectRepository(restarted).list()).flatMap((project) =>
        project.missions.map((mission) => mission.id),
      );
      assert.ok(names.includes('M-file'));
    } finally {
      await closeServer(server);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('错误带 api 版本及与 health 一致的 instance/state', async () => {
    const identity = { instanceId: '11111111-1111-4111-8111-111111111111', stateId: 'state-l3' };
    const { server, base } = await openApi({ identity });
    try {
      const health = await request(base, '/api/health');
      assert.equal(health.status, 200);
      assert.equal(health.headers.get('x-coagent-api'), API_VERSION);
      assert.equal(health.headers.get('x-coagent-instance'), identity.instanceId);
      assert.equal(health.headers.get('x-coagent-state-id'), identity.stateId);

      const missing = await request(base, '/api/missions/no-such/finalize', {
        verdict: 'merge',
        reasons: [],
      });
      assert.notEqual(missing.status, 200);
      assert.equal(missing.headers.get('x-coagent-api'), API_VERSION);
      assert.equal(missing.headers.get('x-coagent-instance'), health.headers.get('x-coagent-instance'));
      assert.equal(missing.headers.get('x-coagent-state-id'), health.headers.get('x-coagent-state-id'));
      assert.equal(typeof missing.json.error, 'string');
      assert.equal(typeof missing.json.message, 'string');
    } finally {
      await closeServer(server);
    }
  });
});

const RUN_IDENTITY = {
  instanceId: '22222222-2222-4222-8222-222222222222',
  stateId: 'state-run',
};

function writerTarget(port: number) {
  return {
    port,
    instanceId: RUN_IDENTITY.instanceId,
    stateId: RUN_IDENTITY.stateId,
    apiVersion: API_VERSION,
  };
}

describe('hosted run 流与排空门禁', () => {
  test('未配置的 run-mission / run-plan 明确拒绝，JSON API 语义不变', async () => {
    const { server, base } = await openApi({ identity: RUN_IDENTITY });
    try {
      await assert.rejects(
        () =>
          loopbackRunRequest(writerTarget((server.address() as AddressInfo).port), {
            path: '/api/control/run-mission',
            body: {},
          }, () => {}),
        (error: unknown) =>
          error instanceof LoopbackHttpError &&
          error.status === 501 &&
          error.code === 'HOSTED_RUN_UNAVAILABLE',
      );
      await assert.rejects(
        () =>
          loopbackRunRequest(writerTarget((server.address() as AddressInfo).port), {
            path: '/api/control/run-plan',
            body: {},
          }, () => {}),
        (error: unknown) =>
          error instanceof LoopbackHttpError &&
          error.status === 501 &&
          error.code === 'HOSTED_RUN_UNAVAILABLE',
      );
      const health = await request(base, '/api/health');
      assert.equal(health.status, 200);
      assert.equal(health.json.ok, true);
    } finally {
      await closeServer(server);
    }
  });

  test('持锁身份下流先进度后终态，stdout/stderr 可区分，非零 exitCode 原样返回', async () => {
    const seenBodies: unknown[] = [];
    const runMission: HostedRunHandler = async (body, emit) => {
      seenBodies.push(body);
      emit('stdout', 'running-out');
      emit('stderr', 'running-err');
      return 7;
    };
    const runPlan: HostedRunHandler = async (_body, emit) => {
      emit('stdout', 'plan-out');
      return 0;
    };
    const { server, base } = await openApi({
      identity: RUN_IDENTITY,
      runMission,
      runPlan,
    });
    try {
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(`${base}/api/control/run-mission`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: '/tmp/x' }),
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-coagent-api'), API_VERSION);
      assert.equal(res.headers.get('x-coagent-instance'), RUN_IDENTITY.instanceId);
      assert.equal(res.headers.get('x-coagent-state-id'), RUN_IDENTITY.stateId);
      assert.match(res.headers.get('content-type') ?? '', /application\/x-ndjson/);
      const frames = (await res.text())
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      assert.deepEqual(frames.slice(0, -1), [
        { channel: 'stdout', line: 'running-out' },
        { channel: 'stderr', line: 'running-err' },
      ]);
      assert.deepEqual(frames.at(-1), { exitCode: 7 });
      assert.deepEqual(seenBodies, [{ cwd: '/tmp/x' }]);

      const lines: Array<{ channel: string; line: string }> = [];
      const code = await loopbackRunRequest(
        writerTarget(port),
        { path: '/api/control/run-mission', body: { cwd: '/tmp/x' } },
        (channel, line) => {
          lines.push({ channel, line });
        },
      );
      assert.equal(code, 7);
      assert.deepEqual(lines, [
        { channel: 'stdout', line: 'running-out' },
        { channel: 'stderr', line: 'running-err' },
      ]);

      const planCode = await loopbackRunRequest(
        writerTarget(port),
        { path: '/api/control/run-plan', body: {} },
        (channel, line) => {
          assert.equal(channel, 'stdout');
          assert.equal(line, 'plan-out');
        },
      );
      assert.equal(planCode, 0);
    } finally {
      await closeServer(server);
    }
  });

  test('回调抛错写成 stderr 和非零终态；身份错误与断线/缺终态显式失败且不重试', async () => {
    const runMission: HostedRunHandler = async (_body, emit) => {
      emit('stdout', 'before-throw');
      throw new Error('hosted boom');
    };
    const { server } = await openApi({ identity: RUN_IDENTITY, runMission });
    try {
      const port = (server.address() as AddressInfo).port;
      const lines: Array<{ channel: string; line: string }> = [];
      const code = await loopbackRunRequest(
        writerTarget(port),
        { path: '/api/control/run-mission', body: {} },
        (channel, line) => lines.push({ channel, line }),
      );
      assert.equal(code, 1);
      assert.deepEqual(lines, [
        { channel: 'stdout', line: 'before-throw' },
        { channel: 'stderr', line: 'hosted boom' },
      ]);

      await assert.rejects(
        () =>
          loopbackRunRequest(
            { ...writerTarget(port), instanceId: 'other-instance' },
            { path: '/api/control/run-mission', body: {} },
            () => {
              throw new Error('身份错误后不得把进度当成功');
            },
          ),
        (error: unknown) => error instanceof LoopbackIdentityError && /实例漂移/.test(error.message),
      );
    } finally {
      await closeServer(server);
    }

    let hits = 0;
    const stub = createServer((req, res) => {
      hits += 1;
      const url = req.url ?? '/';
      if (url.includes('cut')) {
        res.writeHead(200, {
          'x-coagent-api': API_VERSION,
          'x-coagent-instance': RUN_IDENTITY.instanceId,
          'x-coagent-state-id': RUN_IDENTITY.stateId,
          'content-type': 'application/x-ndjson; charset=utf-8',
        });
        res.write(`${JSON.stringify({ channel: 'stdout', line: 'partial' })}\n`);
        res.end();
        return;
      }
      res.writeHead(200, {
        'x-coagent-api': API_VERSION,
        'x-coagent-instance': RUN_IDENTITY.instanceId,
        'x-coagent-state-id': RUN_IDENTITY.stateId,
        'content-type': 'application/x-ndjson; charset=utf-8',
      });
      res.write(`${JSON.stringify({ channel: 'stdout', line: 'hang' })}\n`);
      req.socket.destroy();
    });
    try {
      await listenLoopback(stub, 0);
      const port = (stub.address() as AddressInfo).port;
      const target = writerTarget(port);
      await assert.rejects(
        () => loopbackRunRequest(target, { path: '/cut', body: {} }, () => {}),
        (error: unknown) => error instanceof Error && /截断/.test(error.message),
      );
      await assert.rejects(
        () => loopbackRunRequest(target, { path: '/drop', body: {} }, () => {}),
        (error: unknown) => error instanceof Error && /写者断线|截断/.test(error.message),
      );
      assert.equal(hits, 2, '断线与缺终态都不得自动重试');
    } finally {
      await closeServer(stub);
    }
  });

  test('关闭门禁拒新启动并等待在途 job/HTTP 写；断连后 job 仍只执行一次，JSON 仍可响应', async () => {
    let releaseJob: (code: number) => void = () => {};
    let jobStarted!: () => void;
    const jobStartedPromise = new Promise<void>((resolve) => {
      jobStarted = resolve;
    });
    let runs = 0;
    const runMission: HostedRunHandler = async (_body, emit) => {
      runs += 1;
      emit('stdout', 'job-running');
      jobStarted();
      return await new Promise<number>((resolve) => {
        releaseJob = resolve;
      });
    };
    let releaseMutation: () => void = () => {};
    let mutationStarted!: () => void;
    const mutationStartedPromise = new Promise<void>((resolve) => {
      mutationStarted = resolve;
    });
    const { server, base } = await openApi({
      identity: RUN_IDENTITY,
      runMission,
      onMutation: async () => {
        mutationStarted();
        await new Promise<void>((resolve) => {
          releaseMutation = resolve;
        });
      },
    });
    try {
      const port = (server.address() as AddressInfo).port;
      const aborted = await new Promise<{ status: number }>((resolve, reject) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            family: 4,
            port,
            path: '/api/control/run-mission',
            method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': 2 },
          },
          (res) => {
            res.once('data', () => {
              req.destroy();
              resolve({ status: res.statusCode ?? 0 });
            });
          },
        );
        req.on('error', () => {
          // destroy 之后 socket 报错是预期，job 必须继续。
        });
        req.on('timeout', () => reject(new Error('abort fixture timed out')));
        req.write('{}');
        req.end();
      });
      assert.equal(aborted.status, 200);
      await jobStartedPromise;
      assert.equal(runs, 1);

      const writePromise = request(base, '/api/missions', {
        projectId: 'P-drain',
        missionId: 'M-drain',
        contract: CONTRACT,
      });
      await mutationStartedPromise;

      const draining = drainApi(server);
      let drainDone = false;
      void draining.then(() => {
        drainDone = true;
      });
      await Promise.resolve();
      assert.equal(drainDone, false);

      await assert.rejects(
        () =>
          loopbackRunRequest(writerTarget(port), { path: '/api/control/run-mission', body: {} }, () => {}),
        (error: unknown) =>
          error instanceof LoopbackHttpError &&
          error.status === 503 &&
          error.code === 'SERVICE_DRAINING',
      );
      assert.equal(runs, 1);

      const health = await request(base, '/api/health');
      assert.equal(health.status, 200);
      assert.equal(health.json.ok, true);
      assert.equal(drainDone, false);

      releaseJob(0);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(drainDone, false, '写请求未结束时 drain 不能完成');
      releaseMutation();
      const written = await writePromise;
      assert.equal(written.status, 201);
      await draining;
      assert.equal(drainDone, true);
      assert.equal(runs, 1);

      const after = await request(base, '/api/health');
      assert.equal(after.status, 200);
    } finally {
      releaseJob(1);
      releaseMutation();
      await closeServer(server);
    }
  });

  test('心跳帧不进 onLine；有心跳时短超时不断流；无字节才超时且不重试', async () => {
    const ndjsonHeaders = {
      'x-coagent-api': API_VERSION,
      'x-coagent-instance': RUN_IDENTITY.instanceId,
      'x-coagent-state-id': RUN_IDENTITY.stateId,
      'content-type': 'application/x-ndjson; charset=utf-8',
    };
    const waitUntil = (predicate: () => boolean, timeoutMs: number, dump: () => string): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      return new Promise((resolve, reject) => {
        const tick = () => {
          if (predicate()) {
            resolve();
            return;
          }
          if (Date.now() >= deadline) {
            reject(new Error(`等待超时：${dump()}`));
            return;
          }
          setTimeout(tick, 15);
        };
        tick();
      });
    };

    const mixed = createServer((_req, res) => {
      res.writeHead(200, ndjsonHeaders);
      res.write(`${JSON.stringify({ heartbeat: true })}\n`);
      res.write(`${JSON.stringify({ channel: 'stdout', line: 'keep' })}\n`);
      res.write(`${JSON.stringify({ heartbeat: true })}\n`);
      res.write(`${JSON.stringify({ exitCode: 0 })}\n`);
      res.end();
    });
    try {
      await listenLoopback(mixed, 0);
      const lines: Array<{ channel: string; line: string }> = [];
      const code = await loopbackRunRequest(
        writerTarget((mixed.address() as AddressInfo).port),
        { path: '/run', body: {} },
        (channel, line) => lines.push({ channel, line }),
      );
      assert.equal(code, 0);
      assert.deepEqual(lines, [{ channel: 'stdout', line: 'keep' }]);
    } finally {
      await closeServer(mixed);
    }

    let liveHits = 0;
    let heartbeats = 0;
    let finishLive: (() => void) | undefined;
    const live = createServer((_req, res) => {
      liveHits += 1;
      res.writeHead(200, ndjsonHeaders);
      const timer = setInterval(() => {
        heartbeats += 1;
        res.write(`${JSON.stringify({ heartbeat: true })}\n`);
      }, 20);
      finishLive = () => {
        clearInterval(timer);
        res.write(`${JSON.stringify({ exitCode: 0 })}\n`);
        res.end();
      };
    });
    try {
      await listenLoopback(live, 0);
      const lines: Array<{ channel: string; line: string }> = [];
      const running = loopbackRunRequest(
        writerTarget((live.address() as AddressInfo).port),
        { path: '/run', body: {} },
        (channel, line) => lines.push({ channel, line }),
        { timeoutMs: 80 },
      );
      await waitUntil(() => heartbeats >= 4, 1_000, () => `heartbeats=${String(heartbeats)}`);
      finishLive?.();
      assert.equal(await running, 0);
      assert.deepEqual(lines, []);
      assert.equal(liveHits, 1, '有心跳的长流不得自动重试');
    } finally {
      finishLive?.();
      await closeServer(live);
    }

    let idleHits = 0;
    const idle = createServer((_req, res) => {
      idleHits += 1;
      res.writeHead(200, ndjsonHeaders);
    });
    try {
      await listenLoopback(idle, 0);
      const target = writerTarget((idle.address() as AddressInfo).port);
      await assert.rejects(
        () => loopbackRunRequest(target, { path: '/run', body: {} }, () => {}, { timeoutMs: 80 }),
        (error: unknown) => error instanceof Error && /回环运行流超时/.test(error.message),
      );
      await assert.rejects(
        () => loopbackRunRequest(target, { path: '/run', body: {} }, () => {}, { timeoutMs: 80 }),
        (error: unknown) => error instanceof Error && /回环运行流超时/.test(error.message),
      );
      assert.equal(idleHits, 2, '超时失败不得在单次调用内重试；两次调用才是两次');
    } finally {
      await closeServer(idle);
    }
  });

  test('hosted run 空闲心跳可被探测且不进进度；等待期间健康检查仍可回应', async () => {
    let releaseJob: (code: number) => void = () => {};
    const runPlan: HostedRunHandler = async (_body, emit) => {
      emit('stdout', 'waiting');
      return await new Promise<number>((resolve) => {
        releaseJob = resolve;
      });
    };
    const { server, base } = await openApi({ identity: RUN_IDENTITY, runPlan });
    try {
      const port = (server.address() as AddressInfo).port;
      const frames: Array<Record<string, unknown>> = [];
      const raw = await new Promise<{ req: ReturnType<typeof httpRequest> }>((resolve, reject) => {
        const req = httpRequest(
          {
            host: '127.0.0.1',
            family: 4,
            port,
            path: '/api/control/run-plan',
            method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': 2 },
          },
          (res) => {
            let buffer = '';
            res.on('data', (chunk) => {
              buffer += String(chunk);
              let nl = buffer.indexOf('\n');
              while (nl >= 0) {
                const rawLine = buffer.slice(0, nl);
                buffer = buffer.slice(nl + 1);
                nl = buffer.indexOf('\n');
                if (rawLine.length === 0) continue;
                frames.push(JSON.parse(rawLine) as Record<string, unknown>);
              }
            });
            resolve({ req });
          },
        );
        req.on('error', reject);
        req.write('{}');
        req.end();
      });
      const deadline = Date.now() + HOSTED_RUN_HEARTBEAT_IDLE_MS * 3;
      await new Promise<void>((resolve, reject) => {
        const tick = () => {
          if (frames.some((frame) => frame.heartbeat === true)) {
            resolve();
            return;
          }
          if (Date.now() >= deadline) {
            reject(new Error(`未见心跳：${JSON.stringify(frames)}`));
            return;
          }
          setTimeout(tick, 20);
        };
        tick();
      });
      assert.ok(frames.some((frame) => frame.channel === 'stdout' && frame.line === 'waiting'));
      assert.equal(
        frames.some((frame) => frame.heartbeat === true && (frame.channel === 'stdout' || frame.channel === 'stderr')),
        false,
      );
      const health = await request(base, '/api/health');
      assert.equal(health.status, 200);
      assert.equal(health.json.ok, true);
      assert.equal(
        frames.filter((frame) => frame.heartbeat === true).every((frame) => frame.channel === undefined),
        true,
      );
      releaseJob(0);
      const endAt = Date.now() + 2_000;
      await new Promise<void>((resolve, reject) => {
        const tick = () => {
          if (frames.some((frame) => typeof frame.exitCode === 'number')) {
            resolve();
            return;
          }
          if (Date.now() >= endAt) {
            reject(new Error(`未见终态：${JSON.stringify(frames)}`));
            return;
          }
          setTimeout(tick, 20);
        };
        tick();
      });
      assert.equal(frames.at(-1)?.exitCode, 0);
      raw.req.destroy();
    } finally {
      releaseJob(1);
      await closeServer(server);
    }
  });
});
