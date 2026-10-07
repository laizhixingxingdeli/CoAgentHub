/**
 * W-491：accept 门禁 + verified 回执。
 *
 * 为什么必须走 Platform 而不是直接改仓储：门禁与写回执都在同一事务里，绕开就测
 * 不到「拒绝时盘上一个字节都不变」——那正是这条规则的全部价值。
 *
 * ① 覆盖后 accept 才写 verified，且不会误用别的 Attempt 的报告；没有通过的 VR 时 accept 照常成功但不写。
 * ② 缺回执 / hash 不符时 accept 被拒、盘上零副作用；reject 仍可用；重派后新旧提交与各自报告都还在。
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AcceptanceResult, MissionContract, ValidationReport, WorkOrder } from '../src/kernel/index.ts';
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
const LEASE_MS = 30 * 60 * 1000;
const CONTRACT: MissionContract = { intent: '把 X 修好', acceptance: ['测试全绿'], constraints: [], nonGoals: [], guardrails: [] };
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
const DIFF = '把 step 2 换成 step 2b';
const DIFF_HASH = '9d4fbbb3d09d3b36d8573d4185d0bbc69e52e61c3b2dabb72e68c11539512241';
const HEX64 = /^[0-9a-f]{64}$/;
const PASS: readonly AcceptanceResult[] = [{ criterion: 'foo() === 1', status: 'pass', evidence: '核过' }];
const FAIL: readonly AcceptanceResult[] = [{ criterion: 'foo() === 1', status: 'fail', evidence: '没过' }];

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function harness() {
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
    validation: { reports, engine: { validate: async () => { throw new Error('unused'); } } },
  });
  return { statePath, clock, platform, activity, hops, impacts, receipts, reports };
}
type H = ReturnType<typeof harness>;

interface Live {
  readonly missionId: string;
  readonly workItemId: string;
  readonly executorAttemptId: string;
  readonly executorClaim: QueueClaimIdentity;
}

async function claim(h: H, id: string, live: { workItemId: string; missionId: string }): Promise<QueueClaimIdentity> {
  const row: QueuedHop = {
    id, projectId: 'P', missionId: live.missionId, workItemId: live.workItemId, role: 'executor',
    priority: 0, availableAt: NOW, attemptCount: 0, maxAttempts: 3, idempotencyKey: `key-${id}`,
    status: 'queued', createdAt: NOW, updatedAt: NOW,
  };
  await h.hops.enqueue(row);
  const leaseUntil = new Date(h.clock.now().getTime() + LEASE_MS).toISOString();
  const taken = await h.hops.claim(id, 'owner', h.clock.now().toISOString(), leaseUntil);
  assert.ok(taken, `hop ${id} 应能领到`);
  return { id, owner: 'owner', claimGeneration: taken.claimGeneration ?? 1 };
}

/** 协调者已交卷 + 一个已派发并领取的执行者在跑。 */
async function start(h: H, missionId = 'M', hopId = 'h-exec'): Promise<Live> {
  await h.platform.createMission({ projectId: 'P', missionId, contract: CONTRACT, origin: { clientType: 'cli', conversationRef: 'me' } });
  const coord = await h.platform.startCoordinatorAttempt(missionId);
  await h.platform.updatePlan(missionId, coord.attemptId, PLAN);
  await h.platform.submitContractCheck(missionId, coord.attemptId, { verdict: 'ok', summary: '两条都核过' });
  const { workItemId } = await h.platform.createWorkItem(missionId, coord.attemptId, { title: 'W', order: ORDER });
  await h.platform.dispatchWorkItems(missionId, coord.attemptId, [workItemId]);
  const executorClaim = await claim(h, hopId, { workItemId, missionId });
  const exec = await h.platform.startExecutorAttempt(missionId, workItemId, undefined, executorClaim);
  await h.platform.finishAttempt(missionId, coord.attemptId, { endedBy: 'structured_submit' });
  return { missionId, workItemId, executorAttemptId: exec.attemptId, executorClaim };
}

/** 投一条 compatible 差异：这次提交要覆盖的就是它。 */
function appendImpact(h: H, live: Live, changeId: string): Promise<void> {
  const impact: ChangeImpact = {
    changeId,
    missionId: live.missionId,
    workItemId: live.workItemId,
    attemptId: live.executorAttemptId,
    claimGeneration: live.executorClaim.claimGeneration,
    coordinatorAttemptId: 'coord-unused',
    claim: { id: 'h-impact', owner: 'owner', claimGeneration: 1 },
    decision: 'compatible',
    workOrderDiff: DIFF,
    affectedAcceptance: [1],
    reason: 'step 2b 仍可执行',
  };
  return h.impacts.append(impact);
}

