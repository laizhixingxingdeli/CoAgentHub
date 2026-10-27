/**
 * 工作流环节投影（src/web/task-detail-flow.js）。
 *
 * 只写两条，对应工单里两条验收：这一层的错都不报错也不崩——预铺未来环节、按样板
 * 写死「执行第 13 次」、把别的工单的事件算进当前项、把机器自动退回画成协调者
 * 的动作。夹具写在文件里，不读仓库外的 JSON（外部文件一改，测试静默换了意思）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { projectWorkflow } from '../src/web/task-detail-flow.js';

function view() {
  return {
    missionId: 'CUI3-task-detail-20261026',
    coordinationMode: 'hierarchical',
    workItems: [
      // 已验收的那张排在前面：默认选中最后一个没作废的，而不是第一项。
      { id: 'W-A', title: '补修原项', status: 'accepted', attemptIds: ['W-A.exec-1'] },
      {
        id: 'W-B',
        title: '工作流环节纯投影',
        status: 'dispatched',
        attemptIds: ['W-B.exec-1', 'W-B.exec-2'],
        order: { orderRevision: 'r3' },
        // 机器验证报告存在，但本函数不读它——它答不了「谁在哪一轮干了什么」。
        validationReport: { passed: false, failures: ['node --test 红'] },
      },
    ],
  };
}

function activity() {
  return [
    // 已验收那张的痕迹：它们在 activity 里，但不属于 W-B。
    { kind: 'attempt.started', attemptId: 'W-A.exec-1', workItemId: 'W-A', at: '2026-10-26T09:00:00.000Z', data: { kind: 'executor' } },
    { kind: 'attempt.ended', attemptId: 'W-A.exec-1', workItemId: 'W-A', at: '2026-10-26T09:10:00.000Z' },
    { kind: 'work_item.dispatched', attemptId: 'coord-1', workItemId: 'W-A', at: '2026-10-26T09:11:00.000Z' },
    // W-B 第一次执行：跑完被打回。
    { kind: 'attempt.started', attemptId: 'W-B.exec-1', workItemId: 'W-B', at: '2026-10-26T10:00:00.000Z', data: { kind: 'executor' } },
    { kind: 'attempt.ended', attemptId: 'W-B.exec-1', workItemId: 'W-B', at: '2026-10-26T10:20:00.000Z' },
    // W-B 第二次：只有 started，还在跑。
    { kind: 'attempt.started', attemptId: 'W-B.exec-2', workItemId: 'W-B', at: '2026-10-26T11:00:00.000Z', data: { kind: 'executor' } },
  ];
}

test('未指定选择：选当前未结束的工作项，环节只含它的已发生事件，当前键指向未结束的 Attempt', () => {
  const flow = projectWorkflow(view(), activity(), {});

  assert.equal(flow.selectedId, 'W-B');
  assert.equal(flow.executionCount, 2);
  assert.equal(flow.executionLabel, '已记录 2 次执行');
  assert.equal(flow.round.roundNumber, 3);
  assert.equal(flow.round.label, '第 3 轮');

  // 只收 W-B 的环节：W-A 的两次尝试与那条派发事件都不能混进来。
  assert.deepEqual(flow.stages.map((stage) => stage.attemptId), ['W-B.exec-1', 'W-B.exec-2']);
  assert.deepEqual(flow.stages.map((stage) => stage.title), ['执行第 1 次', '执行第 2 次']);
  assert.deepEqual(flow.stages.map((stage) => stage.stateText), ['已记录', '进行中']);
  // 次数只从 attemptId 解析，不按样板写死。
  assert.equal(flow.stages.some((stage) => stage.title.includes('13')), false);

  // 当前键指向没结束的那一跳；at 原样是事件里的 ISO。
  assert.equal(flow.currentKey, 'W-B.exec-2');
  assert.equal(flow.stages[1].at, '2026-10-26T11:00:00.000Z');

  // 收起时留最后 4 条，顺序仍是旧在前、新在后；没有预铺的未来环节。
  assert.equal(flow.visibleStages.length, 2);
  assert.equal(flow.visibleStages.at(-1).attemptId, 'W-B.exec-2');

  // 展开后两条都在，exec-1 仍在 exec-2 前。
  const expanded = projectWorkflow(view(), activity(), { expanded: true });
  assert.deepEqual(expanded.stages.map((stage) => stage.attemptId), ['W-B.exec-1', 'W-B.exec-2']);
  assert.equal(expanded.visibleStages.length, 2);
  assert.ok(expanded.visibleStages.findIndex((stage) => stage.attemptId === 'W-B.exec-1')
    < expanded.visibleStages.findIndex((stage) => stage.attemptId === 'W-B.exec-2'));

  // 别的已验收工单单独列出，不改动选择。
  assert.deepEqual(flow.acceptedOthers, ['W-A']);
});

test('work_item.auto_redispatched 归平台：badge 是平台，title/detail 不提协调者', () => {
  const only = [
    {
      kind: 'work_item.auto_redispatched',
      workItemId: 'W-B',
      at: '2026-10-26T11:30:00.000Z',
      data: { reason: 'validation_failed', count: 1, summary: '第二次验证仍然红' },
    },
  ];

  const flow = projectWorkflow(view(), only, {});
  const stage = flow.stages.find((row) => row.title || row.detail);
  assert.ok(stage);

  assert.equal(stage.role, 'platform');
  assert.equal(stage.badge, '平台');
  assert.equal(stage.model, null);
  // 没有 attemptId 的行不冒充一次 Attempt：它单独成行，key 带 orphan 前缀。
  assert.equal(stage.attemptId, '');
  assert.equal(stage.key, 'orphan-0');

  const said = [stage.title, stage.detail, stage.badge].join(' ');
  assert.equal(said.includes('协调者'), false);
  assert.equal(said.includes('外部主控'), false);
  assert.equal(said.includes('验证没过'), true);
});

/**
 * 实测反例（cui3-visual-truth.json）：coord-7 已经 attempt.ended，但那一条没有
 * workItemId、也不在工作项的 attemptIds 里。先按工单过滤再判结束，就会把 13:28:26
 * 已经结束的协调者一直写成「进行中」，并把最后一条已记录的环节标成当前项。
 *
 * 另一条反例：没有 attemptId 的 L3 记录也不是一次「还在跑的尝试」。
 */
