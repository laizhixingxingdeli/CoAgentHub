/**
 * W-491：accept 门禁 + verified 回执。
 *
 * 为什么必须走 Platform 而不是直接改仓储：门禁与写回执都在同一事务里，绕开就测
 * 不到「拒绝时盘上一个字节都不变」——那正是这条规则的全部价值。
 *
 * ① 覆盖后 accept 才写 verified，且不会误用别的 Attempt 的报告；没有通过的 VR 时
 *   accept 照常成功但不写。
 * ② 缺回执 / hash 不符时 accept 被拒、盘上零副作用；reject 仍可用；重派后新旧
 *   提交与各自报告都还在。
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  AcceptanceResult,
  MissionContract,
  ValidationReport,
  WorkOrder,
} from '../src/kernel/index.ts';
import { FixedClock } from '../src/application/in-memory.ts';
import {
  FileActivityLog,
  FileDeliveryRepository,
  FileProjectRepository,
  FileQueuedHopRepository,
  FileStateStore,
  FileValidationReportRepository,
  PersistentIds,
} from '../src/application/file-store.ts';
import { FileChangeImpactRepository } from '../src/application/change-impact-repository.ts';
import { FileChangeReceiptRepository } from '../src/application/change-receipt-repository.ts';
import type { QueuedHop } from '../src/application/durable-scheduler.ts';
import type { ChangeImpact } from '../src/application/change-impact.ts';
import { Platform } from '../src/application/platform.ts';
import { PlatformRuleError } from '../src/application/platform/context.ts';
import type { QueueClaimIdentity } from '../src/application/platform/types.ts';

const NOW = '2026-01-01T00:00:00.000Z';
const EXEC_LEASE_MS = 30 * 60 * 1000;

const CONTRACT: MissionContract = {
  intent: '把 X 修好',
  acceptance: ['测试全绿'],
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
  readonly statePath: string;
  readonly clock: FixedClock;
  readonly platform: Platform;
  readonly activity: FileActivityLog;
  readonly hops: FileQueuedHopRepository;
  readonly impacts: FileChangeImpactRepository;
  readonly receipts: FileChangeReceiptRepository;
  readonly reports: FileValidationReportRepository;
}

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'snapshot-review-'));
  dirs.push(dir);
  const statePath = join(dir, 'state.json');
  const store = new FileStateStore(statePath);
  const clock = new FixedClock(NOW);
  const ids = new PersistentIds(store);
  const activity = new FileActivityLog(store, clock);
  const hops = new FileQueuedHopRepository(store);
  const impacts = new FileChangeImpactRepository(store);
  const receipts = new FileChangeReceiptRepository(store);
  const reports = new FileValidationReportRepository(store);
  const validation = {
    reports,
    engine: { validate: async () => { throw new Error('unused'); } },
  };
  const platform = new Platform({
    projects: new FileProjectRepository(store),
    deliveries: new FileDeliveryRepository(store, clock, ids),
    activity,
    clock,
    ids,
    transaction: store,
    changeImpacts: impacts,
    queuedHops: hops,
    changeReceipts: receipts,
    validation,
  });
  return { statePath, clock, platform, activity, hops, impacts, receipts, reports };
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

type Live = {
  readonly missionId: string;
  readonly workItemId: string;
  readonly executorAttemptId: string;
  readonly executorClaim: QueueClaimIdentity;
};

/** 协调者已交卷 + 一个已派发并领取的执行者在跑。 */
async function runningExecutor(h: Harness, missionId = 'M', hopId = 'h-exec'): Promise<Live> {
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
  const executorClaim = await claim(h, hopId, workItemId, missionId);
  const exec = await h.platform.startExecutorAttempt(missionId, workItemId, undefined, executorClaim);
  await h.platform.finishAttempt(missionId, coord.attemptId, { endedBy: 'structured_submit' });
  return { missionId, workItemId, executorAttemptId: exec.attemptId, executorClaim };
}

