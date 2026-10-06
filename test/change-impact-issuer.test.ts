/**
 * W-472 补修的两条关键组合（工单 W-476）：
 *
 *   1. 真实 makeIssuer 签发的 impact 牌：purpose / changeId / workItemId / claim
 *      可信冻结；拿这张牌走真实 HTTP 能读到绑定请求、提交四业务字段并跨重开读回。
 *      缺 claim 或缺装配一律 CHANGE_IMPACT_UNSUPPORTED：不发牌、不开任何新
 *      coordinator Attempt，更不回退成普通 coordinator 牌。
 *   2. buildPersistentPlatform 把 changeRequests / changeImpacts / queuedHops 注在
 *      **同一个** FileStateStore 上：built.issuer 发牌能看见同 store 的请求、决定
 *      能保存并跨重建读回；未装配的 buildPlatform 不隐式读文件、不回退普通牌。
 *
 * 与 change-impact-api.test.ts 的分工：那份测「用牌」（HTTP 门禁与持久化），
 * 这一份测「发牌」（issuer 绑定与装配）。fixture 有意保持同构（File 双 hop /
 * 双 claim：执行者租约短、impact 租约长；finish 普通 L2 之后才开 impact），
 * 唯一区别是签发改走真实 makeIssuer，而不是 tokens.issue 直接造 impact 牌。
 *
 * 零第三方；相对 import 带 .ts；Windows 临时目录与现测一致用 mkdtempSync(join(tmpdir(),…))。
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
import { buildPersistentPlatform, buildPlatform, makeIssuer } from '../src/main.ts';
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';

const NOW = '2026-01-01T00:00:00.000Z';
/** 与 change-impact-api.test.ts 同口径：租约时长而非绝对时刻。 */
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
  hops: FileQueuedHopRepository,
  clock: { now(): Date },
  input: Partial<QueuedHop> & Pick<QueuedHop, 'id' | 'role'>,
  leaseMs: number,
): Promise<QueueClaimIdentity> {
  await hops.enqueue(hopRow(input));
  const at = clock.now().toISOString();
  const leaseUntil = new Date(clock.now().getTime() + leaseMs).toISOString();
  const taken = await hops.claim(input.id, 'owner', at, leaseUntil);
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

async function startApi(
  platform: Platform,
  tokens: RunTokenRegistry,
  deliveries: FileDeliveryRepository,
): Promise<{ base: string; server: Server }> {
  const server = createApi({ platform, tokens, deliveries });
  servers.push(server);
  await listenLoopback(server, 0);
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

async function closeServer(server: Server): Promise<void> {
  const at = servers.indexOf(server);
  if (at >= 0) servers.splice(at, 1);
  await new Promise<void>((resolve, reject) => {
    server.close((error) =>
      error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve(),
    );
  });
}

async function postJson(
  base: string,
  path: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; json: Record<string, unknown> & { error?: string } }> {
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

function onDisk(statePath: string): { changeImpacts: Record<string, unknown>[]; events: { kind: string }[] } {
  return JSON.parse(readFileSync(statePath, 'utf8'));
}

/**
 * 把 tokens.issue / platform.startCoordinatorAttempt 装成可计数代理。
 * 测的是「unsupported 不发牌、不开新 coordinator Attempt、不回退普通牌」。
 */
function instrumentIssuerSide(tokens: RunTokenRegistry, platform: Platform) {
  let issued = 0;
  let coordinatorStarts = 0;
  const origIssue = tokens.issue.bind(tokens);
  tokens.issue = ((input: Parameters<RunTokenRegistry['issue']>[0]) => {
    issued += 1;
    return origIssue(input);
  }) as RunTokenRegistry['issue'];
  const origStart = platform.startCoordinatorAttempt.bind(platform);
  platform.startCoordinatorAttempt = (async (...args: Parameters<Platform['startCoordinatorAttempt']>) => {
    coordinatorStarts += 1;
    return origStart(...args);
  }) as Platform['startCoordinatorAttempt'];
  return {
    issued: () => issued,
    coordinatorStarts: () => coordinatorStarts,
  };
}

/* ==================== 组合 1：真实 makeIssuer 发牌 ==================== */

test('真实 makeIssuer.startImpactCoordinator 只签发绑定真实 Attempt/请求目标/claim 的可信牌；缺 claim 或缺装配 unsupported 且不发牌不回退', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'impact-issuer-'));
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
  const tokens = new RunTokenRegistry();
  const issuer = makeIssuer(platform, tokens);
  assert.equal(typeof issuer.startImpactCoordinator, 'function');

  // —— 与 API 测试同构的 fixture：双 hop、双 claim、执行者租约短、impact 租约长 ——
  const missionId = 'M';
  await platform.createMission({ projectId: 'P', missionId, contract: CONTRACT, origin: ORIGIN });
  const coord = await platform.startCoordinatorAttempt(missionId);
  await platform.updatePlan(missionId, coord.attemptId, PLAN);
  await platform.submitContractCheck(missionId, coord.attemptId, {
    verdict: 'ok',
    summary: '四条都核过',
  });
  const { workItemId } = await platform.createWorkItem(missionId, coord.attemptId, {
    title: 'W1',
    order: ORDER,
  });
  const { dispatched } = await platform.dispatchWorkItems(missionId, coord.attemptId, [workItemId]);
  assert.deepEqual(dispatched, [workItemId]);

  const executorClaim = await claim(
    hops,
    clock,
    { id: 'h-exec', role: 'executor', missionId, workItemId },
    EXEC_LEASE_MS,
  );
  const exec = await platform.startExecutorAttempt(missionId, workItemId, undefined, executorClaim);
  // 让出唯一的 coordinator 位：impact 要在「执行者在跑、协调者没在跑」时开。
  await platform.finishAttempt(missionId, coord.attemptId, { endedBy: 'structured_submit' });
  await requests.append(request({ changeId: CHANGE_ID, workItemId, attemptId: exec.attemptId }));
  const impactClaim = await claim(
    hops,
    clock,
    { id: 'h-impact', role: 'coordinator', missionId, workItemId, purpose: 'impact', changeId: CHANGE_ID },
    IMPACT_LEASE_MS,
  );

  // —— 真实 issuer 发牌（不是 tokens.issue 直接造 impact 牌）——
  const issued = await issuer.startImpactCoordinator!(missionId, CHANGE_ID, undefined, impactClaim);
  const frozen = tokens.resolve(issued.token);
  assert.ok(frozen, 'issuer 发的牌必须可解析');
  assert.equal(frozen.purpose, 'impact');
  assert.equal(frozen.changeId, CHANGE_ID);
  assert.equal(frozen.workItemId, workItemId, '牌上的工作项来自变更请求的目标，不是调用方自述');
  assert.equal(frozen.missionId, missionId);
  assert.equal(frozen.role, 'coordinator');
  assert.equal(frozen.attemptId, issued.attemptId, '牌绑定 issuer 刚从 Platform 开出的 Attempt');
  assert.deepEqual(frozen.claim, impactClaim);
  assert.equal(Object.isFrozen(frozen), true, '整张牌冻结');
  assert.equal(Object.isFrozen(frozen.claim), true, 'claim 三元组冻结');

  // —— 用这张牌走真实 HTTP：读绑定请求、提交四业务字段 ——
  const { base, server } = await startApi(platform, tokens, deliveries);
  const workItemsBefore = JSON.stringify((await platform.getMissionView(missionId)).workItems);
  const read = await postJson(base, '/api/agent/coagent_get_change_request', {}, issued.token);
  assert.equal(read.status, 200, JSON.stringify(read.json));
  assert.equal(read.json.changeId, CHANGE_ID);
  assert.equal(read.json.workItemId, workItemId);
  assert.equal(read.json.attemptId, exec.attemptId, '读到的是牌绑定的那个执行 Attempt');

  const submitted = await postJson(base, '/api/agent/coagent_submit_change_impact', { ...IMPACT_BODY }, issued.token);
  assert.equal(submitted.status, 200, JSON.stringify(submitted.json));
  assert.equal(submitted.json.decision, 'compatible');
  assert.equal(submitted.json.coordinatorAttemptId, issued.attemptId);
  assert.equal(submitted.json.attemptId, exec.attemptId);

  // 判断不落地成动作：不声称已应用，冻结工单原样。
  const disk = onDisk(statePath);
  assert.equal(disk.changeImpacts.length, 1);
  const record = disk.changeImpacts[0]!;
  for (const forbidden of ['applied', 'consumed', 'verified']) {
    assert.equal(forbidden in record, false, `判断记录不得声称「${forbidden}」`);
  }
  assert.equal(
    JSON.stringify((await platform.getMissionView(missionId)).workItems),
    workItemsBefore,
    '提交判断不得重派或取消工作项',
  );

  // 重开 FileStateStore 读回同一条 ChangeImpact。
  const reopened = new FileChangeImpactRepository(new FileStateStore(statePath));
  assert.deepEqual(await reopened.get(CHANGE_ID), submitted.json);

  // revoke 后 resolve 为 undefined。
  issuer.revoke(issued.token);
  assert.equal(tokens.resolve(issued.token), undefined, 'revoke 后牌即刻失效');
  await closeServer(server);

  // —— 缺 claim：unsupported，不开 Attempt、不发牌、不回退普通牌 ——
  const counters = instrumentIssuerSide(tokens, platform);
  await assert.rejects(
    () => issuer.startImpactCoordinator!(missionId, CHANGE_ID, undefined, undefined),
    (error: unknown) => error instanceof Error && error.message.includes('CHANGE_IMPACT_UNSUPPORTED'),
    '缺 claim 必须明确 unsupported，而不是悄悄换发普通 coordinator 牌',
  );
  assert.equal(counters.coordinatorStarts(), 0, '缺 claim 的调用没有开新 coordinator Attempt');
  assert.equal(counters.issued(), 0, '缺 claim 的调用没有发新牌');

  // —— 未装配（new Platform 不注入 changeImpacts / changeRequests）：同样 unsupported ——
  // 能力缺位时不得隐式去读文件里的仓储、不得借道开普通牌。
  const bareStore = new FileStateStore(statePath);
  const bareClock = new FixedClock(NOW);
  const barePlatform = new Platform({
    projects: new FileProjectRepository(bareStore),
    deliveries: new FileDeliveryRepository(bareStore, bareClock, new PersistentIds(bareStore)),
    activity: new FileActivityLog(bareStore, bareClock),
    clock: bareClock,
    ids: new PersistentIds(bareStore),
    transaction: bareStore,
    // 不注入 changeRequests / changeImpacts / queuedHops
  });
  assert.equal(barePlatform.supportsChangeImpact(), false);
  const bareTokens = new RunTokenRegistry();
  const bareCounters = instrumentIssuerSide(bareTokens, barePlatform);
  const bareIssuer = makeIssuer(barePlatform, bareTokens);
  const diskBytesBefore = readFileSync(statePath, 'utf8');
  await assert.rejects(
    () => bareIssuer.startImpactCoordinator!(missionId, CHANGE_ID, undefined, impactClaim),
    (error: unknown) => error instanceof Error && error.message.includes('CHANGE_IMPACT_UNSUPPORTED'),
    '缺装配必须明确 unsupported；带上合法 claim 也不等于装配齐备',
  );
  assert.equal(bareCounters.issued(), 0, 'unsupported 不得发任何牌');
  assert.equal(bareCounters.coordinatorStarts(), 0, 'unsupported 不得开任何 coordinator Attempt');
  assert.equal(readFileSync(statePath, 'utf8'), diskBytesBefore, 'unsupported 路径不得改动盘文件');
});

