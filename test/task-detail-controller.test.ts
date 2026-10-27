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
 *   3. 路由离开（容器被资源页换掉 + hash 指向 #/pool）时不靠人调 stop：旧轮询与在途
 *      响应都不再把详情画回同一个容器，也不再请求该 Mission。
 *   4. 已验收的工作项按 reportId 去取已有的只读完整报告，交付区的提交时间不再是
 *      未知，受评执行与已跑命令归属到执行者；dispatched 残留报告不得去拉。
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

/**
 * 只读的 GET 之外一律算错：多打一个端点就是这一页在替别的层下结论。
 *
 * validation-reports 也在白名单里：它是已有只读 GET，交付区的「已跑命令与计数」只能从
 * 完整报告里取（Mission 视图只带简版）。
 */
function assertOnlyAllowedPaths(paths: string[]): void {
  for (const path of paths) {
    const allowed = /^\/api\/missions\/[^/]+$/.test(path)
      || /^\/api\/missions\/[^/]+\/activity$/.test(path)
      || /^\/api\/missions\/[^/]+\/attempts\/.+$/.test(path)
      || /^\/api\/missions\/[^/]+\/live\?cursor=\d+$/.test(path)
      || /^\/api\/missions\/[^/]+\/validation-reports\/[^/]+$/.test(path);
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
  // dispatched 上残留着 VR-1：那一份讲不出这一跳过没过，不得去拉它。
  assert.equal(
    requested.some((path) => path.includes('/validation-reports/')),
    false,
    'dispatched 残留报告也去拉完整报告了：' + requested.join(', '),
  );

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

test('容器被资源页接管且 hash 指向 #/pool 后，不调用 stop 也不再画回也不请求该 Mission', async () => {
  const h = harness();
  const requested: string[] = [];
  let missionGets = 0;
  let releaseMission: (value: unknown) => void = () => {};
  const hanging = new Promise<unknown>((resolve) => {
    releaseMission = resolve;
  });

  async function fetchJson(path: string): Promise<unknown> {
    requested.push(path);
    if (path === '/api/missions/M-1') {
      missionGets += 1;
      // 第二轮起挂起：这一轮就是「在途响应」，它晚到的那一刻页面已经属于资源页了。
      return missionGets > 1 ? hanging : missionView();
    }
    if (path === '/api/missions/M-1/activity') return missionActivity();
    if (path === '/api/missions/M-1/attempts/W-1.exec-1') {
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
  assert.equal(h.textOf('.td-mission-id'), 'M-1');
  assert.equal(h.textOf('.td-intent').includes('原始意图'), true);

  // stop 之后这些定时器必须一个都不再动作：停了的控制器还被指着打接口，等于没停。
  const timersBeforeLeave = [...h.timers.values()];

  // 第一道闸的场景：别的页面先把同一个容器换掉，hash 事件可能还没跑到。
  void controller.refresh();
  await flush();
  assert.equal(requested.filter((path) => path === '/api/missions/M-1').length, 2);
  const beforeLeave = requested.length;

  h.container.innerHTML = '<section id="pool-body">资源池</section>';
  h.window.location.hash = '#/pool';
  h.window.dispatchEvent(new h.window.Event('hashchange'));

  // 在途响应现在才回来，然后定时器再走一轮：两样都不许把详情画回去。
  releaseMission(missionView());
  await flush();
  await flush();
  for (const timer of timersBeforeLeave) timer.fn();
  for (const timer of [...h.timers.values()]) timer.fn();
  await flush();
  await flush();

  assert.ok(h.q('#pool-body'), '资源页被旧详情盖掉了');
  assert.equal(h.q('.td-page'), null, '容器里又长出了 .td-page');
  assert.equal(h.container.textContent?.includes('原始意图'), false, '旧详情把正文改回了 M-1');
  assert.equal(h.window.location.hash, '#/pool');

  const afterLeave = requested.slice(beforeLeave);
  assert.deepEqual(afterLeave, [], '离页后仍在请求该 Mission：' + afterLeave.join(', '));
});

/**
 * 已验收的工作项：按 reportId 去取完整报告，三处时间从 activity 对齐出来。
 *
 * 这条验的是「接线接对了」：投影本身已经在交付测试里验过，但如果页面不传 activity 与
 * 完整报告，屏幕上就永远是未知，而事实明明就在只读数据里。
 */
test('已验收：按 reportId 取完整报告，提交时间不再是未知，受评执行不是评审者', async () => {
  const h = harness();
  const requested: string[] = [];

  const view: Record<string, unknown> = {
    missionId: 'M-3',
    projectId: 'coagenthub-v5',
    status: 'executing',
    coordinationMode: 'hierarchical',
    executionMode: 'standard',
    contract: { intent: '交付证据时间' },
    usage: { quality: 'unknown', cost: 0 },
    workItems: [
      {
        id: 'W-906',
        title: '交卷证据时间',
        status: 'accepted',
        attemptIds: ['W-906.exec-1'],
        lastReview: { verdict: 'accept', attemptId: 'coord-8' },
        validationReport: { reportId: 'VR-639', passed: true },
        executionResult: { outcome: 'completed', summary: '补齐时间', changedFiles: ['src/web/a.js'] },
        order: { verification: ['node --test test/a.test.ts'] },
      },
    ],
    updatedAt: '2026-10-26T14:00:00.000Z',
  };

  const activity: Array<Record<string, unknown>> = [
    {
      kind: 'execution_result.submitted',
      at: '2026-10-26T13:29:13.113Z',
      attemptId: 'W-906.exec-1',
      workItemId: 'W-906',
      data: { orderRevision: 'r2' },
    },
    {
      kind: 'validation.reported',
      at: '2026-10-26T13:31:17.987Z',
      workItemId: 'W-906',
      data: { reportId: 'VR-639', submittedAttemptId: 'W-906.exec-1' },
    },
    {
      kind: 'review.recorded',
      at: '2026-10-26T13:33:47.061Z',
      attemptId: 'coord-8',
      workItemId: 'W-906',
      data: { verdict: 'accept' },
    },
  ];

  const fullReport: Record<string, unknown> = {
    id: 'VR-639',
    missionId: 'M-3',
    workItemId: 'W-906',
    attemptId: 'W-906.exec-1',
    passed: true,
    startedAt: '2026-10-26T13:30:00.000Z',
    endedAt: '2026-10-26T13:31:00.000Z',
    checks: [
      {
        kind: 'command',
        passed: true,
        command: { argv: ['node', '--test'], cwd: '/repo', exitCode: 0, outputTail: '# tests 2033\n# pass 2033\n' },
      },
    ],
  };

  async function fetchJson(path: string): Promise<unknown> {
    requested.push(path);
    if (path === '/api/missions/M-3') return view;
    if (path === '/api/missions/M-3/activity') return activity;
    if (path === '/api/missions/M-3/attempts/W-906.exec-1') {
      return { attemptId: 'W-906.exec-1', status: 'completed' };
    }
    if (path === '/api/missions/M-3/validation-reports/VR-639') return fullReport;
    if (path === '/api/missions/M-3/live?cursor=0') return { cursor: 0, chunks: [] };
    throw new Error('unexpected ' + path);
  }

  const controller = createTaskDetailController({
    doc: h.document,
    container: h.container,
    missionId: 'M-3',
    fetchJson,
    nowIso: () => NOW,
    setInterval: h.setInterval,
    clearInterval: h.clearInterval,
  });

  await controller.start();
  await flush();

  assertOnlyAllowedPaths(requested);
  assert.ok(
    requested.includes('/api/missions/M-3/validation-reports/VR-639'),
    '没有去取这一跳的完整报告：' + requested.join(', '),
  );

  const submissionText = h.textOf('.td-submission');
  assert.equal(submissionText.includes('提交时间未知'), false, '提交时间仍是未知：' + submissionText);
  assert.ok(submissionText.includes('W-906.exec-1'), '交卷摘要没写受评执行：' + submissionText);
  assert.equal(submissionText.includes('coord-8'), false, '交卷摘要把评审者当成了受评执行：' + submissionText);
  // 已跑命令与计数来自完整报告。
  const ran = h.all('[data-ran-command="true"]').map((el) => el.textContent || '');
  assert.deepEqual(ran, ['node --test · 全量 · tests 2033 · pass 2033']);
  assert.ok(submissionText.includes('tests 2033 · pass 2033'), '没写出计数：' + submissionText);

  // 机器层与角色层的时间也从事件对齐出来（换算成本地时刻，title 留原文）。
  const machineBox = h.q('.td-layer[data-layer="machine"] .td-layer-time');
  assert.equal(machineBox?.getAttribute('title'), '2026-10-26T13:31:17.987Z');
  const roleBox = h.q('.td-layer[data-layer="role"] .td-layer-time');
  assert.equal(roleBox?.getAttribute('title'), '2026-10-26T13:33:47.061Z');
  // 交卷摘要里的提交时间也是对应事件那一刻，原文留在 title 里可查。
  const submittedTitles = [...h.container.querySelectorAll('.td-submission .td-submission-value')]
    .map((el) => el.getAttribute('title'));
  assert.ok(submittedTitles.includes('2026-10-26T13:29:13.113Z'),
    '交卷摘要的提交时间没对上提交事件：' + JSON.stringify(submittedTitles));

  controller.stop();
});
