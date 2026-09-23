/**
 * 两件在建平台过程中补上的事：
 *
 *  1. **Mission 生命周期真的被驱动了。** 之前调度器从头到尾没让 Mission 离开
 *     investigating，于是「同一 Project 同时只有一个 Mission 在改代码」这条
 *     不变量形同虚设——它挂在 executing 上，而没人走进 executing。
 *  2. **结果进收件箱。** 发起 Mission 的会话可能早关了；结果要留着等人来取，
 *     不能只打印在一个可能已经没有的控制台上。
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
import { InPlaceWorkspaceManager } from '../src/application/workspace.ts';
import { Platform, PlatformRuleError } from '../src/application/platform.ts';
import type { MissionContract, WorkOrder } from '../src/kernel/index.ts';

const CONTRACT: MissionContract = {
  intent: '修 X',
  acceptance: ['绿'],
  constraints: [],
  nonGoals: [],
  guardrails: [],
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
  findings: 'f',
  rejectedHypotheses: [],
  decisions: [],
  direction: 'd',
  risks: [],
};

function makePlatform() {
  const clock = new FixedClock();
  const ids = new SequentialIds();
  const deliveries = new InMemoryDeliveryRepository(clock, ids);
  const platform = new Platform({
    projects: new InMemoryProjectRepository(),
    deliveries,
    workspace: new InPlaceWorkspaceManager(),
    activity: new InMemoryActivityLog(clock),
    clock,
    ids,
  });
  return { platform, deliveries };
}

/** 把一个 Mission 推到「已派发」。 */
async function dispatchOne(platform: Platform, missionId: string) {
  // 真实流程里这一步由调度器在开好工作区之后做。
  await platform.recordWorkspace(missionId, {
    branch: `mission/${missionId}`,
    baseRevision: 'base0',
  });
  const { attemptId } = await platform.startCoordinatorAttempt(missionId);
  try {
    await platform.updatePlan(missionId, attemptId, PLAN);
    const { workItemId } = await platform.createWorkItem(missionId, attemptId, {
      title: 'W',
      order: ORDER,
    });
    await platform.dispatchWorkItems(missionId, attemptId, [workItemId]);
    return { attemptId, workItemId };
  } catch (error) {
    // 派发被拒也要收尾这次 attempt——调度器就是这么做的（finally 里收尾）。
    // 不收尾的话不变量 B 会把这个 Mission 后续的协调者尝试全挡死。
    await platform.finishAttempt(missionId, attemptId, { endedBy: 'no_structured_result' });
    throw error;
  }
}

describe('改动名额：同一 Project 同时只有一个 Mission 在改代码', () => {
  test('派发即占用名额，Mission 进入 executing', async () => {
    const { platform } = makePlatform();
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
    assert.equal((await platform.getMissionView('M1')).isMutating, false);

    await dispatchOne(platform, 'M1');

    const view = await platform.getMissionView('M1');
    assert.equal(view.status, 'executing');
    assert.equal(view.isMutating, true);
  });

  test('同 Project 的第二个 Mission 不能派发，但可以继续调查与规划', async () => {
    const { platform } = makePlatform();
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
    await platform.createMission({ projectId: 'P', missionId: 'M2', contract: CONTRACT });
    await dispatchOne(platform, 'M1');

    // M2 照样能调查、写计划、建工作项——只是不能真的动代码。
    const { attemptId } = await platform.startCoordinatorAttempt('M2');
    await platform.updatePlan('M2', attemptId, PLAN);
    const { workItemId } = await platform.createWorkItem('M2', attemptId, {
      title: 'W',
      order: ORDER,
    });

    await assert.rejects(
      () => platform.dispatchWorkItems('M2', attemptId, [workItemId]),
      (e: unknown) => (e as PlatformRuleError).code === 'PROJECT_BUSY',
    );

    // 被拒绝的派发不留下半套流转。
    const view = await platform.getMissionView('M2');
    assert.equal(view.status, 'investigating');
    assert.equal(view.workItems[0].status, 'created', '工作项不该被改成 dispatched');
  });

  test('不同 Project 互不影响', async () => {
    const { platform } = makePlatform();
    await platform.createMission({ projectId: 'P1', missionId: 'M1', contract: CONTRACT });
    await platform.createMission({ projectId: 'P2', missionId: 'M2', contract: CONTRACT });
    await dispatchOne(platform, 'M1');
    await dispatchOne(platform, 'M2');
    assert.equal((await platform.getMissionView('M1')).isMutating, true);
    assert.equal((await platform.getMissionView('M2')).isMutating, true);
  });

  test('交卷不放名额；L3 放行之后下一个 Mission 才排得上', async () => {
    const { platform } = makePlatform();
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
    await platform.createMission({ projectId: 'P', missionId: 'M2', contract: CONTRACT });
    const first = await dispatchOne(platform, 'M1');

    const exec = await platform.startExecutorAttempt('M1', first.workItemId);
    // S11.1：completed 必须有证据撑着，平台会拦下没证据的提交。
    await platform.submitEvidence('M1', exec.attemptId, {
      kind: 'test',
      summary: 'node --test 全绿',
      command: 'node --test',
      exitCode: 0,
    });
    await platform.submitExecutionResult('M1', exec.attemptId, {
      outcome: 'completed',
      summary: 's',
      changedFiles: [],
      evidenceIds: [],
      notes: '无',
    });
    await platform.finishAttempt('M1', exec.attemptId, { endedBy: 'structured_submit' });
    await platform.reviewExecutionResult('M1', first.attemptId, {
      workItemId: first.workItemId,
      verdict: 'accept', acceptanceResults: ORDER.acceptance.map((criterion) => ({ criterion, status: 'pass' as const, evidence: '测试替身：逐条核过' })),
      reasons: ['复跑过'],
      requiredChanges: [],
    });
    await platform.submitMissionResult('M1', first.attemptId, {
      outcome: 'delivered',
      summary: '好了',
      acceptanceEvidence: [],
      memoryDelta: [],
      openRisks: [],
    });

    // 交卷只到 awaiting_review，名额仍然握着：改动还在未合并的分支上。
    assert.equal((await platform.getMissionView('M1')).status, 'awaiting_review');
    assert.equal((await platform.getMissionView('M1')).isMutating, true);
    await assert.rejects(
      () => dispatchOne(platform, 'M2'),
      (e: unknown) => (e as PlatformRuleError).code === 'PROJECT_BUSY',
    );

    // L3 放行 → 落地 → 名额释放 → M2 排得上。
    await platform.finalizeMission('M1', {
      verdict: 'merge',
      reasons: ['ok'],
      projectRoot: process.cwd(),
    });
    assert.equal((await platform.getMissionView('M1')).status, 'completed');
    await dispatchOne(platform, 'M2');
    assert.equal((await platform.getMissionView('M2')).isMutating, true);
  });

  test('交 blocked 之后 L3 放弃，名额释放', async () => {
    const { platform } = makePlatform();
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
    await platform.createMission({ projectId: 'P', missionId: 'M2', contract: CONTRACT });
    const first = await dispatchOne(platform, 'M1');
    await platform.submitMissionResult('M1', first.attemptId, {
      outcome: 'blocked',
      summary: '卡住了',
      acceptanceEvidence: [],
      memoryDelta: [],
      openRisks: [],
    });
    assert.equal((await platform.getMissionView('M1')).status, 'awaiting_review');
    await platform.finalizeMission('M1', { verdict: 'abandon', reasons: ['确实做不了'] });
    assert.equal((await platform.getMissionView('M1')).status, 'blocked');
    await dispatchOne(platform, 'M2');
  });
});