test('已结束的协调者与无 attemptId 的记录都不是进行中，全结束时当前键为 null', () => {
  const v = {
    missionId: 'CUI3-task-detail-20261026',
    coordinationMode: 'hierarchical',
    workItems: [
      // 工单只记了执行者那一跳：协调者 coord-7 没有任何 workItem 侧登记。
      { id: 'W-906', title: '选择环节事实概要', status: 'dispatched', attemptIds: ['W-906.exec-1'] },
    ],
  };
  const events = [
    {
      kind: 'attempt.started',
      attemptId: 'coord-7',
      workItemId: 'W-906',
      at: '2026-10-26T13:26:16.780Z',
      data: {
        kind: 'coordinator',
        profile: { profileId: 'coordinator-grok-4.7', facts: [{ key: 'model', value: 'grok-4.7' }] },
      },
    },
    // 结束事件没有 workItemId：它只能靠 attemptId 与全量扫描对上。
    { kind: 'attempt.ended', attemptId: 'coord-7', at: '2026-10-26T13:28:26.651Z', data: { endedBy: 'structured_submit' } },
    // 没有 attemptId 的 L3 记录：不是一次尝试。
    { kind: 'review.recorded', workItemId: 'W-906', at: '2026-10-26T13:30:00.000Z', data: { verdict: 'send_back' } },
    { kind: 'attempt.started', attemptId: 'W-906.exec-1', workItemId: 'W-906', at: '2026-10-26T13:40:00.000Z', data: { kind: 'executor' } },
    { kind: 'attempt.ended', attemptId: 'W-906.exec-1', workItemId: 'W-906', at: '2026-10-26T13:50:00.000Z', data: { endedBy: 'structured_submit' } },
  ];

  const flow = projectWorkflow(v, events, { selectedWorkItemId: 'W-906' });

  const coord = flow.stages.find((stage) => stage.attemptId === 'coord-7');
  assert.ok(coord, '协调者那一跳不在环节里');
  assert.equal(coord.stateText, '已记录');
  // 结束原因原样带出，不编一句「正常结束」。
  assert.equal(coord.resultText, 'structured_submit');
  // 身份只来自本组 started 的 profile，缺的段写未知。
  assert.ok(coord.identity.includes('coordinator-grok-4.7'), coord.identity);
  assert.ok(coord.identity.includes('grok-4.7'), coord.identity);

  const orphan = flow.stages.find((stage) => stage.attemptId === '');
  assert.ok(orphan, '没有 attemptId 的记录没有单独成行');
  assert.equal(orphan.stateText, '已记录');
  assert.equal(orphan.stateText === '进行中', false);

  const exec = flow.stages.find((stage) => stage.attemptId === 'W-906.exec-1');
  assert.equal(exec.stateText, '已记录');
  // 执行者身份同样只取自己那一跳的 profile：没有记就写未知，不借协调者的。
  assert.equal(exec.identity.includes('coordinator-grok-4.7'), false);

  // 全部结束：没有当前项，不能回退到最后一条已记录的环节。
  assert.equal(flow.currentKey, null);
});

