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
  const deliveries = new InMemoryDeliveryRepository(clock, ids);
  const platform = new Platform({ projects, deliveries, activity, clock, ids });
  return { platform, activity, projects, deliveries };
}

/** 直接拿活对象：数「卡/投递/事件」必须以内存里的真实引用为准，不看投影。 */
async function liveMission(projects: InMemoryProjectRepository) {
  const project = await projects.get('P');
  assert.ok(project);
  const mission = project.missions.find((m) => m.id === 'M1');
  assert.ok(mission);
  return mission;
}

function countKind(events: readonly { kind: string }[], kind: string) {
  return events.filter((event) => event.kind === kind).length;
}

/** Standard Mission + 已写回的 Plan + 一个可派发的工作项。 */
async function standardMissionWithWorkItem() {
  const { platform, activity, projects, deliveries } = makePlatform();
  await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
  const { attemptId: coord } = await platform.startCoordinatorAttempt('M1');
  await platform.updatePlan('M1', coord, PLAN);
  const { workItemId } = await platform.createWorkItem('M1', coord, { title: 'W', order: ORDER });
  return { platform, activity, projects, deliveries, coord, workItemId };
}

async function workItemStatus(projects: InMemoryProjectRepository, workItemId: string) {
  const project = await projects.get('P');
  assert.ok(project);
  const mission = project.missions.find((m) => m.id === 'M1');
  assert.ok(mission);
  const item = mission.workItem(workItemId);
  assert.ok(item);
  return item.status;
}

