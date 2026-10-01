import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FixedClock,
  InMemoryActivityLog,
  InMemoryProjectRepository,
  SequentialIds,
} from '../src/application/in-memory.ts';
import { InMemoryDeliveryRepository } from '../src/application/delivery.ts';
import { Platform, PlatformRuleError } from '../src/application/platform.ts';
import type { MissionContract, WorkOrder } from '../src/kernel/index.ts';
import type { WorkspaceManager } from '../src/application/workspace.ts';

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

function makePlatform(workspace?: WorkspaceManager) {
  const clock = new FixedClock();
  const activity = new InMemoryActivityLog(clock);
  const projects = new InMemoryProjectRepository();
  const ids = new SequentialIds();
  const platform = new Platform({ projects, deliveries: new InMemoryDeliveryRepository(clock, ids), activity, clock, ids, workspace });
  return { platform, activity, projects };
}

async function liveWorkItem(
  projects: InMemoryProjectRepository,
  projectId: string,
  missionId: string,
  workItemId: string,
) {
  const project = await projects.get(projectId);
  assert.ok(project);
  const mission = project.missions.find((m) => m.id === missionId);
  assert.ok(mission);
  const item = mission.workItem(workItemId);
  assert.ok(item);
  return item;
}

/** 跑到「W1 已提交、等待验收」这个状态。 */
const PLAN = {
  findings: '查到了',
  rejectedHypotheses: [],
  decisions: [],
  direction: '这么改',
  risks: [],
};

async function upToSubmitted() {
  const { platform, activity } = makePlatform();
  await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
  const { attemptId: coord } = await platform.startCoordinatorAttempt('M1');
  await platform.updatePlan('M1', coord, {
    findings: '查到了',
    rejectedHypotheses: [],
    decisions: [],
    direction: '这么改',
    risks: [],
  });
  const { workItemId } = await platform.createWorkItem('M1', coord, { title: 'W', order: ORDER });
  await platform.dispatchWorkItems('M1', coord, [workItemId]);
  const { attemptId: exec } = await platform.startExecutorAttempt('M1', workItemId);
  // S11.1：completed 必须有证据撑着，平台会拦下没证据的提交。
  await platform.submitEvidence('M1', exec, {
    kind: 'test',
    summary: 'node --test 全绿',
    command: 'node --test',
    exitCode: 0,
  });
  await platform.submitExecutionResult('M1', exec, {
    outcome: 'completed',
    summary: '改好了',
    changedFiles: ['src/foo.ts'],
    evidenceIds: [],
    notes: '无',
  });
  return { platform, activity, coord, exec, workItemId };
}

describe('Mission park', () => {
  test('conflict dispatch barrier freezes old dispatched work items until cleared', async () => {
    const { platform } = makePlatform();
    await platform.createMission({ projectId: 'P', missionId: 'BARRIER', contract: CONTRACT });
    const { attemptId: coord } = await platform.startCoordinatorAttempt('BARRIER');
    await platform.updatePlan('BARRIER', coord, PLAN);
    const oldItem = await platform.createWorkItem('BARRIER', coord, { title: 'old', order: ORDER });
    await platform.dispatchWorkItems('BARRIER', coord, [oldItem.workItemId]);

    assert.deepEqual(await platform.recordConflictDispatchBarrier('BARRIER', ['src/foo.ts']), [oldItem.workItemId]);
    const newItem = await platform.createWorkItem('BARRIER', coord, { title: 'resolution', order: ORDER });
    await platform.dispatchWorkItems('BARRIER', coord, [newItem.workItemId]);
    assert.deepEqual(await platform.recordConflictDispatchBarrier('BARRIER', ['src/foo.ts']), [oldItem.workItemId]);
    assert.deepEqual(await platform.recordConflictDispatchBarrier('BARRIER', []), []);
    const view = await platform.getMissionView('BARRIER');
    assert.equal(view.workItems.find((item) => item.id === oldItem.workItemId)?.status, 'dispatched');
    assert.equal(view.workItems.find((item) => item.id === newItem.workItemId)?.status, 'dispatched');
  });

  test('resume 同一 Mission 前先同步目标 HEAD 并保留已验收成果', async () => {
    const calls: string[] = [];
    let platform: Platform;
    const workspace = {
      worktreePath: () => '/fake/mission-worktree',
      checkpoint: async (_cwd: string, _missionId: string, _reason: string, _paths: string[]) => { calls.push('checkpoint'); },
      syncMissionWithTarget: async () => {
        calls.push('sync');
        assert.equal((await platform.getMissionView('M1')).parked, true);
        return { targetHead: 'new-head', conflictFiles: [] };
      },
    } as WorkspaceManager;
    ({ platform } = makePlatform(workspace));
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
    const { attemptId: coord } = await platform.startCoordinatorAttempt('M1');
    await platform.updatePlan('M1', coord, PLAN);
    const { workItemId } = await platform.createWorkItem('M1', coord, { title: 'W', order: ORDER });
    await platform.dispatchWorkItems('M1', coord, [workItemId]);
    const { attemptId: exec } = await platform.startExecutorAttempt('M1', workItemId);
    await platform.submitEvidence('M1', exec, { kind: 'test', summary: 'passed', command: 'node --test', exitCode: 0 });
    await platform.submitExecutionResult('M1', exec, {
      outcome: 'completed', summary: 'done', changedFiles: ['src/foo.ts'], evidenceIds: [], notes: 'none',
    });
    await platform.reviewExecutionResult('M1', coord, {
      workItemId, verdict: 'accept',
      acceptanceResults: ORDER.acceptance.map((criterion) => ({ criterion, status: 'pass' as const, evidence: 'verified' })),
      reasons: ['ok'], requiredChanges: [],
    });
    await platform.recordWorkspace('M1', {
      projectRoot: '/fake/project', branch: 'mission/M1', targetBranch: 'main', baseRevision: 'old-head',
    });
    const before = await platform.getMissionView('M1');
    const lastReview = before.workItems[0]?.lastReview;
    await platform.parkMission('M1', { reason: 'waiting', reviewer: 'L3' });
    await assert.rejects(
      platform.resumeParkedMission('M1', { reason: 'answered', reviewer: 'L3', answer: 'answer' }),
      (error: unknown) => error instanceof PlatformRuleError && error.code === 'NO_OPEN_ESCALATION',
    );
    assert.deepEqual(calls, ['checkpoint']);
    assert.equal((await platform.getMissionView('M1')).parked, true);
    await platform.resumeParkedMission('M1', { reason: 'answered', reviewer: 'L3' });
    const after = await platform.getMissionView('M1');
    assert.deepEqual(calls, ['checkpoint', 'sync']);
    assert.equal(after.missionId, before.missionId);
    assert.equal(after.status, before.status);
    assert.equal(after.parked, false);
    assert.equal(after.workspaceRef?.baseRevision, 'new-head');
    assert.equal(after.workItems[0]?.id, workItemId);
    assert.equal(after.workItems[0]?.status, 'accepted');
    assert.deepEqual(after.workItems[0]?.lastReview, lastReview);
    assert.deepEqual(after.workItems[0]?.attempts, before.workItems[0]?.attempts);
  });

  test('拒绝空 reason 或 reviewer', async () => {
    const { platform } = makePlatform();
    await platform.createMission({ projectId: 'P', missionId: 'PARK1', contract: CONTRACT });
    await assert.rejects(platform.parkMission('PARK1', { reason: ' ', reviewer: 'L3' }), PlatformRuleError);
    await assert.rejects(platform.parkMission('PARK1', { reason: 'wait', reviewer: ' ' }), PlatformRuleError);
    assert.equal((await platform.getMissionView('PARK1')).parked, false);
  });

  test('挂起释放同项目名额，下一张票可以开跑', async () => {
    const cleanChecks: string[] = [];
    const workspace = {
      worktreePath: () => '/fake/mission-worktree',
      assertMissionWorktreeClean: async (missionId: string) => { cleanChecks.push(missionId); },
    } as WorkspaceManager;
    const { platform } = makePlatform(workspace);
    const prepare = async (missionId: string) => {
      await platform.createMission({ projectId: 'P', missionId, contract: CONTRACT });
      const coord = await platform.startCoordinatorAttempt(missionId);
      await platform.updatePlan(missionId, coord.attemptId, PLAN);
      const item = await platform.createWorkItem(missionId, coord.attemptId, { title: 'W', order: ORDER });
      await platform.dispatchWorkItems(missionId, coord.attemptId, [item.workItemId]);
    };

    await prepare('PARK-FIRST');
    await platform.recordWorkspace('PARK-FIRST', {
      projectRoot: '/fake/project', branch: 'mission/PARK-FIRST', targetBranch: 'main', baseRevision: 'base',
    });
    assert.equal((await platform.getMissionView('PARK-FIRST')).isMutating, true);
    await platform.parkMission('PARK-FIRST', { reason: '等待用户答复', reviewer: 'L3' });
    const parked = await platform.getMissionView('PARK-FIRST');
    assert.equal(parked.parked, true);
    assert.equal(parked.parkReason, '等待用户答复');
    assert.equal(parked.isMutating, false);
    assert.deepEqual(cleanChecks, ['PARK-FIRST']);

    await prepare('PARK-SECOND');
    const second = await platform.getMissionView('PARK-SECOND');
    assert.equal(second.status, 'executing');
    assert.equal(second.isMutating, true);
  });
});

