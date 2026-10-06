/**
 * 执行者读差异 + 逐层回执的 Platform 路径（真实 File + 围栏事务）。
 *
 * 为什么走 Platform 而不是直接调用例函数：这条路径的全部不变量都在
 * 「事务 + 执行者自己的租约 + 当前 in_progress Attempt」的交界上，绕开 Platform
 * 就绕开了事务，测出来的「通过」只说明逻辑跑通，不说明它在真实装配下站得住。
 *
 * 为什么用真实 FileStateStore：内存版没有事务回滚，拒绝之后盘上照样留下东西——
 * 那正是这条路径最该挡住的坏形状。
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
import { FileChangeImpactRepository } from '../src/application/change-impact-repository.ts';
import { FileChangeReceiptRepository } from '../src/application/change-receipt-repository.ts';
import type { ActivityEvent } from '../src/application/ports.ts';
import type { QueuedHop } from '../src/application/durable-scheduler.ts';
import type { ChangeImpact } from '../src/application/change-impact.ts';
import { Platform } from '../src/application/platform.ts';
import { PlatformRuleError } from '../src/application/platform/context.ts';
import { CHANGE_RECEIPT_RECORDED_KIND } from '../src/application/platform/change-receipt.ts';
import type { QueueClaimIdentity } from '../src/application/platform/types.ts';

const NOW = '2026-01-01T00:00:00.000Z';
const EXEC_LEASE_MS = 30 * 60 * 1000;

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
const DIFF = '把 step 2 换成 step 2b';
const DIFF_HASH = '9d4fbbb3d09d3b36d8573d4185d0bbc69e52e61c3b2dabb72e68c11539512241';
const IMPACT_CLAIM = { id: 'h-impact', owner: 'owner', claimGeneration: 1 };
const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  readonly statePath: string;
  readonly clock: FixedClock;
  readonly platform: Platform;
  readonly activity: FileActivityLog;
  readonly hops: FileQueuedHopRepository;
  readonly impacts: FileChangeImpactRepository;
  readonly receipts: FileChangeReceiptRepository;
}

function harness(withReceipts = true): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'receipt-platform-'));
  dirs.push(dir);
  const statePath = join(dir, 'state.json');
  const store = new FileStateStore(statePath);
  const clock = new FixedClock(NOW);
  const ids = new PersistentIds(store);
  const activity = new FileActivityLog(store, clock);
  const hops = new FileQueuedHopRepository(store);
  const impacts = new FileChangeImpactRepository(store);
  const receipts = new FileChangeReceiptRepository(store);
  const platform = new Platform({
    projects: new FileProjectRepository(store),
    deliveries: new FileDeliveryRepository(store, clock, ids),
    activity,
    clock,
    ids,
    transaction: store,
    changeImpacts: impacts,
    queuedHops: hops,
    ...(withReceipts ? { changeReceipts: receipts } : {}),
  });
  return { statePath, clock, platform, activity, hops, impacts, receipts };
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

/** 入队并领取一次，返回这一代的领取身份。租约按当前时钟现算。 */
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
    claim: IMPACT_CLAIM,
    decision: 'compatible',
    workOrderDiff: DIFF,
    affectedAcceptance: [1],
    reason: 'step 2b 仍可执行',
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
  await h.platform.finishAttempt(missionId, coord.attemptId, { endedBy: 'structured_submit' });
  return {
    missionId,
    workItemId,
    executorAttemptId: exec.attemptId,
    executorClaim,
  };
}

function diskBytes(statePath: string): string {
  return readFileSync(statePath, 'utf8');
}

async function rejectCode(promise: Promise<unknown>): Promise<string> {
  const error = await promise.catch((caught: unknown) => caught);
  assert.ok(error instanceof PlatformRuleError, `期望 PlatformRuleError，实际 ${String(error)}`);
  return error.code;
}

/** 拒绝必须逐字节不改：读/拒都不能顺手落一条回执或事件。 */
async function assertRejected(
  h: Harness,
  code: string,
  run: () => Promise<unknown>,
): Promise<void> {
  const before = diskBytes(h.statePath);
  assert.equal(await rejectCode(run()), code);
  assert.equal(diskBytes(h.statePath), before, '拒绝不得改动盘文件字节');
}

async function receiptEvents(h: Harness, missionId: string): Promise<readonly ActivityEvent[]> {
  return (await h.activity.list(missionId)).filter(
    (event) => event.kind === CHANGE_RECEIPT_RECORDED_KIND,
  );
}

