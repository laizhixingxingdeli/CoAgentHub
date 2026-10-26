/**
 * 双入口外壳：左导航的选中态、顶栏的项目控件与同步状态。
 *
 * 外壳**不读业务数据**：它只碰 `/api/projects` 与 `/api/platform/status`；某个
 * 任务里写了什么归任务页自己管。分开的理由是加一个页面时外壳不用动，反过来
 * 也不会因为某一页改了渲染就把导航和同步状态带歪。
 *
 * 这里刻意不做的事：不写死任何时刻、不编造项目列表、不预测服务状态。
 * 顶栏那句「最近同步」必须是**真的读到过**的时刻——写死一个 14:32:08 看起来
 * 最省事，但那句话从此与平台无关，故障时人还会以为服务是好的。
 */

/** 项目控件的「全部项目」哨兵值。空串不会和任何真实 projectId 撞上。 */
export const ALL_PROJECTS = '';

/**
 * 服务连不上时给的那句能照着敲的话。
 *
 * 凭印象写一句 `npm start` 会把人引到不存在的脚本上，而屏幕上完全看不出
 * 那是猜的。这一条与 `docs/getting-started.md`、`README.md` 是同一句。
 */
export const START_COMMAND = 'node scripts/coagent.mjs start';

/** 顶栏同步状态与项目列表的读取周期。 */
export const SHELL_POLL_MS = 30000;

/**
 * 多久没有成功读取就算「数据已过期」。
 *
 * 取三倍轮询周期而不是两倍：偶发一次慢请求不该让整条顶栏变黄，而三次都没
 * 成功就说明确实卡住了——那时候还显示「服务正常」才是在骗人。
 */
export const STALE_AFTER_MS = SHELL_POLL_MS * 3;

/** 一级入口只有「任务」和「资源」。 */
const TASK_ROUTES = new Set(['home', 'projects', 'mission', 'project-spec']);
const POOL_ROUTES = new Set(['pool']);

/**
 * 路由 → 一级导航高亮项。
 *
 * 方案运行、平台、设置、角色与模型这些页面仍然可达（旧深链接保留），但它们
 * **不属于任何一级入口**：把它们高亮成「任务」，人就会以为自己在看任务列表。
 * 没有归属就一个都不亮，这比亮错一个诚实。
 */
export function navKeyForRoute(name) {
  if (TASK_ROUTES.has(name)) return 'tasks';
  if (POOL_ROUTES.has(name)) return 'pool';
  return '';
}

/**
 * 路由 → 项目控件的状态。
 *
 * 项目控件在任务页和资源页都可见，默认「全部项目」。曾经在资源页返回
 * `visible: false`，理由是「摆下拉等于暗示资源按项目存」；但池本来就没有项目
 * 私池这回事，藏掉控件反而让人以为资源页没有项目这个维度（Figma 2:214 顶栏
 * 也是有「项目：全部项目」的）。控件只说「你在看哪个项目的任务」，不改变池的
 * 读取范围——`refresh` 无论在哪一页都只请求全局 `/api/projects`。
 *
 * 任务列表页的当前项目只有它自己拿得到（外壳不读业务数据），所以其余页面显示
 * 「全部项目」；选中任一项目就跳到它的任务列表——换项目本来就是要换上下文。
 */
export function projectSelectState(route) {
  const name = route && route.name;
  if (name === 'projects') return { visible: true, value: String((route && route.projectId) || ALL_PROJECTS) };
  return { visible: true, value: ALL_PROJECTS };
}

/** 项目控件选中一个值之后要去的地址。 */
export function projectSelectTarget(projectId) {
  const id = String(projectId ?? '');
  // 「全部项目」去任务总览，不是 `#/projects`：后者会落到列表里的第一个项目，
  // 那不是「全部」，只是恰好排在第一。
  if (!id) return '#/';
  return '#/projects/' + encodeURIComponent(id);
}

/** 本地 HH:MM:SS。顶栏只显示时分秒，完整时刻留给 title。 */
export function formatClock(at) {
  const date = new Date(at);
  const pad = (n) => String(n).padStart(2, '0');
  return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
}

function statusErrorText(error) {
  if (error.kind === 'unreachable') return '服务离线';
  // 读被拒说明服务是活着的：把它说成「离线」会让人去重启一个好好的服务。
  return '状态读取失败（HTTP ' + error.status + '）';
}