describe('平台规则：能用工具层挡住的，不指望模型记得住', () => {
  test('没有 Plan 就不许创建工作项', async () => {
    const { platform } = makePlatform();
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
    const { attemptId } = await platform.startCoordinatorAttempt('M1');
    await assert.rejects(
      () => platform.createWorkItem('M1', attemptId, { title: 'W', order: ORDER }),
      (e: unknown) => (e as PlatformRuleError).code === 'PLAN_REQUIRED',
    );
  });

  test('还有未验收的工作项时不许交卷', async () => {
    const { platform, coord } = await upToSubmitted();
    await assert.rejects(
      () =>
        platform.submitMissionResult('M1', coord, {
          outcome: 'delivered',
          summary: '交了',
          acceptanceEvidence: [],
          memoryDelta: [],
          openRisks: [],
        }),
      (e: unknown) => (e as PlatformRuleError).code === 'WORK_ITEMS_UNFINISHED',
    );
  });

  test('交不出来时允许以 blocked 交卷', async () => {
    const { platform, coord } = await upToSubmitted();
    await platform.submitMissionResult('M1', coord, {
      outcome: 'blocked',
      summary: '卡住了',
      acceptanceEvidence: [],
      memoryDelta: [],
      openRisks: ['还没验收'],
    });
    const view = await platform.getMissionView('M1');
    assert.equal(view.result?.outcome, 'blocked');
  });

  test('reject 必须说清楚要改什么', async () => {
    const { platform, coord, workItemId } = await upToSubmitted();
    await assert.rejects(
      () =>
        platform.reviewExecutionResult('M1', coord, {
          workItemId,
          verdict: 'reject', acceptanceResults: ORDER.acceptance.map((criterion) => ({ criterion, status: 'fail' as const })),
          reasons: ['不行'],
          requiredChanges: [],
        }),
      (e: unknown) => (e as PlatformRuleError).code === 'REJECT_NEEDS_CHANGES',
    );
  });

  test('Standard review 的 lastReview.attemptId 是 Coordinator attempt，不被重解释为 Executor', async () => {
    const { platform, coord, exec, workItemId } = await upToSubmitted();
    await platform.reviewExecutionResult('M1', coord, {
      workItemId,
      verdict: 'accept', acceptanceResults: ORDER.acceptance.map((criterion) => ({ criterion, status: 'pass' as const, evidence: '测试替身：逐条核过' })),
      reasons: ['ok'],
      requiredChanges: [],
    });
    const view = await platform.getMissionView('M1');
    const last = view.workItems[0]?.lastReview;
    assert.ok(last);
    assert.equal(last.attemptId, coord, 'attemptId = Coordinator reviewer Attempt');
    assert.notEqual(last.attemptId, exec);
    assert.equal(last.submittedAttemptId, undefined);
    assert.equal(last.authority, undefined);
  });

  test('没有执行结果时不能验收', async () => {
    const { platform } = makePlatform();
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
    const { attemptId: coord } = await platform.startCoordinatorAttempt('M1');
    await platform.updatePlan('M1', coord, {
      findings: 'f',
      rejectedHypotheses: [],
      decisions: [],
      direction: 'd',
      risks: [],
    });
    const { workItemId } = await platform.createWorkItem('M1', coord, { title: 'W', order: ORDER });
    await platform.dispatchWorkItems('M1', coord, [workItemId]);
    await assert.rejects(
      () =>
        platform.reviewExecutionResult('M1', coord, {
          workItemId,
          verdict: 'accept', acceptanceResults: ORDER.acceptance.map((criterion) => ({ criterion, status: 'pass' as const, evidence: '测试替身：逐条核过' })),
          reasons: [],
          requiredChanges: [],
        }),
      (e: unknown) => (e as PlatformRuleError).code === 'NO_RESULT',
    );
  });
});

describe('身份校验：工具面之外再挡一道', () => {
  test('执行者不能改 Plan（即使直接调端点）', async () => {
    const { platform, exec } = await upToSubmitted();
    await assert.rejects(
      () =>
        platform.updatePlan('M1', exec, {
          findings: '我是执行者但我想改计划',
          rejectedHypotheses: [],
          decisions: [],
          direction: 'x',
          risks: [],
        }),
      (e: unknown) => (e as PlatformRuleError).code === 'WRONG_ROLE',
    );
  });

  test('执行者不能验收自己的结果（不变量 A 的端点侧对应物）', async () => {
    const { platform, exec, workItemId } = await upToSubmitted();
    await assert.rejects(
      () =>
        platform.reviewExecutionResult('M1', exec, {
          workItemId,
          verdict: 'accept', acceptanceResults: ORDER.acceptance.map((criterion) => ({ criterion, status: 'pass' as const, evidence: '测试替身：逐条核过' })),
          reasons: ['我觉得挺好'],
          requiredChanges: [],
        }),
      (e: unknown) => (e as PlatformRuleError).code === 'WRONG_ROLE',
    );
  });

  test('已经结束的 attempt 不能再提交', async () => {
    const { platform, exec } = await upToSubmitted();
    await platform.finishAttempt('M1', exec, { endedBy: 'structured_submit' });
    await assert.rejects(
      () =>
        platform.submitEvidence('M1', exec, {
          kind: 'test',
          summary: '迟到的证据',
        }),
      (e: unknown) => (e as PlatformRuleError).code === 'ATTEMPT_NOT_ACTIVE',
    );
  });
});