/** 逐层 ack 到 executor_started：这次提交确实照这份 diff 跑了。 */
async function ack(h: H, live: Live, changeId: string): Promise<void> {
  await appendImpact(h, live, changeId);
  const at = (layer: string, contentHash?: string) =>
    h.platform.ackChangeReceipt(
      live.missionId,
      live.workItemId,
      live.executorAttemptId,
      { changeId, layer, ...(contentHash === undefined ? {} : { contentHash }) },
      live.executorClaim,
    );
  await at('adapter_received');
  await at('session_consumed');
  await at('executor_started', DIFF_HASH);
}

/** 先交一条证据再交卷：completed 必须有证据撑着，两次写都要带 executorClaim。 */
async function submitDone(h: H, live: Live): Promise<void> {
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
    { outcome: 'completed', summary: '好了', changedFiles: ['src/foo.ts'], evidenceIds: ['E-1'], notes: '无' },
    c,
  );
}

/** 种一份通过报告 + 一条引用它的 validation.reported：报告只有被事件引用才算依据。 */
async function plantReport(h: H, live: Live, reportId: string, attemptId: string): Promise<void> {
  const report: ValidationReport = {
    id: reportId,
    policyRevision: 1,
    missionId: live.missionId,
    workItemId: live.workItemId,
    attemptId,
    startedAt: NOW,
    endedAt: NOW,
    passed: true,
    checks: [{ kind: 'command', passed: true, startedAt: NOW, endedAt: NOW, summary: 'ok' }],
  };
  await h.reports.save(report);
  await h.activity.append({
    projectId: 'P',
    missionId: live.missionId,
    workItemId: live.workItemId,
    kind: 'validation.reported',
    data: { reportId, passed: true, submittedAttemptId: attemptId },
  });
}

function review(h: H, live: Live, coordAttemptId: string, verdict: 'accept' | 'reject') {
  return h.platform.reviewExecutionResult(live.missionId, coordAttemptId, {
    workItemId: live.workItemId,
    verdict,
    reasons: ['核过'],
    requiredChanges: verdict === 'reject' ? ['补回执'] : [],
    acceptanceResults: verdict === 'reject' ? FAIL : PASS,
  });
}

async function uncovered(h: H, live: Live, coordAttemptId: string): Promise<PlatformRuleError> {
  const err = await review(h, live, coordAttemptId, 'accept').then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.ok(err instanceof PlatformRuleError, '未覆盖时 accept 必须抛 PlatformRuleError');
  assert.equal(err.code, 'ACCEPT_CHANGES_UNCOVERED');
  return err;
}

/** 盘上 / 事件 data 的一行：这里只按字段取，字段都可选才过得去两种形状。 */
interface Row {
  readonly [key: string]: string | number | undefined;
}

/** 盘上 changeReceipts 原始行：verified 不出现在 list/get 里，只能直接读盘看。 */
function diskReceipts(h: H, missionId: string): Row[] {
  const state = JSON.parse(diskBytes(h)) as { changeReceipts?: Row[] };
  return (state.changeReceipts ?? []).filter((row) => row.missionId === missionId);
}

function diskBytes(h: H): string {
  return readFileSync(h.statePath, 'utf8');
}

test('① 覆盖后 accept 写出 verified；无通过的 VR 时不写但仍 accept', async () => {
  const h = harness();
  const live = await start(h);
  await ack(h, live, 'CH-1');
  await submitDone(h, live);

  const events = await h.activity.list(live.missionId);
  const submitted = events.find(
    (row) => row.kind === 'execution_result.submitted' && row.attemptId === live.executorAttemptId,
  );
  assert.ok(submitted, '应有一条该 attempt 的 execution_result.submitted');
  const data = submitted.data as { appliedChanges: readonly Row[]; snapshotHash: string };
  assert.deepEqual([...data.appliedChanges], [{ changeId: 'CH-1', contentHash: DIFF_HASH }]);
  assert.match(data.snapshotHash, HEX64);

  // 先摆一份别的 Attempt 的通过报告：verified 的 reportId 必须取本次提交的这份。
  await plantReport(h, live, 'VR-stale', 'not-this');
  await plantReport(h, live, 'VR-1', live.executorAttemptId);

  const coord = await h.platform.startCoordinatorAttempt(live.missionId);
  assert.equal((await review(h, live, coord.attemptId, 'accept')).status, 'accepted');

  const rows = diskReceipts(h, live.missionId);
  assert.deepEqual(
    rows.filter((row) => row.layer !== 'verified').map((row) => row.layer),
    ['adapter_received', 'session_consumed', 'executor_started'],
  );
  const verified = rows.find((row) => row.layer === 'verified');
  assert.ok(verified, 'accept 通过且有 VR 时应写出 verified');
  assert.equal(verified.reportId, 'VR-1', '不能误用别的 Attempt 的报告');
  assert.equal(verified.sourceAttemptId, coord.attemptId);
  assert.deepEqual(
    { changeId: verified.changeId, attemptId: verified.attemptId, contentHash: verified.contentHash },
    { changeId: 'CH-1', attemptId: live.executorAttemptId, contentHash: DIFF_HASH },
  );

  const all = await h.activity.list(live.missionId);
  const recorded = all.find(
    (row) => row.kind === 'change.receipt_recorded' && (row.data as Row).layer === 'verified',
  );
  assert.ok(recorded, '应有 change.receipt_recorded 的 verified 事件');
  assert.deepEqual(recorded.data, {
    changeId: 'CH-1',
    layer: 'verified',
    workItemId: live.workItemId,
    attemptId: live.executorAttemptId,
    sourceAttemptId: coord.attemptId,
    reportId: 'VR-1',
    contentHash: DIFF_HASH,
  });
  assert.equal(recorded.workItemId, live.workItemId);

  // verified 不是接收侧的层：list / get 都看不见它。
  assert.deepEqual(
    (await h.receipts.listByChange('CH-1')).map((row) => row.layer),
    ['adapter_received', 'session_consumed', 'executor_started'],
  );
  assert.equal(await h.receipts.get('CH-1', 'verified' as never), undefined);

  // 另开一个不种 VR 的 Mission：accept 仍成功，但一个 verified 都不写。
  const h2 = harness();
  const live2 = await start(h2, 'M-novr', 'h-exec-novr');
  await ack(h2, live2, 'CH-1');
  await submitDone(h2, live2);
  const coord2 = await h2.platform.startCoordinatorAttempt('M-novr');
  assert.equal((await review(h2, live2, coord2.attemptId, 'accept')).status, 'accepted');
  const listed = JSON.stringify(await h2.receipts.listByMission('M-novr'));
  assert.equal(diskReceipts(h2, 'M-novr').some((row) => row.layer === 'verified'), false);
  assert.equal(listed.includes('verified'), false);
});

