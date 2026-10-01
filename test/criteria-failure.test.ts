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
  acceptance: ['连续三个失败要停派', '不加依赖'],
  constraints: ['不加依赖'],
  nonGoals: ['不重构 Y'],
  guardrails: ['不得改 Contract'],
};

function order(criteria: number[] | undefined, overrides: Partial<WorkOrder> = {}): WorkOrder {
  return {
    objective: '改 foo',
    allowedScope: ['src/foo.ts'],
    requiredBehaviour: 'foo 返回 1',
    constraints: [],
    acceptance: ['foo() === 1'],
    verification: ['node --test'],
    doNot: [],
    contextRefs: [],
    ...(criteria === undefined ? {} : { criteria }),
    ...overrides,
  };
}

function makePlatform() {
  const clock = new FixedClock();
  const activity = new InMemoryActivityLog(clock);
  const projects = new InMemoryProjectRepository();
  const ids = new SequentialIds();
  const deliveries = new InMemoryDeliveryRepository(clock, ids);
  const platform = new Platform({ projects, deliveries, activity, clock, ids });
  return { platform, activity, projects, deliveries };
}

/** 建 Mission → 写 Plan → 拿到协调者 attempt。之后每次派发前都要先交契约核对结论。 */
async function bootstrap() {
  const { platform, activity, projects, deliveries } = makePlatform();
  await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
  const { attemptId: coord } = await platform.startCoordinatorAttempt('M1');
  await platform.updatePlan('M1', coord, {
    findings: '查到了',
    rejectedHypotheses: [],
    decisions: [],
    direction: '这么改',
    risks: [],
  });
  return { platform, activity, projects, deliveries, coord };
}

/**
 * 送到「已提交、待验收」。
 *
 * 这一跳怎么结束的（`endReason`）留到提交之后才记：attempt 一旦收尾就不能再提交
 * 证据/结果，而「上次是怎么没的」正是诊断卡要读的东西——所以先交卷、再 finishAttempt。
 */
async function toSubmitted(platform: Platform, coord: string, workItemId: string, endReason: 'structured_submit' | 'upstream_failure' = 'structured_submit') {
  await platform.submitContractCheck('M1', coord, { verdict: 'ok', summary: '测试契约已核对' });
  await platform.dispatchWorkItems('M1', coord, [workItemId]);
  const { attemptId: exec } = await platform.startExecutorAttempt('M1', workItemId);
  await platform.submitEvidence('M1', exec, { kind: 'test', summary: 'node --test 全绿', command: 'node --test', exitCode: 0 });
  await platform.submitExecutionResult('M1', exec, { outcome: 'completed', summary: '改好了', changedFiles: ['src/foo.ts'], evidenceIds: [], notes: '无' });
  await platform.finishAttempt('M1', exec, {
    endedBy: endReason,
    ...(endReason === 'structured_submit' ? {} : { failureMessage: `这一跳是 ${endReason}` }),
  });
}

/**
 * 让一项「先被闸掐掉一跳、再报 blocked」地失败。
 *
 * 顺序是有讲究的：诊断卡要写「这一项上次是怎么没的」，而 endedBy 只有
 * finishAttempt 才落进事件流；reportBlocked 又只接受在途的 attempt。
 * 所以先跑掉一跳（留下 killed_* 记录），再开一跳报 blocked。
 */
async function toBlockedAfterKilled(platform: Platform, coord: string, workItemId: string, reason: string, killedBy: 'killed_idle' | 'killed_wall_clock' = 'killed_idle') {
  await platform.submitContractCheck('M1', coord, { verdict: 'ok', summary: '测试契约已核对' });
  await platform.dispatchWorkItems('M1', coord, [workItemId]);
  const first = await platform.startExecutorAttempt('M1', workItemId);
  await platform.finishAttempt('M1', first.attemptId, { endedBy: killedBy, failureMessage: `这一跳是 ${killedBy}` });
  const second = await platform.startExecutorAttempt('M1', workItemId);
  await platform.reportBlocked('M1', second.attemptId, { reason, whatWasTried: [], needsFromUpstream: '' });
}

function isRuleError(e: unknown, code: string): boolean {
  return e instanceof PlatformRuleError && (e as { code?: string }).code === code;
}