describe('结束原因分类：上游失败与「没提交」不是一回事', () => {
  test('upstream_failure 标成可重试，no_structured_result 不标', async () => {
    const { platform, activity } = makePlatform();
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });

    const a = await platform.startCoordinatorAttempt('M1');
    await platform.finishAttempt('M1', a.attemptId, {
      endedBy: 'upstream_failure',
      failureMessage: '403 需要充值',
    });

    const b = await platform.startCoordinatorAttempt('M1');
    await platform.finishAttempt('M1', b.attemptId, { endedBy: 'no_structured_result' });

    const events = (await activity.list('M1')).filter((e) => e.kind === 'attempt.ended');
    assert.equal(events.length, 2);
    assert.equal((events[0].data as { retriable: boolean }).retriable, true);
    assert.equal((events[1].data as { retriable: boolean }).retriable, false);

    const view = await platform.getMissionView('M1');
    assert.equal(view.status, 'investigating', '尝试失败不改变 Mission 状态');
  });

  test('上游失败后可以再开一次协调者尝试（不变量 B 不会被占死）', async () => {
    const { platform } = makePlatform();
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
    const a = await platform.startCoordinatorAttempt('M1');
    await platform.finishAttempt('M1', a.attemptId, { endedBy: 'upstream_failure' });
    const b = await platform.startCoordinatorAttempt('M1');
    assert.notEqual(b.attemptId, a.attemptId);
  });
});

describe('打回重做', () => {
  test('提交结果不等于尝试结束：没收尾就开不了下一次', async () => {
    const { platform, workItemId } = await upToSubmitted();
    await assert.rejects(
      () => platform.startExecutorAttempt('M1', workItemId),
      (e: unknown) => (e as PlatformRuleError).code === 'ATTEMPT_STILL_RUNNING',
    );
  });

  test('reject 之后可重新派发，且下一张工单带上了上次的 requiredChanges', async () => {
    const { platform, coord, exec, workItemId } = await upToSubmitted();
    await platform.finishAttempt('M1', exec, { endedBy: 'structured_submit' });
    await platform.reviewExecutionResult('M1', coord, {
      workItemId,
      verdict: 'reject', acceptanceResults: ORDER.acceptance.map((criterion) => ({ criterion, status: 'fail' as const })),
      reasons: ['测试没真跑'],
      requiredChanges: ['把 verification 里的命令实际执行并交退出码'],
    });

    await platform.dispatchWorkItems('M1', coord, [workItemId]);
    const order = await platform.getWorkOrder('M1', workItemId);
    assert.deepEqual(order.previousRequiredChanges, [
      '把 verification 里的命令实际执行并交退出码',
    ]);

    // 同一工作项开第二次尝试，第一次失败不影响它还能再来。
    const second = await platform.startExecutorAttempt('M1', workItemId);
    assert.ok(second.attemptId);
    const view = await platform.getMissionView('M1');
    assert.equal(view.workItems[0].attempts, 2);
  });

  test('L3 send_back 后重派：工单视图与开跑简报都带 L3 理由与最近 reject 要求，冻结工单不变', async () => {
    const { platform, coord, exec, workItemId } = await upToSubmitted();
    await platform.finishAttempt('M1', exec, { endedBy: 'structured_submit' });
    const requiredChanges = ['把 verification 里的命令实际执行并交退出码'];
    await platform.reviewExecutionResult('M1', coord, {
      workItemId,
      verdict: 'reject',
      acceptanceResults: ORDER.acceptance.map((criterion) => ({ criterion, status: 'fail' as const })),
      reasons: ['测试没真跑'],
      requiredChanges,
    });

    // 重派、重做、验收通过，最后交卷给 L3。
    await platform.dispatchWorkItems('M1', coord, [workItemId]);
    const second = await platform.startExecutorAttempt('M1', workItemId);
    await platform.submitEvidence('M1', second.attemptId, {
      kind: 'test',
      summary: '绿',
      command: 'node --test',
      exitCode: 0,
    });
    await platform.submitExecutionResult('M1', second.attemptId, {
      outcome: 'completed',
      summary: '改好了',
      changedFiles: ['src/foo.ts'],
      evidenceIds: [],
      notes: '无',
    });
    await platform.finishAttempt('M1', second.attemptId, { endedBy: 'structured_submit' });
    await platform.reviewExecutionResult('M1', coord, {
      workItemId,
      verdict: 'accept',
      acceptanceResults: ORDER.acceptance.map((criterion) => ({ criterion, status: 'pass' as const, evidence: '逐条核过' })),
      reasons: ['ok'],
      requiredChanges: [],
    });
    await platform.submitMissionResult('M1', coord, {
      outcome: 'delivered',
      summary: '做完了',
      acceptanceEvidence: ['证据'],
      memoryDelta: [],
      openRisks: [],
    });

    // L3 打回整个 Mission。此时工单最后一条评审是 accept、requiredChanges 为空，
    // 单看它执行者读到的「上次要改什么」是空——本投影要救的正是这个场景。
    const l3Reasons = ['Contract 已更新到 r2，需要按新契约重新核对'];
    await platform.finalizeMissionByReviewer('M1', {
      verdict: 'send_back',
      reasons: l3Reasons,
      reviewerId: 'reviewer-1',
      confirmedBy: 'user-1',
    });

    // 重派已验收的工作项，并开新的执行者尝试。
    await platform.dispatchWorkItems('M1', coord, [workItemId]);
    const third = await platform.startExecutorAttempt('M1', workItemId);

    const orderView = await platform.getWorkOrder('M1', workItemId);
    assert.deepEqual(orderView.l3SendBackReasons, l3Reasons);
    assert.deepEqual(orderView.previousRequiredChanges, requiredChanges);
    // 打回理由与要求是事后补的，不能写进冻结 order。
    assert.equal(orderView.order.orderRevision, 'r1');

    const brief = await platform.getStartupBrief('M1', third.attemptId);
    assert.deepEqual(brief.workItem?.l3SendBackReasons, l3Reasons);
    assert.deepEqual(brief.workItem?.previousRequiredChanges, requiredChanges);
    assert.equal(brief.workItem?.order?.orderRevision, 'r1');
  });
});

describe('用量聚合', () => {
  test('按分项相加，不是只滚一个 total', async () => {
    const { platform } = makePlatform();
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
    const a = await platform.startCoordinatorAttempt('M1');
    await platform.finishAttempt('M1', a.attemptId, {
      endedBy: 'structured_submit',
      usage: {
        input: 100,
        output: 50,
        cacheRead: 9000,
        cacheWrite: 10,
        total: 9160,
        cost: 0.5,
        quality: 'reported',
      },
    });
    const view = await platform.getMissionView('M1');
    assert.equal(view.usage.input, 100);
    assert.equal(view.usage.cacheRead, 9000, '缓存命中必须单独可见');
    assert.equal(view.usage.total, 9160);
    assert.equal(view.usage.quality, 'reported');
  });
});

describe('契约与用量质量', () => {
  test('建 Mission 时带的契约要真的落进去', async () => {
    const { platform } = makePlatform();
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
    const view = await platform.getMissionView('M1');
    assert.equal(view.contractRevision, 1, '契约必须随创建一起落地');
    assert.equal(view.contract?.intent, CONTRACT.intent);
    assert.deepEqual(view.contract?.guardrails, CONTRACT.guardrails);
  });

  test('用量质量：没人上报就是 unknown，不是 estimated', async () => {
    const { platform } = makePlatform();
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
    await platform.startCoordinatorAttempt('M1');
    const view = await platform.getMissionView('M1');
    assert.equal(view.usage.quality, 'unknown', '在途 attempt 不该把读数说成估算过');
  });

  test('用量质量：部分上报是 estimated', async () => {
    const { platform } = makePlatform();
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
    const a = await platform.startCoordinatorAttempt('M1');
    await platform.finishAttempt('M1', a.attemptId, {
      endedBy: 'structured_submit',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2, quality: 'reported' },
    });
    await platform.startCoordinatorAttempt('M1');
    const view = await platform.getMissionView('M1');
    assert.equal(view.usage.quality, 'estimated');
  });
});

