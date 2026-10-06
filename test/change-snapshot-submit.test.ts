/**
 * COM3-B4：交卷事件带上 appliedChanges 与 snapshotHash。
 *
 * 为什么走 Platform 而不是直接调哈希函数：这两个字段的意义在于「执行者 ack 过的
 * 回执」与「它被派到的那份工单」在同一次提交里对齐；绕开 Platform 就没有事务，
 * 也测不到未装配回执仓储时交卷仍成功。
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
import type { QueuedHop } from '../src/application/durable-scheduler.ts';
import type { ChangeImpact } from '../src/application/change-impact.ts';
import { Platform } from '../src/application/platform.ts';
import type { QueueClaimIdentity } from '../src/application/platform/types.ts';
import {
  submissionSnapshotHash,
  workOrderContentHash,
  type AppliedChangeRef,
} from '../src/application/change-receipt.ts';

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
const HEX64 = /^[0-9a-f]{64}$/;
const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  readonly clock: FixedClock;
  readonly platform: Platform;
  readonly activity: FileActivityLog;
  readonly hops: FileQueuedHopRepository;
  readonly impacts: FileChangeImpactRepository;
  readonly receipts: FileChangeReceiptRepository;
}

function harness(withReceipts = true): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'snapshot-submit-'));
  dirs.push(dir);
  const store = new FileStateStore(join(dir, 'state.json'));
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
  return { clock, platform, activity, hops, impacts, receipts };
}

/** 入队并领取一次，返回这一代的领取身份。 */
async function claim(
  h: Harness,
  id: string,
  workItemId: string,
  missionId: string,
): Promise<QueueClaimIdentity> {
  const row: QueuedHop = {
    id,
    projectId: 'P',
    missionId,
    workItemId,
    role: 'executor',
    priority: 0,
    availableAt: NOW,
    attemptCount: 0,
    maxAttempts: 3,
    idempotencyKey: `key-${id}`,
    status: 'queued',
    createdAt: NOW,
    updatedAt: NOW,
  };
  await h.hops.enqueue(row);
  const at = h.clock.now().toISOString();
  const leaseUntil = new Date(h.clock.now().getTime() + EXEC_LEASE_MS).toISOString();
  const taken = await h.hops.claim(id, 'owner', at, leaseUntil);
  assert.ok(taken, `hop ${id} 应能领到`);
  return { id, owner: 'owner', claimGeneration: taken.claimGeneration ?? 1 };
}

function impact(input: {
  changeId: string;
  attemptId: string;
  claimGeneration: number;
  workItemId: string;
  missionId: string;
}): ChangeImpact {
  return {
    changeId: input.changeId,
    missionId: input.missionId,
    workItemId: input.workItemId,
    attemptId: input.attemptId,
    claimGeneration: input.claimGeneration,
    coordinatorAttemptId: 'coord-unused',
    claim: IMPACT_CLAIM,
    decision: 'compatible',
    workOrderDiff: DIFF,
    affectedAcceptance: [1],
    reason: 'step 2b 仍可执行',
  };
}

/** 协调者已交卷 + 一个已派发并领取的执行者在跑。 */
async function runningExecutor(h: Harness, missionId = 'M') {
  await h.platform.createMission({ projectId: 'P', missionId, contract: CONTRACT, origin: ORIGIN });
  const coord = await h.platform.startCoordinatorAttempt(missionId);
  await h.platform.updatePlan(missionId, coord.attemptId, PLAN);
  await h.platform.submitContractCheck(missionId, coord.attemptId, {
    verdict: 'ok',
    summary: '两条都核过',
  });
  const { workItemId } = await h.platform.createWorkItem(missionId, coord.attemptId, {
    title: 'W',
    order: ORDER,
  });
  const { dispatched } = await h.platform.dispatchWorkItems(missionId, coord.attemptId, [workItemId]);
  assert.deepEqual(dispatched, [workItemId]);
  const executorClaim = await claim(h, 'h-exec', workItemId, missionId);
  const exec = await h.platform.startExecutorAttempt(missionId, workItemId, undefined, executorClaim);
  await h.platform.finishAttempt(missionId, coord.attemptId, { endedBy: 'structured_submit' });
  return {
    missionId,
    workItemId,
    executorAttemptId: exec.attemptId,
    executorClaim,
  };
}