describe('同一条验收标准连续三个工作项没过（AC1）', () => {
  test('三次失败开一张可答复诊断卡并停派，答复后计数清零可重派', async () => {
    const { platform, activity, deliveries, coord } = await bootstrap();
    const a = (await platform.createWorkItem('M1', coord, { title: 'A', order: order([1]) })).workItemId;
    const b = (await platform.createWorkItem('M1', coord, { title: 'B', order: order([1]) })).workItemId;
    const c = (await platform.createWorkItem('M1', coord, { title: 'C', order: order([1]) })).workItemId;

    // ---- 建/修单时 criteria 的合法性：越界与非法整份拒绝，不留一半变更 ----
    const bad = (e: unknown) => isRuleError(e, 'BAD_WORK_ITEM_CRITERIA');
    await assert.rejects(() => platform.createWorkItem('M1', coord, { title: 'bad', order: order([9]) }), bad);
    await assert.rejects(() => platform.createWorkItem('M1', coord, { title: 'bad2', order: order([0]) }), bad);
    // 被拒的建单没有留下任何状态：工作项仍只有三条。
    assert.equal((await platform.getMissionView('M1')).workItems.length, 3);
    // 修订同理：非法 criteria 不改工单与修订号。
    const before = await platform.getMissionView('M1');
    await assert.rejects(() => platform.reviseWorkOrder('M1', coord, a, order([7])), bad);
    const after = await platform.getMissionView('M1');
    assert.equal(after.workItems.length, before.workItems.length);

    // ---- 合法关联：索引里显示序号；无关联的显示 '—' ----
    const noCriteria = (await platform.createWorkItem('M1', coord, { title: 'D', order: order(undefined) })).workItemId;
    const view = await platform.getAgentMissionView('M1');
    assert.deepEqual(view.workItemIndex.find((w) => w.id === a)?.criteria, [1], '合法关联要显示序号');
    assert.equal(view.workItemIndex.find((w) => w.id === noCriteria)?.criteria, '—', '无关联显式 —');

    // ---- 第 1 次：review reject ----
    const s1 = await toSubmitted(platform, coord, a);
    await platform.reviewExecutionResult('M1', coord, {
      workItemId: a,
      verdict: 'reject',
      reasons: ['第一版理由：没写测试'],
      requiredChanges: ['补测试'],
      acceptanceResults: [{ criterion: 'foo() === 1', status: 'fail', note: '没写测试' }],
    });
    assert.equal((await platform.getMissionView('M1')).escalations, 0, '一次失败不该开卡');

    // ---- 重复失败不凑次数：同一项 reject 之后再 retire，仍只占一个位置 ----
    await platform.retireWorkItem('M1', a, '第一项作废理由');
    assert.equal((await platform.getMissionView('M1')).escalations, 0, '同一项重复失败不能凑成两次');

    // ---- 第 2 次：retired ----
    await platform.retireWorkItem('M1', b, '第二项作废理由：契约改了');
    assert.equal((await platform.getMissionView('M1')).escalations, 0, '两次失败不该开卡');

    // ---- 第 3 次：reportBlocked。到此应当开卡并停派 ----
    await toBlockedAfterKilled(platform, coord, c, '第三项卡住理由：接口根本不存在');

    const stopped = await platform.getMissionView('M1');
    assert.equal(stopped.escalations, 1, '第三次失败应当开一张卡');
    assert.equal(stopped.openEscalations.length, 1, '卡应是可答复的（未答复）');

    // ---- 卡的内容：标准序号与原文、三项 id、每次首次计数的失败理由原文 ----
    const events = await activity.list('M1');
    const escalated = events.find((e) => e.kind === 'escalated');
    assert.ok(escalated);
    const card = escalated.data as { criteriaFailure?: boolean; criteria?: number[]; question?: string };
    assert.equal(card.criteriaFailure, true, '必须是明确的诊断卡标识，不靠文本猜');
    assert.deepEqual(card.criteria, [1]);
    const question = card.question ?? '';
    assert.ok(question.includes('1'), '卡要写明是哪一条标准');
    assert.ok(question.includes('连续三个失败要停派'), '卡要写明标准原文');
    // 三项 id 都在卡上。
    for (const id of [a, b, c]) {
      assert.ok(question.includes(id), `卡要写明工作项 ${id}`);
    }
    // 每次首次计数的失败理由原文（第二项 retire 那次的理由，不是它 reject 的）。
    assert.ok(question.includes('第一版理由：没写测试'), '第一次失败理由原文');
    assert.ok(question.includes('第二项作废理由：契约改了'), '第二次失败理由原文');
    assert.ok(question.includes('第三项卡住理由：接口根本不存在'), '第三次失败理由原文');
    // ---- 卡还要带上这些项「上次是怎么结束的」：上游失败 / 被闸掐掉 / 额度 ----
    // 卡的正文投进收件箱才是升级；这里断言信里带着记录到的结束原因，
    // 没有记录的要说未知，不编。
    const inbox = await deliveries.pending();
    const cardMail = inbox.find((d) => d.missionId === 'M1' && d.outcome === 'escalated');
    assert.ok(cardMail, '诊断卡要投递进收件箱');
    assert.ok(
      cardMail.summary.includes('killed_idle'),
      `卡要带上被闸掐掉的记录，实际：${cardMail.summary}`,
    );
    assert.ok(
      cardMail.summary.includes('未知') || cardMail.summary.includes('structured_submit'),
      '没跑过尝试的项要写明没有记录，不能编一个原因',
    );
    assert.ok(!cardMail.summary.includes('SECRET'), '进卡的内容必须过脱敏边界');

    // ---- 停派：直接派发被挡，且不留状态副作用 ----
    const beforeBlocked = await platform.getMissionView('M1');
    await assert.rejects(() => platform.dispatchWorkItems('M1', coord, [c]), (e: unknown) => isRuleError(e, 'CRITERIA_FAILURE_STOPPED'));
    const afterBlocked = await platform.getMissionView('M1');
    assert.equal(afterBlocked.workItems.length, beforeBlocked.workItems.length);
    assert.equal(
      afterBlocked.workItems.find((w) => w.id === c)?.status,
      beforeBlocked.workItems.find((w) => w.id === c)?.status,
      '被挡的派发不得改动工作项状态',
    );
    // 再失败一次也不该开第二张卡。
    await platform.retireWorkItem('M1', noCriteria, '无关联项作废');
    assert.equal((await platform.getMissionView('M1')).escalations, 1, '已有未答复诊断卡不重复开卡');

    // ---- 答复：计数清零，可修订重派 ----
    await platform.answerEscalation('M1', '这条标准拆细一点');
    assert.equal((await platform.getMissionView('M1')).openEscalations.length, 0);
    // 答复后重新可派：照 L3 给的方向修订工单，再走正式入口。
    // （不修订就原样重派是被另一条门禁挡着的，那是另一条规则。）
    await platform.reviseWorkOrder('M1', coord, c, order([1], { objective: '改 foo，按 L3 答复拆细' }));
    const dispatched = await platform.dispatchWorkItems('M1', coord, [c]);
    assert.deepEqual(dispatched.dispatched, [c], '答复后应能重新派发');

    // 清零之后：新开一项再失败一次，不该立刻又开卡（序列从头数）。
    const fresh = (await platform.createWorkItem('M1', coord, { title: 'E', order: order([1]) })).workItemId;
    await toBlockedAfterKilled(platform, coord, fresh, '答复后又卡住一次', 'killed_wall_clock');
    assert.equal((await platform.getMissionView('M1')).openEscalations.length, 0, '清零后一次失败不该开卡');
  });

  test('失败之间有关联项被验收通过则计数清零，后续失败不停派', async () => {
    const { platform, coord } = await bootstrap();
    const a = (await platform.createWorkItem('M1', coord, { title: 'A', order: order([2]) })).workItemId;
    const b = (await platform.createWorkItem('M1', coord, { title: 'B', order: order([2]) })).workItemId;
    const c = (await platform.createWorkItem('M1', coord, { title: 'C', order: order([2]) })).workItemId;
    const unrelated = (await platform.createWorkItem('M1', coord, { title: 'U', order: order(undefined) })).workItemId;

    // 第 1 次失败（关联标准 2）。
    await platform.retireWorkItem('M1', a, 'A 作废：先做别的');

    // 另一条关联项被验收通过 → 标准 2 上的连续失败清零。
    const s1 = await toSubmitted(platform, coord, b);
    await platform.reviewExecutionResult('M1', coord, {
      workItemId: b,
      verdict: 'accept',
      reasons: ['通过了'],
      requiredChanges: [],
      acceptanceResults: [{ criterion: 'foo() === 1', status: 'pass', evidence: 'node --test 退出码 0' }],
    });

    // 清零之后再来两次失败：不到三个，不该开卡、不该停。
    await platform.retireWorkItem('M1', c, 'C 作废：拆错了');
    assert.equal((await platform.getMissionView('M1')).escalations, 0, 'accept 之后两次失败不该开卡');
    // 无关联项的失败不影响任何标准。
    await platform.retireWorkItem('M1', unrelated, 'U 作废');
    assert.equal((await platform.getMissionView('M1')).escalations, 0, '无关联项失败不参与计数');

    // 没有被停派：仍能正常派发（用刚被验收通过、可再派的 b）。
    const again = await platform.dispatchWorkItems('M1', coord, [b]);
    assert.deepEqual(again.dispatched, [b], '没到三个失败就不得停派');
  });
});
