/**
 * 项目页：左栏项目列表，右栏详情卡 + 任务表。
 *
 * 只走 /api/*，只读。写操作（放行/打回/取消）刻意不做：规则该只有一份实现，
 * 界面里再写一份，迟早和平台判的不一样（观测面同理，见 src/api/web.ts 顶部）。
 *
 * 生成 HTML 的函数都是纯函数（喂数据 → 回字符串），DOM 写入只在这一个文件
 * 底部的 renderProjectsPage 里。这么分是因为浏览器不在测试里：纯函数能直接在
 * node 里喂一条假 Mission 断言列与 chip，而这些恰恰是最容易悄悄改错的部分
 * （少一个字段只是那一格空着，不报错）。
 */

import { STAGE_CN, WAIT_REASON, reasonText, stateLabel, usageLine , usageCell, planStatusText, planStopText, planFeatureText, planCostText } from './narrate.js';

/**
 * 词表只住在 narrate.js（任务页也读同一份）。这里把它们再导出去，是给
 * 已经从这里取这些名字的调用方留一条不动的路——**不是**第二份实现。
 * 再抄一份表进来，加一个状态就会只改到一处，另一处静悄悄地退回默认值。
 */
export { STAGE_CN, WAIT_REASON, reasonText, stateLabel };

/** 插入 DOM 的字段一律转义：projectId、intent、waitDetail 全是外部输入。 */
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * 取色。逐个对着观测面 .badge 抄（src/api/web.ts）。改一边就得改另一边，
 * 否则同一状态在两个界面里是两种颜色。只经由 stageChip / stageTone 出去。
 */
const STAGE_TONE = {
  investigating: 'queued',
  planning: 'queued',
  executing: 'running',
  awaiting_review: 'unconfirmed',
  completed: 'done',
  blocked: 'failed',
};

/**
 * 阶段 → 色。表格行左侧那条色条也要它：行色与阶段 chip 必须同源，
 * 否则「执行中」的 chip 是绿的而它的行是灰的，人就会以为那是两件事。
 */
export function stageTone(status) {
  return STAGE_TONE[status] || 'queued';
}

/** title 是可选的：等待中的 chip 靠它把停机原因带出来。 */
const chip = (tone, text, title) =>
  '<span class="chip ' + esc(tone) + '"'
  + (title ? ' title="' + esc(title) + '"' : '')
  + '>' + esc(text) + '</span>';

/**
 * 阶段 chip：内核 MissionStatus → 中文 + 取色。
 *
 * 抽出来而不是让任务详情页再抄一份：中文表与取色表一旦有两份，加一个状态就会
 * 只改到一处，另一处的 chip 静悄悄退回默认灰——那种错没人会当 bug 报。
 */
export function stageChip(status) {
  return chip(stageTone(status), STAGE_CN[status] || status);
}

/**
 * 状态是第二根轴：阶段说"走到哪了"，这根说"为什么不动"。
 *
 * 词来自 narrate.stateLabel（完成品是「已结束」/「已停止」，与阶段的
 * 「已完成」/「已中止」刻意不同词）；取色留在这一页。下面这几行的分支顺序
 * 与 stateLabel 一一对应——对不上就是「等待中」配了「进行中」的颜色，
 * 而那种错在屏幕上说不出哪里不对。
 */
export function stateChip(row) {
  const r = row || {};
  const tone = r.paused ? 'cancelled'
    : r.waitReason ? 'unconfirmed'
    : r.status === 'completed' ? 'done'
    : r.status === 'blocked' ? 'failed'
    : 'running';
  // 等待中的行，停机原因挂在 chip 上：只写「等待中」等于没说在等什么，
  // 人得去横着一个屏幕的原因栏里找。
  return chip(tone, stateLabel(r), r.paused || r.waitReason ? reasonText(r) : '');
}

// 任务详情页也要这个数（实时输出的行数、累计用量），所以是导出的。
export const num = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString('en-US') : '0');

export function projectListHtml(projects, selectedId) {
  if (!projects || projects.length === 0) return '<li class="empty">还没有项目</li>';
  return projects
    .map(
      (p) =>
        '<li class="proj" data-id="' + esc(p.projectId) + '"' +
        (p.projectId === selectedId ? ' data-active="1"' : '') + '>' +
        '<div class="name">' + esc(p.projectId) + '</div>' +
        '<div class="meta">' + esc(num(p.missions)) + ' 个任务 · 改动名额 ' +
        (p.mutating ? '已占' : '空闲') + '</div>' +
        '</li>',
    )
    .join('');
}