describe('投递收件箱', () => {
  test('交卷生成一条待取投递，收件人取自 OriginChannel', async () => {
    const { platform, deliveries } = makePlatform();
    await platform.createMission({
      projectId: 'P',
      missionId: 'M1',
      contract: CONTRACT,
      origin: { clientType: 'claude-code', conversationRef: 'conv-42' },
    });
    const { attemptId } = await platform.startCoordinatorAttempt('M1');
    await platform.submitMissionResult('M1', attemptId, {
      outcome: 'delivered',
      summary: '查完了，不用改',
      acceptanceEvidence: [],
      memoryDelta: [],
      openRisks: [],
    });

    assert.equal((await platform.getMissionView('M1')).status, 'awaiting_review');
    const pending = await deliveries.pending('conv-42');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].missionId, 'M1');
    assert.equal(pending[0].outcome, 'delivered');
    assert.equal(pending[0].status, 'pending');
    // 收件人不对的查不到——收件箱是按人隔离的。
    assert.equal((await deliveries.pending('别人')).length, 0);
  });

  test('确认之后就不在待取列表里，且重复确认幂等', async () => {
    const { platform, deliveries } = makePlatform();
    await platform.createMission({
      projectId: 'P',
      missionId: 'M1',
      contract: CONTRACT,
      origin: { clientType: 'cli', conversationRef: 'c1' },
    });
    const { attemptId } = await platform.startCoordinatorAttempt('M1');
    await platform.submitMissionResult('M1', attemptId, {
      outcome: 'blocked',
      summary: '卡住',
      acceptanceEvidence: [],
      memoryDelta: [],
      openRisks: [],
    });

    const [delivery] = await deliveries.pending('c1');
    const first = await deliveries.acknowledge(delivery.id);
    assert.equal(first?.status, 'acknowledged');
    assert.equal((await deliveries.pending('c1')).length, 0);

    // Host 重发 ack 比丢 ack 常见得多，必须幂等。
    const again = await deliveries.acknowledge(delivery.id);
    assert.equal(again?.status, 'acknowledged');
    assert.equal(again?.acknowledgedAt, first?.acknowledgedAt);
  });

  test('没有 origin 的 Mission 结果也不丢，只是没有收件人', async () => {
    const { platform, deliveries } = makePlatform();
    await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
    const { attemptId } = await platform.startCoordinatorAttempt('M1');
    await platform.submitMissionResult('M1', attemptId, {
      outcome: 'delivered',
      summary: '没人认领但结果还在',
      acceptanceEvidence: [],
      memoryDelta: [],
      openRisks: [],
    });
    const all = await deliveries.pending();
    assert.equal(all.length, 1);
    assert.equal(all[0].recipient, 'unknown');
  });
});
