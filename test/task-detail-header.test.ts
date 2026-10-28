/**
 * 任务详情页头投影（src/web/task-detail-header.js）。
 *
 * 只写两条：这一层最容易出的错都不报错也不崩——direct 时给主控编一个模型、把缺省
 * costCap 补成 10、把终态残留的 waitInfo 翻译成「等你处理」、把 estimated 冒充精确。
 * 每条断言对应工单里的一句验收，分支不各写一条。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { projectTaskHeader } from '../src/web/task-detail-header.js';

test('direct：原始 intent、执行中与附标分字段、主控未计且上限未知', () => {
  const header = projectTaskHeader({
    missionId: 'CUI3-task-detail-20261026',
    projectId: 'coagenthub-v5',
    status: 'executing',
    coordinationMode: 'direct',
    executionMode: 'standard',
    // 两层协作里平台看得见主控派了工，但看不见主控会话自己的花费。
    usage: { cost: 0, quality: 'unknown' },
    contract: { intent: '  修设备边界  ' },
    // 残留的等待信息不能把页头改写成「等你处理」。
    waitInfo: { owner: 'l3', autoResume: false, activeAgent: false, action: '去看' },
    openEscalations: [],
    workItems: [{ id: 'W-12', title: '补修原项 W-12' }],
    updatedAt: '2026-10-26T10:00:00.000Z',
    // 没有 costCap 这一格 = 上限未知，不是「上限是 10」。
  }, {
    createdAt: '2026-10-26T09:00:00.000Z',
    nowIso: '2026-10-26T09:30:00.000Z',
  });

  // 状态与附标各走各的字段：混进 statusText 就成了一个不存在的第七种状态。
  assert.equal(header.statusKey, 'executing');
  assert.equal(header.statusText, '执行中');
  assert.equal(header.marksText.includes('执行中'), false);
  const markKeys = header.marks.map((mark) => mark.key);
  assert.ok(markKeys.includes('direct'));
  assert.ok(markKeys.includes('repair'));

  // 原始 intent 原样给出（去掉两端空白），不从 contract 里推断别的目标。
  assert.equal(header.intent, '修设备边界');
  assert.equal(header.intentKnown, true);

  // 费用未知时不能说成 $0.00；direct 的主控花费必须挂「主控未计」。
  assert.equal(header.cost.quality, 'unknown');
  assert.equal(header.cost.cap, null);
  assert.equal(header.cost.capKnown, false);
  assert.equal(header.cost.line.includes('主控未计'), true);
  assert.equal(header.cost.line.includes('上限未知'), true);
  assert.equal(header.cost.line.includes('$10'), false);

  // 没有 L2 模型这一格：给个占位 id 就是凭空造一个事实。
  assert.equal(header.coordinatorModel, null);

  // 非终态用「现在」算时长：30 分钟。
  assert.equal(header.time.runningText, '30 分 0 秒');
  assert.equal(header.time.createdText, '2026-10-26T09:00:00.000Z');
});

test('已完成：残留 waitInfo 不改处理人，已上报费用带实际上限且不标估算', () => {
  const header = projectTaskHeader({
    missionId: 'CUI3-task-detail-20261026',
    projectId: 'coagenthub-v5',
    status: 'completed',
    coordinationMode: 'hierarchical',
    executionMode: 'standard',
    usage: { cost: 2.11, quality: 'reported' },
    costCap: 10,
    contract: { intent: '修设备边界' },
    // 终态残留的等待信息：不能让它把「已结束」说成「等你处理」。
    waitInfo: { owner: 'user', autoResume: false, activeAgent: false, action: '去答复' },
    openEscalations: [],
    workItems: [],
    updatedAt: '2026-10-26T09:45:00.000Z',
  }, {
    createdAt: '2026-10-26T09:00:00.000Z',
    // 终态不用「现在」，否则时长会随着人盯着屏幕一直变大。
    nowIso: '2026-10-26T23:59:59.000Z',
  });

  assert.equal(header.owner.key, 'none');
  assert.equal(header.owner.text, '已结束，没有待办');
  assert.equal(header.recovery.text.includes('用户'), false);
  assert.equal(header.recovery.text, '不会自动恢复');
  assert.equal(header.nextStep, '');

  // 已上报就是已上报：不带 ≈，也不能被说成估算。
  assert.equal(header.cost.quality, 'reported');
  assert.equal(header.cost.line.includes('$2.11'), true);
  assert.equal(header.cost.line.includes('≈'), false);
  assert.equal(header.cost.line.includes('部分为估算'), false);
  // 上限是内核记的真值，两位小数显式写出来。
  assert.equal(header.cost.capKnown, true);
  assert.equal(header.cost.cap, 10);
  assert.equal(header.cost.line.includes('上限 $10.00'), true);
  assert.equal(header.cost.line.includes('主控未计'), false);

  assert.equal(header.collaboration, '协作方式：三层');
  assert.equal(header.assurance, '执行保障：标准');
  assert.equal(header.direct, false);

  // 终态时长跑到 updatedAt 为止，与 nowIso 无关。
  assert.equal(header.time.runningText, '45 分 0 秒');
});
