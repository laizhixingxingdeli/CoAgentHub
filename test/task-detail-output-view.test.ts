/**
 * 「当前实时输出 / 选中环节」两张卡的渲染层（src/web/task-detail-output-view.js）。
 *
 * 只写三条，对应验收的两条：
 *   1. 历史 Attempt 与当前实时输出的 id 可以不同；实时行只含当前那一跳且逐条成块，
 *      历史正文缺失显示未知，文件与用量面板不借用实时行、任务累计或 missionDiff。
 *   2. 概要那一块写的是**选中这一跳自己**的标题/身份/允许范围/费用质量/交回结果，
 *      缺的一律「未知」，任务级路径不进概要与文件区。
 *   3. 心跳的三种结论（不适用 / 疑似停滞 / 未知）由投影给出，本层只渲染：
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
  // 左标题就是这一区的身份：写「当前」这个词不够，得看得见正在跑的是哪一次执行。
  // 只写死一句「当前实时输出」时，选了历史之后左正文在、人却分不出它是哪一跳的。
  const liveTitle = q('.td-live-title')?.textContent || '';
  assert.ok(liveTitle.includes('W-1.exec-2'), '左标题没写出当前这一跳：' + liveTitle);
  assert.ok(liveTitle.includes('第 2 次'), '左标题缺执行次数：' + liveTitle);
  assert.equal(liveTitle.includes('W-1.exec-1'), false, '左标题把所选历史当成了当前：' + liveTitle);

  // 没有当前执行时直说没有，不编一个活跃身份，也不把历史那一跳写成当前。
  const idle = mount({ currentAttemptId: null, selectedAttemptId: 'W-1.exec-1', nowIso: '2026-10-26T10:00:00.000Z', selectedAttempt: null, liveChunks: [] });
  assert.equal(idle.q('.td-live-title')?.textContent, '当前实时输出 · 无当前执行');
  assert.equal((idle.q('.td-live-title')?.textContent || '').includes('W-1.exec-1'), false,
    '没有当前执行时左标题借用了所选历史');

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

test('概要写这一跳自己的身份、范围、费用与交回结果，实时行逐条分块且只含当前 Attempt', () => {
  const { q, all } = mount({
    currentAttemptId: 'W-1.exec-13',
    selectedAttemptId: 'W-1.exec-13',
    nowIso: '2026-10-26T10:00:00.000Z',
    currentAttempt: {
      attemptId: 'W-1.exec-13',
      status: 'in_progress',
      heartbeatAt: '2026-10-26T09:59:50.000Z',
    },
    selectedAttempt: {
      attemptId: 'W-1.exec-13',
      kind: 'executor',
      status: 'succeeded',
      profile: {
        profileId: 'exec-codebuddy-cn-ds41-flash',
        facts: [
          { key: 'provider', value: 'codebuddy' },
          { key: 'model', value: 'deepseek-v4.1-flash' },
          { key: 'reasoning', value: 'medium' },
        ],
      },
      usage: { cost: 0, quality: 'reported' },
      output: '已完成',
    },
    selectedWorkItem: {
      id: 'W-1',
      status: 'dispatched',
      attemptIds: ['W-1.exec-12', 'W-1.exec-13'],
      order: { allowedScope: ['src/web/app.js', 'test/web-task.test.ts'] },
    },
    liveChunks: [
      { attemptId: 'W-1.exec-13', at: '2026-10-26T09:59:48.000Z', kind: 'executor', text: '第一行' },
      { attemptId: 'W-1.exec-13', at: '2026-10-26T09:59:49.000Z', kind: 'tool', text: '第二行' },
      { attemptId: 'W-1.exec-12', at: '2026-10-26T09:00:00.000Z', kind: 'executor', text: '旧行' },
    ],
    // 任务级的改动路径不能冒充允许范围，也不能进文件区。
    missionDiff: ['src/web/other.js'],
  });

  // 两张卡各自是独立的白卡：它们是并列的兄弟节点，不是同一张卡的两个子区。
  const live = q('.td-live');
  const history = q('.td-history');
  assert.ok(live && history);
  assert.equal(live?.parentElement?.classList.contains('td-output'), true);
  assert.equal(history?.parentElement?.classList.contains('td-output'), true);
  assert.equal(q('.td-history-title')?.textContent, '选中环节');

  // 实时行逐条成块：两条正文黏成一段时，屏幕上分不出是哪一秒、谁说的。
  const lines = all('.td-live-line');
  assert.equal(lines.length, 2, '实时行没有被拆成两条独立块：' + lines.length);
  assert.ok(lines[0].textContent?.includes('第一行'));
  assert.ok(lines[1].textContent?.includes('第二行'));
  // 认得出的角色才前缀，认不出的（这里是空 kind）不能编一个。
  // 正文里的时刻只到秒的本地时分秒，原 ISO 挂在该行 title 上可查：满屏 ISO 会把每行
  // 正文挤到右边。具体钟点随机器时区变，所以断言形状 + title 原值，不写死时刻。
  assert.ok(/^\[\d{2}:\d{2}:\d{2}\] \[执行者\] 第一行$/.test(lines[0].textContent || ''),
    '第一行不是本地时分秒：' + lines[0].textContent);
  assert.ok(/^\[\d{2}:\d{2}:\d{2}\] \[工具\] 第二行$/.test(lines[1].textContent || ''),
    '第二行不是本地时分秒：' + lines[1].textContent);
  assert.equal((lines[0].textContent || '').includes('2026-10-26'), false, '正文仍印了完整 ISO');
  assert.equal(lines[0].getAttribute('title'), '2026-10-26T09:59:48.000Z', '原 ISO 没留在 title 上');
  assert.equal((q('.td-live-text')?.textContent || '').includes('旧行'), false, '实时区混进了别的 Attempt 的行');

  // 概要的六格事实来自这一跳自己。
  const summary = q('[data-panel="summary"]');
  const summaryText = summary?.textContent || '';
  assert.equal(q('[data-fact="title"]')?.textContent?.includes('执行第 13 次'), true, summaryText);
  assert.ok(summaryText.includes('exec-codebuddy-cn-ds41-flash'), '概要缺候选：' + summaryText);
  assert.ok(summaryText.includes('codebuddy/deepseek-v4.1-flash'), '概要缺 provider/model：' + summaryText);
  assert.ok(summaryText.includes('medium'), '概要缺思考档：' + summaryText);
  assert.ok(summaryText.includes('src/web/app.js'), '概要不准允诺范围：' + summaryText);
  assert.ok(summaryText.includes('test/web-task.test.ts'), '概要不准允诺范围：' + summaryText);
  // 上报 0 是真报过了 0：写 $0.00 · 上报，不是「未知」也不是 `0 · reported` 两列原值。
  assert.equal(q('[data-fact="cost"]')?.textContent, '本环节费用$0.00 · 上报');
  assert.ok(summaryText.includes('已交回'), '概要缺交回结果：' + summaryText);
  // 历史正文单独一块，事实区不替代它。
  assert.ok(summaryText.includes('历史正文'), '概要缺历史正文标签：' + summaryText);
  assert.ok(q('[data-panel="summary"] .td-history-text')?.textContent?.includes('已完成'), '历史正文丢了');

  // 任务级改动路径任何地方都不能出现：概要不带，文件区也不带。
  assert.equal((q('.td-output')?.textContent || '').includes('src/web/other.js'), false, 'missionDiff 漏进了输出区');
  click(q('[data-side="files"]'));
  assert.equal((q('[data-panel="files"]')?.textContent || '').includes('src/web/other.js'), false,
    '文件区拿 missionDiff 冒充了这一跳的文件清单');
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
