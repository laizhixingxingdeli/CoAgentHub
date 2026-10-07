import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MissionContract, ValidationReport, WorkOrder } from '../src/kernel/index.ts';
import { FixedClock } from '../src/application/in-memory.ts';
import {
  FileActivityLog,
  FileDeliveryRepository,
  FileProjectRepository,
  FileStateStore,
  FileValidationReportRepository,
  PersistentIds,
} from '../src/application/file-store.ts';
import { FileChangeImpactRepository } from '../src/application/change-impact-repository.ts';
import { FileContractHistoryRepository } from '../src/application/contract-history-repository.ts';
import { FileAcceptanceDispositionRepository } from '../src/application/acceptance-disposition-repository.ts';
import { validationReportedData } from '../src/application/platform/standard-validation.ts';
import { Platform } from '../src/application/platform.ts';
import { PlatformRuleError } from '../src/application/platform/context.ts';

const NOW = '2026-01-01T00:00:00.000Z';
const CONTRACT: MissionContract = {
  intent: '把 X 修好',
  acceptance: ['旧口径', '另一条'],
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
  criteria: [1],
  validation: {
    commands: [{ argv: ['node', '--test'], timeoutMs: 5000 }],
  },
};

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function harness(gate = false) {
  const dir = mkdtempSync(join(tmpdir(), 'acceptance-disposition-gate-'));
  dirs.push(dir);
  const statePath = join(dir, 'state.json');
  const store = new FileStateStore(statePath);
  const clock = new FixedClock(NOW);
  const ids = new PersistentIds(store);
  const activity = new FileActivityLog(store, clock);
  const impacts = new FileChangeImpactRepository(store);
  const contractHistories = new FileContractHistoryRepository(store);
  const acceptanceDispositions = new FileAcceptanceDispositionRepository(store);
  const reports = new FileValidationReportRepository(store);
  const platform = new Platform({
    projects: new FileProjectRepository(store),
    deliveries: new FileDeliveryRepository(store, clock, ids),
    activity,
    clock,
    ids,
    transaction: store,
    contractHistories,
    changeImpacts: impacts,
    acceptanceDispositions,
    acceptanceEvidenceGate: gate,
    validation: {
      engine: {
        validate: async () => {
          throw new Error('unused');
        },
      },
      reports,
    },
  });
  return {
    statePath,
    clock,
    platform,
    activity,
    impacts,
    contractHistories,
    acceptanceDispositions,
    reports,
  };
}

function makeReport(missionId: string, workItemId: string, attemptId: string): ValidationReport {
  return {
    id: 'VR-1',
    policyRevision: 1,
    missionId,
    workItemId,
    attemptId,
    startedAt: NOW,
    endedAt: '2026-01-01T00:00:01.000Z',
    passed: true,
    checks: [
      {
        kind: 'command',
        passed: true,
        startedAt: NOW,
        endedAt: '2026-01-01T00:00:01.000Z',
        summary: 'ok',
        command: {
          argv: ['node', '--test'],
          cwd: '/w',
          exitCode: 0,
          timedOut: false,
          durationMs: 12,
          outputTail: '',
        },
      },
      {
        kind: 'changed-paths',
        passed: true,
        startedAt: NOW,
        endedAt: '2026-01-01T00:00:01.000Z',
        summary: 'ok',
        changedPaths: {
          allowedScope: ['src/foo.ts'],
          actual: ['src/foo.ts'],
          violations: [],
          unsupportedScope: [],
        },
      },
    ],
  };
}

