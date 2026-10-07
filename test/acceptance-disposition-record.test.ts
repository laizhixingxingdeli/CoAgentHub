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
import { buildPlatform } from '../src/main.ts';
import { PlatformRuleError } from '../src/application/platform/context.ts';

const NOW = '2026-01-01T00:00:00.000Z';
const CONTRACT: MissionContract = {
  intent: '把 X 修好',
  acceptance: ['旧口径'],
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

function harness(withAll = true) {
  const dir = mkdtempSync(join(tmpdir(), 'acceptance-disposition-'));
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
    ...(withAll
      ? {
          contractHistories,
          changeImpacts: impacts,
          acceptanceDispositions,
          validation: {
            engine: {
              validate: async () => {
                throw new Error('unused');
              },
            },
            reports,
          },
        }
      : {}),
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

test('测试一：reuse 写入当前修订处置并只发一次事件；同内容重试不新增', async () => {
  const h = harness();
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
  const { workItemId } = await h.platform.createWorkItem(missionId, coord.attemptId, {
    title: 'W',
    order: ORDER,
  });

  const report = makeReport(missionId, workItemId, 'AT-1');
  await h.reports.save(report);
  await h.activity.append({
    missionId,
    workItemId,
    attemptId: 'AT-1',
    kind: 'validation.reported',
    data: validationReportedData(report, 'AT-1', ORDER),
  });

  const body = {
    dispositionId: 'D-1',
    index: 1,
    decision: 'reuse',
    workItemIds: [workItemId],
    basis: {
      priorContractRevision: 1,
      submittedAttemptId: 'AT-1',
      reportId: report.id,
      note: '原文未变',
    },
  };

  const recorded = await h.platform.recordAcceptanceDisposition(missionId, coord.attemptId, body);
  assert.equal(recorded.contractRevision, 1);
  assert.equal(recorded.coordinatorAttemptId, coord.attemptId);

  const list = await h.acceptanceDispositions.listByMission(missionId);
  assert.equal(list.length, 1);

  const events = (await h.activity.list(missionId)).filter(
    (e) => e.kind === 'acceptance.disposition_recorded',
  );
  assert.equal(events.length, 1);
  assert.equal((events[0]!.data as { decision: string }).decision, 'reuse');

  // 再调一次：同内容重试不新增
  const retried = await h.platform.recordAcceptanceDisposition(missionId, coord.attemptId, body);
  assert.equal(retried.dispositionId, 'D-1');

  const listAfterRetry = await h.acceptanceDispositions.listByMission(missionId);
  assert.equal(listAfterRetry.length, 1);

  const eventsAfterRetry = (await h.activity.list(missionId)).filter(
    (e) => e.kind === 'acceptance.disposition_recorded',
  );
  assert.equal(eventsAfterRetry.length, 1);
});

test('测试二：工单没写 criteria / 命令不等被拒且字节不变；未装配抛 UNSUPPORTED；原文已改后旧报告 revalidate 被拒', async () => {
  const h = harness();
  const missionId = 'M-2';
  await h.platform.createMission({
    projectId: 'P',
    missionId,
    contract: CONTRACT,
    origin: { clientType: 'cli', conversationRef: 'me' },
  });
  const coord = await h.platform.startCoordinatorAttempt(missionId);
  await h.platform.updatePlan(missionId, coord.attemptId, PLAN);
  await h.platform.submitContractCheck(missionId, coord.attemptId, { verdict: 'ok', summary: '核过' });

  // 1. 先建一个不写 criteria 的工单
  const orderWithoutCriteria: WorkOrder = {
    objective: '改 bar',
    allowedScope: ['src/bar.ts'],
    requiredBehaviour: 'bar 返回 1',
    constraints: [],
    acceptance: ['bar() === 1'],
    verification: ['node --test'],
    doNot: [],
    contextRefs: [],
  };
  const { workItemId: itemWithoutCriteria } = await h.platform.createWorkItem(missionId, coord.attemptId, {
    title: 'W-no-criteria',
    order: orderWithoutCriteria,
  });

  const stateBefore1 = readFileSync(h.statePath);
  await assert.rejects(
    () =>
      h.platform.recordAcceptanceDisposition(missionId, coord.attemptId, {
        dispositionId: 'D-rej-1',
        index: 1,
        decision: 'reuse',
        workItemIds: [itemWithoutCriteria],
        basis: {
          priorContractRevision: 1,
          submittedAttemptId: 'AT-1',
          reportId: 'VR-1',
          note: '原文未变',
        },
      }),
    (err: unknown) => {
      assert.ok(err instanceof PlatformRuleError);
      assert.equal(err.code, 'ACCEPTANCE_DISPOSITION_REJECTED');
      return true;
    },
  );
  const stateAfter1 = readFileSync(h.statePath);
  assert.deepEqual(stateBefore1, stateAfter1);
  assert.deepEqual(await h.acceptanceDispositions.listByMission(missionId), []);

  // 2. 再对带 criteria 的工单把事件 commands timeoutMs 改成 1，同样 REJECTED 且字节不变
  const { workItemId: itemWithCriteria } = await h.platform.createWorkItem(missionId, coord.attemptId, {
    title: 'W-with-criteria',
    order: ORDER,
  });
  const report2 = makeReport(missionId, itemWithCriteria, 'AT-2');
  report2.id = 'VR-2';
  await h.reports.save(report2);
  await h.activity.append({
    missionId,
    workItemId: itemWithCriteria,
    attemptId: 'AT-2',
    kind: 'validation.reported',
    data: {
      ...validationReportedData(report2, 'AT-2', ORDER),
      commands: [{ argv: ['node', '--test'], timeoutMs: 1 }], // timeoutMs 改成 1
    },
  });

  const stateBefore2 = readFileSync(h.statePath);
  await assert.rejects(
    () =>
      h.platform.recordAcceptanceDisposition(missionId, coord.attemptId, {
        dispositionId: 'D-rej-2',
        index: 1,
        decision: 'reuse',
        workItemIds: [itemWithCriteria],
        basis: {
          priorContractRevision: 1,
          submittedAttemptId: 'AT-2',
          reportId: report2.id,
          note: '原文未变',
        },
      }),
    (err: unknown) => {
      assert.ok(err instanceof PlatformRuleError);
      assert.equal(err.code, 'ACCEPTANCE_DISPOSITION_REJECTED');
      return true;
    },
  );
  const stateAfter2 = readFileSync(h.statePath);
  assert.deepEqual(stateBefore2, stateAfter2);
  assert.deepEqual(await h.acceptanceDispositions.listByMission(missionId), []);

  // 3. buildPlatform() 不装仓储，createMission + startCoordinatorAttempt 后调用，code 为 ACCEPTANCE_DISPOSITION_UNSUPPORTED
  const unmounted = buildPlatform();
  const { missionId: unmountedMissionId } = await unmounted.platform.createMission({
    projectId: 'P-unmounted',
    contract: CONTRACT,
  });
  const unmountedCoord = await unmounted.platform.startCoordinatorAttempt(unmountedMissionId);
  await assert.rejects(
    () =>
      unmounted.platform.recordAcceptanceDisposition(unmountedMissionId, unmountedCoord.attemptId, {
        dispositionId: 'D-unsupported',
        index: 1,
        decision: 'reuse',
        workItemIds: ['W-any'],
        basis: {
          priorContractRevision: 1,
          submittedAttemptId: 'AT-1',
          reportId: 'VR-1',
          note: '原文未变',
        },
      }),
    (err: unknown) => {
      assert.ok(err instanceof PlatformRuleError);
      assert.equal(err.code, 'ACCEPTANCE_DISPOSITION_UNSUPPORTED');
      return true;
    },
  );

  // 4. 另用 FixedClock.advance：先 append 报告和 execution_result.submitted，再 advance，
  //    再 reviseContract 把 acceptance 改成 ['新口径']，对旧报告记 revalidate，必须 REJECTED 且没有处置行。
  const report3 = makeReport(missionId, itemWithCriteria, 'AT-3');
  report3.id = 'VR-3';
  await h.reports.save(report3);
  await h.activity.append({
    missionId,
    workItemId: itemWithCriteria,
    attemptId: 'AT-3',
    kind: 'validation.reported',
    data: validationReportedData(report3, 'AT-3', ORDER),
  });
  await h.activity.append({
    missionId,
    workItemId: itemWithCriteria,
    attemptId: 'AT-3',
    kind: 'execution_result.submitted',
    data: {},
  });

  h.clock.advance(10_000);
  await h.platform.reviseContract(missionId, {
    ...CONTRACT,
    acceptance: ['新口径'],
  });

  await assert.rejects(
    () =>
      h.platform.recordAcceptanceDisposition(missionId, coord.attemptId, {
        dispositionId: 'D-rej-3',
        index: 1,
        decision: 'revalidate',
        workItemIds: [itemWithCriteria],
        basis: {
          submittedAttemptId: 'AT-3',
          reportId: report3.id,
          note: '旧报告不能给新口径做 revalidate',
        },
      }),
    (err: unknown) => {
      assert.ok(err instanceof PlatformRuleError);
      assert.equal(err.code, 'ACCEPTANCE_DISPOSITION_REJECTED');
      return true;
    },
  );
  assert.deepEqual(await h.acceptanceDispositions.listByMission(missionId), []);
});