describe('VAL-003：executionResult 绑定提交它的 executor attempt', () => {
  test('submitExecutionResult 后 item.submittedAttemptId === 认证过的 executor attemptId', async () => {
    const { platform, projects } = makePlatform();
    await platform.createMission({ projectId: 'P', missionId: 'M-val3', contract: CONTRACT });
    const coord = await platform.startCoordinatorAttempt('M-val3');
    await platform.updatePlan('M-val3', coord.attemptId, PLAN);
    const { workItemId } = await platform.createWorkItem('M-val3', coord.attemptId, {
      title: 'W',
      order: ORDER,
    });
    await platform.dispatchWorkItems('M-val3', coord.attemptId, [workItemId]);
    const exec = await platform.startExecutorAttempt('M-val3', workItemId);
    await platform.submitEvidence('M-val3', exec.attemptId, {
      kind: 'test',
      summary: '绿',
      command: 'node --test',
      exitCode: 0,
    });
    await platform.submitExecutionResult('M-val3', exec.attemptId, {
      outcome: 'completed',
      summary: '改好了',
      changedFiles: ['src/foo.ts'],
      evidenceIds: [],
      notes: '无',
    });

    const item = await liveWorkItem(projects, 'P', 'M-val3', workItemId);
    assert.equal(item.submittedAttemptId, exec.attemptId);
  });

  test('另一个 WorkItem/attempt 不串', async () => {
    const { platform, projects } = makePlatform();
    await platform.createMission({ projectId: 'P', missionId: 'M-val3b', contract: CONTRACT });
    const coord = await platform.startCoordinatorAttempt('M-val3b');
    await platform.updatePlan('M-val3b', coord.attemptId, PLAN);
    const a = await platform.createWorkItem('M-val3b', coord.attemptId, {
      title: 'WA',
      order: ORDER,
    });
    const b = await platform.createWorkItem('M-val3b', coord.attemptId, {
      title: 'WB',
      order: ORDER,
    });
    await platform.dispatchWorkItems('M-val3b', coord.attemptId, [a.workItemId, b.workItemId]);

    const execA = await platform.startExecutorAttempt('M-val3b', a.workItemId);
    await platform.submitEvidence('M-val3b', execA.attemptId, {
      kind: 'test',
      summary: 'A 绿',
      command: 'node --test',
      exitCode: 0,
    });
    await platform.submitExecutionResult('M-val3b', execA.attemptId, {
      outcome: 'completed',
      summary: 'A 好了',
      changedFiles: ['a.ts'],
      evidenceIds: [],
      notes: '无',
    });

    const execB = await platform.startExecutorAttempt('M-val3b', b.workItemId);
    await platform.submitEvidence('M-val3b', execB.attemptId, {
      kind: 'test',
      summary: 'B 绿',
      command: 'node --test',
      exitCode: 0,
    });
    await platform.submitExecutionResult('M-val3b', execB.attemptId, {
      outcome: 'completed',
      summary: 'B 好了',
      changedFiles: ['b.ts'],
      evidenceIds: [],
      notes: '无',
    });

    const itemA = await liveWorkItem(projects, 'P', 'M-val3b', a.workItemId);
    const itemB = await liveWorkItem(projects, 'P', 'M-val3b', b.workItemId);
    assert.equal(itemA.submittedAttemptId, execA.attemptId);
    assert.equal(itemB.submittedAttemptId, execB.attemptId);
    assert.notEqual(itemA.submittedAttemptId, itemB.submittedAttemptId);
  });
});

describe('S11.1：「已完成」必须有证据', () => {
  test('没证据的 completed 被平台拦下，而且说清楚下一步', async () => {
    const { platform } = makePlatform();
    await platform.createMission({ projectId: 'P', missionId: 'M9', contract: CONTRACT });
    const coord = await platform.startCoordinatorAttempt('M9');
    await platform.updatePlan('M9', coord.attemptId, PLAN);
    const { workItemId } = await platform.createWorkItem('M9', coord.attemptId, {
      title: 'W',
      order: ORDER,
    });
    await platform.dispatchWorkItems('M9', coord.attemptId, [workItemId]);
    const exec = await platform.startExecutorAttempt('M9', workItemId);

    // 挡在工具层而不是只写进 prompt——一句没有任何验证支撑的 completed
    // 会一路走到 L2 验收面前，而那时它看起来和真做完了一模一样。
    await assert.rejects(
      () =>
        platform.submitExecutionResult('M9', exec.attemptId, {
          outcome: 'completed',
          summary: '改好了',
          changedFiles: ['src/foo.ts'],
          evidenceIds: [],
          notes: '无',
        }),
      (error: unknown) => {
        const e = error as { code?: string; message?: string };
        assert.equal(e.code, 'NO_EVIDENCE');
        // 报错要写成「下一步该干什么」，模型会把它原样读进去。
        assert.match(e.message ?? '', /coagent_submit_evidence/);
        return true;
      },
    );

    // 工作项不能因为这次被拒就留下半个流转。
    assert.equal((await platform.getMissionView('M9')).workItems[0].status, 'dispatched');
  });

  test('交了证据就放行', async () => {
    const { platform } = makePlatform();
    await platform.createMission({ projectId: 'P', missionId: 'M10', contract: CONTRACT });
    const coord = await platform.startCoordinatorAttempt('M10');
    await platform.updatePlan('M10', coord.attemptId, PLAN);
    const { workItemId } = await platform.createWorkItem('M10', coord.attemptId, {
      title: 'W',
      order: ORDER,
    });
    await platform.dispatchWorkItems('M10', coord.attemptId, [workItemId]);
    const exec = await platform.startExecutorAttempt('M10', workItemId);
    await platform.submitEvidence('M10', exec.attemptId, {
      kind: 'test',
      summary: '绿',
      command: 'node --test',
      exitCode: 0,
    });
    await platform.submitExecutionResult('M10', exec.attemptId, {
      outcome: 'completed',
      summary: '改好了',
      changedFiles: ['src/foo.ts'],
      evidenceIds: [],
      notes: '无',
    });
    assert.equal((await platform.getMissionView('M10')).workItems[0].status, 'submitted');
  });

  test('blocked 不要求举证 —— 逼它为交卷编一条证据更糟', async () => {
    const { platform } = makePlatform();
    await platform.createMission({ projectId: 'P', missionId: 'M11', contract: CONTRACT });
    const coord = await platform.startCoordinatorAttempt('M11');
    await platform.updatePlan('M11', coord.attemptId, PLAN);
    const { workItemId } = await platform.createWorkItem('M11', coord.attemptId, {
      title: 'W',
      order: ORDER,
    });
    await platform.dispatchWorkItems('M11', coord.attemptId, [workItemId]);
    const exec = await platform.startExecutorAttempt('M11', workItemId);
    await platform.submitExecutionResult('M11', exec.attemptId, {
      outcome: 'blocked',
      summary: '前提不成立',
      changedFiles: [],
      evidenceIds: [],
      notes: '无',
    });
    assert.equal((await platform.getMissionView('M11')).workItems[0].status, 'submitted');
  });
});

describe('S05.2：工作项冻结拆它时的规划版本', () => {
  test('规划后来改了，工作项记的还是当初那一版', async () => {
    const { platform } = makePlatform();
    await platform.createMission({ projectId: 'P', missionId: 'M12', contract: CONTRACT });
    const coord = await platform.startCoordinatorAttempt('M12');
    await platform.updatePlan('M12', coord.attemptId, PLAN);
    const first = await platform.createWorkItem('M12', coord.attemptId, {
      title: 'W1',
      order: ORDER,
    });

    // 规划随证据变化——这是允许的。但 W1 是照 r1 拆的。
    await platform.updatePlan('M12', coord.attemptId, { ...PLAN, direction: '换个方向' });
    await platform.updatePlan('M12', coord.attemptId, { ...PLAN, direction: '再换' });
    const later = await platform.createWorkItem('M12', coord.attemptId, {
      title: 'W2',
      order: ORDER,
    });

    const view = await platform.getMissionView('M12');
    assert.equal(view.planRevision, 3);
    const w1 = view.workItems.find((i) => i.id === first.workItemId);
    const w2 = view.workItems.find((i) => i.id === later.workItemId);
    // 不冻的话这两个都会读成 3，"这个工单凭什么这么拆"的答案就错了，
    // 而且错得看不出来。
    assert.equal(w1?.planRevision, 1);
    assert.equal(w2?.planRevision, 3);
  });
});

