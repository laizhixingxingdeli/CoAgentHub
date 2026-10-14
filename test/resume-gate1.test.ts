/**
 * GATE1 遗留：advisory 落盘与 park 存档事件。
 *
 * 锁住两件事：
 * 1. validation/report-repository.ts 的 cloneCheck 落盘保留 check.advisory，
 *    重读后与落盘前一致（validationReportsEqual 为 true）。
 * 2. park 经检查点把范围外文件存档时写出 workspace.scope_archived，
 *    entries 含 path/archivePath/tracked/source=unknown；checkpoint 返回 undefined 不抛。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import { Platform } from '../src/application/platform.ts';
import type { MissionContract, ValidationReport, WorkOrder } from '../src/kernel/index.ts';
import type { WorkspaceManager } from '../src/application/workspace.ts';
import {
  InMemoryValidationReportRepository,
  validationReportsEqual,
} from '../src/application/validation/report-repository.ts';

const CONTRACT: MissionContract = {
  intent: '把 X 修好',
  acceptance: ['测试全绿'],
  constraints: ['不加依赖'],
  nonGoals: ['不重构 Y'],
  guardrails: ['不得改 Contract'],
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

const PLAN = {
  findings: '查到了',
  rejectedHypotheses: [],
  decisions: [],
  direction: '这么改',
  risks: [],
};

function makePlatform(workspace?: WorkspaceManager) {
  const clock = new FixedClock();
  const activity = new InMemoryActivityLog(clock);
  const projects = new InMemoryProjectRepository();
  const ids = new SequentialIds();
  const platform = new Platform({
    projects,
    deliveries: new InMemoryDeliveryRepository(clock, ids),
    activity,
    clock,
    ids,
    workspace,
  });
  return { platform, activity, projects };
}

describe('GATE1：advisory 落盘保留', () => {
  test('save 一份 checks[0].advisory===true 的报告，get 回来仍为 true 且结构相等', async () => {
    const repo = new InMemoryValidationReportRepository();
    const report: ValidationReport = {
      id: 'VR-1',
      policyRevision: 1,
      missionId: 'M-1',
      startedAt: '2026-06-01T12:00:00.000Z',
      endedAt: '2026-06-01T12:00:01.000Z',
      passed: true,
      checks: [
        {
          kind: 'diff-size',
          passed: false,
          advisory: true,
          startedAt: '2026-06-01T12:00:00.000Z',
          endedAt: '2026-06-01T12:00:00.500Z',
          summary: 'diff-size 超限，仅提醒',
          diffSize: {
            limits: { maxChangedFiles: 1 },
            used: { changedFiles: 2 },
            unknown: [],
          },
        },
      ],
    };

    await repo.save(report);
    const got = await repo.get('VR-1');
    assert.ok(got);
    assert.equal(got.checks[0]?.advisory, true);
    assert.equal(validationReportsEqual(report, got), true);
  });
});

describe('GATE1：park 存档事件', () => {
  test('checkpoint 返回非空数组时写出 workspace.scope_archived，entries 保留来源与元数据', async () => {
    const calls: string[] = [];
    const workspace = {
      worktreePath: () => '/fake/mission-worktree',
      checkpoint: async (
        _cwd: string,
        _missionId: string,
        _reason: string,
        _paths: string[],
      ) => {
        calls.push('checkpoint');
        return [{ path: 'scratch/x.tmp', archivePath: '/tmp/arch/x.tmp', tracked: false }];
      },
    } as WorkspaceManager;
    const { platform, activity } = makePlatform(workspace);

    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
    const { attemptId: coord } = await platform.startCoordinatorAttempt('M1');
    await platform.updatePlan('M1', coord, PLAN);
    const { workItemId } = await platform.createWorkItem('M1', coord, { title: 'W', order: ORDER });
    await platform.submitContractCheck('M1', coord, { verdict: 'ok', summary: '测试契约已核对' });
    await platform.dispatchWorkItems('M1', coord, [workItemId]);
    const { attemptId: exec } = await platform.startExecutorAttempt('M1', workItemId);
    await platform.submitEvidence('M1', exec, {
      kind: 'test',
      summary: 'passed',
      command: 'node --test',
      exitCode: 0,
    });
    await platform.submitExecutionResult('M1', exec, {
      outcome: 'completed',
      summary: 'done',
      changedFiles: ['src/foo.ts'],
      evidenceIds: [],
      notes: 'none',
    });
    await platform.reviewExecutionResult('M1', coord, {
      workItemId,
      verdict: 'accept',
      acceptanceResults: ORDER.acceptance.map((criterion) => ({
        criterion,
        status: 'pass' as const,
        evidence: 'verified',
      })),
      reasons: ['ok'],
      requiredChanges: [],
    });
    await platform.recordWorkspace('M1', {
      projectRoot: '/fake/project',
      branch: 'mission/M1',
      targetBranch: 'main',
      baseRevision: 'base',
    });

    await platform.parkMission('M1', { reason: '等答复', reviewer: 'L3' });
    assert.deepEqual(calls, ['checkpoint']);
    assert.equal((await platform.getMissionView('M1')).parked, true);

    const archived = (await activity.list('M1')).filter(
      (event) => event.kind === 'workspace.scope_archived',
    );
    assert.equal(archived.length, 1);
    const entries = (archived[0]?.data as { entries: Array<Record<string, unknown>> }).entries;
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.path, 'scratch/x.tmp');
    assert.equal(entries[0]?.archivePath, '/tmp/arch/x.tmp');
    assert.equal(entries[0]?.tracked, false);
    assert.equal(entries[0]?.source, 'unknown');
  });

  test('checkpoint 返回 undefined 时不写存档事件也不抛', async () => {
    const workspace = {
      worktreePath: () => '/fake/mission-worktree',
      checkpoint: async () => undefined,
    } as WorkspaceManager;
    const { platform, activity } = makePlatform(workspace);

    await platform.createMission({ projectId: 'P', missionId: 'M2', contract: CONTRACT });
    const { attemptId: coord } = await platform.startCoordinatorAttempt('M2');
    await platform.updatePlan('M2', coord, PLAN);
    const { workItemId } = await platform.createWorkItem('M2', coord, { title: 'W', order: ORDER });
    await platform.submitContractCheck('M2', coord, { verdict: 'ok', summary: '测试契约已核对' });
    await platform.dispatchWorkItems('M2', coord, [workItemId]);
    const { attemptId: exec } = await platform.startExecutorAttempt('M2', workItemId);
    await platform.submitEvidence('M2', exec, {
      kind: 'test',
      summary: 'passed',
      command: 'node --test',
      exitCode: 0,
    });
    await platform.submitExecutionResult('M2', exec, {
      outcome: 'completed',
      summary: 'done',
      changedFiles: ['src/foo.ts'],
      evidenceIds: [],
      notes: 'none',
    });
    await platform.reviewExecutionResult('M2', coord, {
      workItemId,
      verdict: 'accept',
      acceptanceResults: ORDER.acceptance.map((criterion) => ({
        criterion,
        status: 'pass' as const,
        evidence: 'verified',
      })),
      reasons: ['ok'],
      requiredChanges: [],
    });
    await platform.recordWorkspace('M2', {
      projectRoot: '/fake/project',
      branch: 'mission/M2',
      targetBranch: 'main',
      baseRevision: 'base',
    });

    await platform.parkMission('M2', { reason: '等答复', reviewer: 'L3' });
    assert.equal((await platform.getMissionView('M2')).parked, true);
    const archived = (await activity.list('M2')).filter(
      (event) => event.kind === 'workspace.scope_archived',
    );
    assert.equal(archived.length, 0);
  });
});