function statusErrorOf(reason) {
  const message = String((reason && reason.message) || '');
  const http = /^HTTP (\d{3})/.exec(message);
  if (http) return { kind: 'http', status: Number(http[1]) };
  return { kind: 'unreachable' };
}

function isAbort(reason) {
  return Boolean(reason) && (reason.name === 'AbortError' || reason.code === 20);
}

/**
 * 顶栏那句同步状态。
 *
 * 四种语气，三种都必须保留**最后一次成功读取**的时刻：
 *
 *   - `unknown`：一次都没读成功过。不许显示「服务正常」——初次加载就是绿的，
 *     等于告诉人「一切正常」，而实际上什么都没读到。
 *   - `ok`：读到了，且不旧。
 *   - `stale`：读到了，但很久没再成功。时刻还是那个时刻，另加过期提示。
 *   - `down`：这次读取失败。时刻还是最后的成功时刻，后面接失败原因。
 */
export function syncStatusLabel(state, nowMs) {
  const at = state && state.lastOkAt;
  const error = (state && state.statusError) || null;
  if (at == null) {
    return {
      tone: 'unknown',
      text: error ? '还没读到同步时刻 · ' + statusErrorText(error) : '还没读到同步时刻 · 服务状态未知',
    };
  }
  const clock = formatClock(at);
  if (error) return { tone: 'down', text: '最近同步 ' + clock + ' · ' + statusErrorText(error) };
  const ageMs = Math.max(0, nowMs - at);
  if (ageMs > STALE_AFTER_MS) {
    return { tone: 'stale', text: '最近同步 ' + clock + ' · 数据已过期（' + Math.round(ageMs / 1000) + ' 秒前）' };
  }
  return { tone: 'ok', text: '最近同步 ' + clock + ' · 服务正常' };
}

/**
 * 页面级横幅：过期与离线两种状态，都必须保住最后时刻，并给出恢复路径。
 *
 * 只在真需要动手时出现。一句「服务正常」写两遍不算信息，写在这儿反而把真正
 * 需要处理的那一次淹掉。
 */
export function shellBanner(state, nowMs) {
  const error = (state && state.statusError) || null;
  const at = state && state.lastOkAt;
  if (error && error.kind === 'unreachable') {
    return (at != null ? '服务未运行，页面停在 ' + formatClock(at) + ' 读到的数据。'
      : '服务未运行，还没有读到任何数据。')
      + '已核实的本机启动命令：' + START_COMMAND;
  }
  if (!error && at != null && nowMs - at > STALE_AFTER_MS) {
    return '数据已过期，最后同步 ' + formatClock(at) + '。服务没响应时，已核实的本机启动命令：' + START_COMMAND;
  }
  return '';
}

async function defaultFetchJson(path, signal) {
  const response = await fetch(path, { cache: 'no-store', signal });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return response.json();
}

/**
 * 装配外壳。返回 `{ update, refresh, dispose }`。
 *
 * `deps` 全部可注入（doc / win / fetchJson / now / pollMs）——浏览器里默认就是
 * 全局那几个；测试里换掉它们才能在没有真服务的情况下验请求生命周期。
 */