test('② 未覆盖时 accept 被拒且盘上零副作用；reject 可用；重派后旧报告仍在', async () => {
  const h = harness();
  const live = await start(h, 'M-miss', 'h-exec-miss');
  await appendImpact(h, live, 'CH-miss');
  await submitDone(h, live);

  const coord = await h.platform.startCoordinatorAttempt(live.missionId);
  // 起协调者这一跳本身要落盘，所以基线取在它之后：比的是 accept 这一次写没写。
  const before = diskBytes(h);
  assert.ok((await uncovered(h, live, coord.attemptId)).message.includes('CH-miss'));
  assert.equal(diskBytes(h), before, '拒绝必须逐字节不改');
  assert.equal((await h.platform.getMissionView(live.missionId)).workItems[0]!.status, 'submitted');

  assert.equal((await review(h, live, coord.attemptId, 'reject')).status, 'rejected');
  assert.equal(diskReceipts(h, live.missionId).some((row) => row.layer === 'verified'), false);

  // hash 不符同样算没覆盖。
  const h2 = harness();
  const live2 = await start(h2, 'M-hash', 'h-exec-hash');
  await appendImpact(h2, live2, 'CH-hash');
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
  await uncovered(h2, live2, coord2.attemptId);
  assert.equal(diskBytes(h2), before2, 'hash 不符的拒绝也必须逐字节不改');

  // 重派：第一次提交的 impact 仍没被覆盖，第二次 accept 照样被拒；
  // 两次提交与各自的报告都还在，attemptId 不被改写。执行者那一跳还 in_progress，先收尾。
  await h.platform.finishAttempt(live.missionId, live.executorAttemptId, { endedBy: 'structured_submit' }, live.executorClaim);
  await h.platform.dispatchWorkItems(live.missionId, coord.attemptId, [live.workItemId]);
  const claim2 = await claim(h, 'h-exec-2', live);
  const exec2 = await h.platform.startExecutorAttempt(live.missionId, live.workItemId, undefined, claim2);
  const live1b = { ...live, executorAttemptId: exec2.attemptId, executorClaim: claim2 };
  await submitDone(h, live1b);
  await plantReport(h, live, 'VR-old', live.executorAttemptId);
  await plantReport(h, live1b, 'VR-new', exec2.attemptId);
  await uncovered(h, live, coord.attemptId);

  const all = await h.activity.list(live.missionId);
  const pick = (kind: string) => all.filter((row) => row.kind === kind);
  const submittedIds = pick('execution_result.submitted').map((row) => row.attemptId);
  assert.equal(new Set(submittedIds).size, 2, '两次提交的事件都还在');
  assert.ok(submittedIds.includes(live.executorAttemptId) && submittedIds.includes(exec2.attemptId));
  const reported = pick('validation.reported').map((row) => (row.data as Row).submittedAttemptId);
  assert.equal(new Set(reported).size, 2, '两份报告各绑一次提交');
  assert.equal((await h.reports.get('VR-old'))?.attemptId, live.executorAttemptId);
  assert.equal((await h.reports.get('VR-new'))?.attemptId, exec2.attemptId);
  assert.equal(diskReceipts(h, live.missionId).some((row) => row.layer === 'verified'), false);
});
