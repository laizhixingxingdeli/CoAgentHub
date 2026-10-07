/**
 * impact 专属工具的真实 HTTP 组合测试（W-475）。
 *
 * 为什么单独一个文件：这里要的是「身份从 x-coagent-run 进来 → 门禁在 readJson
 * 之前 → 业务落在真实 Platform + File 事务里」这条完整链路。直接调 Platform
 * 测出来的「通过」不覆盖 HTTP 层那道分流，而 W-472 改的正是那道分流。
 *
 * 为什么用真实 FileStateStore：内存版没有事务回滚，「拒绝之后盘上有没有多一条
 * 记录」这句话在内存版上根本测不到。拒绝必须是逐字节不改。
 *
 * 只两条组合测试：拆开之后每条都要各自搭一遍 Mission / 目标执行 / impact 槽，
 * 搭出来的那一份很快会和真实装配漂移。
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import type { MissionContract, WorkOrder } from '../src/kernel/index.ts';
import { FixedClock } from '../src/application/in-memory.ts';
import {
  FileActivityLog,
  FileDeliveryRepository,
  FileProjectRepository,
  FileQueuedHopRepository,
  FileStateStore,
  PersistentIds,
} from '../src/application/file-store.ts';
import { FileChangeRequestRepository } from '../src/application/change-request-repository.ts';
import { FileChangeImpactRepository } from '../src/application/change-impact-repository.ts';
import type { QueuedHop } from '../src/application/durable-scheduler.ts';
import type { ChangeRequest } from '../src/application/change-request.ts';
import { Platform, type QueueClaimIdentity } from '../src/application/platform.ts';
import { RunTokenRegistry } from '../src/api/run-tokens.ts';
import { createApi } from '../src/api/server.ts';
import { listenLoopback } from '../src/application/loopback-listen.ts';

const NOW = '2026-01-01T00:00:00.000Z';
/**
 * 租约时长而不是绝对时刻：过期用例要把时钟推着走。执行者租约短、impact 租约长，
 * 于是「目标失租」那条拒绝不会同时被「impact 自己也过期了」蒙对。
 */
const EXEC_LEASE_MS = 60 * 1000;
const IMPACT_LEASE_MS = 30 * 60 * 1000;

const CONTRACT: MissionContract = {
  intent: '把 X 修好',
  acceptance: ['测试全绿', 'foo 返回 1'],
  constraints: [],
  nonGoals: [],
  guardrails: ['不得改 Contract'],
};

const PLAN = {
  findings: '查到了',
  rejectedHypotheses: [] as string[],
  decisions: [] as string[],
  direction: '这么改',
  risks: [] as string[],
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

const ORIGIN = { clientType: 'cli', conversationRef: 'me' };

const IMPACT_BODY = {
  decision: 'compatible',
  workOrderDiff: '把 step 2 换成 step 2b',
  affectedAcceptance: [1],
  reason: 'step 2b 仍可执行',
};

const CHANGE_ID = 'CR-1';

const dirs: string[] = [];
const servers: Server[] = [];
after(async () => {
  for (const server of servers) await closeServer(server);
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  readonly statePath: string;
  readonly clock: FixedClock;
  readonly platform: Platform;
  readonly hops: FileQueuedHopRepository;
  readonly requests: FileChangeRequestRepository;
  readonly impacts: FileChangeImpactRepository;
  readonly deliveries: FileDeliveryRepository;
  readonly tokens: RunTokenRegistry;
}

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'impact-api-'));
  dirs.push(dir);
  const statePath = join(dir, 'state.json');
  const store = new FileStateStore(statePath);
  const clock = new FixedClock(NOW);
  const ids = new PersistentIds(store);
  const hops = new FileQueuedHopRepository(store);
  const requests = new FileChangeRequestRepository(store);
  const impacts = new FileChangeImpactRepository(store);
  const deliveries = new FileDeliveryRepository(store, clock, ids);
  const platform = new Platform({
    projects: new FileProjectRepository(store),
    deliveries,
    activity: new FileActivityLog(store, clock),
    clock,
    ids,
    transaction: store,
    changeRequests: requests,
    changeImpacts: impacts,
    queuedHops: hops,
  });
  return { statePath, clock, platform, hops, requests, impacts, deliveries, tokens: new RunTokenRegistry() };
}

