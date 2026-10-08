import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { FixedClock, InMemoryActivityLog, InMemoryProjectRepository, SequentialIds } from '../src/application/in-memory.ts';
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

/** 建 Mission → 写 Plan → 拿到协调者 attempt。 */
async function bootstrap() {
  const { platform, activity, projects, deliveries } = makePlatform();
  await platform.createMission({ projectId: 'P', missionId: 'M1', contract: CONTRACT });
  const { attemptId: coord } = await platform.startCoordinatorAttempt('M1');
  await platform.updatePlan('M1', coord, {
    findings: '查到了', rejectedHypotheses: [], decisions: [], direction: '这么改', risks: [],
  });
  return { platform, activity, projects, deliveries, coord };
}

async function dispatch(platform: Platform, coord: string, workItemId: string) {
  await platform.submitContractCheck('M1', coord, { verdict: 'ok', summary: '测试契约已核对' });
  await platform.dispatchWorkItems('M1', coord, [workItemId]);
}

/**
 * 送到「已提交、待验收」；`dispatchFirst` 为假时假定已派发（用于同一项多跳）。
 * 这一跳怎么结束的留到提交之后才记：attempt 收尾后就不能再提交证据/结果。
 */
async function toSubmitted(
  platform: Platform,
  coord: string,
  workItemId: string,
  endReason: 'structured_submit' | 'upstream_failure' = 'structured_submit',
  dispatchFirst = true,
) {
  if (dispatchFirst) await dispatch(platform, coord, workItemId);
  const { attemptId: exec } = await platform.startExecutorAttempt('M1', workItemId);
  await platform.submitEvidence('M1', exec, { kind: 'test', summary: 'node --test 全绿', command: 'node --test', exitCode: 0 });
  await platform.submitExecutionResult('M1', exec, { outcome: 'completed', summary: '改好了', changedFiles: ['src/foo.ts'], evidenceIds: [], notes: '无' });
  await platform.finishAttempt('M1', exec, {
    endedBy: endReason,
    ...(endReason === 'structured_submit' ? {} : { failureMessage: `这一跳是 ${endReason}` }),
  });
}

/**
 * 让一项「先被上游挂掉一跳、再被闸掐掉一跳、再交卷」地走完：三次结束原因都落进
 * 事件流，诊断卡要汇总**每一次**是怎么没的，只看最后一条会漏掉上游失败。
 */
async function toSubmittedAfterUpstreamAndKill(platform: Platform, coord: string, workItemId: string) {
  await dispatch(platform, coord, workItemId);
  for (const [endedBy, failureMessage] of [['upstream_failure', '上游 502'], ['killed_idle', '这一跳是 killed_idle']] as const) {
    const { attemptId } = await platform.startExecutorAttempt('M1', workItemId);
    await platform.finishAttempt('M1', attemptId, { endedBy, failureMessage });
  }
  await toSubmitted(platform, coord, workItemId, 'structured_submit', false);
}

/**
 * 诊断卡事件。**按标识找，不取「第一个 escalated」**——前面可能已经有普通升级卡。
 */
function diagnosticEvents(events: readonly { kind: string; data: unknown }[]) {
  return events.filter(
    (e) => e.kind === 'escalated' && (e.data as { criteriaFailure?: boolean } | undefined)?.criteriaFailure === true,
  );
}

function findDiagnostic(events: readonly { kind: string; data: unknown }[]) {
  const found = diagnosticEvents(events).at(0);
  assert.ok(found, '应当有一张带 criteriaFailure 标识的诊断卡');
  return found.data as { criteriaFailure?: boolean; criteria?: number[]; question?: string };
}

/**
 * 让一项「先被闸掐掉一跳、再报 blocked」地失败。顺序有讲究：endedBy 只有 finishAttempt
 * 才落进事件流；reportBlocked 又只接受在途的 attempt。
 */
