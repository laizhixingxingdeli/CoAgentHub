/**
 * 任务总览的 DOM / 刷新接线（src/web/console-overview-controller.js + overview.js）。
 *
 * 只写两组，对应验收的两条：
 *   1. 筛选、加载更早、键盘焦点真的工作，且一次刷新之后查询/暂停/状态/已显示条数
 *      和输入选区都还在。这些错了浏览器里都不报错：控件看着像能用的，点了没反应；
 *      刷新一次筛选被重置，光标跳到末尾，下一个人接着打出来的字并不是他想写的。
 *   2. 初次加载 / 初次失败 / 真正的空集合 / 刷新失败是四件不同的事；隐藏与离页要
 *      停定时器并取消在飞的请求，晚到的响应不许覆盖已经画上的那一份。
 *
 * DOM 用仓库里已有的 happy-dom（经 npm workspaces 装在根 node_modules），不安装新依赖。
 */

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { Window } from 'happy-dom';

import { renderOverviewPage, overviewHtml } from '../src/web/overview.js';
import {
  OVERVIEW_ENRICH_CONCURRENCY,
  OVERVIEW_INITIAL_BATCH,
  OVERVIEW_REFRESH_MS,
  createOverviewController,
} from '../src/web/console-overview-controller.js';

type Timer = { fn: () => void; ms: number };

let window: Window;
let document: Document;
let container: HTMLElement;
let timers: Map<number, Timer>;
let nextTimerId: number;
let requests: Array<{ path: string; signal: AbortSignal | undefined }>;
let held: Array<{ resolve: (value: unknown) => void; reject: (reason: unknown) => void }>;
let rows: Record<string, unknown>[];
let mode: 'ok' | 'fail' | 'hold';
let hidden: boolean;

function mission(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    missionId: id,
    projectId: 'P-1',
    status: 'executing',
    coordinationMode: 'hierarchical',
    updatedAt: '2026-10-26T06:32:00.000Z',
    paused: false,
    isMutating: false,
    intent: '任务 ' + id,
    openEscalations: 0,
    usage: { cost: 1.5, quality: 'reported' },
    ...over,
  };
}

function many(): Record<string, unknown>[] {
  return Array.from({ length: 12 }, (_, i) => mission(`M-${String(i).padStart(2, '0')}`, {
    // 后 4 条已完成、其中 2 条暂停：状态页签与暂停开关都能真的筛出不同的集合。
    status: i >= 8 ? 'completed' : 'executing',
    paused: i === 2 || i === 9,
    intent: i % 2 === 0 ? '整理车辆策略' : '修复通知关联恢复',
    updatedAt: new Date(Date.UTC(2026, 9, 26, 6, 0, 0) - i * 60_000).toISOString(),
  }));
}

