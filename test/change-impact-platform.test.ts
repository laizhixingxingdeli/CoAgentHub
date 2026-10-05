/**
 * Application impact 双 claim 事务权威路径（Platform + 真实 File）。
 *
 * 为什么走 Platform 而不是直接调用例函数：限权判断的全部不变量都发生在
 * 「事务 + 租约 + 唯一 coordinator」的交界上，绕开 Platform 就绕开了事务，
 * 于是测出来的「通过」只说明逻辑跑通，不说明它在真实装配下站得住。
 *
 * 为什么用真实 FileStateStore：内存版没有事务回滚，事件写失败之后记录还在——
 * 那正是这条路径最该挡住的坏形状，用内存版根本测不到。
 *
 * 两条组合测试，不拆成十几条小断言：拆开之后每条都要各自搭一遍 Mission 与目标，
 * 搭出来的那一份很快会和真实的装配漂移。
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
import type { ActivityEvent, ActivityLog } from '../src/application/ports.ts';
import type { QueuedHop } from '../src/application/durable-scheduler.ts';
import type { ChangeRequest } from '../src/application/change-request.ts';
import { Platform } from '../src/application/platform.ts';
import { PlatformRuleError } from '../src/application/platform/context.ts';
import type { QueueClaimIdentity } from '../src/application/platform/types.ts';

const NOW = '2026-01-01T00:00:00.000Z';
/**
 * 租约时长而不是绝对时刻：整条路径里时钟会被推着走，写死一个时刻会让
 * 「后来新领的牌」一领到就是过期的。执行者给得长、impact 给得短，
 * 于是过期测试里过期的那一方不含糊。
 */
const EXEC_LEASE_MS = 30 * 60 * 1000;
const IMPACT_LEASE_MS = 60 * 1000;

const CONTRACT: MissionContract = {
  intent: '把 X 修好',
  acceptance: ['测试全绿', 'foo 返回 1'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
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
  decision: 'compatible' as const,
  workOrderDiff: '把 step 2 换成 step 2b',
  affectedAcceptance: [1],
  reason: 'step 2b 仍可执行',
};

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * 决定事件的注入闸门。
 *
 * 为什么包一层而不是换一个 ActivityLog：盘上必须是**同一个** FileStateStore，
 * 换实例就换了一份内存副本，「保存随事务回滚」这句话就没测到真实的那份状态。
 */
class DecidedEventGate implements ActivityLog {
  fail = false;
  readonly #inner: ActivityLog;

  constructor(inner: ActivityLog) {
    this.#inner = inner;
  }

  async append(event: Omit<ActivityEvent, 'at'>): Promise<void> {
    if (this.fail && event.kind === 'change.impact_decided') {
      throw new Error('decided 事件写失败');
    }
    return this.#inner.append(event);
  }

  async list(missionId: string): Promise<readonly ActivityEvent[]> {
    return this.#inner.list(missionId);
  }

  async all(): Promise<readonly ActivityEvent[]> {
    return this.#inner.all();
  }
}

interface Harness {
  readonly statePath: string;
  readonly store: FileStateStore;
  readonly clock: FixedClock;
  readonly platform: Platform;
  readonly hops: FileQueuedHopRepository;
  readonly requests: FileChangeRequestRepository;
  readonly impacts: FileChangeImpactRepository;
  readonly gate: DecidedEventGate;
}

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'impact-platform-'));
  dirs.push(dir);
  const statePath = join(dir, 'state.json');
  const store = new FileStateStore(statePath);
  const clock = new FixedClock(NOW);
  const ids = new PersistentIds(store);
  const gate = new DecidedEventGate(new FileActivityLog(store, clock));
  const hops = new FileQueuedHopRepository(store);
  const requests = new FileChangeRequestRepository(store);
  const impacts = new FileChangeImpactRepository(store);
  const platform = new Platform({
    projects: new FileProjectRepository(store),
    deliveries: new FileDeliveryRepository(store, clock, ids),
    activity: gate,
    clock,
    ids,
    transaction: store,
    changeRequests: requests,
    changeImpacts: impacts,
    queuedHops: hops,
  });
  return { statePath, store, clock, platform, hops, requests, impacts, gate };
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

/**
 * 入队并领取一次，返回这一代的领取身份。
 *
 * 领取时刻与租约都从 h.clock 现算：写死 NOW 的话，时钟推过之后新领的牌
 * 一领到就是过期的，后面「活租约」的断言会莫名其妙地红。
 */
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

