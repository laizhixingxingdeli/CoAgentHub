/**
 * 「当前实时输出 / 历史选择」两区的渲染层（src/web/task-detail-output-view.js）。
 *
 * 只写两条，对应验收的两条：
 *   1. 历史 Attempt 与当前实时输出的 id 可以不同；实时正文只含当前那一跳的行，
 *      历史正文缺失显示未知，文件与用量面板不借用实时行、任务累计或 missionDiff。
 *   2. 心跳的三种结论（不适用 / 疑似停滞 / 未知）由投影给出，本层只渲染：
 *      已结束不说停滞，缺失或非法时间只说未知且 stalled 不为真。
 *
 * 这些错了浏览器都不报错：屏幕上看着都挺合理，只是把上一跳的结尾、或者整条任务的
 * 累计数，说成了这一跳的。
 *
 * 必须 import 真实 projectOutputBinding，不 stub stalled：本单的验收正是「渲染投影」，
 * stub 掉就等于只测了自己写的那半边，投影改了会静默失配。
 *
 * 夹具写在文件里，不读仓库外的 JSON（外部文件一改，测试静默换了意思）。DOM 用仓库
 * 里已有的 happy-dom（经 npm workspaces 装在根 node_modules），不装新依赖。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Window } from 'happy-dom';

import { bindTaskOutput, taskOutputHtml } from '../src/web/task-detail-output-view.js';

const window = new Window({ url: 'http://127.0.0.1:3101/#/missions/CUI3-task-detail-20261026' });
const document = window.document as unknown as Document;

function mount(input: Record<string, unknown>, options: Record<string, unknown> = {}) {
  document.body.innerHTML = '<div id="view"></div>';
  const container = document.getElementById('view') as unknown as HTMLElement;
  container.innerHTML = taskOutputHtml(input, options);
  const root = container.querySelector('.td-output') as HTMLElement;
  assert.ok(root, '没有渲染出输出区根节点');
  bindTaskOutput(root);
  const q = (selector: string) => root.querySelector(selector) as HTMLElement | null;
  const all = (selector: string) => [...root.querySelectorAll(selector)] as HTMLElement[];
  return { container, root, q, all };
}

const click = (el: Element | null): void => {
  assert.ok(el, '要点的元素不在页面上');
  el.dispatchEvent(new window.Event('click', { bubbles: true }) as unknown as Event);
};

/** 面板是否可见：hidden 属性是唯一依据，不看 CSS（测试里没有层叠上下文）。 */
const shown = (el: HTMLElement | null): boolean => el !== null && !el.hasAttribute('hidden');

test('实时输出认当前 Attempt、历史选择认选中的那跳：缺失正文为未知，文件与用量不借别的账', () => {
  const { root, q, all } = mount({
    currentAttemptId: 'W-1.exec-2',
    selectedAttemptId: 'W-1.exec-1',
    nowIso: '2026-10-26T10:00:00.000Z',
    currentAttempt: {
      attemptId: 'W-1.exec-2',
      status: 'in_progress',
      heartbeatAt: '2026-10-26T09:59:50.000Z',
    },
    // 选中的历史这一跳详情没取到：正文、用量、文件都只能「未知」。
    selectedAttempt: null,
    liveChunks: [
      { attemptId: 'W-1.exec-2', text: '当前' },
      { attemptId: 'W-1.exec-1', text: '旧行' },
    ],
    // 任务累计用量与任务级改动清单都不能拿来冒充这一跳的。
    missionUsage: { cost: 9, quality: 'reported' },
    missionDiff: ['src/a.js'],
    executionResult: { output: '任务级输出' },
  });

  // 两个 id 各自独立：这正是「左实时、右历史」互不串账的凭据。
  assert.equal(q('.td-live')?.getAttribute('data-live-attempt'), 'W-1.exec-2');
  assert.equal(q('.td-history')?.getAttribute('data-history-attempt'), 'W-1.exec-1');

  // 实时正文只含当前这一跳的行：上一跳的行混进来会被读成这一跳正在跑的内容。
  const liveText = q('.td-live-text')?.textContent || '';
  assert.ok(liveText.includes('当前'), '实时正文缺当前这一跳的内容：' + liveText);
  assert.equal(liveText.includes('旧行'), false, '实时正文混进了别的 Attempt 的行：' + liveText);
  assert.equal(q('.td-live-title')?.textContent, '当前实时输出');

  // 默认在概要：历史正文缺失必须明说未知，且不能改显示实时行或任务级输出。
  assert.equal(root.getAttribute('data-side'), 'summary');
  const summary = q('[data-panel="summary"]');
  assert.ok(shown(summary), '默认应当显示概要面板');
  const summaryText = summary?.textContent || '';
  assert.ok(summaryText.includes('未知'), '概要没说清历史正文未知：' + summaryText);
  assert.equal(summaryText.includes('当前'), false, '概要借用了实时行：' + summaryText);
  assert.equal(summaryText.includes('任务级输出'), false, '概要借用了任务级输出：' + summaryText);

  // 三个页签的文案与选中态。
  assert.deepEqual(all('[data-side]').map((el) => el.textContent), ['概要', '文件', '用量']);
  assert.deepEqual(all('[data-side]').map((el) => el.getAttribute('aria-selected')), ['true', 'false', 'false']);

  // 点用量：活的那一路仍属于当前这一跳，用量面板不含任务累计的 9。
  click(q('[data-side="usage"]'));
  assert.equal(root.getAttribute('data-side'), 'usage');
  assert.equal(q('.td-live')?.getAttribute('data-live-attempt'), 'W-1.exec-2', '切页签改了实时输出归属');
  assert.equal(q('[data-live-attempt] .td-live-text')?.textContent, liveText, '切页签改了实时正文');
  const usage = q('[data-panel="usage"]');
  assert.ok(shown(usage), '点了用量但用量面板不可见');
  assert.equal(shown(q('[data-panel="summary"]')), false, '点了用量但概要面板还可见');
  const usageText = usage?.textContent || '';
  assert.equal(usageText.includes('9'), false, '用量面板借用了任务累计用量：' + usageText);
  assert.ok(usageText.includes('未知'), '用量缺失时没有说未知：' + usageText);
  assert.deepEqual(all('[data-side]').map((el) => el.getAttribute('aria-selected')), ['false', 'false', 'true']);

  // 点文件：不列 missionDiff 的路径，明确说这一跳没有单独的文件清单。
  click(q('[data-side="files"]'));
  assert.equal(q('.td-live')?.getAttribute('data-live-attempt'), 'W-1.exec-2');
  const files = q('[data-panel="files"]');
  assert.ok(shown(files), '点了文件但文件面板不可见');
  const filesText = files?.textContent || '';
  assert.equal(filesText.includes('src/a.js'), false, '文件面板借用了 missionDiff：' + filesText);
  assert.ok(filesText.includes('该尝试没有单独的文件清单'), '文件面板没说明为什么没有清单：' + filesText);
  assert.deepEqual(all('[data-panel]').map((el) => el.getAttribute('data-panel')), ['summary', 'files', 'usage']);
  assert.deepEqual(all('[data-panel]').map(shown), [false, true, false]);
});