export function detailCardHtml(project, workspace) {
  const slot = project.mutating ? '1/1' : '0/1';
  // 读不到仓库不等于「没有仓库」：拿 — 顶上去，人分不出是后端没给还是本来就没有。
  const root = workspace.projectRoot || '（还没读到代码路径）';
  const branch = workspace.branch || '（还没读到目标分支）';
  return '<div class="card"><h2>' + esc(project.projectId) + '</h2>'
    + '<dl class="fields">'
    +   '<dt>项目 ID</dt><dd class="mono">' + esc(project.projectId) + '</dd>'
    +   '<dt>代码仓库</dt><dd class="mono">' + esc(root) + '</dd>'
    +   '<dt>目标分支</dt><dd class="mono">' + esc(branch) + '</dd>'
    // 改动名额是内核那条"同项目同时只放一条改动"的不变量。显示成 n/1，
    // 是为了让人一眼看出下一条派得出去派不出去，而不是去猜。
    +   '<dt>变更中任务</dt><dd>' + chip(project.mutating ? 'unconfirmed' : 'queued', slot)
    +     ' <span class="muted">同一项目同时只放一条改动</span></dd>'
    + '</dl></div>';
}

/** 任务表表头。列名与顺序一起写死，测试照着这七列断言。 */
export const TASK_COLUMNS = ['任务 ID', '标题', '阶段', '状态', '原因', '最新更新时间', 'Token'];

/**
 * 某一行没有 updatedAt。不能写成「列表接口不提供时间戳」：/api/missions 行上
 * 早就有这个字段，那句会让人以为后端没给、不再去查。也不能用页面生成时间
 * 冒充——那是个会让人据此判断谁卡住了的假数字。
 */
const NO_TIMESTAMP = '还没读到更新时间';

/** 没有停机原因不等于「原因未知」：多数任务只是没停过。 */
const NO_WAIT_REASON = '没有停机，正常推进';

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * 任务表的更新时间。列上 MM-DD HH:mm 够扫；完整本地时刻放 title，
 * 悬停才展开到秒。不从 task.js 借 formatTime：那边已经 import 本文件，
 * 再反向 import 就是循环依赖，两边加载顺序一变，有一个会拿到未初始化的绑定。
 */
function formatUpdatedAt(iso) {
  const t = Date.parse(String(iso ?? ''));
  if (!Number.isFinite(t)) return { text: NO_TIMESTAMP, title: '' };
  const d = new Date(t);
  const text = pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
    + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  const title = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
    + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  return { text, title };
}