function hopRow(input: Partial<QueuedHop> & Pick<QueuedHop, 'id' | 'role'>): QueuedHop {
  return {
    projectId: 'P',
    missionId: 'M',
    workItemId: 'W-1',
    priority: 0,
    availableAt: NOW,
    attemptCount: 0,
    maxAttempts: 3,
    idempotencyKey: `key-${input.id}`,
    status: 'queued',
    createdAt: NOW,
    updatedAt: NOW,
    ...input,
  };
}

async function claim(
  h: Harness,
  input: Partial<QueuedHop> & Pick<QueuedHop, 'id' | 'role'>,
  leaseMs: number,
): Promise<QueueClaimIdentity> {
  await h.hops.enqueue(hopRow(input));
  const at = h.clock.now().toISOString();
  const leaseUntil = new Date(h.clock.now().getTime() + leaseMs).toISOString();
  const taken = await h.hops.claim(input.id, 'owner', at, leaseUntil);
  assert.ok(taken, `hop ${input.id} 应能领到`);
  return { id: input.id, owner: 'owner', claimGeneration: taken.claimGeneration ?? 1 };
}

function request(overrides: Partial<ChangeRequest> & Pick<ChangeRequest, 'changeId'>): ChangeRequest {
  return {
    missionId: 'M',
    reviewer: 'L3',
    reason: 'L3 确认要改',
    confirmedChange: '改 < 为 <=',
    workItemId: 'W-1',
    attemptId: 'W-1.exec-1',
    baseSnapshotHash: 'hash-1',
    createdAt: NOW,
    sourceContractRevision: 1,
    claimGeneration: 1,
    ...overrides,
  };
}

interface Fixture {
  readonly missionId: string;
  readonly workItemId: string;
  readonly changeId: string;
  readonly executorAttemptId: string;
  readonly impactAttemptId: string;
  readonly impactClaim: QueueClaimIdentity;
  readonly token: string;
}

/**
 * 建一个「执行者在跑、目标已登记变更、impact 判断已开」的真实装配，并换一张可信
 * impact 牌。
 *
 * 牌直接由 tokens.issue 发：HTTP 上没有签发端点，测试也不经过未验收的 issuer——
 * 签发这一侧的可信性由工单给定，这里要测的是**用牌的那一侧**。
 */
async function buildImpact(h: Harness): Promise<Fixture> {
  const missionId = 'M';
  await h.platform.createMission({ projectId: 'P', missionId, contract: CONTRACT, origin: ORIGIN });
  const coord = await h.platform.startCoordinatorAttempt(missionId);
  await h.platform.updatePlan(missionId, coord.attemptId, PLAN);
  await h.platform.submitContractCheck(missionId, coord.attemptId, {
    verdict: 'ok',
    summary: '四条都核过',
  });
  const { workItemId } = await h.platform.createWorkItem(missionId, coord.attemptId, {
    title: 'W1',
    order: ORDER,
  });
  const { dispatched } = await h.platform.dispatchWorkItems(missionId, coord.attemptId, [workItemId]);
  assert.deepEqual(dispatched, [workItemId]);

  const executorClaim = await claim(
    h,
    { id: 'h-exec', role: 'executor', missionId, workItemId },
    EXEC_LEASE_MS,
  );
  const exec = await h.platform.startExecutorAttempt(missionId, workItemId, undefined, executorClaim);
  // 让出唯一的 coordinator 位：impact 要在「执行者在跑、协调者没在跑」时开。
  await h.platform.finishAttempt(missionId, coord.attemptId, { endedBy: 'structured_submit' });

  await h.requests.append(request({ changeId: CHANGE_ID, workItemId, attemptId: exec.attemptId }));
  const impactClaim = await claim(
    h,
    {
      id: 'h-impact',
      role: 'coordinator',
      missionId,
      workItemId,
      purpose: 'impact',
      changeId: CHANGE_ID,
    },
    IMPACT_LEASE_MS,
  );
  const started = await h.platform.startImpactCoordinatorAttempt(
    missionId,
    CHANGE_ID,
    undefined,
    impactClaim,
  );
  const token = h.tokens.issue({
    missionId,
    attemptId: started.attemptId,
    role: 'coordinator',
    workItemId,
    claim: impactClaim,
    purpose: 'impact',
    changeId: CHANGE_ID,
  }).token;
  return {
    missionId,
    workItemId,
    changeId: CHANGE_ID,
    executorAttemptId: exec.attemptId,
    impactAttemptId: started.attemptId,
    impactClaim,
    token,
  };
}

