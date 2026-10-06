/**
 * 回执专属工具的真实 HTTP 组合测试（W-486）。
 *
 * 为什么单独一个文件：这里要的是「执行者身份从 x-coagent-run 进来 → 门禁在
 * readJson 之前 → 读差异与写回执落在真实 Platform + File 事务里」这条完整链路。
 * 直接调 Platform 测出来的「通过」不覆盖 HTTP 层那道分流。
 *
 * 为什么用真实 FileStateStore：内存版没有事务回滚，「拒绝之后盘上有没有多一条
 * 记录」这句话在内存版上根本测不到。拒绝必须是逐字节不改。
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
import { FileChangeImpactRepository } from '../src/application/change-impact-repository.ts';
import { FileChangeReceiptRepository } from '../src/application/change-receipt-repository.ts';
import type { QueuedHop } from '../src/application/durable-scheduler.ts';
import type { ChangeImpact } from '../src/application/change-impact.ts';
import { Platform } from '../src/application/platform.ts';
import type { QueueClaimIdentity } from '../src/application/platform/types.ts';
import { RunTokenRegistry } from '../src/api/run-tokens.ts';
import { createApi } from '../src/api/server.ts';
import { listenLoopback } from '../src/application/loopback-listen.ts';

const NOW = '2026-01-01T00:00:00.000Z';
/** 执行者租约：够长到能跑完全部回执，推过它就是失租。 */
const EXEC_LEASE_MS = 30 * 60 * 1000;
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

const DIFF = '把 step 2 换成 step 2b';
const DIFF_HASH = '9d4fbbb3d09d3b36d8573d4185d0bbc69e52e61c3b2dabb72e68c11539512241';
const CHANGE_ID = 'CH-1';

const GET_TOOL = '/api/agent/coagent_get_change_deliveries';
const ACK_TOOL = '/api/agent/coagent_ack_change_receipt';

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
  readonly impacts: FileChangeImpactRepository;
  readonly receipts: FileChangeReceiptRepository;
  readonly deliveries: FileDeliveryRepository;
  readonly tokens: RunTokenRegistry;
}

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'receipt-api-'));
  dirs.push(dir);
  const statePath = join(dir, 'state.json');
  // 回执仓储与其它仓储共用同一个 FileStateStore：事务边界就是这一个文件。
  const store = new FileStateStore(statePath);
  const clock = new FixedClock(NOW);
  const ids = new PersistentIds(store);
  const hops = new FileQueuedHopRepository(store);
  const impacts = new FileChangeImpactRepository(store);
  const receipts = new FileChangeReceiptRepository(store);
  const deliveries = new FileDeliveryRepository(store, clock, ids);
  const platform = new Platform({
    projects: new FileProjectRepository(store),
    deliveries,
    activity: new FileActivityLog(store, clock),
    clock,
    ids,
    transaction: store,
    changeImpacts: impacts,
    changeReceipts: receipts,
    queuedHops: hops,
  });
  return { statePath, clock, platform, hops, impacts, receipts, deliveries, tokens: new RunTokenRegistry() };
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

function impact(overrides: Partial<ChangeImpact> & Pick<ChangeImpact, 'changeId'>): ChangeImpact {
  return {
    missionId: 'M',
    workItemId: 'W-1',
    attemptId: 'W-1.exec-1',
    claimGeneration: 1,
    coordinatorAttemptId: 'coord-unused',
    claim: { id: 'h-impact', owner: 'owner', claimGeneration: 1 },
    decision: 'compatible',
    workOrderDiff: DIFF,
    affectedAcceptance: [1],
    reason: 'step 2b 仍可执行',
    ...overrides,
  };
}

interface Fixture {
  readonly missionId: string;
  readonly workItemId: string;
  readonly executorAttemptId: string;
  readonly executorClaim: QueueClaimIdentity;
  readonly token: string;
}

