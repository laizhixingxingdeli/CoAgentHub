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

function makePlatform() {
  const clock = new FixedClock();
  const activity = new InMemoryActivityLog(clock);
  const projects = new InMemoryProjectRepository();
  const ids = new SequentialIds();
  const platform = new Platform({ projects, deliveries: new InMemoryDeliveryRepository(clock, ids), activity, clock, ids });
  return { platform, activity };
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
          verdict: 'reject',
          reasons: ['不行'],
          requiredChanges: [],
        }),
      (e: unknown) => (e as PlatformRuleError).code === 'REJECT_NEEDS_CHANGES',
    );
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
          verdict: 'accept',
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
          verdict: 'accept',
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
      verdict: 'reject',
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