describe('Standard 派发前的契约核对门禁', () => {
  test('缺当前修订的核对结论时任何派发副作用之前就拒绝；旧修订的 ok 不解闸，当前修订 ok 后放行', async () => {
    const { platform, activity, projects, coord, workItemId } = await standardMissionWithWorkItem();

    await assert.rejects(
      platform.dispatchWorkItems('M1', coord, [workItemId]),
      (e: unknown) => e instanceof PlatformRuleError && e.code === 'CONTRACT_CHECK_REQUIRED',
    );
    // 被拒的调用不留半套流转：工作项还在 created，也没有派发事件。
    assert.equal(await workItemStatus(projects, workItemId), 'created');
    assert.equal(
      (await activity.list('M1')).filter((e) => e.kind === 'work_item.dispatched').length,
      0,
    );

    await platform.submitContractCheck('M1', coord, { verdict: 'ok', summary: '四条都核过' });
    // 协调者简报显示当前修订核对结论（未重新核对前旧修订的解闸不发生）。
    const briefR1 = await platform.getStartupBrief('M1', coord);
    assert.deepEqual(briefR1.contractCheck, {
      contractRevision: 1,
      verdict: 'ok',
      summary: '四条都核过',
    });
    // 契约改到 r2 之后，r1 的 ok 不能给 r2 解闸。
    await platform.reviseContract('M1', { ...CONTRACT, acceptance: ['测试全绿', 'foo 返回 1'] });
    // 改到 r2 后重读简报：没有当前修订核对，旧 r1 结论不出现。
    const briefR2Pending = await platform.getStartupBrief('M1', coord);
    assert.equal(briefR2Pending.contractCheck, undefined);
    await assert.rejects(
      platform.dispatchWorkItems('M1', coord, [workItemId]),
      (e: unknown) => e instanceof PlatformRuleError && e.code === 'CONTRACT_CHECK_REQUIRED',
    );
    assert.equal(await workItemStatus(projects, workItemId), 'created');

    await platform.submitContractCheck('M1', coord, { verdict: 'ok', summary: 'r2 四条都核过' });
    const briefR2 = await platform.getStartupBrief('M1', coord);
    assert.deepEqual(briefR2.contractCheck, {
      contractRevision: 2,
      verdict: 'ok',
      summary: 'r2 四条都核过',
    });
    const { dispatched } = await platform.dispatchWorkItems('M1', coord, [workItemId]);
    assert.deepEqual(dispatched, [workItemId]);
    assert.equal(await workItemStatus(projects, workItemId), 'dispatched');
    // 执行者简报不含该来源：避免它以为上一层已替它核对过。
    const { attemptId: exec } = await platform.startExecutorAttempt('M1', workItemId);
    const execBrief = await platform.getStartupBrief('M1', exec);
    assert.equal(execBrief.contextBundle.entries.some((e) => e.source === 'contract_check'), false);
  });

  test('issues 开出一条可答复升级并拒派；仅该次升级答复「照原契约做」后放行', async () => {
    const { platform, projects, coord, workItemId } = await standardMissionWithWorkItem();

    await platform.submitContractCheck('M1', coord, {
      verdict: 'issues',
      summary: '第 2 条验收点名的文件不在 allowedScope 里',
      issues: ['验收 2 涉及 src/bar.ts，但工单 allowedScope 只有 src/foo.ts'],
    });

    // 简报含 issues 提交的核对结论，含 issues 与升级索引。
    const brief = await platform.getStartupBrief('M1', coord);
    assert.deepEqual(brief.contractCheck, {
      contractRevision: 1,
      verdict: 'issues',
      summary: '第 2 条验收点名的文件不在 allowedScope 里',
      issues: ['验收 2 涉及 src/bar.ts，但工单 allowedScope 只有 src/foo.ts'],
      escalationIndex: 0,
    });
    // 升级确实开出来了，而且是待答复的：L3 看得到、答得上。
    const project = await projects.get('P');
    assert.ok(project);
    const mission = project.missions.find((m) => m.id === 'M1');
    assert.ok(mission);
    assert.equal(mission.escalations.length, 1);
    assert.equal(mission.openEscalations.length, 1);

    await assert.rejects(
      platform.dispatchWorkItems('M1', coord, [workItemId]),
      (e: unknown) => e instanceof PlatformRuleError && e.code === 'CONTRACT_CHECK_ISSUES_PENDING',
    );
    assert.equal(await workItemStatus(projects, workItemId), 'created');

    // 带空白：门禁 trim 之后准确等于「照原契约做」才放行。
    await platform.answerEscalation('M1', '  照原契约做  ');
    const { dispatched } = await platform.dispatchWorkItems('M1', coord, [workItemId]);
    assert.deepEqual(dispatched, [workItemId]);
    assert.equal(await workItemStatus(projects, workItemId), 'dispatched');
  });

  test('同一 Attempt 已开普通升级后手动升级被拒且零副作用，答复后同一 Attempt 可再升级', async () => {
    const { platform, activity, projects, deliveries, coord } = await standardMissionWithWorkItem();

    await platform.submitContractCheck('M1', coord, {
      verdict: 'issues',
      summary: '验收 2 点名的文件不在范围内',
      issues: ['验收 2 涉及 src/bar.ts'],
    });
    assert.equal((await liveMission(projects)).escalations.length, 1, 'issues 自动升级开出一张卡');
    const baselineDeliveries = (await deliveries.listForMission('M1')).length;
    const baselineEscalated = countKind(await activity.list('M1'), 'escalated');
    assert.equal(baselineDeliveries, 1);
    assert.equal(baselineEscalated, 1);

    // 同 Attempt 再手动升级：必须被拒，且错误指向已有那张卡、说明它是核对自动开的。
    await assert.rejects(
      platform.escalateToL3('M1', coord, { question: '同一跳再问一次', why: 'w', optionsConsidered: [] }),
      (e: unknown) =>
        e instanceof PlatformRuleError &&
        e.code === 'ESCALATION_ALREADY_OPEN' &&
        /第 1 条/.test(e.message) &&
        /契约核对/.test(e.message) &&
        /等 L3 答复/.test(e.message),
    );
    // 零副作用：卡、escalated 事件、投递一个都不涨。
    assert.equal((await liveMission(projects)).escalations.length, 1);
    assert.equal((await deliveries.listForMission('M1')).length, baselineDeliveries);
    assert.equal(countKind(await activity.list('M1'), 'escalated'), baselineEscalated);

    // 答复之后同一 Attempt 再升级照常开新卡（已答复的不算「已开」）。
    await platform.answerEscalation('M1', '照原契约做');
    await platform.escalateToL3('M1', coord, { question: '答复后的新问题', why: 'w', optionsConsidered: [] });
    assert.equal((await liveMission(projects)).escalations.length, 2);
    assert.equal((await deliveries.listForMission('M1')).length, baselineDeliveries + 1);
  });

  test('手动升级后同 Attempt 的 issues 核对复用原索引且保留核对事件；不同 Attempt 与门禁/诊断卡不被误去重', async () => {
    const { platform, activity, projects, deliveries, coord } = await standardMissionWithWorkItem();

    // 先手动升级：历史第 1 条（index 0）。
    await platform.escalateToL3('M1', coord, { question: '范围需要 L3 定', why: 'w', optionsConsidered: [] });
    const afterManual = countKind(await activity.list('M1'), 'escalated');

    await platform.submitContractCheck('M1', coord, {
      verdict: 'issues',
      summary: '第 2 条验收对不上',
      issues: ['验收 2 涉及 src/bar.ts'],
    });
    // 不再开第二张：卡、escalated、投递都不涨，而且核对事件照常记下并指回原有那张。
    assert.equal((await liveMission(projects)).escalations.length, 1);
    assert.equal(countKind(await activity.list('M1'), 'escalated'), afterManual);
    assert.equal((await deliveries.listForMission('M1')).length, 1);
    const check = (await activity.list('M1')).filter((e) => e.kind === 'contract_check.submitted').at(-1);
    assert.deepEqual((check?.data as { verdict?: string }).verdict, 'issues');
    assert.equal((check?.data as { escalationIndex?: number }).escalationIndex, 0, '核对事件指回已有那张');
    const brief = await platform.getStartupBrief('M1', coord);
    assert.equal(brief.contractCheck?.escalationIndex, 0);

    // 此刻手动升级的消息要点明来源是契约核对自动升级。
    await assert.rejects(
      platform.escalateToL3('M1', coord, { question: '再问', why: 'w', optionsConsidered: [] }),
      (e: unknown) => e instanceof PlatformRuleError && e.code === 'ESCALATION_ALREADY_OPEN' && /契约核对/.test(e.message),
    );

    // 不同 Attempt 不受影响：收尾旧的、开新的协调者跳。
    await platform.finishAttempt('M1', coord, { endedBy: 'structured_submit' });
    const { attemptId: coord2 } = await platform.startCoordinatorAttempt('M1');

    // 平台门禁卡与诊断卡既不是「普通」升级，不该把同一 Attempt 的真升级顶掉：
    // 两张机制卡都开着，coord2 仍能开出自己的普通升级。
    const mission = await liveMission(projects);
    mission.recordEscalation({
      attemptId: coord2,
      question: '票级费用到顶，是否加预算？',
      why: 'w',
      optionsConsidered: [],
      platformGate: { kind: 'cost_cap', threshold: 10 },
    });
    const diagnosticQuestion = '标准 1 连续三个工作项没过';
    mission.recordEscalation({ attemptId: coord2, question: diagnosticQuestion, why: 'w', optionsConsidered: [] });
    await activity.append({
      projectId: 'P', missionId: 'M1', attemptId: coord2, kind: 'escalated',
      data: { question: diagnosticQuestion, criteriaFailure: true, criteria: [1] },
    });
    const beforeManual = (await liveMission(projects)).escalations.length;
    await platform.escalateToL3('M1', coord2, { question: '门禁/诊断之外的真问题', why: 'w', optionsConsidered: [] });
    assert.equal((await liveMission(projects)).escalations.length, beforeManual + 1, '门禁卡与诊断卡都不参与去重');

    // 同一 Attempt 已有普通升级之后，再升级就被拒——不同 Attempt 那条不影响（上面刚成功）。
    await assert.rejects(
      platform.escalateToL3('M1', coord2, { question: '又来一张', why: 'w', optionsConsidered: [] }),
      (e: unknown) => e instanceof PlatformRuleError && e.code === 'ESCALATION_ALREADY_OPEN',
    );
    assert.equal((await liveMission(projects)).escalations.length, beforeManual + 1);
  });
});
