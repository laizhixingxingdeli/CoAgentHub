/**
 * 平台页（hash `#/platform`）：只读服务身份、队列死信、五维占用、装配配置。
 *
 * 与 pool.js / plan-run.js 同一分界：**上面全是纯函数**（喂数据 → 回字符串），
 * 只有底部 renderPlatformPage 碰 DOM 与 fetch。浏览器不在测试里，字段名读错
 * 的 symptom 是那一格永远空着——纯函数才能在 node 里把真 JSON 喂进去抓住。
 *
 * 后端形状以 W-130 落地为准（扁平：identity 字段散在顶层，占用叫 occupancy
 * 不是 capacity）。对接容错：缺字段、`{ inapplicable, reason }` 都要说出来，
 * 不能把「PG 没有文件锁」画成空串，那看起来像「没这个东西」。
 *
 * 只读。不发 POST：写接口要等鉴权，界面里再做一份「能不能改」迟早和平台判的不一样。
 */

import { esc } from './projects.js';
import { ROLE_CN } from './narrate.js';

const DASH = '—';

/** 离开页面后过期响应不得写 DOM；间隔写在一处，测试才能断言不是 5 秒那种「顺便抄的」。 */
export const PLATFORM_POLL_MS = 10000;

const QUEUE_STATUSES = ['queued', 'claimed', 'completed', 'retry_wait', 'dead_letter'];

function text(value) {
  return value === undefined || value === null ? '' : String(value);
}

function isInapplicable(value) {
  return Boolean(value && typeof value === 'object' && value.inapplicable === true);
}

/**
 * 装配不上的字段后端给 `{ inapplicable, reason }`，不是 null。
 * 把 reason 吃掉会让 PG 实例看起来像「没身份」而不是「这种仓储本来就没有文件锁」。
 */
export function inapplicableText(value) {
  if (!isInapplicable(value)) return '';
  const reason = text(value.reason).trim();
  return reason ? '不适用（' + reason + '）' : '不适用';
}

function countOf(value, key) {
  const n = Number(value && value[key]);
  return Number.isFinite(n) ? n : 0;
}

function formatWhen(iso) {
  const t = Date.parse(String(iso ?? ''));
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

function roleLabel(role) {
  const key = text(role);
  return ROLE_CN[key] || key || DASH;
}

/**
 * 普通值 / 布尔 / 不适用 / 空，四种都要有字。
 * 空不能落成空白：空白在屏幕上像「这一项本来就是没有的」。
 */
export function fieldText(value, emptyText) {
  const fallback = emptyText || '还没读到';
  if (value === undefined || value === null || value === '') return fallback;
  const inapplicable = inapplicableText(value);
  if (inapplicable) return inapplicable;
  if (typeof value === 'boolean') return value ? '是' : '否';
  return String(value);
}

function fieldRow(label, value, emptyText) {
  return '<div><dt>' + esc(label) + '</dt><dd class="mono">' + esc(fieldText(value, emptyText)) + '</dd></div>';
}

function listenText(listen) {
  if (listen === undefined || listen === null || listen === '') return '还没读到';
  const inapplicable = inapplicableText(listen);
  if (inapplicable) return inapplicable;
  const address = text(listen.address);
  const port = listen.port;
  if (!address && !Number.isFinite(Number(port))) return '还没读到';
  return address + ':' + String(port);
}

export function identityCardHtml(status) {
  const s = status || {};
  const started = isInapplicable(s.startedAt)
    ? inapplicableText(s.startedAt)
    : (formatWhen(s.startedAt) || fieldText(s.startedAt));
  return '<div class="card" data-platform-identity>'
    + '<h2>服务身份</h2>'
    + '<dl class="fields">'
    + fieldRow('API', s.api)
    + fieldRow('进程', s.pid)
    + fieldRow('仓储', s.store)
    + fieldRow('实例', s.instanceId)
    + fieldRow('状态文件', s.statePath)
    + fieldRow('持有主锁', s.holdsMainLock)
    + '<div><dt>监听</dt><dd class="mono">' + esc(listenText(s.listen)) + '</dd></div>'
    + '<div><dt>启动</dt><dd class="mono">' + esc(started) + '</dd></div>'
    + '</dl>'
    + '</div>';
}

function queueCountStats(counts) {
  const n = (key) => countOf(counts, key);
  return '<dl class="task-stats">'
    + '<div class="stat"><dt>排队</dt><dd class="mono" data-queue="queued">' + esc(n('queued')) + '</dd></div>'
    + '<div class="stat"><dt>已领取</dt><dd class="mono" data-queue="claimed">' + esc(n('claimed')) + '</dd></div>'
    + '<div class="stat"><dt>已完成</dt><dd class="mono" data-queue="completed">' + esc(n('completed')) + '</dd></div>'
    + '<div class="stat"><dt>等待重试</dt><dd class="mono" data-queue="retry_wait">' + esc(n('retry_wait')) + '</dd></div>'
    + '<div class="stat"><dt>死信</dt><dd class="mono" data-queue="dead_letter">' + esc(n('dead_letter')) + '</dd></div>'
    + '</dl>';
}

/**
 * 死信最新在上。后端已经按 at 倒序，这里再排一次：
 * 顺序一旦漂，人会把旧故障当成刚发生的——而页面不会报错。
 * 不原地 sort 入参：调用方可能还拿着同一份列表。
 */
export function sortDeadLetters(rows) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  list.sort((a, b) => {
    const ta = Date.parse(String(a && a.at != null ? a.at : ''));
    const tb = Date.parse(String(b && b.at != null ? b.at : ''));
    const aOk = Number.isFinite(ta);
    const bOk = Number.isFinite(tb);
    if (aOk && bOk && tb !== ta) return tb - ta;
    if (aOk !== bOk) return aOk ? -1 : 1;
    const ia = text(a && a.hopId);
    const ib = text(b && b.hopId);
    if (ia < ib) return -1;
    if (ia > ib) return 1;
    return 0;
  });
  return list;
}