/** 重新领取一条已在队列里的 hop：换代，并返回新一代身份。 */
async function reClaim(
  h: Harness,
  id: string,
  leaseMs: number,
): Promise<QueueClaimIdentity> {
  const at = h.clock.now().toISOString();
  const leaseUntil = new Date(h.clock.now().getTime() + leaseMs).toISOString();
  const taken = await h.hops.claim(id, 'owner', at, leaseUntil);
  assert.ok(taken, `hop ${id} 应能重新领到`);
  return { id, owner: 'owner', claimGeneration: taken.claimGeneration ?? 1 };
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

/** 建一个「协调者已交卷 + 一个已派发并领取的执行者在跑」的 Mission。 */
async function runningExecutor(h: Harness, missionId = 'M') {
  await h.platform.createMission({ projectId: 'P', missionId, contract: CONTRACT, origin: ORIGIN });
  const coord = await h.platform.startCoordinatorAttempt(missionId);
  await h.platform.updatePlan(missionId, coord.attemptId, PLAN);
  await h.platform.submitContractCheck(missionId, coord.attemptId, {
    verdict: 'ok',
    summary: '四条都核过',
  });
  const { workItemId } = await h.platform.createWorkItem(missionId, coord.attemptId, {
    title: 'W',
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
  // 协调者交卷，让出唯一的 coordinator 位：impact 要在「执行者在跑、协调者没在跑」时开。
  await h.platform.finishAttempt(missionId, coord.attemptId, { endedBy: 'structured_submit' });
  return {
    missionId,
    workItemId,
    executorAttemptId: exec.attemptId,
    executorClaim,
  };
}

function ruleCode(error: unknown): string {
  assert.ok(error instanceof PlatformRuleError, `期望 PlatformRuleError，实际 ${String(error)}`);
  return error.code;
}

async function rejectCode(promise: Promise<unknown>): Promise<string> {
  return ruleCode(await promise.catch((error: unknown) => error));
}

async function eventsOf(h: Harness, missionId: string, kind: string): Promise<readonly ActivityEvent[]> {
  return (await h.gate.list(missionId)).filter((event) => event.kind === kind);
}

function onDisk(statePath: string): { changeImpacts: unknown[]; events: { kind: string }[] } {
  return JSON.parse(readFileSync(statePath, 'utf8'));
}

/* ==================== 1. 合法双 claim 路径 ==================== */

test('合法 impact claim 开唯一 L2、读绑定请求、保存带正确来源的决定；重试只一事件、冲突与额外身份拒绝、冻结工单不变且重开恢复', async () => {
  const h = harness();
  const live = await runningExecutor(h);
  await h.requests.append(request({ changeId: 'CR-1', attemptId: live.executorAttemptId }));

  // impact hop：独立一行、role=coordinator、自己的槽。它先被领走又让出再领一次，
  // 于是 impact 代次是 2、执行者代次是 1——两者必须互不相干，混用会立刻显形。
  await claim(
    h,
    {
      id: 'h-impact',
      role: 'coordinator',
      missionId: live.missionId,
      workItemId: live.workItemId,
      purpose: 'impact',
      changeId: 'CR-1',
    },
    IMPACT_LEASE_MS,
  );
  h.clock.advance(IMPACT_LEASE_MS + 1000);
  const impactClaim = await reClaim(h, 'h-impact', IMPACT_LEASE_MS);
  h.clock.advance(-(IMPACT_LEASE_MS + 1000));
  assert.equal(impactClaim.claimGeneration, 2, 'impact 代次与执行者代次互不相干');
  assert.equal(live.executorClaim.claimGeneration, 1);
  assert.notEqual(impactClaim.id, live.executorClaim.id);

  // 普通 coordinator 正在跑：impact 不得抢占（不变量 B 由 Mission 守着）。
  const busy = await h.platform.startCoordinatorAttempt(live.missionId);
  assert.equal(
    await rejectCode(h.platform.startImpactCoordinatorAttempt(live.missionId, 'CR-1', undefined, impactClaim)),
    'CONCURRENT_COORDINATOR_ATTEMPT',
  );
  // 同一个在跑的普通 coordinator 也借不到这条读：它没有 impact 关联标记。
  assert.equal(
    await rejectCode(h.platform.getChangeRequest(live.missionId, busy.attemptId, 'CR-1', impactClaim)),
    'WRONG_ROLE',
  );
  await h.platform.finishAttempt(live.missionId, busy.attemptId, { endedBy: 'structured_submit' });

  const started = await h.platform.startImpactCoordinatorAttempt(
    live.missionId,
    'CR-1',
    undefined,
    impactClaim,
  );
  assert.equal(started.workItemId, live.workItemId);

  // started 事件里刻下关联与 claim 三元组：后面每次读写都拿它对照。
  const mine = (await eventsOf(h, live.missionId, 'attempt.started')).find(
    (event) => event.attemptId === started.attemptId,
  );
  assert.ok(mine);
  assert.deepEqual(mine.data, {
    kind: 'coordinator',
    queue: true,
    purpose: 'impact',
    changeId: 'CR-1',
    workItemId: live.workItemId,
    claim: { id: 'h-impact', owner: 'owner', claimGeneration: 2 },
  });

  // 读：只给这次 Attempt 绑定的那一条。
  const read = await h.platform.getChangeRequest(
    live.missionId,
    started.attemptId,
    'CR-1',
    impactClaim,
  );
  assert.equal(read.changeId, 'CR-1');
  assert.equal(read.attemptId, live.executorAttemptId);
  assert.equal(read.workItemId, live.workItemId);

  const frozen = JSON.stringify(ORDER);
  const workItemBefore = JSON.stringify(
    (await h.platform.getMissionView(live.missionId)).workItems,
  );

  const saved = await h.platform.submitChangeImpact(
    live.missionId,
    started.attemptId,
    'CR-1',
    IMPACT_BODY,
    impactClaim,
  );
  // 外层代次来自 executor request；内层 claim 来自 impact 自己的真实代次。
  assert.equal(saved.claimGeneration, 1, '外层代次来自 executor request');
  assert.deepEqual(
    saved.claim,
    { id: 'h-impact', owner: 'owner', claimGeneration: 2 },
    '内层 claim 是 impact 自己的真实代次，不是 request 的代次',
  );
  assert.equal(saved.attemptId, live.executorAttemptId);
  assert.equal(saved.coordinatorAttemptId, started.attemptId);
  assert.equal((await eventsOf(h, live.missionId, 'change.impact_decided')).length, 1);

  // 等值重试：原记录、原来源，且不再发第二条事件。
  const again = await h.platform.submitChangeImpact(
    live.missionId,
    started.attemptId,
    'CR-1',
    IMPACT_BODY,
    impactClaim,
  );
  assert.deepEqual(again, saved);
  assert.equal((await eventsOf(h, live.missionId, 'change.impact_decided')).length, 1);

  // 异业务：冲突，不覆盖。
  const conflicted = await h.platform
    .submitChangeImpact(
      live.missionId,
      started.attemptId,
      'CR-1',
      { ...IMPACT_BODY, decision: 'replan' as const },
      impactClaim,
    )
    .catch((error: unknown) => error);
  assert.equal((conflicted as { code?: string }).code, 'CHANGE_IMPACT_CONFLICT');
  assert.equal((await h.impacts.get('CR-1'))?.decision, 'compatible');

  // replan / cancel_replace 都不执行动作：冻结工单与工作项原样。
  assert.equal(JSON.stringify(ORDER), frozen, '冻结工单原样');
  assert.equal(
    JSON.stringify((await h.platform.getMissionView(live.missionId)).workItems),
    workItemBefore,
    '没有重派或取消',
  );

  // 另一张 impact 牌（同一条变更、新开的槽）不能借当前 Attempt 写。
  const other = await claim(
    h,
    {
      id: 'h-impact-2',
      role: 'coordinator',
      missionId: live.missionId,
      workItemId: live.workItemId,
      purpose: 'impact',
      changeId: 'CR-1',
    },
    IMPACT_LEASE_MS,
  );
  assert.equal(
    await rejectCode(h.platform.getChangeRequest(live.missionId, started.attemptId, 'CR-1', other)),
    'CLAIM_FENCE_REJECTED',
  );

  // body 里任何身份字段一律拒：身份只来自 claim 与请求记录。
  await assert.rejects(
    h.platform.submitChangeImpact(
      live.missionId,
      started.attemptId,
      'CR-1',
      { ...IMPACT_BODY, changeId: 'CR-9' },
      impactClaim,
    ),
    /只接受四业务字段/,
  );
  assert.equal((await eventsOf(h, live.missionId, 'change.impact_decided')).length, 1);

  // 盘上：一条决定、一条事件；重开（新读文件）恢复出来的就是保存的那份。
  const disk = onDisk(h.statePath);
  assert.equal(disk.changeImpacts.length, 1);
  assert.equal(disk.events.filter((event) => event.kind === 'change.impact_decided').length, 1);
  const reopened = new FileStateStore(h.statePath);
  assert.deepEqual(await new FileChangeImpactRepository(reopened).get('CR-1'), saved);

  // pending：已决定的 CR-1 不再是当前活执行者的未决项。
  assert.deepEqual(
    await h.platform.listPendingChangeRequests(
      live.missionId,
      live.workItemId,
      live.executorAttemptId,
      live.executorClaim,
    ),
    [],
  );
});

/* ==================== 2. 拒绝与回滚 ==================== */

test('跨任务/变更/claim、旧代次、过期租约与非当前目标一律无副作用拒绝；事件写失败回滚决定且可重试', async () => {
  const h = harness();
  const live = await runningExecutor(h);
  await h.requests.append(request({ changeId: 'CR-1', attemptId: live.executorAttemptId }));
  const impactClaim = await claim(
    h,
    {
      id: 'h-impact',
      role: 'coordinator',
      missionId: live.missionId,
      workItemId: live.workItemId,
      purpose: 'impact',
      changeId: 'CR-1',
    },
    IMPACT_LEASE_MS,
  );

  // 别的 Mission 的变更：拿 A 任务的变更去卡 B 任务。
  await h.platform.createMission({ projectId: 'P', missionId: 'M2', contract: CONTRACT, origin: ORIGIN });
  await h.requests.append(request({ changeId: 'CR-2', missionId: 'M2' }));
  assert.equal(
    await rejectCode(h.platform.startImpactCoordinatorAttempt('M', 'CR-2', undefined, impactClaim)),
    'UNKNOWN_CHANGE_REQUEST',
  );

  // impact 牌绑的是 CR-1，却要开 CR-3 的判断：purpose/changeId 是钉死的一对。
  // CR-3 指向另一代执行：它会在 pending 里被目标过滤掉，而不是全停。
  await h.requests.append(request({ changeId: 'CR-3', attemptId: 'W-1.exec-9' }));
  assert.equal(
    await rejectCode(h.platform.startImpactCoordinatorAttempt('M', 'CR-3', undefined, impactClaim)),
    'CLAIM_FENCE_REJECTED',
  );

  const started = await h.platform.startImpactCoordinatorAttempt(
    live.missionId,
    'CR-1',
    undefined,
    impactClaim,
  );

  // 旧代次：换代前的旧牌不能接着写。
  const stale: QueueClaimIdentity = { ...impactClaim, claimGeneration: 0 };
  assert.equal(
    await rejectCode(h.platform.getChangeRequest(live.missionId, started.attemptId, 'CR-1', stale)),
    'CLAIM_FENCE_REJECTED',
  );

  // 过期租约：时钟越过 impact 的 leaseUntil（执行者租约还长），活租约等于没有租约。
  h.clock.advance(120_000);
  assert.equal(
    await rejectCode(h.platform.getChangeRequest(live.missionId, started.attemptId, 'CR-1', impactClaim)),
    'CLAIM_FENCE_REJECTED',
  );
  h.clock.advance(-120_000);

  // 另一张 impact 牌：与发牌时钉下的 claim 三元组不一致。
  const other = await claim(
    h,
    {
      id: 'h-impact-2',
      role: 'coordinator',
      missionId: live.missionId,
      workItemId: live.workItemId,
      purpose: 'impact',
      changeId: 'CR-1',
    },
    IMPACT_LEASE_MS,
  );
  assert.equal(
    await rejectCode(h.platform.getChangeRequest(live.missionId, started.attemptId, 'CR-1', other)),
    'CLAIM_FENCE_REJECTED',
  );

  /* ---- pending 筛选：已有 coordinator 不抢占、暂停不报、按目标过滤 ---- */
  assert.deepEqual(
    await h.platform.listPendingChangeRequests(
      live.missionId,
      live.workItemId,
      live.executorAttemptId,
      live.executorClaim,
    ),
    [],
    '已有 impact coordinator 在跑，不再给未决项',
  );
  await h.platform.pauseMission(live.missionId);
  assert.deepEqual(
    await h.platform.listPendingChangeRequests(
      live.missionId,
      live.workItemId,
      live.executorAttemptId,
      live.executorClaim,
    ),
    [],
    '暂停的 Mission 不报未决项',
  );
  // 暂停中也不能开新的 impact：那是在「先别动它」的命令下偷偷动它。
  await assert.rejects(
    h.platform.startImpactCoordinatorAttempt(live.missionId, 'CR-1', undefined, impactClaim),
    (error: unknown) =>
      error instanceof PlatformRuleError && error.code === 'MISSION_NOT_STARTABLE',
    '暂停中不开新的 impact 判断',
  );
  await h.platform.resumeMission(live.missionId);
  await h.platform.finishAttempt(
    live.missionId,
    started.attemptId,
    { endedBy: 'structured_submit' },
    impactClaim,
  );
  assert.deepEqual(
    (
      await h.platform.listPendingChangeRequests(
        live.missionId,
        live.workItemId,
        live.executorAttemptId,
        live.executorClaim,
      )
    ).map((row) => row.changeId),
    ['CR-1'],
    '让出 coordinator 位后按目标给出未决项',
  );
  // 一条 attemptId 就是点名那一次、代次也对的请求，但正在跑的是**另一次**执行：
  // 仓储过滤会把它选出来，所以必须由「最新 running attempt」这一层挡掉。
  await h.requests.append(
    request({ changeId: 'CR-9', attemptId: 'W-1.exec-9', claimGeneration: live.executorClaim.claimGeneration }),
  );
  assert.deepEqual(
    await h.platform.listPendingChangeRequests(
      live.missionId,
      live.workItemId,
      'W-1.exec-9',
      live.executorClaim,
    ),
    [],
    '点名的 attempt 不是正在跑的那一次 → 空',
  );

  /* ---- 目标 attempt 已结束：拒绝，且不留记录 / 事件 ---- */
  await h.platform.finishAttempt(
    live.missionId,
    live.executorAttemptId,
    { endedBy: 'no_structured_result' },
    live.executorClaim,
  );
  assert.equal(
    await rejectCode(h.platform.startImpactCoordinatorAttempt(live.missionId, 'CR-1', undefined, impactClaim)),
    'UNKNOWN_ATTEMPT',
  );
  assert.equal(await h.impacts.get('CR-1'), undefined);
  assert.equal((await eventsOf(h, live.missionId, 'change.impact_decided')).length, 0);
  assert.equal(
    (await eventsOf(h, live.missionId, 'attempt.started')).filter(
      (event) => (event.data as { purpose?: string }).purpose === 'impact',
    ).length,
    1,
    '被拒的开局不留 impact started 事件',
  );

  // 旧代次的请求（没有对应活着的 executor 租约）开不出 impact。
  await h.requests.append(request({ changeId: 'CR-5', claimGeneration: 99 }));
  assert.equal(
    await rejectCode(h.platform.startImpactCoordinatorAttempt(live.missionId, 'CR-5', undefined, impactClaim)),
    'CLAIM_FENCE_REJECTED',
  );

  /* ---- 缺仓储 / 缺 fence：明确 unsupported，不退化成不校验直接写 ---- */
  const bare = new Platform({
    projects: new FileProjectRepository(h.store),
    deliveries: new FileDeliveryRepository(h.store, h.clock, new PersistentIds(h.store)),
    activity: h.gate,
    clock: h.clock,
    ids: new PersistentIds(h.store),
  });
  assert.equal(bare.supportsChangeImpact(), false);
  assert.equal(
    await rejectCode(bare.startImpactCoordinatorAttempt(live.missionId, 'CR-1', undefined, impactClaim)),
    'CHANGE_IMPACT_UNSUPPORTED',
  );

  /* ---- 事件写失败：保存 + 事件同事务，决定随 File 事务回滚，重开后可重试 ---- */
  // 换一代执行者，让目标重新在跑。
  const nextClaim = await claim(
    h,
    { id: 'h-exec-2', role: 'executor', missionId: live.missionId, workItemId: live.workItemId },
    EXEC_LEASE_MS,
  );
  const next = await h.platform.startExecutorAttempt(
    live.missionId,
    live.workItemId,
    undefined,
    nextClaim,
  );
  await h.requests.append(request({ changeId: 'CR-4', attemptId: next.attemptId }));


  const impact4 = await claim(
    h,
    {
      id: 'h-impact-4',
      role: 'coordinator',
      missionId: live.missionId,
      workItemId: live.workItemId,
      purpose: 'impact',
      changeId: 'CR-4',
    },
    IMPACT_LEASE_MS,
  );

  const fresh = await h.platform.startImpactCoordinatorAttempt(
    live.missionId,
    'CR-4',
    undefined,
    impact4,
  );
  h.gate.fail = true;
  await assert.rejects(
    h.platform.submitChangeImpact(live.missionId, fresh.attemptId, 'CR-4', IMPACT_BODY, impact4),
    /decided 事件写失败/,
  );
  h.gate.fail = false;
  // 回滚：盘上没有这条决定，也没有它的事件。
  const afterFail = onDisk(h.statePath);
  assert.equal(afterFail.changeImpacts.length, 0);
  assert.equal(afterFail.events.filter((event) => event.kind === 'change.impact_decided').length, 0);

  // 重新尝试可成功：事件真的发出去了（说明上一次确实没落库，否则这里会是幂等返回）。
  const decided = await h.platform.submitChangeImpact(
    live.missionId,
    fresh.attemptId,
    'CR-4',
    IMPACT_BODY,
    impact4,
  );
  assert.equal(decided.changeId, 'CR-4');
  assert.equal((await eventsOf(h, live.missionId, 'change.impact_decided')).length, 1);
  assert.equal(onDisk(h.statePath).changeImpacts.length, 1);

  /* ---- 代次是「哪次执行」的轴：续租换代后旧代次的请求开不出 impact ---- */
  await h.platform.finishAttempt(live.missionId, fresh.attemptId, { endedBy: 'structured_submit' }, impact4);
  // 执行者租约到期后被重新领取：同一条 hop 换代，第 1 代那次执行不再「正在被持有」。
  h.clock.advance(EXEC_LEASE_MS + 1000);
  const gen2 = await reClaim(h, nextClaim.id, EXEC_LEASE_MS);
  h.clock.advance(-(EXEC_LEASE_MS + 1000));
  assert.equal(gen2.claimGeneration, nextClaim.claimGeneration + 1, '重新领取换代');

  // 钉在第 1 代：那一代租约已经不在（h-exec-2 现在是第 2 代），旧请求开不出。
  await h.requests.append(request({ changeId: 'CR-6', attemptId: next.attemptId, claimGeneration: 99 }));
  const impact6 = await claim(
    h,
    {
      id: 'h-impact-6',
      role: 'coordinator',
      missionId: live.missionId,
      workItemId: live.workItemId,
      purpose: 'impact',
      changeId: 'CR-6',
    },
    IMPACT_LEASE_MS,
  );
  await assert.rejects(
    h.platform.startImpactCoordinatorAttempt(live.missionId, 'CR-6', undefined, impact6),
    (error: unknown) =>
      error instanceof PlatformRuleError && error.code === 'CLAIM_FENCE_REJECTED',
    'request 钉的代次已经换代 → 拒绝',
  );

  // pending 也按「正在跑的那一次」过滤：点名新一代 attempt 时，挂在旧 attempt
  // 上的请求不能再报未决——报了也没有人在跑。
  await h.requests.append(
    request({
      changeId: 'CR-8',
      attemptId: next.attemptId,
      claimGeneration: gen2.claimGeneration,
    }),
  );
  const later = await h.platform
    .listPendingChangeRequests(live.missionId, live.workItemId, next.attemptId, gen2)
    .then((rows) => rows.map((row) => row.changeId));
  assert.ok(later.includes('CR-8'), '当前代的未决项被报出');
  assert.ok(!later.includes('CR-6'), '钉在不存在代次的请求不报未决');

  await h.requests.append(
    request({ changeId: 'CR-7', attemptId: next.attemptId, claimGeneration: gen2.claimGeneration }),
  );
  const impact7 = await claim(
    h,
    {
      id: 'h-impact-7',
      role: 'coordinator',
      missionId: live.missionId,
      workItemId: live.workItemId,
      purpose: 'impact',
      changeId: 'CR-7',
    },
    IMPACT_LEASE_MS,
  );
  const gen7 = await h.platform.startImpactCoordinatorAttempt(live.missionId, 'CR-7', undefined, impact7);
  assert.equal(gen7.workItemId, live.workItemId, '当前代次的请求能开');
});