test('执行者只读到发给自己的 compatible 差异；回执逐层前进、拒绝路径无副作用、未装配 unsupported', async () => {
  const h = harness();
  const live = await runningExecutor(h);
  const { missionId, workItemId, executorAttemptId, executorClaim } = live;
  // 直接落库而不走 submitChangeImpact：这条单只验接收侧，判断路径另有其测。
  await h.impacts.append(
    impact({ changeId: 'CH-1', attemptId: executorAttemptId, claimGeneration: executorClaim.claimGeneration }),
  );
  await h.impacts.append(
    impact({
      changeId: 'CH-replan',
      attemptId: executorAttemptId,
      claimGeneration: executorClaim.claimGeneration,
      decision: 'replan',
      affectedAcceptance: [],
      reason: '要推倒重排',
    }),
  );
  await h.impacts.append(
    impact({
      changeId: 'CH-other',
      attemptId: 'AT-other',
      claimGeneration: executorClaim.claimGeneration,
    }),
  );
  const list = () =>
    h.platform.listChangeDeliveries(missionId, workItemId, executorAttemptId, executorClaim);
  const ack = (body: Record<string, unknown>) =>
    h.platform.ackChangeReceipt(missionId, workItemId, executorAttemptId, body, executorClaim);
  const delivered = await list();
  assert.deepEqual(
    delivered.map((row) => row.changeId),
    ['CH-1'],
    'replan 与跨 Attempt 的差异都不该出现',
  );
  assert.equal(delivered[0]!.diffHash, DIFF_HASH);
  assert.deepEqual([...delivered[0]!.affectedAcceptance], [1]);
  assert.deepEqual(delivered[0]!.receipts, [], '还没回执时 receipts 为空');
  assert.equal(delivered[0]!.workOrderDiff, DIFF);
  const started = (changeId: string, contentHash: string) => ({ changeId, layer: 'executor_started', contentHash });
  // 越层、hash 不符、非 compatible、跨 Attempt、body 带身份、verified 层：都拒且盘不变。
  await assertRejected(h, 'RECEIPT_LAYER_ORDER', () => ack(started('CH-1', DIFF_HASH)));
  await assertRejected(h, 'RECEIPT_HASH_MISMATCH', () => ack(started('CH-1', 'a'.repeat(64))));
  await assertRejected(h, 'CHANGE_NOT_DELIVERABLE', () =>
    ack({ changeId: 'CH-replan', layer: 'adapter_received' }),
  );
  await assertRejected(h, 'CHANGE_NOT_DELIVERABLE', () =>
    ack({ changeId: 'CH-other', layer: 'adapter_received' }),
  );
  await assertRejected(h, 'INVALID_CHANGE_RECEIPT', () =>
    ack({ changeId: 'CH-1', layer: 'adapter_received', missionId }),
  );
  await assertRejected(h, 'INVALID_CHANGE_RECEIPT', () => ack({ changeId: 'CH-1', layer: 'verified' }));
  // 逐层前进：adapter_received → session_consumed → executor_started。
  await ack({ changeId: 'CH-1', layer: 'adapter_received' });
  await ack({ changeId: 'CH-1', layer: 'session_consumed' });
  await ack(started('CH-1', DIFF_HASH));
  // 同层幂等重试：不 append 第二条，也不发第二次事件。
  await ack({ changeId: 'CH-1', layer: 'adapter_received' });

  const after3 = await list();
  assert.deepEqual(
    after3[0]!.receipts.map((row) => row.layer),
    ['adapter_received', 'session_consumed', 'executor_started'],
  );
  assert.deepEqual(
    after3[0]!.receipts.map((row) => row.contentHash),
    [undefined, undefined, DIFF_HASH],
  );
  const rows = await h.receipts.listByChange('CH-1');
  assert.equal(rows.length, 3, '同层重试不得 append 第二条');
  assert.equal((await receiptEvents(h, missionId)).length, 3, '幂等重试不得发第二次事件');
  // 只有 executor_started 的回执链：经 Platform 补 adapter_received 是回退，必须拒。
  await h.impacts.append(
    impact({ changeId: 'CH-2', attemptId: executorAttemptId, claimGeneration: executorClaim.claimGeneration }),
  );
  await h.receipts.append({
    changeId: 'CH-2',
    missionId,
    workItemId,
    attemptId: executorAttemptId,
    claimGeneration: executorClaim.claimGeneration,
    layer: 'executor_started',
    at: h.clock.now().toISOString(),
    contentHash: DIFF_HASH,
  });
  await assertRejected(h, 'RECEIPT_LAYER_ORDER', () =>
    ack({ changeId: 'CH-2', layer: 'adapter_received' }),
  );
  assert.deepEqual(
    (await h.receipts.listByChange('CH-2')).map((row) => row.layer),
    ['executor_started'],
  );
  // 失租：换代之后用旧 claim 读，围栏必须拒，且不留下任何新回执 / 事件。
  const receiptsBefore = (await h.receipts.listByMission(missionId)).length;
  const eventsBefore = (await receiptEvents(h, missionId)).length;
  h.clock.advance(EXEC_LEASE_MS + 60_000);
  assert.equal(await rejectCode(list()), 'CLAIM_FENCE_REJECTED');
  assert.equal((await h.receipts.listByMission(missionId)).length, receiptsBefore);
  assert.equal((await receiptEvents(h, missionId)).length, eventsBefore);

  // 未装配：list 与 ack 都 unsupported，绝不隐式写。
  const bare = harness(false);
  const live2 = await runningExecutor(bare);
  const { missionId: m2, workItemId: w2, executorAttemptId: a2, executorClaim: c2 } = live2;
  assert.equal(bare.platform.supportsChangeReceipt(), false);
  const bareBytes = diskBytes(bare.statePath);
  assert.equal(
    await rejectCode(bare.platform.listChangeDeliveries(m2, w2, a2, c2)),
    'CHANGE_RECEIPT_UNSUPPORTED',
  );
  assert.equal(
    await rejectCode(
      bare.platform.ackChangeReceipt(m2, w2, a2, { changeId: 'CH-1', layer: 'adapter_received' }, c2),
    ),
    'CHANGE_RECEIPT_UNSUPPORTED',
  );
  assert.equal(diskBytes(bare.statePath), bareBytes, 'unsupported 不得写任何东西');
});
