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
  const platform = new Platform({
    projects,
    deliveries: new InMemoryDeliveryRepository(clock, ids),
    activity,
    clock,
    ids,
  });
  return { platform, activity, projects };
}

/** Standard Mission + 已写回的 Plan + 一个可派发的工作项。 */
async function standardMissionWithWorkItem() {
  const { platform, activity, projects } = makePlatform();
  await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
  const { attemptId: coord } = await platform.startCoordinatorAttempt('M1');
  await platform.updatePlan('M1', coord, PLAN);
  const { workItemId } = await platform.createWorkItem('M1', coord, { title: 'W', order: ORDER });
  return { platform, activity, projects, coord, workItemId };
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
});
