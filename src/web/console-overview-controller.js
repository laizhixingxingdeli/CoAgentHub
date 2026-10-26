/**
 * 任务总览的接线层：筛选、分页、定时刷新与请求生命周期。
 *
 * 为什么从 overview.js 里搬出来：那一层是纯视图（一行说什么、怎么转义、几列多宽），
 * 这一层是「什么时候去取、取回来的东西能不能写上屏」。混在一处的后果不是代码丑，
 * 而是任何一次刷新逻辑的改动都得动渲染文件、任何一次排版改动都得跑一遍请求生命
 * 周期——两件事的故障从此分不开。
 *
 * 依赖方向是单向的：overview.js → 本文件 → console-overview-model.js。
 * 本文件**不 import overview.js**：渲染函数由调用方以 `render(state)` 注入，
 * 反过来 import 就成了两文件互相 import 的环，浏览器里谁先求值谁就拿到半个模块
 * （表现为某个导出是 undefined，而屏幕上只是少了一块）。
 *
 * 本文件也不 import console-shell.js：外壳那套 statusErrorOf 是它自己顶栏的私有
 * 判断，借用会把两个页面的错误文案绑在一起——外壳改一句措辞，总览的「刷新失败」
 * 跟着变，而没人会去改这里。
 */

/** 可见时的刷新周期。5 秒是「人盯着这一页时的合适粒度」：更快只是白打接口，更慢则暂停/交付这种状态变化看起来像卡住了。 */
export const OVERVIEW_REFRESH_MS = 5000;

/**
 * 首屏显示多少条，以及「加载更早」一次加多少。
 *
 * 这是**分页容量**，不是设计样本数。8 条的依据是 1440×1120 的桌面上，页名、横幅、
 * 工具栏、六态页签、三个组头之外还能整块看到第一屏，不用滚动就知道下面还有没有。
 * 加载更早用同一个数，是为了让「点一次多一屏」这句话成立；两个数不同的话，第二次
 * 点击的增量会静悄悄地变。
 */
export const OVERVIEW_INITIAL_BATCH = 8;

/** 样式与页面同源：从这里取而不是让 index.html 引，见 ensureOverviewStylesheet。 */
const STYLESHEET_HREF = '/console-overview.css';

/**
 * 只挂一次同源样式。
 *
 * 不写进 index.html：那份文件是所有页面共用的，总览的样式进去之后，别的页面
 * 只要改一次全局样式就可能连带改到五列宽度（屏幕上看不出来，只是越来越不像画板）。
 * 幂等判断按 href 找一个已存在的 <link>：控制器每次挂载都会调一次，不查就会
 * 每换一次页多叠一张表，浏览器把同一份 CSS 解析 N 遍。
 */
export function ensureOverviewStylesheet(doc) {
  if (!doc || typeof doc.createElement !== 'function') return;
  const head = doc.head || doc.documentElement;
  if (!head) return;
  if (doc.querySelector('link[href="' + STYLESHEET_HREF + '"]')) return;
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = STYLESHEET_HREF;
  head.appendChild(link);
}

/**
 * 每个项目范围各自记住「上次点开的是哪一条」。
 *
 * 为什么记在这里而不是页面状态里：从总览点进任务再返回，整页是重新挂载的
 * （app.js 换路由会重建容器）。存在模块作用域里，返回时才还认得刚才那条；
 * 按范围分桶则是因为「全部项目」和某个项目看到的是两份不同的列表，把全部项目
 * 里的选中带到项目页，会标出一条根本不在这个列表里的任务。
 */
const selectionByScope = new Map();

async function defaultFetchJson(path, signal) {
  const response = await fetch(path, { cache: 'no-store', signal });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return response.json();
}

function isAbort(reason) {
  return Boolean(reason) && (reason.name === 'AbortError' || reason.code === 20);
}

/**
 * 失败原因分三类，**不合并**：HTTP 5xx 说明服务活着但这一页读不出来（先别重启），
 * 连不上说明进程没了（该去看服务），返回的不是列表说明接口变了（该改代码）。
 * 合成一句「加载失败」会让人对着这三种情况做同一个动作。
 */