/**
 * 实测反例（coord-8）：协调者那一跳的 `attempt.started` 没有 workItemId、也不在
 * 工单的 attemptIds 里，只有它的 `review.recorded` 挂了 W-906。先按工单过滤就会把
 * started 滤掉，于是这一跳的身份退化成「协调者 · 未知 · 未知 · 未知」——而它发牌时
 * 选过哪条候选是记着的。
 *
 * 补回来只靠 attemptId：不从当前候选池推，也不把同一 attemptId 的其它全局事件拉进
 * 本组；没有 attemptId 的 L3 记录仍然是 orphan，不许给它编 profile。
 */
test('没有 workItemId 的协调者 started 按已挂上的 attemptId 补回本项，且顺序不变', () => {
  const v = {
    missionId: 'CUI3-task-detail-20261026',
    coordinationMode: 'hierarchical',
    workItems: [
      { id: 'W-906', title: '选择环节事实概要', status: 'dispatched', attemptIds: ['W-906.exec-1'] },
    ],
  };
  const events = [
    {
      kind: 'attempt.started',
      attemptId: 'coord-8',
      at: '2026-10-26T13:31:29.290Z',
      data: {
        kind: 'coordinator',
        profile: {
          profileId: 'coordinator-grok-4.7',
          facts: [
            { key: 'provider', value: 'xai' },
            { key: 'model', value: 'grok-4.7' },
            { key: 'reasoning', value: 'medium' },
          ],
        },
      },
    },
    { kind: 'review.recorded', attemptId: 'coord-8', workItemId: 'W-906', at: '2026-10-26T13:33:47.061Z', data: { verdict: 'accept' } },
    // 没有 attemptId 的 L3 记录：不是一次尝试，也不带任何 profile。
    { kind: 'review.recorded', workItemId: 'W-906', at: '2026-10-26T13:40:00.000Z', data: { verdict: 'send_back' } },
    // 另一跳协调者，从没挂到 W-906 上：补 started 不能把它一起带进来。
    { kind: 'attempt.started', attemptId: 'other-coord', at: '2026-10-26T13:45:00.000Z', data: { kind: 'coordinator', profile: { profileId: 'should-not-appear' } } },
  ];

  const flow = projectWorkflow(v, events, { selectedWorkItemId: 'W-906' });

  const coord = flow.stages.find((stage) => stage.attemptId === 'coord-8');
  assert.ok(coord, '协调者那一跳没有补进环节');
  assert.ok(coord.identity.includes('协调者'), coord.identity);
  assert.ok(coord.identity.includes('coordinator-grok-4.7'), coord.identity);
  assert.ok(coord.identity.includes('xai/grok-4.7'), coord.identity);
  assert.ok(coord.identity.includes('medium'), coord.identity);

  const orphan = flow.stages.find((stage) => stage.attemptId === '');
  assert.ok(orphan, '没有 attemptId 的记录没有单独成行');
  assert.equal(orphan.identity.includes('coordinator-grok-4.7'), false, orphan.identity);
  assert.equal(orphan.identity.includes('should-not-appear'), false, orphan.identity);

  // 没挂到本项的协调者不出现；补回来的 started 也不许落到执行者那一跳上。
  assert.equal(flow.stages.some((stage) => stage.attemptId === 'other-coord'), false);
  assert.equal(flow.stages.some((stage) => stage.attemptId === 'W-906.exec-1'), false);

  // started 在 activity 里更早，所以 coord-8 必须排在 orphan 之前（不是被追加到末尾）。
  assert.ok(
    flow.stages.findIndex((stage) => stage.attemptId === 'coord-8')
      < flow.stages.findIndex((stage) => stage.attemptId === ''),
    'coord-8 环节跑到了 orphan 之后',
  );
});