describe('契约中途变更（S14.6）', () => {
  test('executing 时改契约 —— 退回规划，已派发的工单不再被执行', async () => {
    // 实测踩到的：中途改需求时 Mission 还在 executing、工单已经派出去，
    // 调度器照样先跑执行者。等 L2 被叫醒，按旧契约做的东西已经做完了——
    // 钱花了，做的还是明确不要的那件事。
    const { platform } = makePlatform();
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
    const coord = await platform.startCoordinatorAttempt('M1');
    await platform.updatePlan('M1', coord.attemptId, PLAN);
    const { workItemId } = await platform.createWorkItem('M1', coord.attemptId, {
      title: 'W',
      order: ORDER,
    });
    await platform.dispatchWorkItems('M1', coord.attemptId, [workItemId]);
    assert.equal((await platform.getMissionView('M1')).status, 'executing');

    await platform.reviseContract('M1', { ...CONTRACT, intent: '改了目标' });

    const view = await platform.getMissionView('M1');
    // 退回规划：接下来该说话的是 L2，不是执行者。
    assert.equal(view.status, 'planning');
    assert.equal(view.finalReview?.verdict, 'send_back');
    assert.match(view.finalReview?.reasons[0] ?? '', /Contract 已更新/);
    // 工单状态不动——compatible / replan / cancel-replace 是 L2 的判断，
    // 不是平台替它做。
    assert.equal(view.workItems[0].status, 'dispatched');
    assert.equal(view.contract?.intent, '改了目标');
  });
});

describe('退回规划之后重新派发', () => {
  test('阶段要重新推到 executing —— 否则调度器永远不跑那些工单', async () => {
    // 实测踩到的死锁：改契约把 Mission 退回 planning，协调者重新派发，
    // 但 dispatchWorkItems 看到"已经占着改动名额"就跳过了 startExecuting()，
    // 于是阶段停在 planning。而调度器只在 executing 跑执行者——
    // 工单永远不会被执行，界面上却显示"已派发"，看不出为什么不动。
    const { platform } = makePlatform();
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
    const coord = await platform.startCoordinatorAttempt('M1');
    await platform.updatePlan('M1', coord.attemptId, PLAN);
    const first = await platform.createWorkItem('M1', coord.attemptId, {
      title: 'W1',
      order: ORDER,
    });
    await platform.dispatchWorkItems('M1', coord.attemptId, [first.workItemId]);
    assert.equal((await platform.getMissionView('M1')).status, 'executing');

    // L3 改契约 → 退回规划。名额不放（分支上的改动还在）。
    await platform.reviseContract('M1', { ...CONTRACT, intent: '换个目标' });
    const back = await platform.getMissionView('M1');
    assert.equal(back.status, 'planning');
    assert.equal(back.isMutating, true, '名额不该因为退回就放掉');

    // 协调者按新契约另开一个工作项并派发。
    const second = await platform.createWorkItem('M1', coord.attemptId, {
      title: 'W2',
      order: ORDER,
    });
    await platform.dispatchWorkItems('M1', coord.attemptId, [second.workItemId]);

    const after = await platform.getMissionView('M1');
    assert.equal(after.status, 'executing', '重新派发之后必须回到 executing');
    assert.equal(
      after.workItems.find((i) => i.id === second.workItemId)?.status,
      'dispatched',
    );
  });
});

describe('L3 作废工作项（S14.6 的 cancel-replace）', () => {
  test('作废之后调度器不会再跑它，理由留给协调者看', async () => {
    // 场景：契约改了，协调者照新契约另拆了一批工单，旧的还挂在 dispatched 上。
    // 不作废的话调度器会把它们也跑一遍——做的是明确不要的那件事，
    // 还要花一次执行者的钱。
    const { platform } = makePlatform();
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
    const coord = await platform.startCoordinatorAttempt('M1');
    await platform.updatePlan('M1', coord.attemptId, PLAN);
    const old = await platform.createWorkItem('M1', coord.attemptId, {
      title: '按旧契约拆的',
      order: ORDER,
    });
    await platform.dispatchWorkItems('M1', coord.attemptId, [old.workItemId]);

    const result = await platform.retireWorkItem('M1', old.workItemId, '契约改了，已被新工单取代');
    // retired 而不是 blocked：两者对交卷的含义相反。blocked 是"这张工单不成立、
    // 需要有人去改"，要拦住交卷；retired 是"不用做了"，不该拦。早先两者挤在
    // 同一个状态上，于是作废过工作项的 Mission 永远交不了卷。
    assert.equal(result.status, 'retired');

    const view = await platform.getMissionView('M1');
    const item = view.workItems.find((i) => i.id === old.workItemId);
    // 离开 dispatched 才是关键：调度器只跑 dispatched 的。
    assert.equal(item?.status, 'retired');
  });

  test('已验收的不让作废 —— 那是在改历史', async () => {
    const { platform, coord, workItemId } = await upToSubmitted();
    await platform.reviewExecutionResult('M1', coord, {
      workItemId,
      verdict: 'accept', acceptanceResults: ORDER.acceptance.map((criterion) => ({ criterion, status: 'pass' as const, evidence: '测试替身：逐条核过' })),
      reasons: ['ok'],
      requiredChanges: [],
    });
    await assert.rejects(
      () => platform.retireWorkItem('M1', workItemId, '想反悔'),
      (error: unknown) => (error as { code?: string }).code === 'NOT_RETIRABLE',
    );
  });

  test('被打回的能作废 —— 被新工单取代之后，它既验收不了也不该卡着', async () => {
    // 实测 W5 卡死在这里：协调者打回 W-1937（DOM 路径是坏的），另拆 W-2001
    // 修掉并验收。此时 W-1937 没有新结果所以验收不了，而 rejected 又进不了
    // 任何终态——它既不能往前也不能作废，整条 Mission 交不了卷。
    const { platform, coord, workItemId } = await upToSubmitted();
    await platform.reviewExecutionResult('M1', coord, {
      workItemId,
      verdict: 'reject', acceptanceResults: ORDER.acceptance.map((criterion) => ({ criterion, status: 'fail' as const })),
      reasons: ['DOM 路径是坏的'],
      requiredChanges: ['换个做法'],
    });
    const result = await platform.retireWorkItem('M1', workItemId, '已被 W-2 取代');
    assert.equal(result.status, 'retired');
  });

  test('作废掉的不算"没做完" —— 否则作废过工作项的 Mission 永远交不了卷', async () => {
    const { platform, coord, workItemId } = await upToSubmitted();
    await platform.reviewExecutionResult('M1', coord, {
      workItemId,
      verdict: 'accept', acceptanceResults: ORDER.acceptance.map((criterion) => ({ criterion, status: 'pass' as const, evidence: '测试替身：逐条核过' })),
      reasons: ['ok'],
      requiredChanges: [],
    });
    // 再拆一张，直接作废掉：它不该拦着交卷。
    const extra = await platform.createWorkItem('M1', coord, {
      title: '后来发现不用做的那张',
      order: ORDER,
    });
    await platform.retireWorkItem('M1', extra.workItemId, '契约改了，不用做了');

    // 交卷闸早先只认 accepted，于是这里必然 WORK_ITEMS_UNFINISHED。
    // 实测 W3 只能改用 outcome=blocked 绕过去——那等于对外宣称任务失败了。
    await platform.submitMissionResult('M1', coord, {
      outcome: 'delivered',
      summary: '做完了',
      acceptanceEvidence: ['证据'],
      memoryDelta: [],
      openRisks: [],
    });
    const view = await platform.getMissionView('M1');
    assert.equal(view.status, 'awaiting_review');
    assert.equal(view.result?.outcome, 'delivered');
  });
});