async function startApi(h: Harness): Promise<string> {
  const server = createApi({ platform: h.platform, tokens: h.tokens, deliveries: h.deliveries });
  servers.push(server);
  await listenLoopback(server, 0);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function postJson(
  base: string,
  path: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; json: Record<string, unknown> & { error?: string; message?: string } }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { 'x-coagent-run': token }),
    },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function diskBytes(statePath: string): string {
  return readFileSync(statePath, 'utf8');
}

function onDisk(statePath: string): { changeImpacts: unknown[]; events: { kind: string }[] } {
  return JSON.parse(readFileSync(statePath, 'utf8'));
}

/* ==================== 1. 成功路径 ==================== */

test('真实 HTTP：impact 牌读到绑定请求、提交四业务字段并持久幂等；冲突与额外身份字段拒绝且不覆盖', async () => {
  const h = harness();
  const base = await startApi(h);
  const fx = await buildImpact(h);

  // —— 读：changeId 只来自牌，body 必须是空的 ——
  const read = await postJson(base, '/api/agent/coagent_get_change_request', {}, fx.token);
  assert.equal(read.status, 200, JSON.stringify(read.json));
  assert.equal(read.json.changeId, fx.changeId);
  assert.equal(read.json.missionId, 'M');
  assert.equal(read.json.workItemId, fx.workItemId);
  assert.equal(read.json.attemptId, fx.executorAttemptId);

  // body 里塞身份（changeId / claim）一律不采信：多一个字段就是 400。
  const bodyNotAllowed = await postJson(
    base,
    '/api/agent/coagent_get_change_request',
    { changeId: 'CR-9', claimGeneration: 1 },
    fx.token,
  );
  assert.equal(bodyNotAllowed.status, 400);
  assert.equal(bodyNotAllowed.json.error, 'BAD_REQUEST');

  const workItemBefore = JSON.stringify((await h.platform.getMissionView('M')).workItems);

  // —— 提交：只有四业务字段 ——
  const submitted = await postJson(
    base,
    '/api/agent/coagent_submit_change_impact',
    { ...IMPACT_BODY },
    fx.token,
  );
  assert.equal(submitted.status, 200, JSON.stringify(submitted.json));
  assert.equal(submitted.json.changeId, fx.changeId);
  assert.equal(submitted.json.missionId, 'M');
  assert.equal(submitted.json.workItemId, fx.workItemId);
  assert.equal(submitted.json.attemptId, fx.executorAttemptId);
  assert.equal(submitted.json.coordinatorAttemptId, fx.impactAttemptId);
  assert.equal(submitted.json.decision, 'compatible');
  assert.equal(submitted.json.claimGeneration, 1, '外层代次来自 executor request');
  assert.deepEqual(submitted.json.claim, { id: 'h-impact', owner: 'owner', claimGeneration: 1 });

  // 幂等：同内容重提返回原记录，不新增事件。
  const again = await postJson(
    base,
    '/api/agent/coagent_submit_change_impact',
    { ...IMPACT_BODY },
    fx.token,
  );
  assert.equal(again.status, 200);
  assert.deepEqual(again.json, submitted.json);

  // 冲突：同一条变更上换了结论 → 409，且原记录不被覆盖。
  const conflict = await postJson(
    base,
    '/api/agent/coagent_submit_change_impact',
    { ...IMPACT_BODY, decision: 'replan', affectedAcceptance: [2] },
    fx.token,
  );
  assert.equal(conflict.status, 409, JSON.stringify(conflict.json));
  assert.equal(conflict.json.error, 'CHANGE_IMPACT_CONFLICT');

  // 额外身份字段：400，且在上面几次请求之后盘上仍然只有一条判断、一条事件。
  const extra = await postJson(
    base,
    '/api/agent/coagent_submit_change_impact',
    { ...IMPACT_BODY, changeId: 'CR-9', claim: { id: 'h-impact', owner: 'owner', claimGeneration: 1 } },
    fx.token,
  );
  assert.equal(extra.status, 400);
  assert.equal(extra.json.error, 'BAD_REQUEST');

  const disk = onDisk(h.statePath);
  assert.equal(disk.changeImpacts.length, 1, '只该有一条判断');
  assert.equal(
    disk.events.filter((event) => event.kind === 'change.impact_decided').length,
    1,
    '幂等重试与冲突都不得再发事件',
  );
  assert.equal(
    (disk.changeImpacts[0] as { decision: string }).decision,
    'compatible',
    '冲突不得覆盖原记录',
  );

  // 判断不落地成动作：冻结工单与工作项原样。
  assert.equal(
    JSON.stringify((await h.platform.getMissionView('M')).workItems),
    workItemBefore,
    'replan 不触发重派或取消',
  );

  // 重开（新读文件）恢复出来的就是保存的那份。
  const reopened = new FileStateStore(h.statePath);
  assert.deepEqual(
    await new FileChangeImpactRepository(reopened).get(fx.changeId),
    submitted.json,
    '重开后读得回同一条判断',
  );
  assert.equal(
    h.tokens.resolve(fx.token)?.changeId,
    fx.changeId,
    '被拒绝的请求不得吊销牌',
  );
});

