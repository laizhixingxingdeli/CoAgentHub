/**
 * 任务详情页的接线层（src/web/task-detail-controller.js）。
 *
 * 只写两条，对应本单的两条验收：
 *   1. 同一条 Mission 再进来从上次的 live 游标续拉；派生出的页面用 Mission JSON 的
 *      真实字段说话（执行中 / 处理人未知 / 自动恢复未知 / 保障标准 / 直接主控 /
 *      费用未知且上限未知），dispatched 的残留报告是「当前未交回」而不是「通过」，
 *      没有 heartbeatAt 键的一跳只说「心跳未知」。
 *   2. 换任务时晚到的响应不写到新任务的页面上；隐藏的页面不发 live 请求；
 *      别的 Attempt 的行不进实时正文。
 *
 * 这些错了浏览器都不报错：屏幕上只是「进度卡住了」「这条任务已经通过」「它又重跑了一遍」。
 *
 * 必须 import 真实的投影与视图，不 stub：本单验收的正是「把它们接对了」，stub 掉就只
 * 测了自己写的那半边。DOM 用仓库里已有的 happy-dom（经 npm workspaces 装在根
 * node_modules），不装新依赖。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Window } from 'happy-dom';

import { createTaskDetailController } from '../src/web/task-detail-controller.js';

type Timer = { fn: () => void; ms: number };

const NOW = '2026-10-26T10:00:00.000Z';

/** 一帧渲染 + 若干次 await 的落地机会：不 flush 的话断言会在响应还没写屏时就跑。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness() {
  const window = new Window({ url: 'http://127.0.0.1:3101/#/missions/M-1' });
  const document = window.document as unknown as Document;
  document.body.innerHTML = '<div id="view"></div>';
  const container = document.getElementById('view') as unknown as HTMLElement;

  const timers = new Map<number, Timer>();
  let nextTimerId = 1;
  const setInterval = (fn: () => void, ms: number): number => {
    const id = nextTimerId;
    nextTimerId += 1;
    timers.set(id, { fn, ms });
    return id;
  };
  const clearInterval = (id: number): void => {
    timers.delete(id);
  };

  const q = (selector: string) => container.querySelector(selector) as HTMLElement | null;
  const all = (selector: string) => [...container.querySelectorAll(selector)] as HTMLElement[];
  const textOf = (selector: string) => q(selector)?.textContent ?? '';

  return { window, document, container, timers, setInterval, clearInterval, q, all, textOf };
}

/** 只读的四条 GET 之外一律算错：多打一个端点就是这一页在替别的层下结论。 */
function assertOnlyAllowedPaths(paths: string[]): void {
  for (const path of paths) {
    const allowed = /^\/api\/missions\/[^/]+$/.test(path)
      || /^\/api\/missions\/[^/]+\/activity$/.test(path)
      || /^\/api\/missions\/[^/]+\/attempts\/.+$/.test(path)
      || /^\/api\/missions\/[^/]+\/live\?cursor=\d+$/.test(path);
    assert.equal(allowed, true, '发了一条不该发的请求：' + path);
  }
}

/* ============================ 夹具 ============================ */

/**
 * 一条 executing / direct / standard 的 Mission：页头那几格说的就是它。
 *
 * 工单项是 dispatched 且留着上一跳的 validationReport 与 executionResult——dispatch
 * 不清旧结果，照抄它们就是把上一跳的通过贴到这一跳头上。
 */
function missionView(): Record<string, unknown> {
  return {
    missionId: 'M-1',
    projectId: 'coagenthub-v5',
    status: 'executing',
    coordinationMode: 'direct',
    executionMode: 'standard',
    contract: { intent: '原始意图', criteria: [1, 3, 4] },
    contractRevision: 2,
    usage: { quality: 'unknown', cost: 0 },
    workItems: [
      {
        id: 'W-1',
        title: '任务详情接线',
        status: 'dispatched',
        attemptIds: ['W-1.exec-1'],
        executionResult: { summary: 'old' },
        validationReport: { reportId: 'VR-1', passed: true },
      },
    ],
    updatedAt: '2026-10-26T09:55:00.000Z',
  };
}

function missionActivity(): Array<Record<string, unknown>> {
  return [
    { kind: 'mission.created', at: '2026-10-26T09:00:00.000Z' },
    { kind: 'attempt.started', attemptId: 'W-1.exec-1', workItemId: 'W-1', at: '2026-10-26T09:50:00.000Z' },
  ];
}

