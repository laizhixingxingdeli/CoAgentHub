/**
 * W-497：accept 门禁的并列判定 —— 快照覆盖（ChangeCoverage）与回执等价。
 *
 * 为什么要有第二条路径：重派之后新执行者拿到的工单正文里已经写进了那条变更，
 * 它读不到旧 tutorial 的差异，也就无从 ack 出一张 executor_started。只有回执能过
 * 门禁，等于逼每一次重派都补一张没人写得出的回执。
 *
 * 为什么必须钉 coverageSource：verified 回执会被当证据引用，看事件的人要能分清
 * 它依据的是「执行者说照这份 diff 跑过」还是「协调者说这份正文里已经有了」。
 * 混成一种，coverage 就会被当成「已验证」用。
 *
 * ① 重派后 coverage 覆盖：accept 通过并写出带 coverageSource 的 verified。
 * ② 没有匹配 coverage 时仍拒、盘上一个字节不变；未装配同样拒。
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
import { FileChangeCoverageRepository } from '../src/application/change-coverage-repository.ts';
import { workOrderContentHash } from '../src/application/change-receipt.ts';
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
const PASS: readonly AcceptanceResult[] = [{ criterion: 'foo() === 1', status: 'pass', evidence: '核过' }];
const FAIL: readonly AcceptanceResult[] = [{ criterion: 'foo() === 1', status: 'fail', evidence: '还差重派' }];

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** coverages=false 就是不装配覆盖仓储的那一种平台：门禁必须与 B4 完全一致。 */
function harness(coverages = true) {
  const dir = mkdtempSync(join(tmpdir(), 'coverage-review-'));
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
    ...(coverages ? { changeCoverages: new FileChangeCoverageRepository(store) } : {}),
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

/** 投一条 compatible 差异，但**不 ack**：这条变更只可能在下一轮正文里被覆盖。 */
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
    requiredChanges: verdict === 'reject' ? ['补进下一轮正文'] : [],
    acceptanceResults: verdict === 'reject' ? FAIL : PASS,
  });
}

interface Row {
  readonly [key: string]: string | number | undefined;
}

function diskReceipts(h: H, missionId: string): Row[] {
  const state = JSON.parse(diskBytes(h)) as { changeReceipts?: Row[] };
  return (state.changeReceipts ?? []).filter((row) => row.missionId === missionId);
}

function diskBytes(h: H): string {
  return readFileSync(h.statePath, 'utf8');
}

test('① 重派后 coverage 覆盖：accept 通过并写出 coverage 来源的 verified', async () => {
  const h = harness();
  const live = await start(h);
  await appendImpact(h, live, 'CH-1');
  await submitDone(h, live);

  // 打回 → 修订工单：正文里写进那条变更，这才是「覆盖」这一支的场景。
  const coord = await h.platform.startCoordinatorAttempt(live.missionId);
  assert.equal((await review(h, live, coord.attemptId, 'reject')).status, 'rejected');
  const revised = await h.platform.reviseWorkOrder(live.missionId, coord.attemptId, live.workItemId, {
    ...ORDER,
    objective: '改 foo v2',
  });
  assert.equal(revised.revision, 'r2', 'kernel 应从 r1 递增，调用方不填修订号');

  // 覆盖按修订后的那一轮记：轮次与正文哈希都要对上当前工单。
  const view = await h.platform.getMissionView(live.missionId);
  const revisedOrder = view.workItems.find((row) => row.id === live.workItemId)!.order!;
  assert.equal(revisedOrder.orderRevision, 'r2');
  await h.platform.recordChangeCoverage(live.missionId, coord.attemptId, live.workItemId, {
    changeId: 'CH-1',
    orderRevision: revisedOrder.orderRevision!,
    workOrderHash: workOrderContentHash(revisedOrder),
  });

  // 新执行者照新正文跑并交卷：不给他写任何回执，他就是读不到那份旧差异。
  await h.platform.finishAttempt(live.missionId, live.executorAttemptId, { endedBy: 'structured_submit' }, live.executorClaim);
  await h.platform.dispatchWorkItems(live.missionId, coord.attemptId, [live.workItemId]);
  const claim2 = await claim(h, 'h-exec-2', live);
  const exec2 = await h.platform.startExecutorAttempt(live.missionId, live.workItemId, undefined, claim2);
  const live2 = { ...live, executorAttemptId: exec2.attemptId, executorClaim: claim2 };
  await submitDone(h, live2);
  await plantReport(h, live2, 'VR-new', exec2.attemptId);

  assert.equal((await review(h, live2, coord.attemptId, 'accept')).status, 'accepted');

  const rows = diskReceipts(h, live.missionId);
  const verified = rows.find((row) => row.layer === 'verified');
  assert.ok(verified, 'coverage 命中时应写出 verified');
  assert.deepEqual(
    { changeId: verified.changeId, attemptId: verified.attemptId },
    { changeId: 'CH-1', attemptId: exec2.attemptId },
    'verified 记的是本次提交，不是当初那条 impact 的尝试',
  );
  assert.equal(verified.claimGeneration, 1, 'claimGeneration 取这条 impact 自己的代次');

  const all = await h.activity.list(live.missionId);
  const recorded = all.find(
    (row) => row.kind === 'change.receipt_recorded' && (row.data as Row).layer === 'verified',
  );
  assert.ok(recorded, '应有 change.receipt_recorded 的 verified 事件');
  assert.equal((recorded.data as Row).coverageSource, 'coverage');
  const text = JSON.stringify(recorded.data);
  assert.equal(text.includes('已应用'), false, '覆盖不是「已应用」');
  assert.equal(text.includes('已验证'), false, '覆盖不是「已验证」');
});

test('② 没有匹配 coverage 时仍拒且盘上零副作用；未装配覆盖仓储时同样拒', async () => {
  const h = harness();
  const live = await start(h, 'M-miss', 'h-exec-miss');
  await appendImpact(h, live, 'CH-miss');
  await submitDone(h, live);
  const coord = await h.platform.startCoordinatorAttempt(live.missionId);
  const before = diskBytes(h);
  const err = await review(h, live, coord.attemptId, 'accept').then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.ok(err instanceof PlatformRuleError, '无匹配 coverage 时 accept 必须抛 PlatformRuleError');
  assert.equal(err.code, 'ACCEPT_CHANGES_UNCOVERED');
  assert.equal(diskBytes(h), before, '拒绝必须逐字节不改');
  assert.equal(diskReceipts(h, live.missionId).some((row) => row.layer === 'verified'), false);

  // 未装配 changeCoverages：门禁口径与 B4 一致，不把「没记录」当成已覆盖。
  const h2 = harness(false);
  const live2 = await start(h2, 'M-nostore', 'h-exec-nostore');
  await appendImpact(h2, live2, 'CH-nostore');
  await submitDone(h2, live2);
  const coord2 = await h2.platform.startCoordinatorAttempt(live2.missionId);
  const err2 = await review(h2, live2, coord2.attemptId, 'accept').then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.ok(err2 instanceof PlatformRuleError, '未装配覆盖仓储时 accept 必须抛 PlatformRuleError');
  assert.equal(err2.code, 'ACCEPT_CHANGES_UNCOVERED');
  assert.ok(err2.message.includes('CH-nostore'));
});
