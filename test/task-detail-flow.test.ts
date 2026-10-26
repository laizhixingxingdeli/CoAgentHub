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