/**
 * 建一个「协调者已交卷 + 执行者在跑」的真实装配，落一条 compatible 判断与一条
 * replan 判断（后者不该出现在 deliveries 里），再换一张执行者自己的牌。
 *
 * 判断直接 impacts.append：这条单只验接收侧，判断路径另有其测。牌由 tokens.issue
 * 发，不走签发 HTTP——签发那一侧的可信性由工单给定，这里测的是**用牌的那一侧**。
 */
async function buildExecutor(h: Harness): Promise<Fixture> {
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
  await h.platform.finishAttempt(missionId, coord.attemptId, { endedBy: 'structured_submit' });

  await h.impacts.append(
    impact({ changeId: CHANGE_ID, attemptId: exec.attemptId, claimGeneration: executorClaim.claimGeneration }),
  );
  await h.impacts.append(
    impact({
      changeId: 'CH-replan',
      attemptId: exec.attemptId,
      claimGeneration: executorClaim.claimGeneration,
      decision: 'replan',
      affectedAcceptance: [],
      reason: '要推倒重排',
    }),
  );
  const token = h.tokens.issue({
    missionId,
    attemptId: exec.attemptId,
    role: 'executor',
    workItemId,
    claim: executorClaim,
  }).token;
  return { missionId, workItemId, executorAttemptId: exec.attemptId, executorClaim, token };
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

function onDisk(statePath: string): {
  changeReceipts: { layer: string; contentHash?: string }[];
  events: { kind: string }[];
} {
  return JSON.parse(readFileSync(statePath, 'utf8'));
}

/* ==================== 1. 成功路径 ==================== */

test('真实 HTTP：执行者读到发给自己的 compatible 差异并按层幂等回执；重开后仍可读', async () => {
  const h = harness();
  const base = await startApi(h);
  const fx = await buildExecutor(h);

  // —— 读：只含发给自己的 compatible 差异，replan 不在里面 ——
  const list = await postJson(base, GET_TOOL, {}, fx.token);
  assert.equal(list.status, 200, JSON.stringify(list.json));
  const rows = list.json.deliveries as {
    changeId: string;
    workOrderDiff: string;
    affectedAcceptance: number[];
    diffHash: string;
  }[];
  assert.deepEqual(rows.map((row) => row.changeId), [CHANGE_ID], 'replan 与跨 Attempt 的差异都不该出现');
  assert.equal(rows[0]!.changeId, CHANGE_ID);
  assert.equal(rows[0]!.workOrderDiff, DIFF);
  assert.deepEqual(rows[0]!.affectedAcceptance, [1]);
  assert.equal(rows[0]!.diffHash, DIFF_HASH);

  // —— 逐层回执：adapter_received → session_consumed → executor_started ——
  const started = { changeId: CHANGE_ID, layer: 'executor_started', contentHash: DIFF_HASH };
  for (const body of [
    { changeId: CHANGE_ID, layer: 'adapter_received' },
    { changeId: CHANGE_ID, layer: 'session_consumed' },
    started,
  ]) {
    const res = await postJson(base, ACK_TOOL, body, fx.token);
    assert.equal(res.status, 200, `${body.layer} 应 200：${JSON.stringify(res.json)}`);
    assert.equal(res.json.changeId, CHANGE_ID);
    assert.equal(res.json.layer, body.layer);
    assert.equal(res.json.missionId, fx.missionId);
    assert.equal(res.json.workItemId, fx.workItemId);
    assert.equal(res.json.attemptId, fx.executorAttemptId);
    assert.equal(res.json.claimGeneration, fx.executorClaim.claimGeneration);
  }
  // 同层再 ack adapter_received：幂等重放仍 200，不 append 第二条、不发第二次事件。
  const sameLayer = await postJson(base, ACK_TOOL, { changeId: CHANGE_ID, layer: 'adapter_received' }, fx.token);
  assert.equal(sameLayer.status, 200, JSON.stringify(sameLayer.json));

  const disk = onDisk(h.statePath);
  assert.deepEqual(
    disk.changeReceipts.map((row) => row.layer),
    ['adapter_received', 'session_consumed', 'executor_started'],
    '幂等重试不得 append 第二条',
  );
  assert.deepEqual(
    disk.changeReceipts.map((row) => row.contentHash),
    [undefined, undefined, DIFF_HASH],
  );
  assert.equal(
    disk.events.filter((event) => event.kind === 'change.receipt_recorded').length,
    3,
    '三层各一条事件，幂等重试不发第二次',
  );

  // 结果里没有 verified：回执没有验收层，谁都不该拿「有回执」当验收通过的证据。
  const againRows = (await postJson(base, GET_TOOL, {}, fx.token)).json.deliveries as {
    receipts: { layer: string }[];
  }[];
  assert.deepEqual(
    againRows[0]!.receipts.map((row) => row.layer),
    ['adapter_received', 'session_consumed', 'executor_started'],
  );
  assert.ok(!JSON.stringify(disk).includes('verified'), '回执链不许出现 verified');

  // 重开同一个 statePath：这三层都还在。
  const reopened = new FileChangeReceiptRepository(new FileStateStore(h.statePath));
  assert.deepEqual(
    (await reopened.listByChange(CHANGE_ID)).map((row) => row.layer),
    ['adapter_received', 'session_consumed', 'executor_started'],
    '重开后仍读得到这三层',
  );
});

/* ==================== 2. 拒绝路径 ==================== */

test('真实 HTTP：错身份 403、错业务 400、越权字节 409，全部零副作用', async () => {
  const h = harness();
  const base = await startApi(h);
  const fx = await buildExecutor(h);

  /** 每次拒绝前读盘、拒绝后比字节：门禁失败不得改动盘文件一个字节。 */
  const reject = async (
    body: unknown,
    expected: number,
    code: string,
    token: string = fx.token,
    tool: string = ACK_TOOL,
  ): Promise<void> => {
    const before = diskBytes(h.statePath);
    const res = await postJson(base, tool, body, token);
    assert.equal(res.status, expected, `应 ${expected}，实际 ${res.status} ${JSON.stringify(res.json)}`);
    assert.equal(res.json.error, code, `${tool} 错误码`);
    assert.equal(diskBytes(h.statePath), before, `${tool} 被拒不得改动盘文件字节`);
  };

  // —— 错身份：403，且在读 body 之前 ——
  const coordinatorToken = h.tokens.issue({
    missionId: fx.missionId,
    attemptId: fx.executorAttemptId,
    role: 'coordinator',
    workItemId: fx.workItemId,
    claim: fx.executorClaim,
  }).token;
  await reject({}, 403, 'ACTION_DENIED', coordinatorToken, GET_TOOL);
  await reject({ changeId: CHANGE_ID, layer: 'adapter_received' }, 403, 'ACTION_DENIED', coordinatorToken);

  const reviewerToken = h.tokens.issue({
    missionId: fx.missionId,
    attemptId: fx.executorAttemptId,
    role: 'independent_reviewer',
    workItemId: fx.workItemId,
    claim: fx.executorClaim,
  }).token;
  await reject({}, 403, 'ACTION_DENIED', reviewerToken, GET_TOOL);
  await reject({ changeId: CHANGE_ID, layer: 'adapter_received' }, 403, 'ACTION_DENIED', reviewerToken);

  // impact 牌：不在 IMPACT_EXCLUSIVE_TOOLS 白名单里，在分流之前就被 403，不是 404。
  const impactClaim = await claim(
    h,
    { id: 'h-impact', role: 'coordinator', missionId: fx.missionId, workItemId: fx.workItemId, purpose: 'impact', changeId: CHANGE_ID },
    IMPACT_LEASE_MS,
  );
  const impactToken = h.tokens.issue({
    missionId: fx.missionId,
    attemptId: fx.executorAttemptId,
    role: 'coordinator',
    workItemId: fx.workItemId,
    claim: impactClaim,
    purpose: 'impact',
    changeId: CHANGE_ID,
  }).token;
  await reject({}, 403, 'ACTION_DENIED', impactToken, GET_TOOL);
  await reject({ changeId: CHANGE_ID, layer: 'adapter_received' }, 403, 'ACTION_DENIED', impactToken);

  // —— body 多身份字段：400 ——
  await reject({ changeId: CHANGE_ID, layer: 'adapter_received', attemptId: fx.executorAttemptId }, 400, 'BAD_REQUEST');
  await reject(
    { changeId: CHANGE_ID, layer: 'adapter_received', claim: fx.executorClaim },
    400,
    'BAD_REQUEST',
  );
  await reject({ changeId: CHANGE_ID, layer: 'verified' }, 400, 'BAD_REQUEST');
  // 读工具不接受请求体。
  await reject({ changeId: CHANGE_ID }, 400, 'BAD_REQUEST', fx.token, GET_TOOL);

  // —— 业务不允许：409 ——
  // 越层：低层没落就写高层。
  await reject(
    { changeId: CHANGE_ID, layer: 'executor_started', contentHash: DIFF_HASH },
    409,
    'RECEIPT_LAYER_ORDER',
  );
  // 非 compatible：replan 不由执行者自己决定照跑。
  await reject({ changeId: 'CH-replan', layer: 'adapter_received' }, 409, 'CHANGE_NOT_DELIVERABLE');
  // 跨 Attempt：别的执行的差异不是这一趟的。
  await h.impacts.append(impact({ changeId: 'CH-other', attemptId: 'AT-other' }));
  await reject({ changeId: 'CH-other', layer: 'adapter_received' }, 409, 'CHANGE_NOT_DELIVERABLE');
  // hash 不符：说照这份 diff 跑了就得拿出那份 diff 的哈希。
  await reject(
    { changeId: CHANGE_ID, layer: 'executor_started', contentHash: 'a'.repeat(64) },
    409,
    'RECEIPT_HASH_MISMATCH',
  );
  // 旧代次：同 Attempt 换了代，旧 claim 不再算数。
  const staleToken = h.tokens.issue({
    missionId: fx.missionId,
    attemptId: fx.executorAttemptId,
    role: 'executor',
    workItemId: fx.workItemId,
    claim: {
      id: fx.executorClaim.id,
      owner: fx.executorClaim.owner,
      claimGeneration: fx.executorClaim.claimGeneration + 1,
    },
  }).token;
  await reject({}, 409, 'CLAIM_FENCE_REJECTED', staleToken, GET_TOOL);
  await reject({ changeId: CHANGE_ID, layer: 'adapter_received' }, 409, 'CLAIM_FENCE_REJECTED', staleToken);
  // 失租：租约过期换代，围栏拒绝读也拒绝写。
  h.clock.advance(EXEC_LEASE_MS + 1000);
  await reject({}, 409, 'CLAIM_FENCE_REJECTED', fx.token, GET_TOOL);
  await reject({ changeId: CHANGE_ID, layer: 'adapter_received' }, 409, 'CLAIM_FENCE_REJECTED');

  // 全程零回执、零回执事件，重开也读不出来；牌没有被吊销。
  const disk = onDisk(h.statePath);
  assert.deepEqual(disk.changeReceipts, [], '拒绝之后不该有任何回执落盘');
  assert.deepEqual(
    disk.events.filter((event) => event.kind === 'change.receipt_recorded'),
    [],
    '拒绝不得发回执事件',
  );
  const reopened = new FileChangeReceiptRepository(new FileStateStore(h.statePath));
  assert.deepEqual(await reopened.listByChange(CHANGE_ID), [], '重开后没有这条回执');
  assert.equal(h.tokens.resolve(fx.token)?.role, 'executor', '拒绝不得吊销牌');
});