export function createShell(deps = {}) {
  const doc = deps.doc || document;
  const win = deps.win || (typeof window === 'undefined' ? undefined : window);
  const fetchJson = deps.fetchJson || defaultFetchJson;
  const now = deps.now || (() => Date.now());
  const pollMs = deps.pollMs == null ? SHELL_POLL_MS : deps.pollMs;

  const navItems = [...doc.querySelectorAll('.cs-nav [data-nav]')];
  const projectBox = doc.getElementById('cs-project');
  const projectSelect = doc.getElementById('cs-project-select');
  const syncSlot = doc.getElementById('cs-sync');
  const bannerSlot = doc.getElementById('cs-banner');

  const state = { projects: null, lastOkAt: null, statusError: null, route: { name: 'home' } };
  // 路由代次与请求代次是两把锁：前者管「换页了，旧响应作废」，后者管「又发了一轮，
  // 上一轮迟到的那份也不许写」。只有一把时，同页连发两次会互相覆盖。
  let routeEpoch = 0;
  let requestSeq = 0;
  let inflight = null;
  let timer = null;
  let disposed = false;

  function renderNav() {
    const key = navKeyForRoute(state.route.name);
    for (const el of navItems) {
      if (key && el.dataset.nav === key) el.dataset.active = '1';
      else el.removeAttribute('data-active');
    }
  }

  function projectOptions(value) {
    const rows = Array.isArray(state.projects) ? state.projects : [];
    const ids = rows.map((row) => String((row && row.projectId) || '')).filter(Boolean);
    // 深链进来的项目可能还在列表之外（列表没读到 / 刚建），补一条进去：
    // 否则下拉会显示「全部项目」，而页面明明在看某个具体项目。
    if (value && !ids.includes(value)) ids.unshift(value);
    return [{ id: ALL_PROJECTS, label: '全部项目' }].concat(ids.map((id) => ({ id, label: id })));
  }

  function renderProject() {
    if (!projectBox || !projectSelect) return;
    const view = projectSelectState(state.route);
    projectBox.hidden = !view.visible;
    const options = projectOptions(view.value);
    projectSelect.replaceChildren(...options.map((option) => {
      const el = doc.createElement('option');
      el.value = option.id;
      el.textContent = option.label;
      return el;
    }));
    projectSelect.value = view.value;
  }

  function renderSync() {
    const label = syncStatusLabel(state, now());
    if (syncSlot) {
      syncSlot.textContent = label.text;
      syncSlot.dataset.tone = label.tone;
    }
    const banner = shellBanner(state, now());
    if (bannerSlot) {
      bannerSlot.textContent = banner;
      bannerSlot.hidden = !banner;
    }
  }

  function abortInflight() {
    if (!inflight) return;
    inflight.abort();
    inflight = null;
  }

  async function refresh() {
    if (disposed) return;
    // 隐藏的标签页不发请求：后台每半分钟打一次接口，是白烧服务端的连接。
    if (doc.visibilityState === 'hidden') return;
    abortInflight();
    const mySeq = ++requestSeq;
    const myEpoch = routeEpoch;
    const controller = new AbortController();
    inflight = controller;
    const [projects, status] = await Promise.allSettled([
      fetchJson('/api/projects', controller.signal),
      fetchJson('/api/platform/status', controller.signal),
    ]);
    if (disposed || mySeq !== requestSeq || myEpoch !== routeEpoch) return;
    inflight = null;
    // 项目列表读失败时保留上一份：一次超时就让下拉退回只剩「全部项目」，
    // 人会以为项目全没了。
    if (projects.status === 'fulfilled' && Array.isArray(projects.value)) state.projects = projects.value;
    if (status.status === 'fulfilled') {
      state.lastOkAt = now();
      state.statusError = null;
    } else if (!isAbort(status.reason)) {
      state.statusError = statusErrorOf(status.reason);
    }
    renderProject();
    renderSync();
  }

  function onVisibility() {
    if (doc.visibilityState === 'hidden') abortInflight();
    else void refresh();
  }

  function onProjectChange(event) {
    const target = event && event.target;
    if (!target || target !== projectSelect || !win || !win.location) return;
    // 改 hash 而不是 location.assign：外壳走 hash 路由，整页重载会把已经读到的
    // 项目与同步状态扔掉重来一次。
    win.location.hash = projectSelectTarget(target.value);
  }

  /** 换页时调用：导航高亮、项目控件、立刻补拉一次。返回这一轮的 promise。 */
  function update(route) {
    state.route = route || { name: 'home' };
    routeEpoch += 1;
    // 换页第一件事是把在飞的请求掐掉：旧响应写进新页面，人看到的就是上一个
    // 项目的项目名和上一个时刻的同步状态。
    abortInflight();
    renderNav();
    renderProject();
    if (!timer && !disposed) {
      timer = setInterval(() => {
        void refresh();
      }, pollMs);
      doc.addEventListener('visibilitychange', onVisibility);
      if (projectSelect) projectSelect.addEventListener('change', onProjectChange);
    }
    return refresh();
  }

  function dispose() {
    disposed = true;
    abortInflight();
    if (timer) clearInterval(timer);
    timer = null;
    doc.removeEventListener('visibilitychange', onVisibility);
    if (projectSelect) projectSelect.removeEventListener('change', onProjectChange);
  }

  return { update, refresh, dispose, state };
}