/* ==================== 2. 拒绝路径 ==================== */

test('真实 HTTP：错目标 / 旧 claim / 目标失租一律拒绝、盘上逐字节不变，重开后没有任何判断', async () => {
  const h = harness();
  const base = await startApi(h);
  const fx = await buildImpact(h);

  const before = diskBytes(h.statePath);
  const reject = async (path: string, body: unknown, token: string, expected: string): Promise<void> => {
    const res = await postJson(base, path, body, token);
    assert.equal(res.status, 409, `${path} 应 409，实际 ${res.status} ${JSON.stringify(res.json)}`);
    assert.equal(res.json.error, expected, `${path} 错误码`);
    assert.equal(diskBytes(h.statePath), before, `${path} 被拒不得改动盘文件字节`);
  };

  // 牌绑的目标不是这条变更指向的工作项：HTTP 层核目标（在读完之后）→ 403。
  const wrongTarget = h.tokens.issue({
    missionId: 'M',
    attemptId: fx.impactAttemptId,
    role: 'coordinator',
    workItemId: 'W-other',
    claim: fx.impactClaim,
    purpose: 'impact',
    changeId: fx.changeId,
  }).token;
  for (const path of ['/api/agent/coagent_get_change_request', '/api/agent/coagent_submit_change_impact']) {
    const body = path.endsWith('get_change_request') ? {} : { ...IMPACT_BODY };
    const res = await postJson(base, path, body, wrongTarget);
    assert.equal(res.status, 403, `${path} 错目标应 403，实际 ${res.status}`);
    assert.equal(res.json.error, 'ACTION_DENIED');
  }
  assert.equal(diskBytes(h.statePath), before, '错目标的读与写都不得留下副作用');

  // 旧 claim：同一个 Attempt、同一条变更，但领取代次对不上 → Platform 的租约/来源校核拒绝。
  const staleClaim = h.tokens.issue({
    missionId: 'M',
    attemptId: fx.impactAttemptId,
    role: 'coordinator',
    workItemId: fx.workItemId,
    claim: { id: fx.impactClaim.id, owner: fx.impactClaim.owner, claimGeneration: fx.impactClaim.claimGeneration + 1 },
    purpose: 'impact',
    changeId: fx.changeId,
  }).token;
  await reject('/api/agent/coagent_get_change_request', {}, staleClaim, 'CLAIM_FENCE_REJECTED');
  await reject(
    '/api/agent/coagent_submit_change_impact',
    { ...IMPACT_BODY },
    staleClaim,
    'CLAIM_FENCE_REJECTED',
  );

  // 目标失租：执行者的租约到期换代，impact 的租约仍然活着。
  h.clock.advance(EXEC_LEASE_MS + 1000);
  const impactHop = (await h.hops.list()).find((hop) => hop.id === fx.impactClaim.id);
  assert.ok(
    impactHop && impactHop.status === 'claimed' && Date.parse(impactHop.leaseUntil!) > Date.parse(h.clock.now().toISOString()),
    'impact 租约必须还活着，否则这条拒绝不是「目标失租」',
  );
  await reject('/api/agent/coagent_get_change_request', {}, fx.token, 'CLAIM_FENCE_REJECTED');
  await reject(
    '/api/agent/coagent_submit_change_impact',
    { ...IMPACT_BODY },
    fx.token,
    'CLAIM_FENCE_REJECTED',
  );

  // 全程零判断、零决定事件，重开也读不出来；牌没有被吊销。
  const disk = onDisk(h.statePath);
  assert.equal(disk.changeImpacts.length, 0, '拒绝之后不该有任何判断落盘');
  assert.equal(
    disk.events.filter((event) => event.kind === 'change.impact_decided').length,
    0,
    '拒绝不得发决定事件',
  );
  const reopened = new FileChangeImpactRepository(new FileStateStore(h.statePath));
  assert.equal(await reopened.get(fx.changeId), undefined, '重开后没有这条判断');
  assert.deepEqual(await reopened.listByMission('M'), [], '重开后该 Mission 一条判断都没有');
  assert.equal(h.tokens.resolve(fx.token)?.purpose, 'impact', '拒绝不得吊销牌');

  // 无 HTTP 签发：控制面那条换牌口子不读 body，body 里自称 purpose / changeId
  // 换来的仍是普通牌，拿它调专属工具照旧 403。
  await h.platform.createMission({ projectId: 'P', missionId: 'M2', contract: CONTRACT, origin: ORIGIN });
  const minted = await postJson(base, '/api/missions/M2/coordinator-attempts', {
    role: 'coordinator',
    purpose: 'impact',
    changeId: fx.changeId,
    workItemId: fx.workItemId,
  });
  assert.equal(minted.status, 201, JSON.stringify(minted.json));
  const plain = h.tokens.resolve(String(minted.json.token));
  assert.equal(plain?.role, 'coordinator');
  assert.equal(plain?.purpose, undefined, 'body 自称 purpose 变不成牌上的 purpose');
  assert.equal(plain?.changeId, undefined, 'body 自称 changeId 变不成牌上的 changeId');
  for (const tool of ['coagent_get_change_request', 'coagent_submit_change_impact']) {
    const res = await postJson(
      base,
      `/api/agent/${tool}`,
      { changeId: fx.changeId, purpose: 'impact', decision: 'compatible' },
      String(minted.json.token),
    );
    assert.equal(res.status, 403, `${tool} 普通牌必须 403，实际 ${res.status}`);
    assert.equal(res.json.error, 'ACTION_DENIED');
  }
});