export function fetchErrorOf(reason) {
  const message = String((reason && reason.message) || '');
  const http = /^HTTP (\d{3})/.exec(message);
  if (http) return { kind: 'http', status: Number(http[1]) };
  return { kind: 'unreachable' };
}

/**
 * 建一个总览控制器。返回 `{ start, stop, refresh, updateProject, state }`。
 *
 * deps 全部可注入（doc / win / fetchJson / render / now / refreshMs / setInterval /
 * clearInterval）：浏览器里默认就是全局那几个，测试里换掉它们才能在没有真服务、
 * 真时钟的情况下验「隐藏停轮询」「晚响应不覆盖」这类只在时序里出现的错。
 */
export function createOverviewController(deps = {}) {
  const doc = deps.doc || globalThis.document;
  const win = deps.win || globalThis.window;
  const fetchJson = deps.fetchJson || defaultFetchJson;
  const render = deps.render;
  const now = deps.now || (() => Date.now());
  const refreshMs = deps.refreshMs == null ? OVERVIEW_REFRESH_MS : deps.refreshMs;
  const setIntervalFn = deps.setInterval || globalThis.setInterval;
  const clearIntervalFn = deps.clearInterval || globalThis.clearInterval;
  const container = deps.container;

  if (!doc || !container) throw new TypeError('createOverviewController 需要 doc 与 container');
  if (typeof render !== 'function') throw new TypeError('createOverviewController 需要 render(state)');

  /** 项目范围来自公共 hash 路由：null 与空串都是「全部项目」，只有具体 id 才缩小范围。 */
  const scope = deps.projectId == null || String(deps.projectId) === '' ? '' : String(deps.projectId);

  const root = doc.createElement('section');

  const state = {
    // null 表示一次都没成功取到列表。空数组是「真的没有任务」，两者不能混：
    // 混了之后首次加载就显示「0 条」，人会以为平台上什么都没有。
    missions: null,
    filter: { projectId: scope, status: 'all', pausedOnly: false, query: '' },
    shown: OVERVIEW_INITIAL_BATCH,
    // 首屏没有任何行是选中的：编一个默认选中，等于告诉人「进来就已经点开了一条」。
    selectedId: selectionByScope.get(scope) || '',
    loadStatus: 'loading',
    error: null,
    lastOkAt: null,
  };

  let stopped = false;
  let timer = null;
  let inflight = null;
  let seq = 0;
  let epoch = 0;

  /* ---------------------------- 焦点与选区 ---------------------------- */

  /**
   * 重画（innerHTML 换掉整棵子树）之后焦点一定会丢：节点没了，浏览器把焦点交给
   * body，正在输入的人下一刻的按键就去了别处，而屏幕上只是「光标不见了」。
   * 所以重画前记下「焦点在哪个语义位置、选区在哪」，重画后放回去。
   *
   * 记的是语义位置（选择器）而不是节点引用：新节点是老节点被替换后才有的，
   * 存引用的话还原到的就是已经离开文档的那一个，focus() 不报错也不生效。
   */
  function focusSelector(el) {
    if (!el || typeof el.matches !== 'function') return '';
    if (el.matches('[data-overview-query]')) return '[data-overview-query]';
    if (el.matches('[data-overview-paused]')) return '[data-overview-paused]';
    if (el.matches('[data-overview-more]')) return '[data-overview-more]';
    const status = el.getAttribute('data-overview-status');
    if (status !== null) return '[data-overview-status="' + status.replace(/["\\]/g, '\\$&') + '"]';
    const missionId = el.closest ? el.closest('.co-row') : null;
    if (missionId) {
      return '.co-row[data-mission-id="' + String(missionId.getAttribute('data-mission-id') || '').replace(/["\\]/g, '\\$&') + '"]';
    }
    return '';
  }

  function captureFocus() {
    const active = doc.activeElement;
    if (!active || !active.matches || !root.contains(active)) return null;
    const selector = focusSelector(active);
    if (selector === '') return null;
    // 输入框的选区也要带过去：重画之后光标跳到末尾，正在中间改一个字的人
    // 下一次输入会从末尾续写，改出来的东西完全不是他想写的。
    const hasSelection = typeof active.selectionStart === 'number';
    return {
      selector,
      selection: hasSelection ? { start: active.selectionStart, end: active.selectionEnd } : null,
    };
  }

  function restoreFocus(saved) {
    if (!saved) return;
    const el = root.querySelector(saved.selector);
    if (!el || typeof el.focus !== 'function') return;
    el.focus();
    if (!saved.selection || typeof el.setSelectionRange !== 'function') return;
    try {
      el.setSelectionRange(saved.selection.start, saved.selection.end);
    } catch {
      // 不是文本输入控件就没有选区：这里静默跳过，不为了一个装饰性还原去动焦点。
    }
  }

  /* ---------------------------- 画 ---------------------------- */

  function paint() {
    const focused = captureFocus();
    root.innerHTML = String(render({
      missions: state.missions,
      filter: { ...state.filter },
      shown: state.shown,
      selectedId: state.selectedId,
      now: now(),
      load: { status: state.loadStatus, error: state.error, lastOkAt: state.lastOkAt },
    }));
    restoreFocus(focused);
  }

  /* ---------------------------- 取 ---------------------------- */

  function abortInflight() {
    const controller = inflight;
    inflight = null;
    if (controller) controller.abort();
  }

  function stopTimer() {
    if (timer === null) return;
    clearIntervalFn(timer);
    timer = null;
  }

  function startTimer() {
    if (timer !== null || stopped) return;
    timer = setIntervalFn(() => {
      // 节点已经离开文档（换页了、但这一页没被显式 stop）：定时器必须自己停。
      // 不停的话它会对着一个已经不在屏幕上的容器一直打接口，直到整个标签页关掉。
      if (!root.isConnected) {
        stop();
        return;
      }
      void refresh();
    }, refreshMs);
  }

  /**
   * 取一轮列表。只读 `/api/missions` 一个接口。
   *
   * 旧实现一次并发取 projects / missions / status / pools，再一起画。其中
   * projects 只喂页内那个项目下拉（本单删掉，范围改由 hash 决定），status 与
   * pools 一个字段都没被读过。留着它们的代价不只是多三个请求：三个请求里任何一个
   * 慢，整页就跟着慢——而它根本不参与这一页的任何一格。
   */
  async function refresh() {
    if (stopped) return;
    // 隐藏的标签页不发请求；也不重排定时器，恢复可见时由 onVisibility 立即补拉。
    if (doc.visibilityState === 'hidden') return;
    // 上一轮还没回来就不发下一轮：两轮同时在路上时，先发出去的那轮晚到就会覆盖新的。
    if (inflight) return;
    if (state.missions === null) state.loadStatus = 'loading';

    const mySeq = ++seq;
    const myEpoch = epoch;
    const controller = new AbortController();
    inflight = controller;

    let rows;
    try {
      rows = await fetchJson('/api/missions', controller.signal);
    } catch (reason) {
      if (inflight === controller) inflight = null;
      // 取消不是失败：把它说成「刷新失败」会让人以为服务出了问题，而实际上
      // 只是页面被藏起来或换页了。
      if (stopped || isAbort(reason) || mySeq !== seq || myEpoch !== epoch) return;
      fail(fetchErrorOf(reason));
      return;
    }
    if (inflight === controller) inflight = null;
    // 晚到的响应不许上屏：换了页（epoch 变了）、又发了一轮（seq 变了）、
    // 或者页面已经藏起来，这份数据说的都是别的时刻的别的地方。
    if (stopped || mySeq !== seq || myEpoch !== epoch) return;
    if (doc.visibilityState === 'hidden') return;
    if (!Array.isArray(rows)) {
      fail({ kind: 'invalid' });
      return;
    }
    state.missions = rows;
    state.loadStatus = 'ready';
    state.error = null;
    state.lastOkAt = now();
    paint();
  }

  /**
   * 失败：**不动 missions**。
   *
   * 一次超时就把列表清空，等于把「刚刚还看得到的事实」换成「什么都不知道」，
   * 而屏幕上只是少了一屏数据，没有任何报错。旧数据加一条「刷新失败 · 最后成功
   * 时刻」才说明白：这是几分钟前的，不是现在的。
   */
  function fail(error) {
    state.loadStatus = 'error';
    state.error = error;
    paint();
  }

  /* ---------------------------- 事件 ---------------------------- */

  function resetBatch() {
    state.shown = OVERVIEW_INITIAL_BATCH;
  }

  function onInput(event) {
    const target = event && event.target;
    if (!target || typeof target.matches !== 'function') return;
    if (!target.matches('[data-overview-query]')) return;
    state.filter.query = String(target.value ?? '');
    // 查询变了就回到第一屏：停在「加载更早」加到的那一批上，第一页命中会被
    // 悄悄跳过，看起来像搜不到。
    resetBatch();
    paint();
  }

  function onHashChange() {
    // 换页：这一页不再负责那个容器，定时器和在飞的请求都得停。
    stop();
  }

  function onVisibilityChange() {
    if (doc.visibilityState === 'hidden') {
      stopTimer();
      // 已经发出去的请求也要掐掉：它回来时页面是看不见的，写上去也没有人看，
      // 而晚到的响应还会覆盖恢复可见后补拉的那一份。
      abortInflight();
      return;
    }
    // 恢复可见立即补拉一次，不等下一个周期：人切回来看到的第一屏必须是现在的。
    startTimer();
    void refresh();
  }

  function onClick(event) {
    const target = event && event.target;
    if (!target || typeof target.closest !== 'function') return;
    const hit = target.closest('[data-overview-status],[data-overview-paused],[data-overview-more],.co-row');
    if (!hit || !root.contains(hit)) return;

    if (hit.matches('.co-row')) {
      // 行是 <a href="#/missions/…">：导航交给浏览器，这里只记住「这个范围里
      // 点开过哪一条」，返回总览时才能还原来的人看的位置。
      selectionByScope.set(scope, String(hit.getAttribute('data-mission-id') || ''));
      return;
    }

    if (hit.matches('[data-overview-more]')) {
      state.shown += OVERVIEW_INITIAL_BATCH;
      paint();
      return;
    }

    if (hit.matches('[data-overview-paused]')) {
      state.filter.pausedOnly = hit.getAttribute('data-overview-paused') !== '1';
      resetBatch();
      paint();
      return;
    }

    const status = hit.getAttribute('data-overview-status');
    if (status === null) return;
    state.filter.status = status;
    resetBatch();
    paint();
  }

  /* ---------------------------- 生命周期 ---------------------------- */

  function stop() {
    if (stopped) return;
    stopped = true;
    // epoch 一变，所有在飞的响应都作废（包括之后才 reject 的那一批）。
    epoch += 1;
    abortInflight();
    stopTimer();
    doc.removeEventListener('visibilitychange', onVisibilityChange);
    if (win) win.removeEventListener('hashchange', onHashChange);
    root.removeEventListener('input', onInput);
    root.removeEventListener('click', onClick);
  }

  /** 换项目范围（哈希里换了项目）：只改筛选，重新取一轮。 */
  function updateProject(projectId) {
    const next = projectId == null || String(projectId) === '' ? '' : String(projectId);
    if (next === state.filter.projectId) return;
    state.filter.projectId = next;
    state.selectedId = selectionByScope.get(next) || '';
    resetBatch();
    paint();
  }

  function start() {
    ensureOverviewStylesheet(doc);
    container.replaceChildren(root);
    root.addEventListener('input', onInput);
    root.addEventListener('click', onClick);
    doc.addEventListener('visibilitychange', onVisibilityChange);
    if (win) win.addEventListener('hashchange', onHashChange);
    // 先画「加载中…」：不画的话容器里是空的，看起来像这一页坏了；
    // 也不能先画一张 0 条的表，那是替平台下了一个「没有任务」的结论。
    paint();
    startTimer();
    return refresh();
  }

  return { start, stop, refresh, updateProject, state };
}