test('测试一：gate=true，原文改过无处置交卷被拒且字节不变，补上 revalidate 后成功', async () => {
  const h = harness(true);
  const missionId = 'M-1';
  await h.platform.createMission({
    projectId: 'P',
    missionId,
    contract: CONTRACT,
    origin: { clientType: 'cli', conversationRef: 'me' },
  });
  const coord = await h.platform.startCoordinatorAttempt(missionId);
  await h.platform.updatePlan(missionId, coord.attemptId, PLAN);
  await h.platform.submitContractCheck(missionId, coord.attemptId, { verdict: 'ok', summary: '核过' });

  // reviseContract 改成 ['新口径', '另一条']
  await h.platform.reviseContract(missionId, {
    intent: '把 X 修好',
    acceptance: ['新口径', '另一条'],
    constraints: [],
    nonGoals: [],
    guardrails: [],
  });

  const stateBytesBefore = readFileSync(h.statePath);
  const submitBody = {
    outcome: 'delivered' as const,
    summary: '交卷',
    acceptanceEvidence: [],
    memoryDelta: [],
    openRisks: [],
    criteria: [
      { index: 1, status: 'pass' as const, evidence: '通过1' },
      { index: 2, status: 'pass' as const, evidence: '通过2' },
    ],
  };

  await assert.rejects(
    () => h.platform.submitMissionResult(missionId, coord.attemptId, submitBody),
    (err: unknown) => {
      assert(err instanceof PlatformRuleError);
      assert.equal(err.code, 'ACCEPTANCE_EVIDENCE_REQUIRED');
      assert(err.message.includes('处置：1'));
      assert(!err.message.includes('2'));
      return true;
    },
  );

  const stateBytesAfter = readFileSync(h.statePath);
  assert.deepEqual(stateBytesAfter, stateBytesBefore);

  // createWorkItem，order 为带 criteria:[1] 的 ORDER
  const { workItemId } = await h.platform.createWorkItem(missionId, coord.attemptId, {
    title: 'W-1',
    order: ORDER,
  });

  // clock.advance(10_000) 之后再 save 报告并 append validation.reported 和 execution_result.submitted，attemptId 用 'AT-9'
  h.clock.advance(10_000);
  const report = makeReport(missionId, workItemId, 'AT-9');
  await h.reports.save(report);
  await h.activity.append({
    missionId,
    workItemId,
    attemptId: 'AT-9',
    kind: 'validation.reported',
    data: validationReportedData(report, 'AT-9', ORDER),
  });
  await h.activity.append({
    missionId,
    workItemId,
    attemptId: 'AT-9',
    kind: 'execution_result.submitted',
    data: { outcome: 'delivered' },
  });

  // recordAcceptanceDisposition，decision:'revalidate'，index:1，basis 含 submittedAttemptId/reportId/note
  await h.platform.recordAcceptanceDisposition(missionId, coord.attemptId, {
    dispositionId: 'D-reval-1',
    index: 1,
    decision: 'revalidate',
    workItemIds: [workItemId],
    basis: {
      submittedAttemptId: 'AT-9',
      reportId: report.id,
      note: '新证据覆盖',
    },
  });

  // retireWorkItem
  await h.platform.retireWorkItem(missionId, workItemId, '已处置并通过');

  // 再 submit 两条 pass，不抛，getMissionView 的 status 为 awaiting_review
  await h.platform.submitMissionResult(missionId, coord.attemptId, submitBody);
  const view = await h.platform.getMissionView(missionId);
  assert.equal(view.status, 'awaiting_review');
});

test('测试二：gate=false 的同一修订无处置 pass 成功；gate=true 时 not_applicable 条目不要求处置', async () => {
  // gate=false 的同一修订、无处置、两条 pass，submit 成功且 status 为 awaiting_review
  const hFalse = harness(false);
  const mFalseId = 'M-false';
  await hFalse.platform.createMission({
    projectId: 'P',
    missionId: mFalseId,
    contract: CONTRACT,
    origin: { clientType: 'cli', conversationRef: 'me' },
  });
  const coordFalse = await hFalse.platform.startCoordinatorAttempt(mFalseId);
  await hFalse.platform.updatePlan(mFalseId, coordFalse.attemptId, PLAN);
  await hFalse.platform.submitContractCheck(mFalseId, coordFalse.attemptId, { verdict: 'ok', summary: '核过' });
  await hFalse.platform.reviseContract(mFalseId, {
    intent: '把 X 修好',
    acceptance: ['新口径', '另一条'],
    constraints: [],
    nonGoals: [],
    guardrails: [],
  });

  const submitPass = {
    outcome: 'delivered' as const,
    summary: '交卷',
    acceptanceEvidence: [],
    memoryDelta: [],
    openRisks: [],
    criteria: [
      { index: 1, status: 'pass' as const, evidence: '证据1' },
      { index: 2, status: 'pass' as const, evidence: '证据2' },
    ],
  };

  await hFalse.platform.submitMissionResult(mFalseId, coordFalse.attemptId, submitPass);
  const viewFalse = await hFalse.platform.getMissionView(mFalseId);
  assert.equal(viewFalse.status, 'awaiting_review');

  // 另一个 gate=true 的 Mission，index 1 为 not_applicable 且 evidence 为 '不适用'，index 2 为 pass，无处置，submit 成功
  const hTrue = harness(true);
  const mTrueId = 'M-true';
  await hTrue.platform.createMission({
    projectId: 'P',
    missionId: mTrueId,
    contract: CONTRACT,
    origin: { clientType: 'cli', conversationRef: 'me' },
  });
  const coordTrue = await hTrue.platform.startCoordinatorAttempt(mTrueId);
  await hTrue.platform.updatePlan(mTrueId, coordTrue.attemptId, PLAN);
  await hTrue.platform.submitContractCheck(mTrueId, coordTrue.attemptId, { verdict: 'ok', summary: '核过' });
  await hTrue.platform.reviseContract(mTrueId, {
    intent: '把 X 修好',
    acceptance: ['新口径', '另一条'],
    constraints: [],
    nonGoals: [],
    guardrails: [],
  });

  const submitWithNA = {
    outcome: 'delivered' as const,
    summary: '交卷',
    acceptanceEvidence: [],
    memoryDelta: [],
    openRisks: [],
    criteria: [
      { index: 1, status: 'not_applicable' as const, evidence: '不适用' },
      { index: 2, status: 'pass' as const, evidence: '证据2' },
    ],
  };

  await hTrue.platform.submitMissionResult(mTrueId, coordTrue.attemptId, submitWithNA);
  const viewTrue = await hTrue.platform.getMissionView(mTrueId);
  assert.equal(viewTrue.status, 'awaiting_review');
});