describe('调查发现追加（S09.2）', () => {
  test('连续补充保留既有规划信息，完整更新仍整体替换', async () => {
    const { platform } = makePlatform();
    await platform.createMission({ projectId: 'P', missionId: 'F1', contract: CONTRACT });
    const coord = await platform.startCoordinatorAttempt('F1');
    const initial = {
      rootCause: '根因', findings: '原始发现', rejectedHypotheses: ['假设A'],
      decisions: ['决策'], direction: '方向', risks: ['风险'],
    };
    await platform.updatePlan('F1', coord.attemptId, initial);
    await platform.updateFindings('F1', coord.attemptId, '第一次发现', ['假设A', '假设B']);
    await platform.updateFindings('F1', coord.attemptId, '第二次发现');

    const view = await platform.getMissionView('F1');
    assert.equal(view.plan?.findings, '原始发现\n\n—— 第 2 次补充\n第一次发现\n\n—— 第 3 次补充\n第二次发现');
    assert.equal(view.plan?.rootCause, '根因');
    assert.deepEqual(view.plan?.rejectedHypotheses, ['假设A', '假设B']);
    assert.deepEqual(view.plan?.decisions, ['决策']);
    assert.equal(view.plan?.direction, '方向');
    assert.deepEqual(view.plan?.risks, ['风险']);

    await platform.updatePlan('F1', coord.attemptId, { ...initial, findings: '整体替换' });
    assert.equal((await platform.getMissionView('F1')).plan?.findings, '整体替换');
  });
});

describe('Mission 视图：提交证据可见但已验收输出不泄露', () => {
  // 自带 setup：提交带 >1000 字输出的证据后再交执行结果，避免 upToSubmitted 已交过一次结果。
  async function submittedWithEvidence(evidence: {
    kind: 'test' | 'command' | 'diff' | 'typecheck' | 'build' | 'observation';
    summary: string;
    command?: string;
    exitCode?: number;
    output?: string;
  }) {
    const { platform } = makePlatform();
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
    const { attemptId: coord } = await platform.startCoordinatorAttempt('M1');
    await platform.updatePlan('M1', coord, PLAN);
    const { workItemId } = await platform.createWorkItem('M1', coord, { title: 'W', order: ORDER });
    await platform.dispatchWorkItems('M1', coord, [workItemId]);
    const { attemptId: exec } = await platform.startExecutorAttempt('M1', workItemId);
    await platform.submitEvidence('M1', exec, evidence);
    await platform.submitExecutionResult('M1', exec, {
      outcome: 'completed',
      summary: '改好了',
      changedFiles: ['src/foo.ts'],
      evidenceIds: [],
      notes: '无',
    });
    return { platform, coord, exec, workItemId };
  }

  test('submitted 视图带脱敏截尾证据，accepted 仅给条数与结论', async () => {
    // 形状凭据：redactSecrets 按形状命中 `api_key=…` 这类赋值，替换为 [REDACTED]。
    // 长输出在前，凭据行放尾部，确保落在截尾的最后 1000 字里（先脱敏再截尾）。
    const secretLine = '环境变量 api_key=sk-supersecret0123456789abcdefghij 已注入';
    const longOutput = 'x'.repeat(1200) + '\n' + secretLine;
    const { platform, coord, workItemId } = await submittedWithEvidence({
      kind: 'command',
      summary: '跑了 build，token api_key=sk-supersecret0123456789abcdefghij 在用',
      command: 'npm run build --token api_key=sk-supersecret0123456789abcdefghij',
      exitCode: 0,
      output: longOutput,
    });

    const submitted = await platform.getMissionView('M1');
    const submittedItem = submitted.workItems[0];
    assert.equal(submittedItem?.status, 'submitted');
    assert.ok(submittedItem?.submittedEvidence, 'submitted 视图带 submittedEvidence');
    assert.equal(submittedItem?.submittedEvidence?.length, 1);
    const ev = submittedItem!.submittedEvidence![0];
    assert.equal(ev.exitCode, 0);

    // 命令与摘要均脱敏：api_key=… 的值被 [REDACTED] 替换。
    assert.ok(!ev.command.includes('sk-supersecret0123456789abcdefghij'), '命令中的 token 被脱敏');
    assert.ok(!ev.summary.includes('sk-supersecret0123456789abcdefghij'), '摘要中的 token 被脱敏');
    assert.ok(ev.command.includes('[REDACTED]'));
    assert.ok(ev.summary.includes('[REDACTED]'));

    // 输出先脱敏再截尾：原始 1200+ 字截到最后 1000 字，且 token 已被 [REDACTED] 替换。
    assert.ok(!ev.outputTail.includes('sk-supersecret0123456789abcdefghij'), '输出尾部 token 被脱敏');
    assert.ok(ev.outputTail.includes('[REDACTED]'), '输出尾部含脱敏标记');
    assert.equal(ev.outputTail.length, 1000, '输出截到最后的 1000 字');
    assert.equal(submittedItem?.reviewSummary, undefined, 'submitted 不含 reviewSummary');

    // 验收后：只给条数和结论，不返回证据输出。
    await platform.reviewExecutionResult('M1', coord, {
      workItemId,
      verdict: 'accept',
      acceptanceResults: ORDER.acceptance.map((criterion) => ({ criterion, status: 'pass' as const, evidence: '测试替身：逐条核过' })),
      reasons: ['ok'],
      requiredChanges: [],
    });
    const accepted = await platform.getMissionView('M1');
    const acceptedItem = accepted.workItems[0];
    assert.equal(acceptedItem?.status, 'accepted');
    assert.equal(acceptedItem?.submittedEvidence, undefined, 'accepted 不含证据输出');
    assert.ok(acceptedItem?.reviewSummary, 'accepted 带 reviewSummary');
    assert.equal(acceptedItem?.reviewSummary?.evidenceCount, 1, '条数 = 1');
    assert.equal(acceptedItem?.reviewSummary?.verdict, 'accept', '结论 = accept');
  });

  test('rejected 视图同样仅给条数与结论，不泄露证据输出', async () => {
    const { platform, coord, workItemId } = await submittedWithEvidence({
      kind: 'test',
      summary: 'x',
      command: 'node --test',
      exitCode: 0,
      output: 'y'.repeat(1500),
    });
    await platform.reviewExecutionResult('M1', coord, {
      workItemId,
      verdict: 'reject',
      acceptanceResults: ORDER.acceptance.map((criterion) => ({ criterion, status: 'fail' as const })),
      reasons: ['不行'],
      requiredChanges: ['改'],
    });
    const rejected = await platform.getMissionView('M1');
    const item = rejected.workItems[0];
    assert.equal(item?.status, 'rejected');
    assert.equal(item?.submittedEvidence, undefined);
    assert.ok(item?.reviewSummary);
    assert.equal(item?.reviewSummary?.evidenceCount, 1);
    assert.equal(item?.reviewSummary?.verdict, 'reject');
  });
});