test('心跳只渲染投影的结论：已结束不适用，超窗口才疑似停滞，缺失或非法只说未知', () => {
  /** nowIso 写死，绝不用当前时间：用 now 的话「早 100 秒」会随运行时刻自己失效。 */
  const NOW = '2026-10-26T10:00:00.000Z';
  const render = (status: string | null, heartbeatAt: unknown) => mount({
    currentAttemptId: 'W-1.exec-3',
    selectedAttemptId: 'W-1.exec-3',
    nowIso: NOW,
    currentAttempt: { attemptId: 'W-1.exec-3', status, heartbeatAt },
    selectedAttempt: null,
    liveChunks: [],
  });

  // 已结束：心跳再旧也只能说「不适用」。读成停滞会让人去重启一个已经交回结果的环节。
  const done = render('succeeded', '2026-10-26T08:00:00.000Z');
  const doneBeat = done.q('.td-heartbeat');
  assert.ok(doneBeat, '没有心跳节点');
  assert.equal(doneBeat.textContent, '心跳不适用');
  assert.equal(doneBeat.getAttribute('data-stalled'), 'false');

  // 进行中、比 now 早 100 秒（> 90000ms）：疑似停滞。判定来自投影，本层不重算窗口。
  const stale = render('in_progress', '2026-10-26T09:58:20.000Z');
  const staleBeat = stale.q('.td-heartbeat');
  assert.equal(staleBeat?.textContent, '疑似停滞');
  assert.equal(staleBeat?.getAttribute('data-stalled'), 'true');

  // 进行中、比 now 早 10 秒：不算停滞，原样带出 ISO，便于人自己核对心掉在哪一刻。
  const fresh = render('in_progress', '2026-10-26T09:59:50.000Z');
  const freshBeat = fresh.q('.td-heartbeat');
  assert.equal(freshBeat?.getAttribute('data-stalled'), 'false');
  assert.ok((freshBeat?.textContent || '').includes('2026-10-26T09:59:50.000Z'),
    '新鲜心跳没带出时间：' + (freshBeat?.textContent || ''));

  // 缺失、空串、读不出来：只能「心跳未知」，且绝不能把 stalled 判真。
  for (const heartbeatAt of [undefined, null, '', 'not-a-time']) {
    const { q } = render('in_progress', heartbeatAt);
    const beat = q('.td-heartbeat');
    assert.ok(beat, '没有心跳节点');
    assert.equal(beat.textContent, '心跳未知', '心跳 ' + String(heartbeatAt) + ' 的文案不对：' + beat.textContent);
    assert.equal(beat.getAttribute('data-stalled'), 'false',
      '心跳 ' + String(heartbeatAt) + ' 被判成了停滞');
    assert.equal((q('.td-output')?.textContent || '').includes('疑似停滞'), false,
      '心跳 ' + String(heartbeatAt) + ' 的页面里出现了「疑似停滞」');
  }
});
