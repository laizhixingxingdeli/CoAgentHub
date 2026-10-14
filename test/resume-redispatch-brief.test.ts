/**
 * W-653：
 *   1. 结构性验证失败（invalid_argv / unsupported_scope）不自动续派，直接交协调者。
 *   2. 契约在规划阶段再次修订后，简报 / l3SendBackReasons 里的打回理由显示当前修订号，
 *      不再保留写下时烤死的旧 r 号。
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
import type { PlatformContext, PlatformValidationDeps } from '../src/application/platform.ts';
import type {
  ActivityEvent,
  Mission,
  MissionContract,
  ValidationCheckResult,
  ValidationReport,
  WorkItem,
  WorkOrder,
} from '../src/kernel/index.ts';
import { standardAutoRedispatchReason } from '../src/application/platform/standard-redispatch.ts';

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

function makePlatform() {
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
  });
  return { platform, activity, projects };
}

/** 一份最小合法的失败报告：只有 checks 里的 failureCode 决定结构性缺陷。 */
function makeReport(input: {
  id: string;
  missionId: string;
  workItemId: string;
  attemptId: string;
  failureCode?: ValidationCheckResult['failureCode'];
  passed?: boolean;
}): ValidationReport {
  const check: ValidationCheckResult = {
    kind: 'command',
    passed: false,
    startedAt: '2026-06-01T12:00:00.000Z',
    endedAt: '2026-06-01T12:00:01.000Z',
    summary: '命令失败',
    ...(input.failureCode !== undefined ? { failureCode: input.failureCode } : {}),
  };
  return {
    id: input.id,
    policyRevision: 1,
    missionId: input.missionId,
    workItemId: input.workItemId,
    attemptId: input.attemptId,
    startedAt: '2026-06-01T12:00:00.000Z',
    endedAt: '2026-06-01T12:00:01.000Z',
    passed: input.passed ?? false,
    checks: [check],
  };
}

describe('结构性验证失败不自动续派', () => {
  test('invalid_argv / unsupported_scope 返回 undefined；普通失败仍返回 validation_failed', async () => {
    const clock = new FixedClock();
    const activity = new InMemoryActivityLog(clock);
    const projects = new InMemoryProjectRepository();
    const ids = new SequentialIds();
    const reportsById = new Map<string, ValidationReport>();

    // 真 kernel 聚合：item.executionResult / submittedAttemptId / id 都走真对象。
    const project = await projects.ensure('P');
    const mission: Mission = project.createMission({ id: 'M-1', contract: CONTRACT });
    const item: WorkItem = mission.createWorkItem({ id: 'W-1', title: '改 foo', order: ORDER });
    const attemptId = 'A';
    item.dispatch();
    item.submit({ outcome: 'completed', summary: 'done' }, attemptId);

    await activity.append({
      projectId: 'P',
      missionId: 'M-1',
      workItemId: item.id,
      kind: 'validation.reported',
      data: { reportId: 'VR', submittedAttemptId: attemptId },
      protocolVersion: 'cdp/1',
      messageId: 'm-1',
      correlationId: 'M-1',
      contractRevision: mission.contractRevision,
      planRevision: mission.planRevision,
    } as Omit<ActivityEvent, 'at'>);

    const validation: PlatformValidationDeps = {
      reports: {
        async save() {
          // no-op
        },
        async get(reportId: string) {
          return reportsById.get(reportId);
        },
      },
      // 本测试不跑机器验收，engine 占位即可（不会被调用）。
      engine: {
        validate: async () => {
          throw new Error('不该走到 engine');
        },
      },
    } as unknown as PlatformValidationDeps;

    const ctx = {
      projects,
      activity,
      ids,
      clock,
      validation,
    } as unknown as PlatformContext;

    reportsById.set(
      'VR',
      makeReport({
        id: 'VR',
        missionId: 'M-1',
        workItemId: 'W-1',
        attemptId,
        failureCode: 'invalid_argv',
      }),
    );
    assert.equal(
      await standardAutoRedispatchReason(ctx, mission, item, attemptId),
      undefined,
      'invalid_argv 不得自动续派',
    );

    reportsById.set(
      'VR',
      makeReport({
        id: 'VR',
        missionId: 'M-1',
        workItemId: 'W-1',
        attemptId,
        failureCode: 'unsupported_scope',
      }),
    );
    assert.equal(
      await standardAutoRedispatchReason(ctx, mission, item, attemptId),
      undefined,
      'unsupported_scope 不得自动续派',
    );

    reportsById.set(
      'VR',
      makeReport({ id: 'VR', missionId: 'M-1', workItemId: 'W-1', attemptId }),
    );
    const plain = await standardAutoRedispatchReason(ctx, mission, item, attemptId);
    assert.equal(plain?.reason, 'validation_failed', '普通失败仍自动续派');
  });
});

describe('契约在规划阶段再次修订后简报显示当前修订号', () => {
  test('finalReview.reasons 与 contextBundle final_review 都用当前 contractRevision', async () => {
    const { platform } = makePlatform();
    await platform.createMission({ projectId: 'P', missionId: 'M-1', contract: CONTRACT });
    const { attemptId: coord1 } = await platform.startCoordinatorAttempt('M-1');
    await platform.updatePlan('M-1', coord1, PLAN);
    const { workItemId } = await platform.createWorkItem('M-1', coord1, { title: 'W', order: ORDER });
    await platform.submitContractCheck('M-1', coord1, { verdict: 'ok', summary: '核过' });
    await platform.dispatchWorkItems('M-1', coord1, [workItemId]);

    // 第一次修订：Mission 在 executing，reviseContract 会退回 planning 并写 r2 打回理由。
    const r1 = await platform.reviseContract('M-1', { ...CONTRACT, intent: '把 X 修好 v2' });
    assert.equal(r1.contractRevision, 2);

    // 第二次修订：此时 Mission 已是 planning，reviseContract 不再写新 finalReview，
    // 旧的打回理由仍停在 r2，而契约走到 r3。
    const r2 = await platform.reviseContract('M-1', { ...CONTRACT, intent: '把 X 修好 v3' });
    assert.equal(r2.contractRevision, 3);
    assert.notEqual(r1.contractRevision, r2.contractRevision);

    // 收掉第一跳协调者，才能开新的一跳。
    await platform.finishAttempt('M-1', coord1, { endedBy: 'structured_submit' });
    const { attemptId: coord2 } = await platform.startCoordinatorAttempt('M-1');
    const brief = await platform.getStartupBrief('M-1', coord2);

    assert.equal(brief.contractRevision, r2.contractRevision);
    const reasons = brief.finalReview?.reasons ?? [];
    assert.equal(reasons.length, 1);
    assert.match(reasons[0]!, new RegExp(`Contract 已更新到 r${r2.contractRevision}`));
    assert.doesNotMatch(reasons[0]!, /Contract 已更新到 r2(?!\d)/);

    const bundleEntry = brief.contextBundle.entries.find((e) => e.source === 'final_review');
    assert.ok(bundleEntry, 'contextBundle 应有 final_review 条目');
    const bundleReasons = (bundleEntry.content as { reasons?: string[] }).reasons ?? [];
    assert.match(bundleReasons[0]!, new RegExp(`Contract 已更新到 r${r2.contractRevision}`));
    assert.doesNotMatch(bundleReasons[0]!, /Contract 已更新到 r2(?!\d)/);
  });
});