describe('W-292：blocked/partial 工单未修订禁止原样重派', () => {
  test('blocked 后同修订号重派被拒且状态不变，修订后可 dispatch', async () => {
    const { platform } = makePlatform();
    await platform.createMission({ projectId: 'P', missionId: 'M292', contract: CONTRACT });
    const coord = await platform.startCoordinatorAttempt('M292');
    await platform.updatePlan('M292', coord.attemptId, PLAN);
    const { workItemId } = await platform.createWorkItem('M292', coord.attemptId, { title: 'W', order: ORDER });
    await platform.dispatchWorkItems('M292', coord.attemptId, [workItemId]);
    const exec = await platform.startExecutorAttempt('M292', workItemId);
    await platform.reportBlocked('M292', exec.attemptId, {
      reason: '前提不成立',
      whatWasTried: ['试过 X'],
      needsFromUpstream: '',
    });
    // 工单仍是 r1，原样重派必须被拒，且被拒不能留下半套流转（状态仍是 blocked）。
    await assert.rejects(
      () => platform.dispatchWorkItems('M292', coord.attemptId, [workItemId]),
      (e: unknown) => (e as PlatformRuleError).code === 'WORK_ORDER_REVISION_REQUIRED',
    );
    assert.equal((await platform.getMissionView('M292')).workItems[0].status, 'blocked');

    // 修订后修订号递增（r2），可正常重派。
    const { revision } = await platform.reviseWorkOrder('M292', coord.attemptId, workItemId, {
      ...ORDER,
      objective: '把前提改对再派',
    });
    assert.equal(revision, 'r2');
    await platform.dispatchWorkItems('M292', coord.attemptId, [workItemId]);
    assert.equal((await platform.getMissionView('M292')).workItems[0].status, 'dispatched');
  });

  test('partial 被 reject 后同修订号重派被拒，修订后可 dispatch；普通 rejected/accepted 不误拦', async () => {
    const { platform } = makePlatform();
    await platform.createMission({ projectId: 'P', missionId: 'M293', contract: CONTRACT });
    const coord = await platform.startCoordinatorAttempt('M293');
    await platform.updatePlan('M293', coord.attemptId, PLAN);
    const { workItemId } = await platform.createWorkItem('M293', coord.attemptId, { title: 'W', order: ORDER });
    await platform.dispatchWorkItems('M293', coord.attemptId, [workItemId]);
    const exec = await platform.startExecutorAttempt('M293', workItemId);
    await platform.submitEvidence('M293', exec.attemptId, {
      kind: 'test',
      summary: 'x',
      command: 'node --test',
      exitCode: 1,
    });
    await platform.submitExecutionResult('M293', exec.attemptId, {
      outcome: 'partial',
      summary: '只做了一半',
      changedFiles: [],
      evidenceIds: [],
      notes: '无',
    });
    await platform.finishAttempt('M293', exec.attemptId, { endedBy: 'structured_submit' });
    await platform.reviewExecutionResult('M293', coord.attemptId, {
      workItemId,
      verdict: 'reject',
      acceptanceResults: ORDER.acceptance.map((c) => ({ criterion: c, status: 'fail' as const })),
      reasons: ['没做完'],
      requiredChanges: ['做完'],
    });
    assert.equal((await platform.getMissionView('M293')).workItems[0].status, 'rejected');

    // 同修订号（r1）重派被拒。
    await assert.rejects(
      () => platform.dispatchWorkItems('M293', coord.attemptId, [workItemId]),
      (e: unknown) => (e as PlatformRuleError).code === 'WORK_ORDER_REVISION_REQUIRED',
    );

    // 修订后恢复派发。
    const { revision } = await platform.reviseWorkOrder('M293', coord.attemptId, workItemId, {
      ...ORDER,
      objective: '做完',
    });
    assert.equal(revision, 'r2');
    await platform.dispatchWorkItems('M293', coord.attemptId, [workItemId]);
    assert.equal((await platform.getMissionView('M293')).workItems[0].status, 'dispatched');

    // 不误拦 1：普通「completed 提交后被 reject」不是 blocked/partial，可重派。
    const normal = await platform.createWorkItem('M293', coord.attemptId, { title: '正常', order: ORDER });
    await platform.dispatchWorkItems('M293', coord.attemptId, [normal.workItemId]);
    const ne = await platform.startExecutorAttempt('M293', normal.workItemId);
    await platform.submitEvidence('M293', ne.attemptId, { kind: 'test', summary: '绿', command: 'node --test', exitCode: 0 });
    await platform.submitExecutionResult('M293', ne.attemptId, {
      outcome: 'completed',
      summary: '做完了',
      changedFiles: ['src/foo.ts'],
      evidenceIds: [],
      notes: '无',
    });
    await platform.finishAttempt('M293', ne.attemptId, { endedBy: 'structured_submit' });
    await platform.reviewExecutionResult('M293', coord.attemptId, {
      workItemId: normal.workItemId,
      verdict: 'reject',
      acceptanceResults: ORDER.acceptance.map((c) => ({ criterion: c, status: 'fail' as const })),
      reasons: ['差一点'],
      requiredChanges: ['补一处'],
    });
    await platform.dispatchWorkItems('M293', coord.attemptId, [normal.workItemId]);
    assert.equal(
      (await platform.getMissionView('M293')).workItems.find((i) => i.id === normal.workItemId)?.status,
      'dispatched',
    );

    // 不误拦 2：accepted（L3 send_back 重开）重派不受门禁影响。
    const acc = await platform.createWorkItem('M293', coord.attemptId, { title: '已验收', order: ORDER });
    await platform.dispatchWorkItems('M293', coord.attemptId, [acc.workItemId]);
    const ae = await platform.startExecutorAttempt('M293', acc.workItemId);
    await platform.submitEvidence('M293', ae.attemptId, { kind: 'test', summary: '绿', command: 'node --test', exitCode: 0 });
    await platform.submitExecutionResult('M293', ae.attemptId, {
      outcome: 'completed',
      summary: '做完了',
      changedFiles: ['src/foo.ts'],
      evidenceIds: [],
      notes: '无',
    });
    await platform.reviewExecutionResult('M293', coord.attemptId, {
      workItemId: acc.workItemId,
      verdict: 'accept',
      acceptanceResults: ORDER.acceptance.map((c) => ({ criterion: c, status: 'pass' as const, evidence: '核过' })),
      reasons: ['ok'],
      requiredChanges: [],
    });
    // 模拟 L3 send_back 后该 accepted 工作项被重开重派：门禁不应触发。
    await platform.dispatchWorkItems('M293', coord.attemptId, [acc.workItemId]);
    assert.equal(
      (await platform.getMissionView('M293')).workItems.find((i) => i.id === acc.workItemId)?.status,
      'dispatched',
    );
  });
});