async function toBlockedAfterKilled(platform: Platform, coord: string, workItemId: string, reason: string, killedBy: 'killed_idle' | 'killed_wall_clock' = 'killed_idle') {
  await dispatch(platform, coord, workItemId);
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

    // ---- 建/修单时 criteria 的合法性：越界整份拒绝，不留一半变更 ----
    const bad = (e: unknown) => isRuleError(e, 'BAD_WORK_ITEM_CRITERIA');
    await assert.rejects(() => platform.createWorkItem('M1', coord, { title: 'bad', order: order([9]) }), bad);
    await assert.rejects(() => platform.createWorkItem('M1', coord, { title: 'bad2', order: order([0]) }), bad);
    // 被拒的建单没有留下任何状态。修订同理：非法 criteria 不改工单与修订号。
    assert.equal((await platform.getMissionView('M1')).workItems.length, 3);
    const itemBefore = await platform.getAgentWorkItem('M1', a);
    await assert.rejects(() => platform.reviseWorkOrder('M1', coord, a, order([7])), bad);
    const itemAfter = await platform.getAgentWorkItem('M1', a);
    assert.deepEqual(itemAfter.order, itemBefore.order, '非法 criteria 的修订不得改动工单正文');
    assert.equal(itemAfter.orderRevision, itemBefore.orderRevision, '非法修订不得推进修订号');

    // ---- 合法关联显示序号；无关联显示 '—' ----
    const noCriteria = (await platform.createWorkItem('M1', coord, { title: 'D', order: order(undefined) })).workItemId;
    const view = await platform.getAgentMissionView('M1');
    assert.deepEqual(view.workItemIndex.find((w) => w.id === a)?.criteria, [1], '合法关联要显示序号');
    assert.equal(view.workItemIndex.find((w) => w.id === noCriteria)?.criteria, '—', '无关联显式 —');

    // ---- 第 1 次：review reject。这一项先被上游挂掉一跳、再被闸掐掉一跳 ----
    await toSubmittedAfterUpstreamAndKill(platform, coord, a);
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

    // ---- 第三次失败前先留一张**普通**（非诊断）升级卡：它不该抵掉停派 ----
    await platform.escalateToL3('M1', coord, { question: '普通问题', why: '普通原因', optionsConsidered: [] });

    // ---- 第 3 次：reportBlocked。到此应当开卡并停派 ----
    await toBlockedAfterKilled(platform, coord, c, '第三项卡住理由：接口根本不存在');

    const stopped = await platform.getMissionView('M1');
    assert.equal(stopped.escalations, 2, '普通升级之外，第三次失败应当再开一张卡');
    assert.equal(stopped.openEscalations.length, 2, '两张卡都可答复（未答复）');

    // ---- 卡的内容 ----
    const card = findDiagnostic(await activity.list('M1'));
    assert.equal(card.criteriaFailure, true, '必须是明确的诊断卡标识，不靠文本猜');
    assert.deepEqual(card.criteria, [1]);
    const question = card.question ?? '';
    // 标准序号与原文、三项 id、每次首次计数的失败理由原文，都要在卡上。
    const parts = ['1', '连续三个失败要停派', a, b, c, '第一版理由：没写测试',
      '第二项作废理由：契约改了', '第三项卡住理由：接口根本不存在'];
    for (const part of parts) assert.ok(question.includes(part), `卡要写明：${part}`);
    // ---- 卡还要带上这些项每次是怎么结束的：上游失败 / 被闸掐掉 / 额度 ----
    // 卡的正文投进收件箱才是升级；没记录的要说未知，不编。按提问找那封信
    // （收件箱里还有普通升级那封），不能取第一封。
    const cardMail = (await deliveries.pending()).find(
      (d) => d.missionId === 'M1' && d.outcome === 'escalated' && d.summary.includes(question),
    );
    assert.ok(cardMail, '诊断卡要投递进收件箱');
    const mail = cardMail.summary;
    assert.ok(mail.includes('killed_idle'), `卡要带上被闸掐掉的记录，实际：${mail}`);
    assert.ok(mail.includes('未知') || mail.includes('structured_submit'), '没跑过尝试的项要写明没有记录');
    // 较早的上游失败不能被「最后一次结束原因」盖掉。
    assert.ok(mail.includes('upstream_failure') && mail.includes('上游 502'), `卡要汇总每一次结束原因，实际：${mail}`);
    assert.ok(!mail.includes('SECRET'), '进卡的内容必须过脱敏边界');

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
    // 再失败一次也不该开第二张诊断卡。
    await platform.retireWorkItem('M1', noCriteria, '无关联项作废');
    assert.equal(diagnosticEvents(await activity.list('M1')).length, 1, '已有未答复诊断卡不重复开卡');

    // ---- 答复：先答普通卡（不该解停派），再答诊断卡（清零并可重派） ----
    await platform.answerEscalation('M1', '普通答复');
    await assert.rejects(
      () => platform.dispatchWorkItems('M1', coord, [c]),
      (e: unknown) => isRuleError(e, 'CRITERIA_FAILURE_STOPPED'),
      '答复普通卡不解除停派',
    );
    await platform.answerEscalation('M1', '这条标准拆细一点');
    assert.equal((await platform.getMissionView('M1')).openEscalations.length, 0);
    // 答复后重新可派：照 L3 给的方向修订工单，再走正式入口（原样重派是另一条门禁）。
    await platform.reviseWorkOrder('M1', coord, c, order([1], { objective: '改 foo，按 L3 答复拆细' }));
    const dispatched = await platform.dispatchWorkItems('M1', coord, [c]);
    assert.deepEqual(dispatched.dispatched, [c], '答复后应能重新派发');

    // 清零之后：新开一项再失败一次，不该立刻又开卡。
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
    await toSubmitted(platform, coord, b);
    await platform.reviewExecutionResult('M1', coord, {
      workItemId: b,
      verdict: 'accept',
      reasons: ['通过了'],
      requiredChanges: [],
      acceptanceResults: [{ criterion: 'foo() === 1', status: 'pass', evidence: 'node --test 退出码 0' }],
    });

    // 清零之后再来一个**不同**关联项失败：不到三个，不该开卡、不该停。
    await platform.retireWorkItem('M1', c, 'C 作废：拆错了');
    // 无关联项的失败不参与计数。
    await platform.retireWorkItem('M1', unrelated, 'U 作废');
    assert.equal((await platform.getMissionView('M1')).escalations, 0, 'accept 之后一次失败不该开卡');
    // 没有被停派：仍能正常派发（用刚被验收通过、可再派的 b）。
    assert.deepEqual((await platform.dispatchWorkItems('M1', coord, [b])).dispatched, [b], '没到三个失败不得停派');

    // 再一个不同关联项失败：仍是两个，不该开卡、不该停。
    const d = (await platform.createWorkItem('M1', coord, { title: 'D', order: order([2]) })).workItemId;
    await platform.retireWorkItem('M1', d, 'D 作废：也拆错了');
    assert.equal((await platform.getMissionView('M1')).escalations, 0, 'accept 之后两个不同项失败仍不该开卡');
    const fresh = (await platform.createWorkItem('M1', coord, { title: 'F', order: order([2]) })).workItemId;
    assert.deepEqual((await platform.dispatchWorkItems('M1', coord, [fresh])).dispatched, [fresh], '两个失败不得停派');
    // 无关联项失败始终不计数：此时仍是 0 张卡。
    const unrelated2 = (await platform.createWorkItem('M1', coord, { title: 'U2', order: order(undefined) })).workItemId;
    await platform.retireWorkItem('M1', unrelated2, 'U2 作废');
    assert.equal((await platform.getMissionView('M1')).escalations, 0, '无关联项重复失败仍不参与计数');
  });
});