/** 投一条 compatible 差异并逐层 ack 到 executor_started。 */
async function ackAll(
  h: Harness,
  live: { missionId: string; workItemId: string; executorAttemptId: string; executorClaim: QueueClaimIdentity },
  changeId: string,
): Promise<void> {
  await h.impacts.append(
    impact({
      changeId,
      attemptId: live.executorAttemptId,
      claimGeneration: live.executorClaim.claimGeneration,
      workItemId: live.workItemId,
      missionId: live.missionId,
    }),
  );
  const ack = (layer: string, contentHash?: string) =>
    h.platform.ackChangeReceipt(
      live.missionId,
      live.workItemId,
      live.executorAttemptId,
      { changeId, layer, ...(contentHash === undefined ? {} : { contentHash }) },
      live.executorClaim,
    );
  await ack('adapter_received');
  await ack('session_consumed');
  await ack('executor_started', DIFF_HASH);
}

interface SubmittedData {
  appliedChanges: readonly AppliedChangeRef[];
  snapshotHash: string;
  orderRevision: string;
  contractRevision: number;
}

async function submittedEvent(
  h: Harness,
  missionId: string,
  attemptId: string,
): Promise<SubmittedData> {
  const events = await h.activity.list(missionId);
  const event = events.find(
    (row) => row.kind === 'execution_result.submitted' && row.attemptId === attemptId,
  );
  assert.ok(event, '应有一条该 attempt 的 execution_result.submitted');
  const data = event.data as SubmittedData;
  assert.equal(typeof data.snapshotHash, 'string');
  return data;
}

test('交卷事件带上本次 Attempt 的 executor_started 回执（按 changeId 升序）与快照哈希', async () => {
  const h = harness();
  const live = await runningExecutor(h);
  const { missionId, workItemId, executorAttemptId, executorClaim } = live;
  // 排序要求是 changeId 升序：CH-0 后 ack 也要排在 CH-1 前面。
  await ackAll(h, live, 'CH-1');
  await ackAll(h, live, 'CH-0');
  await h.platform.submitEvidence(
    missionId,
    executorAttemptId,
    { kind: 'test', summary: '绿', command: 'node --test', exitCode: 0 },
    executorClaim,
  );
  await h.platform.submitExecutionResult(
    missionId,
    executorAttemptId,
    {
      outcome: 'completed',
      summary: '好了',
      changedFiles: ['src/foo.ts'],
      evidenceIds: ['E-1'],
      notes: '无',
    },
    executorClaim,
  );
  const data = await submittedEvent(h, missionId, executorAttemptId);
  const appliedChanges: readonly AppliedChangeRef[] = [
    { changeId: 'CH-0', contentHash: DIFF_HASH },
    { changeId: 'CH-1', contentHash: DIFF_HASH },
  ];
  assert.deepEqual([...data.appliedChanges], [...appliedChanges]);
  assert.equal(data.orderRevision, 'r1');
  assert.match(data.snapshotHash, HEX64);
  const expected = submissionSnapshotHash({
    orderRevision: data.orderRevision,
    contractRevision: data.contractRevision,
    workOrderHash: workOrderContentHash(ORDER),
    appliedChanges,
  });
  assert.equal(data.snapshotHash, expected);
  assert.equal(data.contractRevision, 1);
  assert.equal(workItemId, 'W-1');
});

test('未装配 changeReceipts：交卷仍成功，appliedChanges 为 []，快照哈希照算', async () => {
  const h = harness(false);
  const live = await runningExecutor(h);
  const { missionId, executorAttemptId, executorClaim } = live;
  await h.platform.submitEvidence(
    missionId,
    executorAttemptId,
    { kind: 'test', summary: '绿', command: 'node --test', exitCode: 0 },
    executorClaim,
  );
  await h.platform.submitExecutionResult(
    missionId,
    executorAttemptId,
    {
      outcome: 'completed',
      summary: '好了',
      changedFiles: ['src/foo.ts'],
      evidenceIds: ['E-1'],
      notes: '无',
    },
    executorClaim,
  );
  const data = await submittedEvent(h, missionId, executorAttemptId);
  assert.deepEqual([...data.appliedChanges], []);
  assert.match(data.snapshotHash, HEX64);
  const expected = submissionSnapshotHash({
    orderRevision: data.orderRevision,
    contractRevision: data.contractRevision,
    workOrderHash: workOrderContentHash(ORDER),
    appliedChanges: [],
  });
  assert.equal(data.snapshotHash, expected);
});