describe('W-317 协调者简报：工作项索引 + 上一跳增量（生产接线）', () => {
  test('首次 coordinator 有索引、增量为空、plan 不变；后续 coordinator 取到提交证据增量；executor 不携带两来源', async () => {
    const { platform } = makePlatform();
    await platform.createMission({ projectId: 'P', missionId: 'W317a', contract: CONTRACT });
    const coord = await platform.startCoordinatorAttempt('W317a');
    await platform.updatePlan('W317a', coord.attemptId, PLAN);
    const { workItemId } = await platform.createWorkItem('W317a', coord.attemptId, { title: 'W', order: ORDER });
    await platform.dispatchWorkItems('W317a', coord.attemptId, [workItemId]);
    const exec = await platform.startExecutorAttempt('W317a', workItemId);
    await platform.submitEvidence('W317a', exec.attemptId, {
      kind: 'test', summary: '绿', command: 'node --test', exitCode: 0,
    });
    await platform.submitExecutionResult('W317a', exec.attemptId, {
      outcome: 'completed', summary: '改好了', changedFiles: ['src/foo.ts'], evidenceIds: [], notes: '无',
    });
    await platform.finishAttempt('W317a', exec.attemptId, { endedBy: 'structured_submit' });
    await platform.reviewExecutionResult('W317a', coord.attemptId, {
      workItemId, verdict: 'accept',
      acceptanceResults: ORDER.acceptance.map((c) => ({ criterion: c, status: 'pass' as const, evidence: '核过' })),
      reasons: ['ok'], requiredChanges: [],
    });

    const coordBrief = await platform.getStartupBrief('W317a', coord.attemptId);
    assert.deepEqual(coordBrief.plan, PLAN, 'coordinator 简报不能改动 plan');
    assert.ok(Array.isArray(coordBrief.workItemsIndex), 'coordinator 应带工作项索引');
    assert.equal(coordBrief.workItemsIndex!.length, 1);
    assert.deepEqual(coordBrief.workItemsIndex![0], {
      id: workItemId, title: 'W', status: 'accepted', attempts: 1, lastReviewVerdict: 'accept',
    });
    assert.deepEqual(coordBrief.sinceLastHop, [], '首次 coordinator 无上一跳，增量为空');

    // 收尾第一跳，开第二次 coordinator，并在两跳之间产生新活动。
    await platform.finishAttempt('W317a', coord.attemptId, { endedBy: 'structured_submit' });
    const coord2 = await platform.startCoordinatorAttempt('W317a');
    const { workItemId: w2 } = await platform.createWorkItem('W317a', coord2.attemptId, { title: 'W2', order: ORDER });
    await platform.dispatchWorkItems('W317a', coord2.attemptId, [w2]);
    const exec2 = await platform.startExecutorAttempt('W317a', w2);
    await platform.submitEvidence('W317a', exec2.attemptId, { kind: 'test', summary: '第二跳证据', command: 'node --test', exitCode: 0 });
    await platform.submitExecutionResult('W317a', exec2.attemptId, { outcome: 'completed', summary: '又改好了', changedFiles: ['src/bar.ts'], evidenceIds: [], notes: '无' });
    await platform.finishAttempt('W317a', exec2.attemptId, { endedBy: 'structured_submit' });
    await platform.reviewExecutionResult('W317a', coord2.attemptId, {
      workItemId: w2, verdict: 'accept',
      acceptanceResults: ORDER.acceptance.map((c) => ({ criterion: c, status: 'pass' as const, evidence: '核过' })),
      reasons: ['ok'], requiredChanges: [],
    });

    const coord2Brief = await platform.getStartupBrief('W317a', coord2.attemptId);
    assert.deepEqual(coord2Brief.plan, PLAN, '第二跳 plan 仍不变');
    assert.equal(coord2Brief.workItemsIndex!.length, 2, '第二跳索引含两项工作项');
    const w2Index = coord2Brief.workItemsIndex!.find((e) => e.id === w2);
    assert.deepEqual(w2Index, { id: w2, title: 'W2', status: 'accepted', attempts: 1, lastReviewVerdict: 'accept' });
    assert.ok(coord2Brief.sinceLastHop!.length >= 1, '第二跳应有上一跳增量');
    const summaries = coord2Brief.sinceLastHop!.map((e) => e.summary);
    assert.ok(
      summaries.some((s) => s.includes('提交[') && s.includes('改动1个文件')),
      `应有证据提交摘要，实际：${JSON.stringify(summaries)}`,
    );

    // 执行者简报不应携带两来源（投影与 Bundle 都没有）。
    await platform.dispatchWorkItems('W317a', coord2.attemptId, [workItemId]);
    const exec3 = await platform.startExecutorAttempt('W317a', workItemId);
    const execBrief = await platform.getStartupBrief('W317a', exec3.attemptId);
    assert.equal(execBrief.workItemsIndex, undefined);
    assert.equal(execBrief.sinceLastHop, undefined);
    assert.equal(
      execBrief.contextBundle.entries.find((e) => e.source === 'work_items_index'),
      undefined,
      'executor 的 Bundle 不得含工作项索引来源',
    );
    assert.equal(
      execBrief.contextBundle.entries.find((e) => e.source === 'since_last_hop'),
      undefined,
      'executor 的 Bundle 不得含上一跳增量来源',
    );
  });

  test('后续 coordinator 增量含证据提交与 blocked 报告摘要，plan 不变', async () => {
    const { platform } = makePlatform();
    await platform.createMission({ projectId: 'P', missionId: 'W317b', contract: CONTRACT });
    const coord = await platform.startCoordinatorAttempt('W317b');
    await platform.updatePlan('W317b', coord.attemptId, PLAN);
    const { workItemId } = await platform.createWorkItem('W317b', coord.attemptId, { title: 'W', order: ORDER });
    await platform.dispatchWorkItems('W317b', coord.attemptId, [workItemId]);
    const exec1 = await platform.startExecutorAttempt('W317b', workItemId);
    await platform.submitEvidence('W317b', exec1.attemptId, { kind: 'test', summary: '绿', command: 'node --test', exitCode: 0 });
    await platform.submitExecutionResult('W317b', exec1.attemptId, { outcome: 'completed', summary: '改好了', changedFiles: ['src/foo.ts'], evidenceIds: [], notes: '无' });
    await platform.finishAttempt('W317b', exec1.attemptId, { endedBy: 'structured_submit' });
    await platform.reviewExecutionResult('W317b', coord.attemptId, { workItemId, verdict: 'accept', acceptanceResults: ORDER.acceptance.map((c) => ({ criterion: c, status: 'pass' as const, evidence: '核过' })), reasons: ['ok'], requiredChanges: [] });
    await platform.finishAttempt('W317b', coord.attemptId, { endedBy: 'structured_submit' });

    // 第二跳：先有一个完成的提交（产生带证据的执行结果事件），再有一个 blocked 报告。
    const coord2 = await platform.startCoordinatorAttempt('W317b');
    await platform.dispatchWorkItems('W317b', coord2.attemptId, [workItemId]);
    const exec2 = await platform.startExecutorAttempt('W317b', workItemId);
    await platform.submitEvidence('W317b', exec2.attemptId, { kind: 'test', summary: '第二跳证据', command: 'node --test', exitCode: 0 });
    await platform.submitExecutionResult('W317b', exec2.attemptId, { outcome: 'completed', summary: '又改好了', changedFiles: ['src/bar.ts'], evidenceIds: [], notes: '无' });
    await platform.finishAttempt('W317b', exec2.attemptId, { endedBy: 'structured_submit' });
    await platform.reviewExecutionResult('W317b', coord2.attemptId, { workItemId, verdict: 'accept', acceptanceResults: ORDER.acceptance.map((c) => ({ criterion: c, status: 'pass' as const, evidence: '核过' })), reasons: ['ok'], requiredChanges: [] });
    await platform.dispatchWorkItems('W317b', coord2.attemptId, [workItemId]);
    const exec3 = await platform.startExecutorAttempt('W317b', workItemId);
    await platform.reportBlocked('W317b', exec3.attemptId, { reason: '依赖没装', whatWasTried: ['试过 npm i'], needsFromUpstream: '' });

    const brief = await platform.getStartupBrief('W317b', coord2.attemptId);
    assert.deepEqual(brief.plan, PLAN, 'plan 保持完整');
    const summaries = brief.sinceLastHop!.map((e) => e.summary);
    assert.ok(
      summaries.some((s) => s.includes('提交[') && s.includes('改动1个文件')),
      `应有证据提交摘要，实际：${JSON.stringify(summaries)}`,
    );
    assert.ok(
      summaries.some((s) => s.includes('卡住报告')),
      `应有 blocked 报告摘要，实际：${JSON.stringify(summaries)}`,
    );
    assert.equal(brief.workItemsIndex!.length, 1);
    const idx = brief.workItemsIndex![0];
    assert.equal(idx.id, workItemId);
    assert.equal(idx.title, 'W');
    assert.equal(idx.status, 'blocked');
    assert.equal(idx.attempts, 3);
    assert.equal(idx.lastReviewVerdict, 'accept');
  });
});