/** 投一条 compatible 差异并逐层 ack 到 executor_started。 */
async function ackAll(h: Harness, live: Live, changeId: string): Promise<void> {
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

/** 只投 impact、不 ack：这次提交没有覆盖它的凭据。 */
async function impactOnly(h: Harness, live: Live, changeId: string): Promise<void> {
  await h.impacts.append(
    impact({
      changeId,
      attemptId: live.executorAttemptId,
      claimGeneration: live.executorClaim.claimGeneration,
      workItemId: live.workItemId,
      missionId: live.missionId,
    }),
  );
}

/** 先交一条证据再交卷：completed 必须有证据撑着，两次写都要带 executorClaim。 */
async function submitDone(h: Harness, live: Live): Promise<void> {
  const c = live.executorClaim;
  await h.platform.submitEvidence(
    live.missionId,
    live.executorAttemptId,
    { kind: 'test', summary: '绿', command: 'node --test', exitCode: 0 },
    c,
  );
  await h.platform.submitExecutionResult(
    live.missionId,
    live.executorAttemptId,
    {
      outcome: 'completed',
      summary: '好了',
      changedFiles: ['src/foo.ts'],
      evidenceIds: ['E-1'],
      notes: '无',
    },
    c,
  );
}

const PASS: readonly AcceptanceResult[] = [
  { criterion: 'foo() === 1', status: 'pass', evidence: '核过' },
];
const FAIL: readonly AcceptanceResult[] = [
  { criterion: 'foo() === 1', status: 'fail', evidence: '没过' },
];

function reportOf(input: {
  id: string;
  missionId: string;
  workItemId: string;
  attemptId: string;
}): ValidationReport {
  return {
    id: input.id,
    policyRevision: 1,
    missionId: input.missionId,
    workItemId: input.workItemId,
    attemptId: input.attemptId,
    startedAt: NOW,
    endedAt: NOW,
    passed: true,
    checks: [{ kind: 'command', passed: true, startedAt: NOW, endedAt: NOW, summary: 'ok' }],
  };
}

/** 一条 validation.reported：报告 id 只有被事件引用才算这次提交的机器依据。 */
async function reportEvent(
  h: Harness,
  missionId: string,
  workItemId: string,
  reportId: string,
  submittedAttemptId: string,
): Promise<void> {
  await h.activity.append({
    projectId: 'P',
    missionId,
    workItemId,
    kind: 'validation.reported',
    data: { reportId, passed: true, submittedAttemptId },
  });
}

function diskBytes(h: Harness): string {
  return readFileSync(h.statePath, 'utf8');
}

interface ReceiptRow {
  readonly changeId: string;
  readonly layer: string;
  readonly attemptId: string;
  readonly claimGeneration: number;
  readonly contentHash?: string;
  readonly sourceAttemptId?: string;
  readonly reportId?: string;
}

/** 盘上 changeReceipts 原始行：verified 不出现在 list/get 里，只能直接读盘看。 */
function diskReceipts(h: Harness, missionId: string): ReceiptRow[] {
  const state = JSON.parse(readFileSync(h.statePath, 'utf8')) as {
    changeReceipts?: ReceiptRow & { missionId?: string }[];
  };
  return (state.changeReceipts ?? []).filter((row) => row.missionId === missionId);
}

test('① 覆盖后 accept 写出 verified；无通过的 VR 时不写但仍 accept', async () => {
  const h = harness();
  const live = await runningExecutor(h);
  const { missionId, workItemId, executorAttemptId } = live;
  await ackAll(h, live, 'CH-1');
  await submitDone(h, live);

  const events = await h.activity.list(missionId);
  const submitted = events.find(
    (row) => row.kind === 'execution_result.submitted' && row.attemptId === executorAttemptId,
  );
  assert.ok(submitted, '应有一条该 attempt 的 execution_result.submitted');
  const data = submitted.data as {
    appliedChanges: readonly { changeId: string; contentHash: string }[];
    snapshotHash: string;
  };
  assert.deepEqual([...data.appliedChanges], [{ changeId: 'CH-1', contentHash: DIFF_HASH }]);
  assert.match(data.snapshotHash, HEX64);

  // 先摆一份别的 Attempt 的通过报告：verified 的 reportId 必须取本次提交的这份。
  await h.reports.save(
    reportOf({ id: 'VR-stale', missionId, workItemId, attemptId: 'not-this' }),
  );
  await reportEvent(h, missionId, workItemId, 'VR-stale', 'not-this');
  await h.reports.save(
    reportOf({ id: 'VR-1', missionId, workItemId, attemptId: executorAttemptId }),
  );
  await reportEvent(h, missionId, workItemId, 'VR-1', executorAttemptId);

  const coord = await h.platform.startCoordinatorAttempt(missionId);
  const out = await h.platform.reviewExecutionResult(missionId, coord.attemptId, {
    workItemId,
    verdict: 'accept',
    reasons: ['核过'],
    requiredChanges: [],
    acceptanceResults: PASS,
  });
  assert.equal(out.status, 'accepted');

  const rows = diskReceipts(h, missionId);
  const layers = rows.map((row) => row.layer);
  assert.deepEqual(
    layers.filter((layer) => layer !== 'verified'),
    ['adapter_received', 'session_consumed', 'executor_started'],
  );
  const verified = rows.find((row) => row.layer === 'verified');
  assert.ok(verified, 'accept 通过且有 VR 时应写出 verified');
  assert.equal(verified.changeId, 'CH-1');
  assert.equal(verified.contentHash, DIFF_HASH);
  assert.equal(verified.reportId, 'VR-1', '不能误用别的 Attempt 的报告');
  assert.equal(verified.sourceAttemptId, coord.attemptId);
  assert.equal(verified.attemptId, executorAttemptId);

  const all = await h.activity.list(missionId);
  const recorded = all.filter((row) => row.kind === 'change.receipt_recorded');
  const verifiedEvent = recorded.find((row) => (row.data as { layer?: string }).layer === 'verified');
  assert.ok(verifiedEvent, '应有 change.receipt_recorded 的 verified 事件');
  assert.deepEqual(verifiedEvent.data, {
    changeId: 'CH-1',
    layer: 'verified',
    workItemId,
    attemptId: executorAttemptId,
    sourceAttemptId: coord.attemptId,
    reportId: 'VR-1',
    contentHash: DIFF_HASH,
  });

  // verified 不是接收侧的层：list / get 都看不见它。
  assert.deepEqual(
    (await h.receipts.listByChange('CH-1')).map((row) => row.layer),
    ['adapter_received', 'session_consumed', 'executor_started'],
  );
  assert.equal(await h.receipts.get('CH-1', 'verified' as never), undefined);

  // 同一 Mission 之外再开一个不种 VR 的：accept 仍成功，但一个 verified 都不写。
  const h2 = harness();
  const live2 = await runningExecutor(h2, 'M-novr', 'h-exec-novr');
  await ackAll(h2, live2, 'CH-1');
  await submitDone(h2, live2);
  const coord2 = await h2.platform.startCoordinatorAttempt('M-novr');
  const out2 = await h2.platform.reviewExecutionResult('M-novr', coord2.attemptId, {
    workItemId: live2.workItemId,
    verdict: 'accept',
    reasons: ['核过'],
    requiredChanges: [],
    acceptanceResults: PASS,
  });
  assert.equal(out2.status, 'accepted');
  const rows2 = diskReceipts(h2, 'M-novr');
  assert.equal(
    rows2.some((row) => row.layer === 'verified'),
    false,
    '没有通过的 VR 时不得写 verified',
  );
  const listed = await h2.receipts.listByMission('M-novr');
  assert.equal(JSON.stringify(listed).includes('verified'), false);
});

test('② 未覆盖时 accept 被拒且盘上零副作用；reject 可用；重派后旧报告仍在', async () => {
  const h = harness();
  const live = await runningExecutor(h, 'M-miss', 'h-exec-miss');
  const { missionId, workItemId } = live;
  await impactOnly(h, live, 'CH-miss');
  await submitDone(h, live);

  const coord = await h.platform.startCoordinatorAttempt(missionId);
  // 起协调者这一跳本身要落盘，所以基线取在它之后：比的是 accept 这一次写没写。
  const before = diskBytes(h);
  await assert.rejects(
    h.platform.reviewExecutionResult(missionId, coord.attemptId, {
      workItemId,
      verdict: 'accept',
      reasons: ['核过'],
      requiredChanges: [],
      acceptanceResults: PASS,
    }),
    (err: unknown) =>
      err instanceof PlatformRuleError &&
      err.code === 'ACCEPT_CHANGES_UNCOVERED' &&
      err.message.includes('CH-miss'),
  );
  assert.equal(diskBytes(h), before, '拒绝必须逐字节不改');
  const view = await h.platform.getMissionView(missionId);
  assert.equal(view.workItems[0]!.status, 'submitted');

  const rejected = await h.platform.reviewExecutionResult(missionId, coord.attemptId, {
    workItemId,
    verdict: 'reject',
    reasons: ['没覆盖'],
    requiredChanges: ['补回执'],
    acceptanceResults: FAIL,
  });
  assert.equal(rejected.status, 'rejected');
  assert.equal(diskReceipts(h, missionId).some((row) => row.layer === 'verified'), false);

  // hash 不符同样算没覆盖。
  const h2 = harness();
  const live2 = await runningExecutor(h2, 'M-hash', 'h-exec-hash');
  await impactOnly(h2, live2, 'CH-hash');
  await h2.receipts.append({
    changeId: 'CH-hash',
    missionId: live2.missionId,
    workItemId: live2.workItemId,
    attemptId: live2.executorAttemptId,
    claimGeneration: live2.executorClaim.claimGeneration,
    layer: 'executor_started',
    at: NOW,
    contentHash: 'a'.repeat(64),
  });
  await submitDone(h2, live2);
  const coord2 = await h2.platform.startCoordinatorAttempt('M-hash');
  const before2 = diskBytes(h2);
  await assert.rejects(
    h2.platform.reviewExecutionResult('M-hash', coord2.attemptId, {
      workItemId: live2.workItemId,
      verdict: 'accept',
      reasons: ['核过'],
      requiredChanges: [],
      acceptanceResults: PASS,
    }),
    (err: unknown) => err instanceof PlatformRuleError && err.code === 'ACCEPT_CHANGES_UNCOVERED',
  );
  assert.equal(diskBytes(h2), before2, 'hash 不符的拒绝也必须逐字节不改');

  // 重派：第一次提交的 impact 仍没被覆盖，第二次 accept 照样被拒；
  // 两次提交与各自的报告都还在，attemptId 不被改写。
  // 执行者那一跳还 in_progress，先收尾才能开新的一跳。
  await h.platform.finishAttempt(missionId, live.executorAttemptId, { endedBy: 'structured_submit' }, live.executorClaim);
  const { dispatched } = await h.platform.dispatchWorkItems(missionId, coord.attemptId, [workItemId]);
  assert.deepEqual(dispatched, [workItemId]);
  const claim2 = await claim(h, 'h-exec-2', workItemId, missionId);
  const exec2 = await h.platform.startExecutorAttempt(missionId, workItemId, undefined, claim2);
  await submitDone(h, { ...live, executorAttemptId: exec2.attemptId, executorClaim: claim2 });

  await h.reports.save(reportOf({ id: 'VR-old', missionId, workItemId, attemptId: live.executorAttemptId }));
  await reportEvent(h, missionId, workItemId, 'VR-old', live.executorAttemptId);
  await h.reports.save(reportOf({ id: 'VR-new', missionId, workItemId, attemptId: exec2.attemptId }));
  await reportEvent(h, missionId, workItemId, 'VR-new', exec2.attemptId);

  await assert.rejects(
    h.platform.reviewExecutionResult(missionId, coord.attemptId, {
      workItemId,
      verdict: 'accept',
      reasons: ['核过'],
      requiredChanges: [],
      acceptanceResults: PASS,
    }),
    (err: unknown) => err instanceof PlatformRuleError && err.code === 'ACCEPT_CHANGES_UNCOVERED',
  );

  const all = await h.activity.list(missionId);
  const submittedIds = all
    .filter((row) => row.kind === 'execution_result.submitted')
    .map((row) => row.attemptId);
  assert.equal(new Set(submittedIds).size, 2, '两次提交的事件都还在');
  assert.ok(submittedIds.includes(live.executorAttemptId));
  assert.ok(submittedIds.includes(exec2.attemptId));
  const reportedAttempts = all
    .filter((row) => row.kind === 'validation.reported')
    .map((row) => (row.data as { submittedAttemptId?: string }).submittedAttemptId);
  assert.equal(new Set(reportedAttempts).size, 2, '两份报告各绑一次提交');
  const oldReport = await h.reports.get('VR-old');
  const newReport = await h.reports.get('VR-new');
  assert.ok(oldReport && newReport);
  assert.equal(oldReport.attemptId, live.executorAttemptId);
  assert.equal(newReport.attemptId, exec2.attemptId);
  assert.equal(diskReceipts(h, missionId).some((row) => row.layer === 'verified'), false);
});