describe('工单 validation.commands 的 argv 前置校验（COM13）', () => {
  test('无效 argv 在建单与修订时整份拒绝，正常 / 无 validation 照通过', async () => {
    const { platform, activity, coord } = await bootstrap();
    const kindCount = async (kind: string) =>
      (await activity.list('M1')).filter((e) => e.kind === kind).length;

    // 正常 argv：建单与修订都通过——不经 shell，glob 交给 Node 自己展开。
    const id = (await platform.createWorkItem('M1', coord, {
      title: 'V',
      order: order([1], { validation: { commands: [{ argv: ['node', '--test'], timeoutMs: 1000 }] } }),
    })).workItemId;
    assert.equal((await platform.getAgentWorkItem('M1', id)).orderRevision, 'r1');
    await platform.reviseWorkOrder('M1', coord, id, order([1], {
      validation: { commands: [{ argv: ['node', '--import', 'tsx', '--test', 'src/*.test.ts'], timeoutMs: 1000 }] },
    }));
    const after = await platform.getAgentWorkItem('M1', id);
    assert.equal(after.orderRevision, 'r2', '正常 argv 的修订照常推进修订号');
    // 没有 validation 的旧工单不受影响（兼容性）。
    await platform.createWorkItem('M1', coord, { title: 'no-validation', order: order([1]) });

    // 坏命令一律放在 commands[1]：下标不对就说明报错指错了那一条。
    const badArgv: readonly (readonly string[])[] = [
      [],
      [''],
      ['cmd'],
      ['cmd.exe'],
      ['sh'],
      ['bash'],
      ['powershell'],
      ['pwsh'],
      ['C:\\Windows\\System32\\cmd.exe'],
      ['/usr/bin/bash'],
      ['CMD.EXE'],
      ['Bash'],
    ];
    const itemsBefore = (await platform.getMissionView('M1')).workItems.length;
    const createdBefore = await kindCount('work_item.created');
    const revisedBefore = await kindCount('work_item.order_revised');
    const orderBefore = after.order;

    for (const argv of badArgv) {
      const bad = order([1], {
        validation: {
          commands: [
            { argv: ['node', '--test'], timeoutMs: 1000 },
            { argv: [...argv], timeoutMs: 1000 },
          ],
        },
      });
      // 空 argv 没有可执行文件可报，报错里要明说它是空的。
      const needle = argv.length === 0 ? '空' : JSON.stringify(argv[0]);
      const check = (e: unknown) => {
        if (!isRuleError(e, 'WORK_ORDER_VALIDATION_ARGV')) return false;
        const msg = (e as Error).message;
        return (
          msg.includes('commands[1]') &&
          msg.includes(needle) &&
          msg.includes('invalid argv') &&
          msg.includes('["node","--test"]')
        );
      };
      await assert.rejects(() => platform.createWorkItem('M1', coord, { title: 'bad', order: bad }), check);
      await assert.rejects(() => platform.reviseWorkOrder('M1', coord, id, bad), check);
    }

    // 被拒的建单 / 修订不留任何状态与事件副作用。
    const rejected = await platform.getAgentWorkItem('M1', id);
    assert.equal((await platform.getMissionView('M1')).workItems.length, itemsBefore, '被拒的建单不得新增工作项');
    assert.deepEqual(rejected.order, orderBefore, '被拒的修订不得改动工单正文');
    assert.equal(rejected.orderRevision, 'r2', '被拒的修订不得推进修订号');
    assert.equal(await kindCount('work_item.created'), createdBefore, '被拒的建单不得写 created 事件');
    assert.equal(await kindCount('work_item.order_revised'), revisedBefore, '被拒的修订不得写 order_revised 事件');
  });
});