function deadLetterRowsHtml(rows) {
  const list = sortDeadLetters(rows);
  if (list.length === 0) {
    return '<tr><td class="empty" colspan="6">没有死信</td></tr>';
  }
  return list.map((row) => {
    const r = row || {};
    const when = formatWhen(r.at) || fieldText(r.at, '还没读到时间');
    return '<tr data-dead-letter="' + esc(r.hopId) + '">'
      + '<td class="mono">' + esc(when) + '</td>'
      + '<td class="mono">' + esc(text(r.hopId) || DASH) + '</td>'
      + '<td class="mono">' + esc(text(r.missionId) || DASH) + '</td>'
      + '<td>' + esc(roleLabel(r.role)) + '</td>'
      + '<td class="mono">' + esc(text(r.workItemId) || DASH) + '</td>'
      + '<td>' + esc(text(r.classification) || 'unknown') + '</td>'
      + '</tr>';
  }).join('');
}

export function queueCardHtml(queue) {
  if (queue === undefined || queue === null || queue === '') {
    return '<div class="card" data-platform-queue><h2>队列</h2>'
      + '<div class="note">还没读到队列</div></div>';
  }
  const inapplicable = inapplicableText(queue);
  if (inapplicable) {
    return '<div class="card" data-platform-queue><h2>队列</h2>'
      + '<div class="note">' + esc(inapplicable) + '</div></div>';
  }
  return '<div class="card" data-platform-queue>'
    + '<h2>队列</h2>'
    + queueCountStats(queue.counts)
    + '<div class="pane-title">死信</div>'
    + '<div class="table-wrap"><table class="tasks">'
    + '<thead><tr><th>时间</th><th>跳</th><th>任务</th><th>角色</th><th>工作项</th><th>类别</th></tr></thead>'
    + '<tbody>' + deadLetterRowsHtml(queue.deadLetters) + '</tbody>'
    + '</table></div>'
    + '</div>';
}

function dimListHtml(map) {
  const obj = map && typeof map === 'object' && !Array.isArray(map) && !isInapplicable(map) ? map : {};
  const keys = Object.keys(obj).sort();
  if (keys.length === 0) return '<div class="muted">没有占用</div>';
  return '<ul class="dim-list">' + keys.map((key) => {
    const n = Number(obj[key]);
    const shown = Number.isFinite(n) ? String(n) : fieldText(obj[key]);
    return '<li><span class="mono">' + esc(key) + '</span> · ' + esc(shown) + '</li>';
  }).join('') + '</ul>';
}

function limitOf(limits, key) {
  if (!limits || typeof limits !== 'object' || isInapplicable(limits)) return '';
  const n = Number(limits[key]);
  return Number.isFinite(n) ? String(n) : '';
}

function occupancyStat(label, used, limit, attr) {
  const right = limit ? used + ' / ' + limit : String(used);
  return '<div class="stat"><dt>' + esc(label) + '</dt>'
    + '<dd class="mono" data-occupancy="' + esc(attr) + '">' + esc(right) + '</dd></div>';
}