/* ==================== 组合 2：buildPersistentPlatform 同 File 装配 ==================== */

test('buildPersistentPlatform 同一 FileStateStore 装配三仓储：built.issuer 看见同 store 请求并保存决定，重建读回；未装配不隐式读文件、不回退', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'impact-wire-'));
  dirs.push(dir);
  const statePath = join(dir, 'state.json');
  const built = await buildPersistentPlatform(statePath, {
    workspace: new InPlaceWorkspaceManager(),
    reconcile: false,
  });
  const realNow = { now: () => new Date() };
  try {
    // 装配：三仓储与 issuer 都挂在同一个 store 实例上；hosted 透传的牌口带可选 impact 方法。
    assert.equal(typeof built.issuer.startImpactCoordinator, 'function');
    assert.equal(built.platform.supportsChangeImpact(), true);

    const missionId = 'M-wire';
    await built.platform.createMission({ projectId: 'P', missionId, contract: CONTRACT, origin: ORIGIN });
    const coord = await built.platform.startCoordinatorAttempt(missionId);
    await built.platform.updatePlan(missionId, coord.attemptId, PLAN);
    await built.platform.submitContractCheck(missionId, coord.attemptId, {
      verdict: 'ok',
      summary: '四条都核过',
    });
    const { workItemId } = await built.platform.createWorkItem(missionId, coord.attemptId, {
      title: 'W1',
      order: ORDER,
    });
    await built.platform.dispatchWorkItems(missionId, coord.attemptId, [workItemId]);

    const executorClaim = await claim(
      built.queuedHops,
      realNow,
      { id: 'h-exec', role: 'executor', missionId, workItemId },
      EXEC_LEASE_MS,
    );
    const exec = await built.platform.startExecutorAttempt(missionId, workItemId, undefined, executorClaim);
    await built.platform.finishAttempt(missionId, coord.attemptId, { endedBy: 'structured_submit' });

    // 同一 store 上的仓储写入——issuer 必须看得见。
    const requests = new FileChangeRequestRepository(built.store);
    await requests.append(request({ changeId: CHANGE_ID, missionId, workItemId, attemptId: exec.attemptId }));
    const impactClaim = await claim(
      built.queuedHops,
      realNow,
      { id: 'h-impact', role: 'coordinator', missionId, workItemId, purpose: 'impact', changeId: CHANGE_ID },
      IMPACT_LEASE_MS,
    );

    const issued = await built.issuer.startImpactCoordinator!(missionId, CHANGE_ID, undefined, impactClaim);
    const frozen = built.tokens.resolve(issued.token);
    assert.equal(frozen?.purpose, 'impact');
    assert.equal(frozen?.changeId, CHANGE_ID);
    assert.equal(frozen?.workItemId, workItemId);
    assert.equal(frozen?.attemptId, issued.attemptId);
    assert.deepEqual(frozen?.claim, impactClaim);

    // 用该牌保存决定（真实 HTTP，与 startServer 同款接线）。
    const api = await startApi(built.platform, built.tokens, built.deliveries);
    const submitted = await postJson(api.base, '/api/agent/coagent_submit_change_impact', { ...IMPACT_BODY }, issued.token);
    assert.equal(submitted.status, 200, JSON.stringify(submitted.json));
    assert.equal(submitted.json.coordinatorAttemptId, issued.attemptId);
    await closeServer(api.server);

    // 收干净第一份 writer 再重开：不并开 writer。
    built.persist();
  } finally {
    built.releaseLock();
  }

  const rebuilt = await buildPersistentPlatform(statePath, {
    workspace: new InPlaceWorkspaceManager(),
    reconcile: false,
  });
  try {
    assert.equal(rebuilt.platform.supportsChangeImpact(), true, '重建后三仓储仍在同一 store');
    const restored = await new FileChangeImpactRepository(rebuilt.store).get(CHANGE_ID);
    assert.ok(restored, '重建后必须读回同一条影响决定');
    assert.equal(restored.decision, 'compatible');
    assert.equal(restored.workOrderDiff, IMPACT_BODY.workOrderDiff);
    assert.deepEqual(restored.affectedAcceptance, IMPACT_BODY.affectedAcceptance);
    assert.equal(restored.changeId, CHANGE_ID);
    assert.equal(restored.missionId, 'M-wire');
    assert.equal(restored.workItemId, 'W-1');
  } finally {
    rebuilt.releaseLock();
  }

  // 未装配的 buildPlatform（全内存，没有三件套）：不隐式读文件、不回退普通牌，
  // 普通 startCoordinator 路径照旧兼容。
  const plain = buildPlatform(new InPlaceWorkspaceManager());
  assert.equal(plain.platform.supportsChangeImpact(), false);
  const counters = instrumentIssuerSide(plain.tokens, plain.platform);
  await assert.rejects(
    () =>
      plain.issuer.startImpactCoordinator!('M-x', CHANGE_ID, undefined, {
        id: 'h-x',
        owner: 'o',
        claimGeneration: 1,
      }),
    (error: unknown) => error instanceof Error && error.message.includes('CHANGE_IMPACT_UNSUPPORTED'),
  );
  assert.equal(counters.issued(), 0, '未装配不得发牌，也不得回退成普通 coordinator 牌');
  assert.equal(counters.coordinatorStarts(), 0, '未装配不得借道开普通 coordinator Attempt');
  await plain.platform.createMission({ projectId: 'P', missionId: 'M-nq', contract: CONTRACT, origin: ORIGIN });
  const normal = await plain.issuer.startCoordinator('M-nq');
  assert.equal(plain.tokens.resolve(normal.token)?.purpose, undefined, '普通牌仍可用且保持普通');
});
