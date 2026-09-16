/**
 * 任务详情页（hash `#/missions/<missionId>`）。
 *
 * 与 projects.js 同一分界：**上面全是纯函数**（喂数据 → 回字符串），
 * 只有底部 renderTaskPage 碰 DOM 与 fetch。这么分不是为了洁癖：浏览器不在
 * 测试里，而"字段名读错了"这类错在页面上是没有声音的——那一格永远是 —，
 * 页面照样跑。纯函数才能在 node 里把真 JSON 喂进去把它抓出来。
 *
 * 只读。没有任何写操作：页头上那个「停止任务」是 disabled 的，而且刻意
 * 不绑事件——写操作要等鉴权（见那颗按钮的 title）。界面里再实现一份
 * 「什么时候可以取消」的规则，迟早和平台判的不一样。
 */

import { esc, num, stateChip, stageChip } from './projects.js';

const DASH = '—';

/** 终态没有"现在"，时长只跑到它最后一次动过的时候。 */
const isTerminal = (status) => status === 'completed' || status === 'blocked';

/* ===================== 时间 ===================== */

const pad = (n) => String(n).padStart(2, '0');

/**
 * ISO → 本地时刻（到秒）。后端存的是 UTC，拿不到本地化就会整条差几个小时。
 */
export function formatTime(iso) {
  const t = Date.parse(String(iso ?? ''));
  if (!Number.isFinite(t)) return DASH;
  const d = new Date(t);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

/**
 * 时长。两个时间点都由调用方给——**纯函数里不许 new Date() 取当前时间**，
 * 否则同一条数据在两次运行里得出不同的字，测试就没法断言了。
 */
export function formatDuration(startIso, endIso) {
  const a = Date.parse(String(startIso ?? ''));
  const b = Date.parse(String(endIso ?? ''));
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return DASH;
  let left = Math.round((b - a) / 1000);
  const days = Math.floor(left / 86400);
  left -= days * 86400;
  const hours = Math.floor(left / 3600);
  left -= hours * 3600;
  const minutes = Math.floor(left / 60);
  const seconds = left - minutes * 60;
  if (days > 0) return days + ' 天 ' + hours + ' 小时';
  if (hours > 0) return hours + ' 小时 ' + minutes + ' 分';
  if (minutes > 0) return minutes + ' 分 ' + seconds + ' 秒';
  return seconds + ' 秒';
}

/** 只要钟点那一段。终端里每行前摆一个日期太长；分不出的话看日期那栏。 */
export function formatClock(iso) {
  const full = formatTime(iso);
  return full === DASH ? DASH : full.slice(11);
}

const firstAt = (activity) => (activity && activity[0] ? activity[0].at : undefined);
const lastAt = (activity) =>
  (activity && activity.length ? activity[activity.length - 1].at : undefined);

/* ===================== 页头 ===================== */

const STOP_TITLE = 'API 尚无鉴权，写操作暂不开放';

/**
 * 页头：标题 + 两根 chip + 三格统计 + 停止按钮。
 *
 * 创建时间取 activity 按时间顺序的第一条（通常是 mission.created）：
 * MissionView **没有 createdAt**，而为了这一格去改内核/后端不值当——
 * 事件流本来就是"这条任务什么时候开始的"的权威来源。
 *
 * nowIso 由调用方传入，理由见 formatDuration。
 */
export function headerHtml(view, activity, nowIso) {
  const intent = (view && view.contract && view.contract.intent) || '（没有契约）';
  const created = firstAt(activity);
  // 终态的"结束"是它最后一次动过（updatedAt 就是最后一条事件落下的时间），
  // 拿不到才退回末条事件；活着的任务才用"现在"。
  const ended = isTerminal(view && view.status)
    ? (view && view.updatedAt) || lastAt(activity)
    : nowIso;
  return '<h1 class="task-title">' + esc(intent) + '</h1>'
    + '<div class="task-chips">'
    +   stageChip(view && view.status)
    +   stateChip(view || {})
    + '</div>'
    + '<dl class="task-stats">'
    +   '<div class="stat"><dt>总消耗 tokens</dt><dd class="mono">'
    +     esc(num(view && view.usage && view.usage.total)) + '</dd></div>'
    +   '<div class="stat"><dt>运行时长</dt><dd class="mono">'
    +     esc(formatDuration(created, ended)) + '</dd></div>'
    +   '<div class="stat"><dt>创建时间</dt><dd class="mono">'
    +     esc(formatTime(created)) + '</dd></div>'
    + '</dl>'
    // disabled + 不绑事件：界面上那颗"能点"的按钮是一个会让人按的谎。
    + '<button class="stop-btn" type="button" disabled title="' + esc(STOP_TITLE) + '">'
    +   '停止任务'
    + '</button>';
}

/* ===================== 左栏：执行事件流 ===================== */

/**
 * 事件流。`data-event-key` 是它在数组里的下标。
 *
 * 用下标而不是 messageId：历史事件不保证带 messageId（Envelope 那几个字段是
 * 后加的），而下标对 append-only 的 activity 来说是稳定且唯一的键。
 */
export function eventStreamHtml(events, selectedKey) {
  const rows = events || [];
  if (rows.length === 0) return '<li class="empty">还没有事件。这条任务刚开始。</li>';
  return rows
    .map((e, i) => {
      const refs = [e && e.workItemId, e && e.attemptId].filter(Boolean).join(' · ');
      return '<li class="evt" data-event-key="' + i + '"'
        + (selectedKey === i ? ' data-active="1"' : '') + '>'
        + '<div class="evt-kind mono">' + esc((e && e.kind) || DASH) + '</div>'
        + '<div class="evt-time">' + esc(formatTime(e && e.at)) + '</div>'
        + (refs ? '<div class="evt-refs mono">' + esc(refs) + '</div>' : '')
        + '</li>';
    })
    .join('');
}

/* ===================== 右上：事件详情 ===================== */

const field = (label, value, mono) =>
  '<dt>' + esc(label) + '</dt><dd' + (mono ? ' class="mono"' : '') + '>' + esc(value) + '</dd>';

/**
 * 选中事件的详情。没选中 / 没有 causationId 时显示 —，不是空白，
 * 也不是崩在 undefined 上：这两件事在屏幕上必须分得出来。
 */
export function eventDetailHtml(event, attempt) {
  const profile = attempt && attempt.profile;
  const usage = attempt && attempt.usage;
  return '<div class="detail-head">'
    +   '<span class="detail-title">事件详情</span>'
    +   '<span class="mono">' + esc((event && event.kind) || '没有选中事件') + '</span>'
    + '</div>'
    + '<dl class="fields">'
    +   field('时间', event && event.at ? formatTime(event.at) : DASH, true)
    +   field('关联工作项', (event && event.workItemId) || DASH, true)
    // causationId 就是"这一跳由哪次尝试引发"，也是去取详情的钥匙。
    +   field('causationId', (event && event.causationId) || DASH, true)
    +   field('候选 profile', profile
        ? profile.profileId + (profile.endpoint ? ' @ ' + profile.endpoint : '')
        : DASH, true)
    +   field('用量 total', usage ? num(usage.total) : DASH, true)
    + '</dl>';
}

/* ===================== 右下：五个 tab ===================== */

export const TASK_TABS = ['实时输出', '文件变更', '验证结果', '相关消息', '原始数据'];

const note = (text) => '<div class="note">' + esc(text) + '</div>';

/** tab 条。当前项 data-active="1"，点哪个由调用方的事件委托决定。 */
export function tabBarHtml(activeTab) {
  return TASK_TABS
    .map(
      (t) =>
        '<button class="tab" type="button" data-tab="' + esc(t) + '"'
        + (t === activeTab ? ' data-active="1"' : '') + '>' + esc(t) + '</button>',
    )
    .join('');
}

/**
 * 终端块里面那一块。
 *
 * `kind === 'usage'` 的 chunk **不当终端行**：它没有 text，塞进终端会吐出一行
 * `undefined`；它是累计用量，所以单独摆一行数字（见 liveMetaHtml）。
 */
export function liveLinesHtml(chunks) {
  const lines = [];
  for (const c of chunks || []) {
    if (c && c.kind !== 'usage') lines.push(c);
  }
  // 空的时候必须有一句说明：一个黑空的块看起来像坏了，而它只是还没开跑。
  if (lines.length === 0) {
    return '<span class="t">还没有实时输出。agent 跑起来时这里会一行行出现。</span>';
  }
  return lines
    .map((c) => (c.kind === 'tool'
      ? '<span class="tool">▸ ' + esc(c.text) + '</span>'
      : '<span class="t">' + esc(formatClock(c.at)) + '</span>  ' + esc(c.text)))
    .join('\n');
}

/** 终端块右上角那一行元信息（行数与累计用量）。勾选框不在里面，不被每秒重写。 */
export function liveMetaHtml(live) {
  const lines = (live && live.lines) || [];
  const count = lines.filter((c) => c && c.kind !== 'usage').length;
  return '<span class="muted">' + esc(num(count)) + ' 行</span>'
    + (live && live.usage ? '<span class="mono muted">tokens ' + esc(num(live.usage.total)) + '</span>' : '');
}

/** 实时输出的外框：勾选框 + 元信息 + 空的终端块。内容逐次只重写 pre 里面。 */
export function livePanelHtml(live) {
  return '<div class="live-bar">'
    +   '<label class="auto-scroll"><input type="checkbox" data-autoscroll'
    +     (live && live.autoScroll === false ? '' : ' checked') + ' /> 自动滚动</label>'
    +   '<span class="live-meta" data-live-meta>' + liveMetaHtml(live) + '</span>'
    + '</div>'
    + '<pre class="term" data-term>' + liveLinesHtml(live && live.lines) + '</pre>';
}

/** 文件变更：stat + 文件清单。逐行着色不在这一版（要引 diff 解析，代价大于用处）。 */
export function diffPanelHtml(diff) {
  if (!diff) return note('读取中…');
  if (diff.error) return note('读不到改动：' + diff.error);
  const files = diff.files || [];
  const stat = diff.stat ? String(diff.stat) : '（无改动）';
  return '<pre class="term">' + esc(stat) + '</pre>'
    + (files.length === 0
      ? note('没有文件清单。')
      : '<ul class="file-list">'
          + files.map((f) => '<li class="mono">' + esc(f) + '</li>').join('') + '</ul>');
}

/** 验证结果：选中事件那次尝试的证据。「已修复」必须有可验证证据——界面同理。 */
export function evidencePanelHtml(evidence) {
  const rows = evidence || [];
  if (rows.length === 0) return note('选中的事件没有对应证据：要么没选中，要么那次尝试没提交证据。');
  return '<ul class="evidence">'
    + rows
        .map(
          (e) => '<li>'
          + '<div class="ev-top"><span class="chip queued">' + esc((e && e.kind) || DASH) + '</span>'
          +   '<span>' + esc((e && e.summary) || DASH) + '</span>'
          +   (e && e.exitCode !== undefined && e.exitCode !== null
              ? '<span class="mono muted">exit=' + esc(e.exitCode) + '</span>'
              : '')
          + '</div>'
          + (e && e.command ? '<div class="mono muted">' + esc(e.command) + '</div>' : '')
          + '</li>',
        )
        .join('')
    + '</ul>';
}

/** 相关消息：升级问答。这一栏是 L3 与平台之间那封往来邮件的原文。 */
export function escalationPanelHtml(log) {
  const rows = log || [];
  if (rows.length === 0) return note('这条任务没有升级过问题（没有 L3 往来消息）。');
  return '<ul class="escalations">'
    + rows
        .map(
          (e) => '<li>'
          + '<div class="q">' + esc((e && e.question) || DASH) + '</div>'
          + '<div class="why">' + esc((e && e.why) || '（没有说明为什么需要 L3）') + '</div>'
          + ((e && e.optionsConsidered && e.optionsConsidered.length)
            ? '<ul class="options">'
                + e.optionsConsidered.map((o) => '<li>' + esc(o) + '</li>').join('')
                + '</ul>'
            : '')
          + '<div class="a">'
          +   (e && e.answer ? esc('答复：' + e.answer) : '<span class="muted">还没有答复。</span>')
          + '</div>'
          + '</li>',
        )
        .join('')
    + '</ul>';
}

/** 原始数据：选中事件整条 JSON。排查字段名不对时靠它。 */
export function rawPanelHtml(event) {
  if (!event) return note('没有选中事件，原始数据是空的。');
  let text = '';
  try {
    text = JSON.stringify(event, null, 2);
  } catch {
    return note('这条事件没法序列化成 JSON。');
  }
  return '<pre class="term">' + esc(text) + '</pre>';
}

/** tab 内容分发。切 tab 是纯渲染：activeTab 进、HTML 出，可测。 */
export function tabPanelHtml(activeTab, data) {
  const d = data || {};
  if (activeTab === '实时输出') return livePanelHtml(d.live);
  if (activeTab === '文件变更') return diffPanelHtml(d.diff);
  if (activeTab === '验证结果') return evidencePanelHtml(d.evidence);
  if (activeTab === '相关消息') return escalationPanelHtml(d.escalationLog);
  if (activeTab === '原始数据') return rawPanelHtml(d.event);
  return note('不认识的标签：' + (activeTab || '（空）'));
}

/* ===================== 自动滚动 ===================== */

/** 贴底多少像素以内算"在看最新的"。与观测面同一个数。 */
const FOLLOW_PX = 32;

/**
 * 要不要把人拽到最新一行。
 *
 * 判据必须在**追加之前**量：追加会先抬高 scrollHeight，追加后再量会把
 * 「刚才还贴着底」误判成「离底很远」，于是每一行新输出都把人的阅读位置甩走一次，
 * 想往上翻历史的人永远翻不动。
 */
export function shouldFollow(box) {
  const b = box || {};
  if (!b.autoScroll) return false;
  const scrollTop = Number(b.scrollTop) || 0;
  const clientHeight = Number(b.clientHeight) || 0;
  const scrollHeight = Number(b.scrollHeight) || 0;
  return scrollHeight - scrollTop - clientHeight <= FOLLOW_PX;
}

/* ===================== 下面才是碰 DOM 的部分 ===================== */

async function get(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(path + ' → HTTP ' + res.status);
  return res.json();
}

/** 终端里最多留多少行。实时输出是**看**的，不是存的。 */
const MAX_LINES = 2000;

/**
 * 每条 Mission 的实时输出状态，按 missionId 记。
 *
 * 离开页面再回来不重置游标：从头拉会把已经翻过去的输出重复追加一遍，
 * 而 cursor 的语义正是"我看到哪了"。
 */
const liveStates = new Map();
function liveStateOf(missionId) {
  let s = liveStates.get(missionId);
  if (!s) {
    s = { cursor: 0, lines: [], usage: null };
    liveStates.set(missionId, s);
  }
  return s;
}

let mounted = null;
/** 一次导航一个代号：await 期间可能又切了页，旧请求的落地必须被丢掉。 */
let epoch = 0;

/** 骨架。导出来是为了能拿它对一下 renderTaskPage 取的那些 id（拼错一个就是白屏）。 */
export function skeletonHtml() {
  return '<div class="task">'
    + '<header class="card task-head" id="task-head"><div class="note">加载中…</div></header>'
    + '<div class="task-cols">'
    +   '<section class="task-left">'
    +     '<div class="pane-title">执行事件流</div>'
    +     '<ul class="evt-list" id="task-events"><li class="empty">加载中…</li></ul>'
    +   '</section>'
    +   '<section class="task-right">'
    +     '<div class="card" id="task-detail"><div class="note">加载中…</div></div>'
    +     '<div class="card">'
    +       '<div class="tabs" id="task-tabs"></div>'
    +       '<div id="task-panel"></div>'
    +     '</div>'
    +   '</section>'
    + '</div>'
    + '</div>';
}

/**
 * 面包屑要哪几段。抽成纯函数是因为这一格全凭一个字符串拼错就错，
 * 而合同（项目 / <projectId> / 任务 <missionId>）是能被验收的。
 *
 * 末段不带 href：它是当前页。给它一个指回自己的链接，看着就像还能往下点。
 * projectId 为空（后端挂了、读不到 view）时中间那段干脆没有——拿 — 当项目名
 * 链到一个不存在的项目页，比少一段更误导人。
 */
export function crumbParts(projectId, missionId) {
  const parts = [{ text: '项目', href: '#/projects' }];
  if (projectId) {
    parts.push({ text: String(projectId), href: '#/projects/' + encodeURIComponent(projectId) });
  }
  parts.push({ text: '任务 ' + (missionId ?? ''), here: true });
  return parts;
}

/**
 * 面包屑归这一页填。
 *
 * 外壳本来一格数据都不读，而合同要的中间那段是 projectId——只有拿到 MissionView
 * 才知道。每段都用 textContent 写：missionId 与 projectId 都来自地址栏，
 * 是外部输入，不走 innerHTML。
 */
function setCrumbs(st) {
  const bar = document.getElementById('crumbs');
  if (!bar) return;
  const nodes = crumbParts(st.view && st.view.projectId, st.missionId).map((part) => {
    const el = document.createElement(part.here ? 'span' : 'a');
    if (part.href) el.href = part.href;
    if (part.here) el.className = 'here';
    // textContent 而不是 innerHTML 拼：面包屑里会出现地址栏来的 id。
    el.textContent = part.text;
    return el;
  });
  const kids = [];
  for (const [i, el] of nodes.entries()) {
    if (i > 0) {
      // 分隔符是页面自己写的字，不是外部输入。
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '/';
      kids.push(sep);
    }
    kids.push(el);
  }
  bar.replaceChildren(...kids);
}

const selectedEvent = (st) =>
  st.selectedKey === null ? undefined : (st.activity || [])[st.selectedKey];

function paintHead(st) {
  if (!st.view) return;
  // 当前时间是 DOM 层的事；纯函数只收字符串。
  st.els.head.innerHTML = headerHtml(st.view, st.activity, new Date().toISOString());
}

function paintEvents(st) {
  st.els.events.innerHTML = eventStreamHtml(st.activity, st.selectedKey);
}

function paintDetail(st) {
  st.els.detail.innerHTML = eventDetailHtml(selectedEvent(st), st.attempt);
}

/**
 * 追新行。只重写终端块里面与那一行元信息，不重建外框。
 *
 * 判据必须在写入**之前**量：追加会先抬高 scrollHeight，写完再量会把
 * 「刚才还贴底」误判成「离底很远」。外框也不重建：那会每秒把
 * 「自动滚动」勾选框与它的焦点丢一次，人正要点它时永远点不中。
 */
function pushLive(st) {
  const term = st.els.panel.querySelector('[data-term]');
  if (!term) return; // 不在实时输出那个 tab 上：行已经攒在 st.live 里，切回去再看。
  const follow = shouldFollow({
    autoScroll: st.autoScroll,
    scrollTop: term.scrollTop,
    clientHeight: term.clientHeight,
    scrollHeight: term.scrollHeight,
  });
  term.innerHTML = liveLinesHtml(st.live.lines);
  const meta = st.els.panel.querySelector('[data-live-meta]');
  if (meta) meta.innerHTML = liveMetaHtml(st.live);
  if (follow) term.scrollTop = term.scrollHeight - term.clientHeight;
}

/**
 * 画 tab 条与内容。切 tab、换选中项时走这里（整块重建）。
 */
function paintPanel(st) {
  st.els.tabs.innerHTML = tabBarHtml(st.tab);
  st.els.panel.innerHTML = tabPanelHtml(st.tab, {
    live: Object.assign({ autoScroll: st.autoScroll }, st.live),
    diff: st.diff,
    evidence: (st.attempt && st.attempt.evidence) || [],
    escalationLog: (st.view && st.view.escalationLog) || [],
    event: selectedEvent(st),
  });
  // 刚重建：滚到最新一行。首帧没有 pre 可量，shouldFollow 把空位当贴底。
  const term = st.els.panel.querySelector('[data-term]');
  if (term && st.autoScroll) term.scrollTop = term.scrollHeight - term.clientHeight;
}

async function loadAttempt(st, key) {
  const event = (st.activity || [])[key];
  const causationId = event && event.causationId;
  st.attempt = null;
  // 没有 causationId 就不发这个请求：拿 undefined 去拼 URL 会打到
  // /attempts/undefined，而它返回的是 UNKNOWN_ATTEMPT 错误——一次没必要的 500。
  if (!causationId) {
    if (st.epoch === epoch) paintDetail(st);
    return;
  }
  let detail = null;
  try {
    detail = await get(
      '/api/missions/' + encodeURIComponent(st.missionId)
        + '/attempts/' + encodeURIComponent(causationId),
    );
  } catch (err) {
    detail = { error: err.message };
  }
  // await 期间人可能又点了别的事件，或者整页都换了一条 Mission。
  if (st.epoch !== epoch || st.selectedKey !== key) return;
  st.attempt = detail && detail.error ? null : detail;
  paintDetail(st);
  if (st.tab === '验证结果') paintPanel(st);
}

async function loadDiff(st) {
  if (st.diffRequested) return;
  st.diffRequested = true;
  let got = null;
  try {
    got = await get('/api/missions/' + encodeURIComponent(st.missionId) + '/diff');
  } catch (err) {
    got = { error: err.message };
  }
  if (st.epoch !== epoch) return;
  st.diff = got;
  if (st.tab === '文件变更') paintPanel(st);
}

/** 一轮游标拉取。只取 cursor 之后的，不从头。 */
async function pollLive(st) {
  if (st.polling) return;
  st.polling = true;
  try {
    const body = await get(
      '/api/missions/' + encodeURIComponent(st.missionId)
        + '/live?cursor=' + st.live.cursor,
    );
    if (st.epoch !== epoch) return;
    const chunks = (body && body.chunks) || [];
    for (const c of chunks) {
      if (c && c.kind === 'usage') {
        st.live.usage = c.usage || st.live.usage;
        continue;
      }
      st.live.lines.push({ at: c && c.at, kind: (c && c.kind) || 'text', text: (c && c.text) || '' });
    }
    if (st.live.lines.length > MAX_LINES) {
      st.live.lines.splice(0, st.live.lines.length - MAX_LINES);
    }
    const cursor = Number(body && body.cursor);
    if (Number.isFinite(cursor)) st.live.cursor = cursor;
    if (chunks.length && st.tab === '实时输出') pushLive(st);
  } catch {
    // 轮询失败不动界面：下一次心跳自然会补上。把它写成一条错误行，
    // 会让"后端重启了一次"看起来像任务挂了。
  } finally {
    st.polling = false;
  }
}

function selectTab(st, tab) {
  st.tab = tab;
  paintPanel(st);
  if (tab === '文件变更') void loadDiff(st);
}

function bind(st) {
  // 监听挂在常驻容器上：panel 每次切 tab 都整块重写 innerHTML，
  // 绑在里面那个元素上的话，切一次就丢一次监听（然后页面"点了没反应"）。
  st.els.events.addEventListener('click', (ev) => {
    const row = ev.target && ev.target.closest && ev.target.closest('[data-event-key]');
    if (!row) return;
    st.selectedKey = Number(row.dataset.eventKey);
    paintEvents(st);
    void loadAttempt(st, st.selectedKey);
    // 原始数据与验证结果两块都跟着选中项变。
    if (st.tab === '原始数据' || st.tab === '验证结果') paintPanel(st);
  });

  st.els.tabs.addEventListener('click', (ev) => {
    const btn = ev.target && ev.target.closest && ev.target.closest('[data-tab]');
    if (!btn) return;
    selectTab(st, btn.dataset.tab);
  });

  st.els.panel.addEventListener('change', (ev) => {
    const box = ev.target && ev.target.closest && ev.target.closest('[data-autoscroll]');
    if (!box) return;
    st.autoScroll = box.checked;
  });
}

function stop(st) {
  if (st.timer) clearInterval(st.timer);
  st.timer = null;
}

async function load(st) {
  const enc = encodeURIComponent(st.missionId);
  try {
    const [view, activity] = await Promise.all([
      get('/api/missions/' + enc),
      get('/api/missions/' + enc + '/activity'),
    ]);
    if (st.epoch !== epoch) return;
    st.view = view;
    st.activity = Array.isArray(activity) ? activity : [];
    setCrumbs(st);
    paintHead(st);
    paintEvents(st);
    paintDetail(st);
    paintPanel(st);
    void pollLive(st);
  } catch (err) {
    if (st.epoch !== epoch) return;
    // 一次都没读到就写「还没有任务」是撒谎：那是读不到，不是没有。
    st.els.head.innerHTML = '<div class="note">读不到这条任务：' + esc(err.message) + '</div>';
    st.els.events.innerHTML = '<li class="empty">刷新一下重试</li>';
    setCrumbs(st);
  }
}

/**
 * 挂载任务页。
 *
 * 同一个容器、同一条 Mission、节点还挂在树上 —— 不重建。重建会把轮询定时器
 * 清掉重开（一次点两下就是两心跳），而实时输出的行是攒在页面里的，清掉就丢。
 */
export async function renderTaskPage(container, missionId) {
  const same = mounted
    && mounted.container === container
    && mounted.missionId === missionId
    && mounted.els.head
    && mounted.els.head.isConnected;
  if (same) return;

  if (mounted) stop(mounted);
  epoch += 1;

  container.innerHTML = skeletonHtml();
  const st = {
    container,
    missionId,
    epoch,
    els: {
      head: container.querySelector('#task-head'),
      events: container.querySelector('#task-events'),
      detail: container.querySelector('#task-detail'),
      tabs: container.querySelector('#task-tabs'),
      panel: container.querySelector('#task-panel'),
    },
    view: null,
    activity: [],
    selectedKey: null,
    attempt: null,
    diff: null,
    diffRequested: false,
    tab: TASK_TABS[0],
    autoScroll: true,
    live: liveStateOf(missionId),
    polling: false,
    timer: null,
  };
  mounted = st;
  bind(st);
  // 离开本页时节点会离树；留着定时器就是一个每 1 秒打一次 API、
  // 又把结果丢进垃圾桶的请求源。这一路只在这里断。
  st.timer = setInterval(() => {
    if (!st.els.head || !st.els.head.isConnected) {
      stop(st);
      return;
    }
    void pollLive(st);
  }, 1000);

  await load(st);
}