export function occupancyCardHtml(occupancy) {
  if (occupancy === undefined || occupancy === null || occupancy === '') {
    return '<div class="card" data-platform-occupancy><h2>五维占用</h2>'
      + '<div class="note">还没读到占用</div></div>';
  }
  const inapplicable = inapplicableText(occupancy);
  if (inapplicable) {
    return '<div class="card" data-platform-occupancy><h2>五维占用</h2>'
      + '<div class="note">' + esc(inapplicable) + '</div></div>';
  }
  const limits = occupancy.limits || {};
  const runtimeNote = countOf(occupancy, 'runtimeUnattributed') > 0
    ? '<div class="note">运行时未归因 ' + esc(countOf(occupancy, 'runtimeUnattributed')) + '</div>'
    : '';
  const profileNote = countOf(occupancy, 'profileUnattributed') > 0
    ? '<div class="note">候选未归因 ' + esc(countOf(occupancy, 'profileUnattributed')) + '</div>'
    : '';
  return '<div class="card" data-platform-occupancy>'
    + '<h2>五维占用</h2>'
    + '<dl class="task-stats">'
    + occupancyStat('活动租约', countOf(occupancy, 'activeLeases'), '', 'activeLeases')
    + occupancyStat('全局', countOf(occupancy, 'global'), limitOf(limits, 'global'), 'global')
    + occupancyStat('项目上限', limitOf(limits, 'project') || DASH, '', 'projectLimit')
    + occupancyStat('角色上限', limitOf(limits, 'role') || DASH, '', 'roleLimit')
    + occupancyStat('运行时上限', limitOf(limits, 'runtime') || DASH, '', 'runtimeLimit')
    + occupancyStat('候选上限', limitOf(limits, 'profile') || DASH, '', 'profileLimit')
    + '</dl>'
    + '<div class="pane-title">项目</div>' + dimListHtml(occupancy.project)
    + '<div class="pane-title">角色</div>' + dimListHtml(occupancy.role)
    + '<div class="pane-title">运行时</div>' + dimListHtml(occupancy.runtime) + runtimeNote
    + '<div class="pane-title">候选</div>' + dimListHtml(occupancy.profile) + profileNote
    + '</div>';
}

function envRows(agentEnv) {
  if (agentEnv === undefined || agentEnv === null || agentEnv === '') {
    return fieldRow('进程环境', '', '还没读到');
  }
  const inapplicable = inapplicableText(agentEnv);
  if (inapplicable) {
    return fieldRow('进程环境', inapplicable);
  }
  return fieldRow('环境透传已声明', agentEnv.passthroughDeclared)
    + fieldRow('基线已过滤', agentEnv.baselineFiltered)
    + fieldRow('额外透传项', agentEnv.extraPassthroughCount);
}

export function configCardHtml(status) {
  const s = status || {};
  return '<div class="card" data-platform-config>'
    + '<h2>只读配置</h2>'
    + '<dl class="fields">'
    + fieldRow('默认适配层', s.defaultAdapter)
    + envRows(s.agentEnv)
    + '</dl>'
    + '</div>';
}

export function platformPageHtml(status, loadError) {
  if (loadError && !status) {
    return '<div class="note">读不到平台状态：' + esc(loadError) + '</div>';
  }
  if (!status) {
    return '<div class="note">正在读取平台状态…</div>';
  }
  return identityCardHtml(status)
    + queueCardHtml(status.queue)
    + occupancyCardHtml(status.occupancy)
    + configCardHtml(status);
}

/* 下面五个状态名只给测试对「页面认的队列键」用，不拿来翻中文。 */
export { QUEUE_STATUSES };

/* ===================== 下面才是碰 DOM 的部分 ===================== */

async function get(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(path + ' → HTTP ' + res.status);
  return res.json();
}

let mounted = null;
let epoch = 0;

function clearTimer(st) {
  if (st && st.timer) {
    clearInterval(st.timer);
    st.timer = null;
  }
}

function stop(st) {
  clearTimer(st);
}

function writable(st) {
  return Boolean(
    st
    && st === mounted
    && st.epoch === epoch
    && st.els.root
    && st.els.root.isConnected,
  );
}

function paint(st) {
  if (!writable(st)) return;
  st.els.root.innerHTML = platformPageHtml(st.status, st.loadError);
}

function armTimer(st) {
  clearTimer(st);
  if (!writable(st)) return;
  st.timer = setInterval(() => {
    if (!writable(st)) {
      stop(st);
      return;
    }
    void pull(st);
  }, PLATFORM_POLL_MS);
}

async function pull(st) {
  const started = st.epoch;
  try {
    const status = await get('/api/platform/status');
    if (st.epoch !== started || !writable(st)) return;
    st.status = status;
    st.loadError = '';
    paint(st);
    armTimer(st);
  } catch (err) {
    if (st.epoch !== started || !writable(st)) return;
    st.loadError = err && err.message ? err.message : String(err);
    if (!st.status) paint(st);
    armTimer(st);
  }
}

/**
 * 挂载平台页。每次进来都重拉：这一页没有表单草稿要保。
 * 离页后靠 epoch + isConnected 丢掉过期响应——不这么做，晚到的 JSON
 * 会把已经切走的任务页整块盖掉，而且不报错。
 */
export async function renderPlatformPage(container) {
  if (mounted) stop(mounted);
  epoch += 1;
  // 外壳挂在常驻 view 上。骨架自己带 data-platform-root：paint 只改它的内部，
  // 这样晚到的响应即使判断失误，也写不进已经换成任务页的那棵树（节点离页即 isConnected=false）。
  container.innerHTML = '<div class="platform" data-platform-root>' + platformPageHtml(null) + '</div>';
  const st = {
    container,
    epoch,
    els: { root: container.querySelector('[data-platform-root]') },
    status: null,
    loadError: '',
    timer: null,
  };
  mounted = st;
  await pull(st);
}