function fetchJson(path: string, signal?: AbortSignal): Promise<unknown> {
  requests.push({ path, signal });
  if (mode === 'fail') return Promise.reject(new Error('HTTP 503'));
  if (mode === 'hold') {
    return new Promise((resolve, reject) => {
      held.push({ resolve, reject });
      signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
  }
  return Promise.resolve(rows);
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function settle(): Promise<void> {
  for (let i = 0; i < 16; i++) await Promise.resolve();
  await tick();
}

function setVisible(next: boolean): void {
  hidden = !next;
  document.dispatchEvent(new window.Event('visibilitychange') as unknown as Event);
}

function mount(projectId: string | null = null) {
  const controller = createOverviewController({
    doc: document,
    win: window as unknown as Window & typeof globalThis,
    container,
    projectId,
    fetchJson,
    render: (state: Record<string, unknown>) => overviewHtml(
      { missions: state.missions },
      {
        filter: state.filter,
        shown: state.shown,
        selectedId: state.selectedId,
        now: state.now,
        load: state.load,
        overlay: state.overlay,
      },
    ),
    now: () => Date.parse('2026-10-26T08:00:00.000Z'),
    refreshMs: OVERVIEW_REFRESH_MS,
    setInterval: ((fn: () => void, ms?: number) => {
      const id = nextTimerId++;
      timers.set(id, { fn, ms: Number(ms) });
      return id as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clearInterval: ((id: ReturnType<typeof setInterval>) => {
      timers.delete(id as unknown as number);
    }) as typeof clearInterval,
  });
  return controller;
}

const text = (): string => container.textContent || '';
const q = <T extends Element = HTMLElement>(selector: string): T | null => container.querySelector(selector) as T | null;
const click = (el: Element | null): void => {
  assert.ok(el, '要点的元素不在页面上');
  el.dispatchEvent(new window.Event('click', { bubbles: true }) as unknown as Event);
};
const pageCount = (): string => q('.co-page-count')?.textContent || '';
const tabCount = (key: string): number => {
  const el = q(`[data-overview-status="${key}"]`);
  assert.ok(el, `找不到页签 ${key}`);
  return Number((el.textContent || '').replace(/\D+/g, ''));
};

beforeEach(() => {
  window = new Window({ url: 'http://127.0.0.1:3101/#/' });
  document = window.document as unknown as Document;
  document.body.innerHTML = '<div id="view"></div>';
  container = document.getElementById('view') as unknown as HTMLElement;
  timers = new Map();
  nextTimerId = 1;
  requests = [];
  held = [];
  rows = many();
  mode = 'ok';
  hidden = false;
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (hidden ? 'hidden' : 'visible'),
  });
});

afterEach(() => {
  window.close();
});

describe('筛选 / 加载更早 / 焦点与刷新保留', () => {
  test('状态页签、暂停开关、搜索、加载更早都真的改集合，完整计数不被可见批次截断', async () => {
    const controller = mount();
    await controller.start();
    await settle();

    // 只取 /api/missions 一个接口：这一页不读平台状态，也不该等别的请求。
    // （补充会另起对可见任务的详情请求，所以这里只数列表那一条。）
    assert.equal(requests[0]?.path, '/api/missions');
    assert.equal(requests.filter((r) => r.path === '/api/missions').length, 1);
    // 首屏显示的是分页容量（具名批次），不是全部 12 条；分母与页签计数是完整集合。
    assert.equal(pageCount().trim(), `显示 ${OVERVIEW_INITIAL_BATCH} / 12`);
    assert.equal(container.querySelectorAll('.co-row').length, OVERVIEW_INITIAL_BATCH, '首屏条数不是批次大小');
    assert.equal(tabCount('all'), 12, '「全部」计数被可见批次截断了');
    assert.equal(tabCount('completed'), 4, '六态计数不是完整集合');
    assert.ok(q('[data-overview-more]'), '还有更多时要给「加载更早」');

    // 加载更早：一次点击按同一个具名批次累加。
    click(q('[data-overview-more]'));
    await settle();
    assert.equal(container.querySelectorAll('.co-row').length, 12, '加载更早没有累加');
    assert.equal(pageCount().trim(), '显示 12 / 12');
    assert.equal(q('[data-overview-more]'), null, '没有更多了还留着「加载更早」');

    // 状态页签：真的改集合，并把已显示条数重置回第一屏。
    click(q('[data-overview-status="completed"]'));
    await settle();
    assert.equal(q('[data-overview-status="completed"]')?.getAttribute('aria-selected'), 'true');
    assert.equal(q('[data-overview-status="all"]')?.getAttribute('aria-selected'), 'false');
    assert.equal(pageCount().trim(), '显示 4 / 4', '状态筛选后条数不对');
    assert.equal(container.querySelectorAll('.co-row').length, 4);

    // 暂停开关：可键盘操作的 button，aria-pressed 跟着真实筛选；与状态叠加。
    click(q('[data-overview-status="all"]'));
    click(q('[data-overview-paused]'));
    await settle();
    assert.equal(q('[data-overview-paused]')?.getAttribute('aria-pressed'), 'true', '开关没标出按下态');
    assert.equal(q('[data-overview-paused]')?.tagName, 'BUTTON', '开关必须是原生 button（键盘能操作）');
    assert.equal(pageCount().trim(), '显示 2 / 2', '仅看已暂停没有筛出那两条暂停的任务');
    assert.equal(q('img.co-switch-track')?.getAttribute('src'), '/console-icon-switch-on.svg');

    // 搜索是真实 input：值来自筛选条件，改动会真的收窄集合。
    click(q('[data-overview-paused]'));
    const input = q<HTMLInputElement>('[data-overview-query]');
    assert.ok(input, '搜索不是 input');
    assert.equal(input.getAttribute('type'), 'search');
    assert.equal(input.value, '', '查询应当来自 filter.query');
    input.value = '通知';
    input.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
    await settle();
    assert.equal(q<HTMLInputElement>('[data-overview-query]')?.value, '通知', '查询没有留在输入框里');
    assert.equal(pageCount().trim(), '显示 6 / 6', '编号/intent 搜索没有真的筛');
    assert.equal(tabCount('all'), 6);

    controller.stop();
  });

  test('刷新保留查询/暂停/状态/已显示条数，也保留焦点与输入选区；首屏无虚构选中', async () => {
    const controller = mount();
    await controller.start();
    await settle();

    // 首屏不编一个默认选中：那会让人以为进来就已经点开了一条。
    assert.equal(container.querySelectorAll('.co-row[data-selected="1"]').length, 0);

    click(q('[data-overview-more]'));
    click(q('[data-overview-status="executing"]'));
    click(q('[data-overview-paused]'));
    await settle();
    assert.equal(pageCount().trim(), '显示 1 / 1', '执行中 + 暂停 应正好一条');

    // 未暂停以拿到更多行，再累积一批，然后回到搜索框里打字。
    click(q('[data-overview-paused]'));
    click(q('[data-overview-status="all"]'));
    await settle();
    click(q('[data-overview-more]'));
    await settle();
    assert.equal(container.querySelectorAll('.co-row').length, 12);

    const input = q<HTMLInputElement>('[data-overview-query]')!;
    input.focus();
    input.value = '车辆';
    input.setSelectionRange(1, 2);
    input.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
    await settle();

    // 打字后焦点与选区都还在新节点上：整棵子树被 innerHTML 换掉过，
    // 不还原的话光标会消失，下一次按键去别处。
    const typed = document.activeElement as unknown as HTMLInputElement;
    assert.equal(typed, q('[data-overview-query]'), '重画后焦点丢了');
    assert.equal(typed.value, '车辆');
    assert.equal(typed.selectionStart, 1);
    assert.equal(typed.selectionEnd, 2);

    // 一轮真实刷新（数据变了）：筛选、已显示条数、焦点与选区都保留。
    rows = [...rows, mission('M-new', { intent: '车辆新任务' })];
    const before = container.querySelectorAll('.co-row').length;
    await controller.refresh();
    await settle();

    assert.equal(q<HTMLInputElement>('[data-overview-query]')?.value, '车辆', '刷新把查询清掉了');
    assert.equal(q('[data-overview-paused]')?.getAttribute('aria-pressed'), 'false', '刷新把暂停筛选重置了');
    assert.equal(q('[data-overview-status="all"]')?.getAttribute('aria-selected'), 'true');
    assert.ok(container.querySelectorAll('.co-row').length >= before, '刷新把已显示条数缩回去了');
    // 新的那条按查询进得来，说明刷新真的把新数据画上了，而不是沿用旧的。
    assert.ok(container.querySelector('.co-row[data-mission-id="M-new"]'), '刷新没有画上新的数据');
    const after = document.activeElement as unknown as HTMLInputElement;
    assert.equal(after, q('[data-overview-query]'), '刷新后焦点丢了');
    assert.equal(after.selectionStart, 1, '刷新后输入选区丢了');

    controller.stop();
  });
});

describe('初次加载 / 初次失败 / 空集合 / 隐藏与晚响应', () => {
  test('初次加载不说 0，初次失败与真正的空集合各自成句；刷新失败保留旧数据、最后成功时刻与筛选', async () => {
    mode = 'hold';
    const controller = mount();
    void controller.start();
    await settle();
    // 还没读到列表：不许出现任何计数（「全部 0」是替平台下结论）。
    assert.ok(q('[data-overview-state="loading"]'), '初次加载没有自己的说明');
    assert.equal(q('[data-overview-status="all"]'), null, '没读到列表就画了页签');
    assert.equal(q('.co-page-count'), null, '没读到列表就画了「显示 0 / 0」');
    assert.doesNotMatch(text(), /全部 0/, '初次加载显示了假 0');

    // 初次失败：如实说原因，且仍然不画计数。
    held[0]!.reject(new Error('HTTP 503'));
    await settle();
    assert.ok(q('[data-overview-state="error"]'), '初次失败没有自己的说明');
    assert.match(text(), /HTTP 503/);
    assert.equal(q('.co-tab'), null, '初次失败却画出了计数');
    controller.stop();

    // 真正的空集合：列表读到了，长度就是 0。和上面两句必须长得不一样。
    mode = 'ok';
    rows = [];
    const empty = mount();
    await empty.start();
    await settle();
    assert.equal(q('[data-overview-empty="all"]')?.textContent, '平台上还没有任务');
    assert.equal(pageCount().trim(), '显示 0 / 0');
    assert.equal(tabCount('all'), 0);
    empty.stop();

    // 刷新失败：保留旧数据、最后成功时刻与全部筛选；不清空、不重置。
    rows = many();
    const live = mount();
    await live.start();
    await settle();
    const input = q<HTMLInputElement>('[data-overview-query]')!;
    input.value = '车辆';
    input.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
    click(q('[data-overview-paused]'));
    await settle();
    const kept = container.querySelectorAll('.co-row').length;
    assert.ok(kept > 0);

    mode = 'fail';
    await live.refresh();
    await settle();
    assert.equal(container.querySelectorAll('.co-row').length, kept, '刷新失败把已有行清掉了');
    assert.match(text(), /刷新失败/, '刷新失败没有被说出来');
    const stale = q('[data-overview-state="stale"]')?.textContent || '';
    assert.match(stale, /最后成功/, '刷新失败没有给出最后成功时刻');
    assert.equal(q<HTMLInputElement>('[data-overview-query]')?.value, '车辆', '刷新失败把查询清掉了');
    assert.equal(q('[data-overview-paused]')?.getAttribute('aria-pressed'), 'true', '刷新失败把筛选重置了');
    live.stop();
  });

  test('隐藏停定时器并取消在飞请求，恢复可见立即补拉；离页后晚到的响应不覆盖；在途请求不重叠', async () => {
    const controller = mount();
    await controller.start();
    await settle();
    assert.equal(timers.size, 1, '可见时该有一个刷新定时器');
    assert.equal([...timers.values()][0]!.ms, OVERVIEW_REFRESH_MS);

    // 在途请求不重叠：上一轮没回来，再点一次刷新也不该再发一个。
    mode = 'hold';
    const before = requests.length;
    const first = controller.refresh();
    await settle();
    assert.equal(requests.length, before + 1, '这一轮该发一个请求');
    assert.equal(requests[before]?.path, '/api/missions');
    await controller.refresh();
    await settle();
    assert.equal(requests.length, before + 1, '上一轮还在路上又发了一轮');

    // 隐藏：立刻停定时器，并把这个在飞的请求取消掉（它回来时页面看不见，
    // 写上去还会覆盖恢复可见后补拉的那份）。
    setVisible(false);
    await settle();
    assert.equal(timers.size, 0, '隐藏后定时器还在跑');
    await first;
    await settle();
    assert.equal(container.querySelectorAll('.co-row').length, OVERVIEW_INITIAL_BATCH, '隐藏期间的响应被画上屏了');

    // 隐藏时定时器不该再发请求。
    requests = [];
    mode = 'ok';
    await controller.refresh();
    await settle();
    assert.deepEqual(requests, [], '隐藏时还在打接口');

    // 恢复可见：立即补拉（不等 5 秒），并重设定时器。
    setVisible(true);
    await settle();
    assert.equal(requests[0]?.path, '/api/missions', '恢复可见没有立即补拉');
    assert.equal(requests.filter((r) => r.path === '/api/missions').length, 1);
    assert.equal(timers.size, 1, '恢复可见没有重设定时器');

    // 离页：stop 之后在飞的响应晚到也不许覆盖已经画上的那一份。
    held = [];
    mode = 'hold';
    void controller.refresh();
    await settle();
    assert.equal(held.length, 1);
    const beforeStop = container.innerHTML;
    controller.stop();
    held[0]!.resolve(rows);
    await settle();
    assert.equal(container.innerHTML, beforeStop, '离页后晚到的响应把页面覆盖了');
    assert.equal(timers.size, 0, 'stop 之后定时器还在');

    const prev = {
      document: globalThis.document,
      window: globalThis.window,
      fetch: globalThis.fetch,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
    };
    globalThis.document = document as unknown as Document;
    globalThis.window = window as unknown as Window & typeof globalThis;
    globalThis.setInterval = ((fn: () => void, ms?: number) => {
      const id = nextTimerId++;
      timers.set(id, { fn, ms: Number(ms) });
      return id as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    globalThis.clearInterval = ((id: ReturnType<typeof setInterval>) => {
      timers.delete(id as unknown as number);
    }) as typeof clearInterval;
    globalThis.fetch = (async (path: unknown, init?: { signal?: AbortSignal }) => {
      requests.push({ path: String(path), signal: init?.signal });
      return { ok: true, json: async () => rows };
    }) as typeof fetch;
    document.querySelectorAll('link[rel="stylesheet"]').forEach((el) => el.remove());
    requests = [];
    mode = 'ok';
    container.innerHTML = '';
    assert.deepEqual(
      [...document.querySelectorAll('link[rel="stylesheet"]')].map((el) => el.getAttribute('href')),
      [],
      '样式应当在挂载时才挂',
    );
    void renderOverviewPage(container, 'P-1');
    await settle();
    assert.equal(requests[0]?.path, '/api/missions');
    assert.equal(requests.filter((r) => r.path === '/api/missions').length, 1);
    assert.equal(document.querySelectorAll('link[href="/console-overview.css"]').length, 1);
    globalThis.document = prev.document;
    globalThis.window = prev.window;
    globalThis.fetch = prev.fetch;
    globalThis.setInterval = prev.setInterval;
    globalThis.clearInterval = prev.clearInterval;
  });
});

test('补充只为可见任务取详情与尾部 Attempt：限并发、先出列表、失败不清列表、隐藏会取消', async () => {
  const waveRows = Array.from({ length: 9 }, (_, i) => mission(`M-${String(i).padStart(2, '0')}`, {
    status: 'executing',
    updatedAt: new Date(Date.UTC(2026, 9, 26, 6, 0, 0) - i * 60_000).toISOString(),
  }));
  const pending: Array<{ path: string; signal: AbortSignal | undefined; resolve: (value: unknown) => void }> = [];
  const seen: string[] = [];
  let phase: 'hold' | 'fail' | 'late' = 'hold';
  const emptyDetail = (id: string) => ({
    missionId: id,
    status: 'executing',
    coordinatorAttemptIds: [],
    independentReviewerAttemptIds: [],
    openEscalations: [],
    workItems: [],
  });
  const idOf = (path: string) => decodeURIComponent(path.split('/')[3] || '');
  const fetchJson = (path: string, signal?: AbortSignal): Promise<unknown> => {
    seen.push(path);
    if (path === '/api/missions') return Promise.resolve(waveRows);
    if (phase === 'fail') {
      if (path === '/api/missions/M-01') return Promise.reject(new Error('HTTP 500'));
      if (path.includes('/attempts/')) {
        return Promise.resolve({ attemptId: idOf(path), status: 'completed', kind: 'executor' });
      }
      return Promise.resolve(emptyDetail(idOf(path)));
    }
    return new Promise((resolve, reject) => {
      pending.push({ path, signal, resolve });
      signal?.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
  };
  const controller = createOverviewController({
    doc: document,
    win: window as unknown as Window & typeof globalThis,
    container,
    fetchJson,
    render: (state: Record<string, unknown>) => overviewHtml(
      { missions: state.missions },
      {
        filter: state.filter,
        shown: state.shown,
        selectedId: state.selectedId,
        now: state.now,
        load: state.load,
        overlay: state.overlay,
      },
    ),
    now: () => Date.parse('2026-10-26T08:00:00.000Z'),
    refreshMs: OVERVIEW_REFRESH_MS,
    setInterval: ((fn: () => void, ms?: number) => {
      const id = nextTimerId++;
      timers.set(id, { fn, ms: Number(ms) });
      return id as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval,
    clearInterval: ((id: ReturnType<typeof setInterval>) => {
      timers.delete(id as unknown as number);
    }) as typeof clearInterval,
  });
  await controller.start();
  await settle();
  assert.ok(container.querySelector('.co-row'), '列表还没画出来');
  assert.equal(text().includes('补修'), false, '详情还没返回就出现了补修');
  const enriching = pending.filter((item) => item.path !== '/api/missions');
  assert.equal(enriching.length, OVERVIEW_ENRICH_CONCURRENCY);
  assert.ok(OVERVIEW_ENRICH_CONCURRENCY < 8);
  assert.equal(seen.some((path) => path.includes('M-08')), false, '请求了不可见任务');
  const take = (pred: (path: string) => boolean) => {
    const index = pending.findIndex((item) => pred(item.path));
    assert.ok(index >= 0, '缺预期请求');
    return pending.splice(index, 1)[0]!;
  };
  take((path) => path === '/api/missions/M-00').resolve({
    missionId: 'M-00',
    status: 'executing',
    coordinatorAttemptIds: [],
    independentReviewerAttemptIds: [],
    openEscalations: [],
    workItems: [{
      title: '补修单',
      order: { requiredBehaviour: '补修原项 W-1 的缺口' },
      attemptIds: ['W-1.exec-1'],
    }],
  });
  await settle();
  take((path) => path.endsWith('/attempts/W-1.exec-1')).resolve({
    attemptId: 'W-1.exec-1',
    status: 'in_progress',
    kind: 'executor',
  });
  for (let i = 0; i < 40 && pending.length > 0; i += 1) {
    const batch = pending.splice(0, pending.length);
    for (const item of batch) {
      if (item.path.includes('/attempts/')) {
        item.resolve({ attemptId: idOf(item.path), status: 'completed', kind: 'executor' });
      } else {
        item.resolve(emptyDetail(idOf(item.path)));
      }
    }
    await settle();
  }
  await settle();
  assert.match(text(), /补修/);
  assert.match(text(), /执行者运行中/);
  assert.match(text(), /全部 9/);
  assert.equal(container.innerHTML.includes('119'), false);

  phase = 'fail';
  await controller.refresh();
  await settle();
  assert.ok(container.querySelectorAll('.co-row').length > 0, '详情失败把列表清掉了');
  assert.equal(text().includes('刷新失败'), false, '补充失败被画成了刷新失败');

  phase = 'late';
  pending.splice(0, pending.length);
  await controller.refresh();
  await settle();
  const late = pending.filter((item) => item.path !== '/api/missions');
  assert.ok(late.length > 0, '没有在飞的补充请求');
  setVisible(false);
  await settle();
  for (const item of late) assert.equal(item.signal?.aborted, true, '隐藏没有取消补充请求');
  for (const item of late) {
    item.resolve({
      missionId: 'M-00',
      status: 'executing',
      openEscalations: [{ reason: '范围冲突' }],
      workItems: [],
    });
  }
  await settle();
  assert.equal(text().includes('已升级（问题）'), false, '隐藏后的晚到结果改了页面');
  assert.ok(container.querySelectorAll('.co-row').length > 0, '晚到结果把列表清掉了');
  controller.stop();
});