/* ============================ 用例 ============================ */

test('页头用 Mission JSON 的真实字段；残留报告是当前未交回；心跳缺失只说心跳未知；游标续拉', async () => {
  const h = harness();
  const requested: string[] = [];

  async function fetchJson(path: string): Promise<unknown> {
    requested.push(path);
    if (path === '/api/missions/M-1') return missionView();
    if (path === '/api/missions/M-1/activity') return missionActivity();
    if (path === '/api/missions/M-1/attempts/W-1.exec-1') {
      // 这一跳在跑，但响应里**没有 heartbeatAt 这个键**（master 上的实际形状）。
      return { attemptId: 'W-1.exec-1', status: 'in_progress' };
    }
    if (path === '/api/missions/M-1/live?cursor=0') {
      return {
        cursor: 4,
        chunks: [{ seq: 4, missionId: 'M-1', attemptId: 'W-1.exec-1', kind: 'text', text: '行甲' }],
      };
    }
    if (path === '/api/missions/M-1/live?cursor=4') return { cursor: 4, chunks: [] };
    throw new Error('unexpected ' + path);
  }

  const controller = createTaskDetailController({
    doc: h.document,
    container: h.container,
    missionId: 'M-1',
    fetchJson,
    nowIso: () => NOW,
    setInterval: h.setInterval,
    clearInterval: h.clearInterval,
  });

  await controller.start();
  await flush();

  assertOnlyAllowedPaths(requested);

  // 页头：编号全文与原始 intent。
  assert.equal(h.textOf('.td-mission-id'), 'M-1');
  assert.equal(h.textOf('.td-intent').includes('原始意图'), true);

  // 六态 / 处理人 / 恢复方式 / 保障 / 协作 / 费用：全部来自 Mission JSON。
  assert.equal(h.textOf('.td-status-text'), '执行中');
  assert.equal(h.textOf('.td-owner'), '未知');
  assert.equal(h.textOf('.td-recovery'), '自动恢复：未知');
  assert.equal(h.textOf('.td-assurance'), '执行保障：标准');
  assert.equal(h.textOf('.td-collaboration'), '协作方式：直接主控');

  // 费用质量未知就是未知：usage.cost 上的 0 只是结构默认值，印成 $0.00 就是「不要钱」。
  const cost = h.textOf('.td-cost');
  assert.equal(cost.includes('费用未知'), true);
  assert.equal(cost.includes('上限未知'), true);
  assert.equal(cost.includes('$0.00'), false);

  // direct 时平台看不见主控会话的模型，页头不许出现编造的模型名。
  const headerText = (h.textOf('.td-header')).toLowerCase();
  assert.equal(headerText.includes('claude'), false, '页头出现了编造的协调者模型名');

  // 心跳：缺键只能显示「心跳未知」，绝不判停滞。
  assert.equal(h.textOf('.td-heartbeat'), '心跳未知');
  assert.equal(h.q('.td-heartbeat')?.getAttribute('data-stalled'), 'false');
  assert.equal(h.textOf('.td-header').includes('疑似停滞'), false);

  // 实时正文收到这一跳的行。
  assert.equal(h.textOf('.td-live-text').includes('行甲'), true);

  // 机器验证：dispatched + 残留 VR-1，是「当前未交回」，不是「通过」。
  const machine = h.q('.td-layer[data-layer="machine"]');
  assert.ok(machine, '没有机器验证那一层');
  assert.equal(machine.querySelector('[data-state]')?.getAttribute('data-state'), 'not_returned');
  assert.equal(machine.textContent?.includes('当前未交回'), true);
  assert.equal(machine.querySelector('[data-state]')?.textContent, '当前未交回');

  // 走开再回来：同一条 Mission 从上次的游标续拉，不回到 0；已经收到的行还在。
  controller.stop();
  const before = requested.length;
  const again = createTaskDetailController({
    doc: h.document,
    container: h.container,
    missionId: 'M-1',
    fetchJson,
    nowIso: () => NOW,
    setInterval: h.setInterval,
    clearInterval: h.clearInterval,
  });
  await again.start();
  await flush();

  const liveAgain = requested.slice(before).filter((path) => path.includes('/live?'));
  assert.deepEqual(liveAgain, ['/api/missions/M-1/live?cursor=4']);
  assert.equal(h.textOf('.td-live-text').includes('行甲'), true, '再次进入丢了已经收到的实时行');

  again.stop();
});