function updatedAtMs(row) {
  const t = Date.parse(String(row && row.updatedAt != null ? row.updatedAt : ''));
  // 缺时间的排到最后：当成 0 的话会和 1970 的真时间挤在一起，扫表时以为它刚动过。
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

/**
 * 方案运行行的花费：只加各 Mission 已上报的 usage.cost。
 * 缺的不当 0——那会把「没上报」显示成「这次不要钱」。
 * 列表里还没出现的 missionId 也算一条未上报，不能假装这笔不存在。
 */
function usagesForPlanRun(run, missions) {
  const byId = new Map();
  for (const row of Array.isArray(missions) ? missions : []) {
    if (row && row.missionId != null) byId.set(String(row.missionId), row.usage);
  }
  const ids = [];
  const seen = new Set();
  const pushId = (id) => {
    const key = String(id ?? '');
    if (!key || seen.has(key)) return;
    seen.add(key);
    ids.push(key);
  };
  for (const feature of Array.isArray(run && run.features) ? run.features : []) {
    for (const id of Array.isArray(feature && feature.missionIds) ? feature.missionIds : []) {
      pushId(id);
    }
  }
  for (const row of Array.isArray(missions) ? missions : []) {
    if (row && row.planRunId === run.id) pushId(row.missionId);
  }
  return ids.map((id) => byId.get(id));
}

/** 票数及结局。词走 planFeatureText，不在这一页再列一张票状态表。 */
function ticketOutcomeText(features) {
  const rows = Array.isArray(features) ? features : [];
  const counts = new Map();
  const order = [];
  for (const feature of rows) {
    const label = planFeatureText(feature && feature.status);
    if (!counts.has(label)) order.push(label);
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  const parts = [rows.length + ' 张票'];
  for (const label of order) {
    const n = counts.get(label);
    if (n) parts.push(label + ' ' + n);
  }
  return parts.join(' · ');
}

function startedAtMs(row) {
  const t = Date.parse(String(row && row.startedAt != null ? row.startedAt : ''));
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

function isPlanRunError(row) {
  return Boolean(row && row.error != null && row.error !== '');
}

/**
 * 方案运行表。按开跑时间倒序；坏记录 {id,error} 沉底，不拿假字段填一行。
 * 入参数组不原地排序：调用方还拿着同一份列表做别的事。
 */
export function planRunsTableHtml(runs, missions) {
  const rows = (Array.isArray(runs) ? runs : []).slice().sort((a, b) => {
    const aBad = isPlanRunError(a);
    const bBad = isPlanRunError(b);
    if (aBad !== bBad) return aBad ? 1 : -1;
    return startedAtMs(b) - startedAtMs(a);
  });
  if (rows.length === 0) {
    return '<div class="card"><div class="pane-title">方案运行</div>'
      + '<div class="empty">这个项目还没有方案运行。</div></div>';
  }
  const head = ['开跑时间', '方案', '票', '升级', '花费']
    .map((t) => '<th>' + esc(t) + '</th>').join('');
  const body = rows.map((row) => {
    const r = row || {};
    if (isPlanRunError(r)) {
      return '<tr class="row-failed" data-plan-run-error="' + esc(r.id) + '">'
        + '<td class="mono">' + esc(r.id) + '</td>'
        + '<td colspan="4" class="cell-reason">' + esc(r.error) + '</td>'
        + '</tr>';
    }
    const when = formatUpdatedAt(r.startedAt);
    const cost = planCostText(usagesForPlanRun(r, missions));
    const href = '#/plan-runs/' + encodeURIComponent(r.id);
    const stop = planStopText(r.stopped);
    return '<tr class="row-' + (r.stopped ? 'cancelled' : 'running') + '" data-plan-run-id="' + esc(r.id) + '">'
      + '<td class="muted"'
      +   (when.title ? ' title="' + esc(when.title) + '"' : '')
      + '>' + esc(when.text) + '</td>'
      + '<td><a class="mono" href="' + esc(href) + '">' + esc(r.id) + '</a>'
      +   '<div>' + esc(r.planId || r.id) + '</div>'
      +   '<div class="muted">' + esc(planStatusText(r)) + (stop ? ' · ' + stop : '') + '</div></td>'
      + '<td>' + esc(ticketOutcomeText(r.features)) + '</td>'
      + '<td>' + esc(num(r.escalationCount)) + '</td>'
      + '<td class="cell-usage">' + esc(cost) + '</td>'
      + '</tr>';
  }).join('');
  return '<div class="card"><div class="pane-title">方案运行</div><div class="table-wrap">'
    + '<table class="tasks"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>'
    + '</div></div>';
}

/**
 * 筛选四态。需处理 = 等人（检视 / 升级 / 暂停），不是所有 waitReason：
 * project_busy 那种是平台在排队，归进行中。终态优先于需处理，
 * 否则一条已完成却还挂着旧 waitReason 的行会永远停在「需处理」里。
 */
export function missionFilterKey(row) {
  const r = row || {};
  if (r.status === 'completed') return 'completed';
  if (r.status === 'blocked') return 'blocked';
  if (r.status === 'awaiting_review' || r.paused || r.waitReason === 'waiting_l3' || r.waitReason === 'escalated') {
    return 'needs';
  }
  return 'active';
}

/**
 * 按 featureId 折多次 Mission。没有 featureId 的各自成组——空串当钥匙会把
 * 所有普通任务揉成一坨，看起来像同票历史，比不分组更误导。
 * 组与组内行都按最新 updatedAt 倒序；不改入参数组。
 */
export function groupMissionsByFeature(rows) {
  const groups = [];
  const byFeature = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const fid = row && row.featureId != null && String(row.featureId) !== '' ? String(row.featureId) : '';
    if (fid) {
      let group = byFeature.get(fid);
      if (!group) {
        group = { featureId: fid, missions: [] };
        byFeature.set(fid, group);
        groups.push(group);
      }
      group.missions.push(row);
    } else {
      groups.push({ featureId: '', missions: [row] });
    }
  }
  for (const group of groups) {
    group.missions = group.missions.slice().sort((a, b) => updatedAtMs(b) - updatedAtMs(a));
  }
  groups.sort((a, b) => updatedAtMs(b.missions[0]) - updatedAtMs(a.missions[0]));
  return groups;
}

export function filterMissionGroups(groups, filter) {
  if (!filter) return groups;
  return (groups || []).filter((group) => missionFilterKey(group.missions[0]) === filter);
}

function featureTitleOf(group, planRuns) {
  const fid = group && group.featureId;
  if (fid) {
    for (const run of Array.isArray(planRuns) ? planRuns : []) {
      for (const feature of Array.isArray(run && run.features) ? run.features : []) {
        if (feature && String(feature.featureId) === fid && feature.title) return feature.title;
      }
    }
  }
  const head = group && group.missions && group.missions[0];
  return (head && head.intent) || fid || '（没有契约）';
}

function missionHistoryHtml(missions) {
  return '<ul class="detail-list">' + missions.map((m) => {
    const when = formatUpdatedAt(m && m.updatedAt);
    const href = '#/missions/' + encodeURIComponent(m && m.missionId);
    return '<li data-mission-id="' + esc(m && m.missionId) + '">'
      + '<a class="mono" href="' + esc(href) + '">' + esc(m && m.missionId) + '</a>'
      + ' ' + stageChip(m && m.status)
      + ' ' + stateChip(m)
      + ' <span class="muted"'
      +   (when.title ? ' title="' + esc(when.title) + '"' : '')
      + '>' + esc(when.text) + '</span>'
      + ' <span class="muted">' + esc(usageCell(m && m.usage)) + '</span>'
      + '<div class="cell-title">' + esc((m && m.intent) || '（没有契约）') + '</div>'
      + '</li>';
  }).join('') + '</ul>';
}

export function missionGroupsHtml(rows, filter, openGroups, planRuns) {
  const groups = filterMissionGroups(groupMissionsByFeature(rows), filter);
  if (!rows || rows.length === 0) {
    return '<div class="card"><div class="empty">这个项目还没有任务。新建一条之后这里会一行行出现。</div></div>';
  }
  if (groups.length === 0) {
    return '<div class="card"><div class="empty">没有符合筛选的任务。</div></div>';
  }
  const open = openGroups instanceof Set ? openGroups : new Set(Array.isArray(openGroups) ? openGroups : []);
  return groups.map((group) => {
    const head = group.missions[0];
    const gid = group.featureId ? 'feature:' + group.featureId : 'solo:' + (head && head.missionId);
    const title = featureTitleOf(group, planRuns);
    const label = group.featureId ? group.featureId : (head && head.missionId);
    const when = formatUpdatedAt(head && head.updatedAt);
    return '<details class="card" data-group-id="' + esc(gid) + '"'
      + (open.has(gid) ? ' open' : '') + '>'
      + '<summary class="plan-feature-head">'
      +   '<span class="mono">' + esc(label) + '</span> '
      +   esc(title) + ' '
      +   stageChip(head && head.status) + ' ' + stateChip(head)
      +   ' <span class="muted">' + esc(when.text) + '</span>'
      +   (group.missions.length > 1 ? ' <span class="muted">' + esc(String(group.missions.length) + ' 次') + '</span>' : '')
      + '</summary>'
      + missionHistoryHtml(group.missions)
      + '</details>';
  }).join('');
}

function tabButton(id, label, current) {
  const on = id === current;
  return '<button type="button" class="chip ' + (on ? 'running' : 'queued') + '" data-tab="' + esc(id) + '"'
    + (on ? ' data-active="1"' : '') + '>' + esc(label) + '</button>';
}

function filterButton(id, label, current) {
  const on = id === current;
  return '<button type="button" class="chip ' + (on ? 'running' : 'queued') + '" data-filter="' + esc(id) + '"'
    + (on ? ' data-active="1"' : '') + '>' + esc(label) + '</button>';
}

/**
 * 项目详情下半：默认方案运行标签，可切到按票分组的全部任务。
 * tab 缺省是 plan-runs——合同要的就是进来先看方案，而不是平铺 Mission。
 */
export function projectWorkbenchHtml(opts) {
  const o = opts || {};
  const tab = o.tab === 'missions' ? 'missions' : 'plan-runs';
  const filter = o.filter || '';
  const tabs = '<div class="task-chips" data-project-tabs>'
    + tabButton('plan-runs', '方案运行', tab)
    + tabButton('missions', '全部任务', tab)
    + '</div>';
  if (tab === 'missions') {
    const filters = '<div class="task-chips" data-mission-filters>'
      + filterButton('active', '进行中', filter)
      + filterButton('needs', '需处理', filter)
      + filterButton('completed', '已完成', filter)
      + filterButton('blocked', '已中止', filter)
      + '</div>';
    return '<div data-workbench>' + tabs + filters + missionGroupsHtml(o.missions, filter, o.openGroups, o.planRuns) + '</div>';
  }
  const error = o.planRunsError
    ? '<div class="empty">读不到方案运行：' + esc(o.planRunsError) + '</div>'
    : '';
  const table = o.planRunsLoading && !(o.planRuns && o.planRuns.length)
    ? '<div class="card"><div class="empty">正在读方案运行…</div></div>'
    : planRunsTableHtml(o.planRuns, o.missions);
  return '<div data-workbench>' + tabs + error + table + '</div>';
}

export function taskTableHtml(rows) {
  if (!rows || rows.length === 0) {
    return '<div class="card"><div class="empty">这个项目还没有任务。新建一条之后这里会一行行出现。</div></div>';
  }
  const head = TASK_COLUMNS.map((t) => '<th>' + esc(t) + '</th>').join('');
  const sorted = rows.slice().sort((a, b) => updatedAtMs(b) - updatedAtMs(a));
  const body = sorted
    .map((m) => {
      const reason = reasonText(m);
      const when = formatUpdatedAt(m.updatedAt);
      return '<tr class="row-' + esc(stageTone(m.status)) + '" data-mission-id="' + esc(m.missionId) + '">'
        + '<td class="mono">' + esc(m.missionId) + '</td>'
        + '<td class="cell-title">' + esc(m.intent || '（没有契约）') + '</td>'
        + '<td>' + stageChip(m.status) + '</td>'
        + '<td>' + stateChip(m) + '</td>'
        + '<td class="cell-reason">'
        +   (reason ? esc(reason) : '<span class="muted">' + esc(NO_WAIT_REASON) + '</span>')
        + '</td>'
        + '<td class="muted"'
        +   (when.title ? ' title="' + esc(when.title) + '"' : '')
        + '>' + esc(when.text) + '</td>'
        // Token 那一列与任务页同一个口径（narrate.usageLine）：只印一个 total
        // 看不出钱花在哪，而缓存读比新增便宜得多。
        + '<td class="cell-usage" title="' + esc(usageLine(m.usage)) + '">' + esc(usageCell(m.usage)) + '</td>'
        + '</tr>';
    })
    .join('');
  return '<div class="card"><div class="pane-title">任务</div><div class="table-wrap">'
    + '<table class="tasks"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>'
    + '</div></div>';
}

/**
 * 该不该拉、拉什么、过多久再拉。纯函数：定时器与 fetch 都在调用方。
 *
 * 三个输入是三根轴，少一根就会在错误的时候打到错误的接口：
 * - page：'projects' | 'mission' | 其它。不在对应页就别拉那页的接口；
 * - status：任务页才看（completed / blocked 停轮询）。项目页不按某一条任务的状态停；
 *   状态还不知道（空串）不当成终态，否则一次瞬时故障之后就再也不会重试；
 * - visible：隐藏标签页还继续拉，是给看不见的人烧配额。
 *
 * 返回（任务页从这里 import，不要再抄；本文件不得 import task.js）：
 * - paths：请求意图。项目页是真路径；任务页是 'view' / 'activity' / 'live'
 *   （这里没有 missionId，拼不出 URL，由调用方接成 GET /api/missions/:id、/activity、live）。
 *   空 = 现在不要请求。
 * - intervalMs：项目列表 / 任务 view+activity 的间隔；null = 不要挂这只定时器。
 * - liveIntervalMs：任务页实时输出间隔；项目页永远是 null。
 * 从隐藏回到可见时 paths 会再次有值：调用方应当立刻拉一次，再按两只间隔续上。
 */
const REFRESH_IDLE = { paths: [], intervalMs: null, liveIntervalMs: null };

export function nextRefresh(page, status, visible) {
  if (!visible) return REFRESH_IDLE;
  if (page === 'projects') {
    return { paths: ['/api/projects', '/api/missions'], intervalMs: 5000, liveIntervalMs: null };
  }
  if (page === 'mission') {
    if (status === 'completed' || status === 'blocked') return REFRESH_IDLE;
    return {
      paths: ['view', 'activity', 'live'],
      intervalMs: 3000,
      liveIntervalMs: 1000,
    };
  }
  return REFRESH_IDLE;
}

/* ===================== 下面才是碰 DOM 的部分 ===================== */

async function get(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(path + ' → HTTP ' + res.status);
  return res.json();
}

let mounted = null;
/** 上一次成功读到的列表。拉失败时保留它，界面继续显示旧数据而不是变成白板。 */
let data = null;
let selected = '';
/** 每个项目的仓库/分支要另拉一次 Mission 详情，拉过就不再拉。 */
const workspaceCache = new Map();
/**
 * 详情下半的浏览态。不进 hash：合同没要求标签可分享，写进地址会让「项目页」
 * 和「方案运行页」两条路由抢 #/plan-runs。切项目仍保留，避免扫任务时每点一次左栏就弹回默认标签。
 */
const workbench = { tab: 'plan-runs', filter: '', openGroups: new Set(), planRunsError: '', loading: false };
/**
 * 导航世代。离开项目页或重建骨架时加一，让还在飞的响应把 data 写进去、
 * 把详情盖掉——人已经在看别的页了，那次结果不该再碰屏幕。
 */
let epoch = 0;
let pollTimer = null;
let onVisibility = null;

function skeleton() {
  return '<div class="page">'
    + '<div><div class="pane-title">项目</div><ul class="proj-list" id="proj-list"></ul></div>'
    + '<div id="proj-detail"><div class="empty">加载中…</div></div>'
    + '</div>';
}

/**
 * 拿哪条 Mission 去问仓库和分支：优先正占用改动名额的那条。
 * 只有真开过工作区的 Mission 才有 workspaceRef，先拿一条还没跑的去问，
 * 得到的是"没有"，而项目其实是有仓库的。
 */
function probeMission(projectId) {
  const rows = ((data && data.missions) || []).filter((m) => m.projectId === projectId);
  return rows.find((m) => m.isMutating) || rows[0];
}

async function loadWorkspace(projectId) {
  if (workspaceCache.has(projectId)) return workspaceCache.get(projectId);
  const probe = probeMission(projectId);
  if (!probe) return {};
  try {
    const view = await get('/api/missions/' + encodeURIComponent(probe.missionId));
    const ref = (view && view.workspaceRef) || {};
    // **目标分支要读 targetBranch，不是 branch。** 后者是 Mission 自己的
    // 工作分支；拿它当目标分支显示，界面上就成了"项目在往 mission/W1 上合"。
    // 老数据没有这个字段，那就如实显示不知道，不要拿另一个字段顶上。
    const found = {
      projectRoot: ref.projectRoot,
      branch: ref.targetBranch,
      missionBranch: ref.branch,
    };
    // 两个字段都拿不到，说的是"这条还没开工作区"，不是"这个项目没有仓库"。
    // 连这个结果一起缓存住的话，Mission 跑起来以后那一栏也会永远是 —，
    // 除非人刷新页面——而他会以为那是后端给错了。
    if (found.projectRoot || found.branch || found.missionBranch) {
      workspaceCache.set(projectId, found);
    }
    return found;
  } catch {
    // 读不到不算错误态：这一栏只是顺带告诉你代码在哪，拿不到就显示 —，
    // 不该让整张详情卡塌掉。也不缓存失败——下次也许就好了。
    return {};
  }
}

function renderList() {
  const list = mounted.list;
  const projects = data ? data.projects : [];
  list.innerHTML = projectListHtml(projects, selected);
  if (projects.length === 0) return;
  // 点击只写 hash，不自己算视图：地址是唯一真相来源，绕开它就会出现
  // 地址和画面不一致的刷新，而那种刷新是没法发给别人看的。
  for (const el of list.querySelectorAll('.proj')) {
    el.onclick = () => {
      const id = el.dataset.id;
      if (id === selected) return;
      location.hash = '#/projects/' + encodeURIComponent(id);
    };
  }
}

async function renderDetail() {
  const box = mounted.detail;
  const project = data && data.projects.find((p) => p.projectId === selected);
  if (!project) {
    box.innerHTML = '<div class="empty">没有这个项目：' + esc(selected) + '</div>';
    return;
  }
  const projectId = project.projectId;
  const started = epoch;
  const workspace = await loadWorkspace(projectId);
  // await 期间人可能又点了别的项目，或已经离开项目页。只画当前选中且还在
  // 这一代导航上的那个，否则先发出的请求后回来，会把新画面盖成旧项目的。
  if (started !== epoch || selected !== projectId) return;
  if (!mounted || !mounted.list.isConnected) return;
  box.innerHTML = detailCardHtml(project, workspace) + '<div id="proj-workbench"></div>';
  paintWorkbench();
  void loadPlanRuns(projectId);
}

function projectRows() {
  return ((data && data.missions) || []).filter((m) => m.projectId === selected);
}

function projectPlanRuns() {
  const by = data && data.planRunsByProject;
  return (by && by[selected]) || [];
}

function paintWorkbench() {
  if (!mounted || !mounted.detail.isConnected) return;
  let host = mounted.detail.querySelector('#proj-workbench');
  if (!host) {
    // 详情卡刚写进去时一定有这个节点；没有就是已经换成错误空态，别往卡片外塞表。
    return;
  }
  const html = projectWorkbenchHtml({
    tab: workbench.tab,
    filter: workbench.filter,
    planRuns: projectPlanRuns(),
    missions: projectRows(),
    openGroups: workbench.openGroups,
    planRunsError: workbench.planRunsError,
    planRunsLoading: workbench.loading && !projectPlanRuns().length,
  });
  host.outerHTML = html;
  host = mounted.detail.querySelector('[data-workbench]');
  if (host) host.id = 'proj-workbench';
  bindWorkbench(mounted.detail);
}

function bindWorkbench(box) {
  for (const el of box.querySelectorAll('[data-tab]')) {
    el.onclick = () => {
      const tab = el.dataset.tab === 'missions' ? 'missions' : 'plan-runs';
      if (tab === workbench.tab) return;
      workbench.tab = tab;
      paintWorkbench();
    };
  }
  for (const el of box.querySelectorAll('[data-filter]')) {
    el.onclick = () => {
      const next = el.dataset.filter || '';
      workbench.filter = workbench.filter === next ? '' : next;
      paintWorkbench();
    };
  }
  for (const tr of box.querySelectorAll('tr[data-plan-run-id]')) {
    tr.onclick = (ev) => {
      if (ev && ev.target && ev.target.closest && ev.target.closest('a')) return;
      location.hash = '#/plan-runs/' + encodeURIComponent(tr.dataset.planRunId);
    };
  }
  // 行 → 任务详情页。监听写在 DOM 段而不是内联 onclick：内联的话这里能测到形状、
  // 测不到行为，而行为（点了去哪）才是要紧的那半。
  for (const el of box.querySelectorAll('[data-mission-id]')) {
    el.onclick = (ev) => {
      if (ev && ev.target && ev.target.closest && ev.target.closest('a')) return;
      const id = el.dataset.missionId;
      if (!id) return;
      location.hash = '#/missions/' + encodeURIComponent(id);
    };
  }
  for (const d of box.querySelectorAll('details[data-group-id]')) {
    d.ontoggle = () => {
      const id = d.dataset.groupId;
      if (!id) return;
      if (d.open) workbench.openGroups.add(id);
      else workbench.openGroups.delete(id);
    };
  }
}

let planRunsInflight = null;
let planRunsInflightKey = '';

function loadPlanRuns(projectId) {
  const started = epoch;
  const key = started + ':' + projectId;
  if (planRunsInflight && planRunsInflightKey === key) return planRunsInflight;
  planRunsInflightKey = key;
  workbench.loading = true;
  workbench.planRunsError = '';
  planRunsInflight = get('/api/plan-runs?project=' + encodeURIComponent(projectId))
    .then((runs) => {
      if (started !== epoch || selected !== projectId) return;
      if (!data) return;
      data.planRunsByProject = { ...(data.planRunsByProject || {}), [projectId]: Array.isArray(runs) ? runs : [] };
      workbench.planRunsError = '';
      workbench.loading = false;
      paintWorkbench();
    })
    .catch((err) => {
      if (started !== epoch || selected !== projectId) return;
      workbench.loading = false;
      workbench.planRunsError = err && err.message ? err.message : String(err);
      paintWorkbench();
    })
    .finally(() => {
      if (planRunsInflightKey === key) planRunsInflight = null;
    });
  return planRunsInflight;
}

function paint(error) {
  if (error && !data) {
    // 一次都没读到过。这时候写「还没有项目」是鋳了：人会以为平台真空了，
    // 而实际是 API 挂了。这两件事在屏幕上必须分得出采。
    mounted.list.innerHTML = '<li class="empty">读不到项目列表：' + esc(error.message) + '</li>';
    mounted.detail.innerHTML = '<div class="empty">刷新一下重试</div>';
    return;
  }
  renderList();
  if (!selected) {
    // 没选中就没内容。同时甩一句"读不到"和一句"先选一个项目"是自相矛盾的，
    // 所以没选中时只报提示。
    mounted.detail.innerHTML = '<div class="empty">左边选一个项目</div>';
    return;
  }
  if (error) {
    mounted.detail.innerHTML = '<div class="empty">读不到：' + esc(error.message) + '</div>';
    return;
  }
  void renderDetail();
}

/** 一次导航要取两个列表；连着点两下不该发出四份请求。 */
let inflight = null;
let inflightEpoch = 0;
function load() {
  const started = epoch;
  if (inflight && inflightEpoch === started) return inflight;
  inflightEpoch = started;
  inflight = Promise.all([get('/api/projects'), get('/api/missions')])
    .then(([projects, missions]) => {
      if (started !== epoch) return null;
      // 方案运行按项目另拉，不能在刷两个列表时把缓存清掉——否则每 5 秒表格会闪成空的。
      data = { projects, missions, planRunsByProject: (data && data.planRunsByProject) || {} };
      return null;
    })
    .catch((err) => (started !== epoch ? null : err))
    .finally(() => {
      // 落地就清。不清掉的话，下一次导航会拿到同一个已完成的 promise，
      // 页面从此再也看不到新开的 Mission。换代之后的清理由 inflightEpoch 守：
      // 旧请求的 finally 不能把新一代的 inflight 抹掉。
      if (inflightEpoch === started) inflight = null;
    });
  return inflight;
}

function isPageVisible() {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

function clearPollTimer() {
  if (pollTimer != null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function stopPolling() {
  clearPollTimer();
  if (onVisibility) {
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility);
    }
    onVisibility = null;
  }
}

function armPollTimer(plan) {
  clearPollTimer();
  if (!plan.intervalMs) return;
  pollTimer = setInterval(() => {
    void poll();
  }, plan.intervalMs);
}

function leaveProjectsPage() {
  epoch += 1;
  stopPolling();
}

async function poll() {
  if (!mounted || !mounted.list.isConnected) {
    leaveProjectsPage();
    return;
  }
  const plan = nextRefresh('projects', '', isPageVisible());
  if (!plan.paths.length) return;
  const started = epoch;
  const error = await load();
  if (started !== epoch) return;
  if (!mounted || !mounted.list.isConnected) return;
  paint(error);
}

function startPolling() {
  stopPolling();
  if (typeof document !== 'undefined') {
    onVisibility = () => {
      if (!mounted || !mounted.list.isConnected) {
        leaveProjectsPage();
        return;
      }
      const visible = document.visibilityState !== 'hidden';
      const plan = nextRefresh('projects', '', visible);
      // 再可见立刻补拉：等下一个 5 秒窗口，人切回来会看到过期列表还停几秒。
      if (plan.paths.length) void poll();
      armPollTimer(plan);
    };
    document.addEventListener('visibilitychange', onVisibility);
  }
  armPollTimer(nextRefresh('projects', '', isPageVisible()));
}

export async function renderProjectsPage(container, projectId) {
  // 比 isConnected 而不是只比 container：从 #/resources 切回 #/projects 时，
  // 外壳把容器内容清空重建了，mounted 还指着一堆已离屏的节点。不检这一目的话
  // 列表会静静地写到一个不在树上的 ul 上——整屏白且不报错。
  if (!mounted || mounted.container !== container || !mounted.list.isConnected) {
    epoch += 1;
    stopPolling();
    container.innerHTML = skeleton();
    mounted = {
      container,
      list: container.querySelector('#proj-list'),
      detail: container.querySelector('#proj-detail'),
    };
    startPolling();
  }
  if (selected !== projectId) {
    // 展开态是按组 id 记的；换项目不清会把上个项目的 feature:F1 误开到这个项目的 F1。
    workbench.openGroups = new Set();
    workbench.planRunsError = '';
  }
  selected = projectId;

  // 旧数据先上一屏：人点下去要的是立刻看到选中态变了，不是等两个请求回来。
  // 没缓存时不抢这一下——骨架里那句「加载中」比一句「没有这个项目」诚实。
  if (data) paint(null);
  const started = epoch;
  const error = await load();
  if (started !== epoch) return;
  if (!mounted || !mounted.list.isConnected) return;
  // 拉失败也照画：data 还是上一次的，界面继续显示旧数据。
  // 直接清空的话，一次瞬时故障看起来像"项目被删了"。
  paint(error);
}