test('换任务时晚到的 view 不写到新任务页；隐藏时不发 live；别的 Attempt 的行不进实时正文', async () => {
  const h = harness();
  const requested: string[] = [];
  let visible = true;

  // M-old 的 view 请求挂在半路：它晚到的那一刻，页面已经属于 M-new 了。
  let releaseOld: (value: unknown) => void = () => {};
  const oldView = new Promise<unknown>((resolve) => {
    releaseOld = resolve;
  });

  const newView: Record<string, unknown> = {
    missionId: 'M-new',
    projectId: 'coagenthub-v5',
    status: 'executing',
    coordinationMode: 'hierarchical',
    executionMode: 'standard',
    contract: { intent: '新任务的意图' },
    usage: { quality: 'unknown', cost: 0 },
    workItems: [
      { id: 'W-9', title: '新任务工单', status: 'dispatched', attemptIds: ['M-new.exec-9'] },
    ],
    updatedAt: '2026-10-26T09:55:00.000Z',
  };

  async function fetchJson(path: string): Promise<unknown> {
    requested.push(path);
    if (path === '/api/missions/M-old') return oldView;
    if (path === '/api/missions/M-new') return newView;
    if (path === '/api/missions/M-new/activity') {
      return [
        { kind: 'mission.created', at: '2026-10-26T09:00:00.000Z' },
        { kind: 'attempt.started', attemptId: 'M-new.exec-9', workItemId: 'W-9', at: '2026-10-26T09:50:00.000Z' },
      ];
    }
    if (path === '/api/missions/M-new/attempts/M-new.exec-9') {
      return { attemptId: 'M-new.exec-9', status: 'in_progress' };
    }
    if (path === '/api/missions/M-new/live?cursor=0') {
      return {
        cursor: 7,
        chunks: [
          { seq: 6, missionId: 'M-new', attemptId: 'OTHER-1', kind: 'text', text: '别跳的行' },
          { seq: 7, missionId: 'M-new', attemptId: 'M-new.exec-9', kind: 'text', text: '新任务的行' },
        ],
      };
    }
    if (path === '/api/missions/M-new/live?cursor=7') return { cursor: 7, chunks: [] };
    throw new Error('unexpected ' + path);
  }

  const controller = createTaskDetailController({
    doc: h.document,
    container: h.container,
    missionId: 'M-old',
    fetchJson,
    nowIso: () => NOW,
    setInterval: h.setInterval,
    clearInterval: h.clearInterval,
    visible: () => visible,
  });

  // M-old 那一轮先开出去、卡在 view 上。
  void controller.start();
  await flush();

  // 换 M-new：页面从此属于新任务。
  await controller.start('M-new');
  await flush();

  assertOnlyAllowedPaths(requested);
  assert.equal(h.textOf('.td-mission-id'), 'M-new');
  assert.equal(h.textOf('.td-intent').includes('新任务的意图'), true);

  // 实时正文只收当前这一跳的行：别的 Attempt 的行混进来，人就会把上一跳的结尾
  // 当成这一跳正在跑的东西。
  const liveText = h.textOf('.td-live-text');
  assert.equal(liveText.includes('新任务的行'), true);
  assert.equal(liveText.includes('别跳的行'), false, '别的 Attempt 的行进了实时正文');

  // M-old 的 view 现在才回来：它一个字都不许上屏。
  releaseOld({
    ...missionView(),
    missionId: 'M-old',
    contract: { intent: '旧任务的意图' },
  });
  await flush();
  await flush();

  assert.equal(h.textOf('.td-mission-id'), 'M-new');
  assert.equal(h.textOf('.td-header').includes('旧任务的意图'), false, '晚到的 M-old 写到了 M-new 的页面上');
  assert.equal(h.textOf('.td-intent').includes('旧任务的意图'), false);
  assertOnlyAllowedPaths(requested);

  // 隐藏的标签页不发 live：给看不见的人烧配额，还会把恢复可见后补拉的那份盖掉。
  const beforeHidden = requested.length;
  visible = false;
  for (const timer of [...h.timers.values()]) timer.fn();
  await flush();
  await flush();
  const afterHidden = requested.slice(beforeHidden);
  assert.equal(afterHidden.length, 0, '隐藏时仍然发了请求：' + afterHidden.join(', '));
  assertOnlyAllowedPaths(requested);

  controller.stop();
});
