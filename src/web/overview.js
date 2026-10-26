/**
 * 任务总览页：五列任务记录（编号/intent、主状态/附标、处理人/下一步、费用、更新时间）
 * + 三组投影 + 六态页签 + 分页。
 *
 * 这一层**只做呈现**：一行要说什么由 console-overview-model.js 决定，这里只负责
 * 转义、配色、尺寸和链接。状态词、处理人、费用质量、分组、排序都从那份纯模型取，
 * 不在这份文件里再算一遍——同一个判断写两处，加一个状态时只会改到一处，另一处
 * 静悄悄地退回默认值，而屏幕上看起来完全正常。
 *
 * 网络部分（renderOverviewPage 的读取/取消/隐藏停轮询）本单不动：换数据显示层
 * 却顺手改请求生命周期，等于把两件事的故障混在一起排查。
 */
import { esc, stageChip, stateChip } from './projects.js';
import {
  UNKNOWN,
  OVERVIEW_STATUS_ORDER,
  buildOverview,
  stageText,
} from './console-overview-model.js';

/* ============================ 纯排版工具 ============================ */

const pad = (n) => String(n).padStart(2, '0');

/**
 * 编号中间省略的保留字数：头 31 / 尾 11。
 *
 * 这两个数字来自画板 2:47 上那条被省略的编号（`Vehicle-Resource-Validation-Fin…ew-20261023`
 * —— 前半 31 字、后半 11 字）。为什么中间省略而不是尾部截断：任务编号的可辨识部分
 * 往往在尾部（日期、序号），只截尾巴会让一批同前缀的任务看起来一模一样。
 */
const ID_HEAD = 31;
const ID_TAIL = 11;

/** 完整值一律留在 title 里：省略只发生在视觉上，事实不能跟着被截掉。 */
export function middleEllipsis(value) {
  const text = String(value ?? '');
  if (text.length <= ID_HEAD + ID_TAIL + 1) return text;
  return text.slice(0, ID_HEAD) + '…' + text.slice(-ID_TAIL);
}

/** 有值才给属性：`title=""` 会让悬停出现一个空提示框，看起来像还没加载完。 */
const attr = (name, value) => {
  const text = String(value ?? '');
  return text === '' ? '' : ' ' + name + '="' + esc(text) + '"';
};

/**
 * 更新时间：同一天只给 HH:MM，跨天补 MM-DD。
 *
 * 全部显示完整时刻会让 64px 记录里的这一格挤成两行；全部只给 HH:MM 又会在
 * 「最近结束」组里分不清是哪天。读不出来的时间仍是「未知」，不补一个当下时刻。
 */
export function formatUpdated(iso, nowMs) {
  const at = Date.parse(String(iso ?? ''));
  if (!Number.isFinite(at)) return UNKNOWN;
  const date = new Date(at);
  const now = new Date(Number.isFinite(nowMs) ? nowMs : Date.now());
  const hhmm = pad(date.getHours()) + ':' + pad(date.getMinutes());
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  return sameDay ? hhmm : pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + hhmm;
}

/* ============================ 状态图形 ============================ */

/**
 * 一行状态前面那颗 16x16 的点/钟，取自画板原样复制到 src/web/ 的 SVG
 * （对应关系在 console-assets.json，不在这里重绘、也不用字符代替）。
 *
 * 为什么状态之外还要看处理人字段：DESIGN.md 约定「主状态虽为执行中但正在等待
 * 人工处理时保留文字、改用琥珀色」「自动恢复用灰色时钟」。只看 status 会把
 * 「执行中·等你答复」和「执行中·平台马上重试」画成同一个点，人就得逐行读文字。
 */
const STATUS_VIEW = {
  complete: { icon: 'console-icon-complete.svg', tone: 'green' },
  aborted: { icon: 'console-icon-aborted.svg', tone: 'red' },
  waiting: { icon: 'console-icon-review.svg', tone: 'amber' },
  auto: { icon: 'console-icon-clock.svg', tone: 'muted' },
  running: { icon: 'console-icon-running.svg', tone: 'running' },
  default: { icon: 'console-icon-dot.svg', tone: 'ink' },
};

/**
 * 判定顺序即优先级：
 *   1. 终态压过一切残留等待信息（终态在内核里没有出边）；
 *   2. 平台会自己接着跑（autoResume === true）→ 时钟，别让人去手动推；
 *   3. 要人动手（检视者 / 用户）→ 琥珀；
 *   4. 真有活动 Agent（activeAgent === true）→ running 蓝，这是唯一该用蓝的地方；
 *   5. 其余（含「不知道」）→ 墨色点：不确定不是故障。
 */
function statusView(row) {
  if (row.terminal) {
    return row.statusKey === 'completed' ? STATUS_VIEW.complete : STATUS_VIEW.aborted;
  }
  const owner = row.owner && typeof row.owner === 'object' ? row.owner : {};
  if (owner.autoResume === true) return STATUS_VIEW.auto;
  if (owner.key === 'l3' || owner.key === 'user') return STATUS_VIEW.waiting;
  if (owner.activeAgent === true) return STATUS_VIEW.running;
  return STATUS_VIEW.default;
}

/* ============================ 片段 ============================ */

function bannerHtml(built, needsYou) {
  if (needsYou.length === 0) return '';
  const l3 = needsYou.filter((row) => row.owner.key === 'l3').length;
  const user = needsYou.filter((row) => row.owner.key === 'user').length;
  const parts = [];
  if (l3 > 0) parts.push(l3 + ' 项等检视者');
  if (user > 0) parts.push(user + ' 项等你处理');
  const scope = built.filter.projectId === ''
    ? '当前为全部项目'
    : '当前为项目「' + esc(built.filter.projectId) + '」';

  // 恢复方式按投影里真实的 autoResume 分开数。分组条件只排除 `true`，缺字段的那批是
  // `unknown`——把它们一起说成「均不会自动恢复」就是替平台下了一个它没给的结论，
  // 人会守着一条其实到点会自己接着跑的任务（或反过来放弃处理一条不会自愈的）。
  let noAuto = 0;
  let yesAuto = 0;
  let unknownAuto = 0;
  for (const row of needsYou) {
    const value = row.owner.autoResume;
    if (value === false) noAuto += 1;
    else if (value === true) yesAuto += 1;
    else unknownAuto += 1;
  }
  const resume = [];
  if (yesAuto > 0) resume.push(yesAuto + ' 项会自动恢复');
  if (noAuto > 0) resume.push(noAuto + ' 项不会自动恢复');
  if (unknownAuto > 0) resume.push(unknownAuto + ' 项恢复方式未知');
  // 只有每一条都确为 false 才敢用「均不会自动恢复」；混进未知就必须逐类说清。
  const note = noAuto === needsYou.length
    ? '以上 ' + needsYou.length + ' 项均不会自动恢复。'
    : '以上 ' + needsYou.length + ' 项中 ' + resume.join('，') + '。';

  return '<div class="co-banner" role="status">'
    + '<p class="co-banner-head">需要你处理 ' + needsYou.length + ' 项：' + parts.join('，') + '</p>'
    + '<p class="co-banner-note">' + scope + '；' + note + '</p></div>';
}

function toolbarHtml(filter) {
  const pausedOn = filter.pausedOnly === true;
  // 图标在文字左侧：画板里的 ConsoleField Search（39:315）是 icon 后接 placeholder，
  // 反过来的话输入提示会被读成「先有一段文字，后面跟了个按钮」。
  return '<div class="co-toolbar">'
    + '<div class="co-field" data-overview-search>'
    + '<img class="co-field-icon" src="/console-icon-search.svg" width="16" height="16" alt="" />'
    + '<span class="co-field-text">搜索编号或 intent</span></div>'
    + '<span class="co-switch" data-overview-paused="' + (pausedOn ? '1' : '0') + '">'
    + '<img class="co-switch-track" src="/' + (pausedOn ? 'console-icon-switch-on.svg' : 'console-icon-switch.svg')
    + '" width="34" height="20" alt="" /><span class="co-switch-label">仅看已暂停</span></span>'
    + '</div>';
}

/**
 * 六态页签。计数用模型给的 counts（只按状态以外的条件统计），不是当前可见批次：
 * 用可见批次算，点进「已完成」会看到 0，而它明明有 12 条。
 *
 * 选中态由真实 filter.status 决定，首屏默认的「全部」也是过滤条件的真实取值，
 * 不是画板上的静态高亮——写死一个选中，页签和列表就会各说各的。
 */
function tabsHtml(filter, counts) {
  const current = String(filter.status ?? '') === '' ? 'all' : String(filter.status);
  const tab = (key, label, count) => {
    const selected = key === current;
    return '<div class="co-tab" role="tab" data-overview-status="' + key + '"'
      + ' data-selected="' + (selected ? '1' : '0') + '" aria-selected="' + (selected ? 'true' : 'false') + '">'
      + esc(label) + ' ' + String(count) + '</div>';
  };
  const tabs = [tab('all', '全部', counts.all)];
  for (const key of OVERVIEW_STATUS_ORDER) tabs.push(tab(key, stageText(key), counts[key]));
  return '<div class="co-tabs" role="tablist" aria-label="按主状态筛选">' + tabs.join('') + '</div>';
}

function rowHtml(row, options) {
  const selected = options.selectedId !== '' && options.selectedId === row.missionId;
  const view = statusView(row);
  // 处理人那一格的颜色只说「这一行是不是在等人」：完成/在跑/未知都用墨色，
  // 全都染色等于没有重点。
  const ownerTone = row.terminal
    ? (row.statusKey === 'completed' ? 'ink' : 'red')
    : (view === STATUS_VIEW.waiting ? 'amber' : 'ink');
  // 恢复方式必须在主行上看得见：只塞进 title 等于把它藏起来，而「平台会不会自己
  // 接着跑」正是决定人要不要动手的那条事实。终态没有待办，就不跟着说恢复。
  const resume = row.terminal ? '' : resumeText(row.owner, options.formatTime);
  const ownerLine = resume === '' ? row.owner.text : row.owner.text + ' · ' + resume;
  const retry = retryText(row.owner.retry);
  const nextLine = [retry, row.nextStep].filter((part) => part !== '').join(' · ');
  const ownerTitle = [ownerLine, nextLine].filter((part) => part !== '').join(' · ');

  return '<a class="co-row" href="#/missions/' + encodeURIComponent(row.missionId) + '"'
    + attr('data-group', row.group) + (selected ? ' data-selected="1"' : '') + '>'
    + '<div class="co-cell co-identity">'
    + '<p class="co-id"' + attr('title', row.missionId) + '>' + esc(middleEllipsis(row.missionId)) + '</p>'
    + '<p class="co-intent"' + attr('title', row.intent) + '>' + esc(row.intent) + '</p></div>'
    + '<div class="co-cell co-status"><span class="co-status-line">'
    + '<img class="co-icon" src="/' + view.icon + '" width="16" height="16" alt="" />'
    + '<span class="co-status-text" data-tone="' + view.tone + '">' + esc(row.statusText) + '</span></span>'
    + '<p class="co-marks"' + attr('title', row.marksText) + '>' + esc(row.marksText) + '</p></div>'
    + '<div class="co-cell co-owner">'
    + '<p class="co-owner-text" data-tone="' + ownerTone + '"' + attr('title', ownerTitle) + '>'
    + esc(ownerLine) + '</p>'
    + '<p class="co-next"' + attr('title', row.nextStep) + '>' + esc(nextLine) + '</p></div>'
    + '<div class="co-cell co-cost"><p class="co-cost-text">' + esc(row.cost.text) + '</p></div>'
    + '<div class="co-cell co-updated"><p>' + esc(formatUpdated(row.updatedAt, options.now)) + '</p></div>'
    + '</a>';
}

/**
 * 处理人的恢复方式：三态分开说。
 *
 * `autoResume` 只有 true / false / 'unknown' 三种真实取值（模型层不把缺失补成 false）。
 * 把 unknown 归进任何一边都是替平台下结论：说成「不会恢复」，人会去推一条其实
 * 到点自己就接着跑的任务；说成「会自动恢复」，人会等一条根本不会自己好的任务。
 *
 * 会自动恢复时把真实的重试时刻写出来（不是“马上”）：那一刻就是下次看进展的时间。
 */
function resumeText(owner, formatTime) {
  const o = owner && typeof owner === 'object' ? owner : {};
  if (o.autoResume === true) {
    const at = typeof o.nextRetryAt === 'string' && o.nextRetryAt !== ''
      ? (typeof formatTime === 'function' ? formatTime(o.nextRetryAt) : o.nextRetryAt)
      : '';
    return at === '' ? '会自动恢复' : at + ' 自动重试';
  }
  if (o.autoResume === false) return '不会自动恢复';
  return '恢复方式未知';
}

/** 退避次数：只有平台真给了 attempt/max 才画，缺一个就空着——补个 0 会变成“没重试过”。 */
function retryText(retry) {
  if (!retry || typeof retry !== 'object') return '';
  const attempt = Number(retry.attempt);
  const max = Number(retry.max);
  if (!Number.isFinite(attempt) || !Number.isFinite(max)) return '';
  return '退避第 ' + String(attempt) + '/' + String(max) + ' 次';
}

const HEAD_HTML = '<div class="co-head">'
  + '<div class="co-cell co-identity">编号 / intent</div>'
  + '<div class="co-cell co-status">主状态 / 附加标记</div>'
  + '<div class="co-cell co-owner">谁处理 / 下一步</div>'
  + '<div class="co-cell co-cost">费用（标价折算）</div>'
  + '<div class="co-cell co-updated">更新时间</div>'
  + '</div>';

function groupsHtml(groups, options) {
  // 空组不画空标题：三个组头下面都没有行，看起来像加载失败。
  const shown = groups.filter((group) => group.rows.length > 0);
  if (shown.length === 0) return '<div class="co-empty">没有符合条件的任务</div>';
  return shown.map((group) => '<div class="co-group" data-group="' + esc(group.key) + '">'
    + '<div class="co-group-head">' + esc(group.title) + '</div>'
    + group.rows.map((row) => rowHtml(row, options)).join('')
    + '</div>').join('');
}

function pageHtml(page) {
  // 「加载更早」这一单只留标记：接线（改 shown 再重画）属于下一单的 DOM 层，
  // 这里给一个能点的 href 会真的把页面跳走，人看到的是「点一下就重置」。
  return '<div class="co-page"><span class="co-page-count">显示 ' + String(page.shown)
    + ' / ' + String(page.total) + '</span>'
    + (page.hasMore ? '<span class="co-more" data-overview-more>加载更早</span>' : '')
    + '</div>';
}

/* ============================ 页面 ============================ */

/**
 * 总览页的完整 HTML。
 *
 * options 全部可选：
 *   - `filter`  真实的筛选条件（projectId / status / pausedOnly / query），
 *               页签选中态、开关轨道、计数都从它和模型来；
 *   - `shown`   一屏显示多少条（缺省 OVERVIEW_PAGE_SIZE）；
 *   - `now`     判定「同一天」用的当前时刻，测试里固定它才能断言时间格式；
 *   - `selectedId` 当前打开的任务。不传就没有任何行是选中的——首屏不编一个
 *               默认选中，那会让人以为进来就点开了一条。
 */
export function overviewHtml(data, options) {
  const d = data && typeof data === 'object' ? data : {};
  const opts = options && typeof options === 'object' ? options : {};
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
  const filter = opts.filter && typeof opts.filter === 'object' ? opts.filter : {};
  const built = buildOverview(d.missions, {
    filter,
    shown: opts.shown,
    // 重试时刻用同一套本地格式：页面上两处时间必须是同一个时区、同一种写法。
    formatTime: (iso) => formatUpdated(iso, now),
  });
  const needsYou = built.matched.filter((row) => row.group === 'needs_you');
  const errors = Array.isArray(d.errors) ? d.errors : [];
  const rowOptions = {
    now,
    selectedId: typeof opts.selectedId === 'string' ? opts.selectedId : '',
    // 重试时刻与「更新时间」用同一个格式化函数：同一格里出现 14:36 与 ISO 两种写法，
    // 人会以为它们不是同一个时区。
    formatTime: (iso) => formatUpdated(iso, now),
  };

  return '<section class="screen console-overview">'
    + '<h1 class="fixed-page-title co-title">任务总览</h1>'
    + bannerHtml(built, needsYou)
    + (errors.length > 0
      ? '<div class="note">部分数据未更新：' + esc(errors.join('；')) + '</div>'
      : '')
    + toolbarHtml(built.filter)
    + '<div class="co-board">'
    + tabsHtml(built.filter, built.counts)
    + '<div class="co-table">' + HEAD_HTML + groupsHtml(built.groups, rowOptions) + '</div></div>'
    + pageHtml(built.page)
    + '</section>';
}

/* ============================ 旧导出：项目任务列表 ============================ */

/** 最近活动在上：项目页与总览共用的排序口径。不改入参。 */
export function newestMissions(rows) {
  return [...rows].sort((a, b) => {
    const delta = (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
    return delta || String(a.missionId).localeCompare(String(b.missionId));
  });
}

/**
 * 项目页的任务表（单项目、表格形状）。总览已改成五列记录，但这张表仍被
 * `#/projects/<id>` 用着，两条入口的数据密度不同，各自留一份。
 *
 * 这里保留 chip（阶段 + 状态两根轴）：项目页是一张宽表，有地方把
 * 「走到哪了」和「为什么不动」分开说；总览的 64px 记录挤不下，改用附标一格。
 */
export function missionTableHtml(rows) {
  if (!rows.length) return '<div class="empty">暂无任务</div>';
  return '<div class="table-wrap"><table class="tasks"><thead><tr><th>任务</th><th>状态</th><th>最近活动</th></tr></thead><tbody>'
    + newestMissions(rows).map(row => '<tr><td><a href="#/missions/' + encodeURIComponent(row.missionId) + '">'
      + esc(row.intent || row.missionId) + '</a><div class="row-sub">' + esc(row.missionId) + '</div></td>'
      + '<td>' + stageChip(row.status) + ' ' + stateChip(row) + '</td><td class="mono">'
      + esc(row.updatedAt ? new Date(row.updatedAt).toLocaleString('zh-CN') : '未知') + '</td></tr>').join('')
    + '</tbody></table></div>';
}

async function readJson(path, signal) {
  const response = await fetch(path, { cache: 'no-store', signal });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return response.json();
}

let active = null;

/** 页面所有请求共用 AbortController，离页与隐藏立即取消，防止旧响应覆盖。 */
export async function renderOverviewPage(container, projectId = null) {
  active?.stop();
  const root = document.createElement('section');
  container.replaceChildren(root);
  const controller = new AbortController();
  const state = { projects: [], missions: [], status: null, pools: null, errors: [] };
  let stopped = false;
  let busy = false;
  let requestController = null;
  const paint = () => {
    if (projectId === null) { root.innerHTML = overviewHtml(state); return; }
    const selected = projectId || state.projects[0]?.projectId || '';
    root.innerHTML = '<section class="screen"><h1 class="fixed-page-title screen-title">项目任务列表</h1><div class="toolbar"><label>项目 <select data-project-select>'
      + state.projects.map(p => '<option value="' + esc(p.projectId) + '"' + (selected === p.projectId ? ' selected' : '') + '>' + esc(p.projectId) + '</option>').join('')
      + '</select></label></div>' + (state.errors.length ? '<div class="note">' + esc(state.errors.join('；')) + '</div>' : '')
      + '<section class="card">' + missionTableHtml(state.missions.filter(m => m.projectId === selected)) + '</section></section>';
  };
  const pull = async () => {
    if (busy || stopped || document.visibilityState === 'hidden') return;
    busy = true;
    const paths = projectId === null ? ['/api/projects', '/api/missions', '/api/platform/status', '/api/pools'] : ['/api/projects', '/api/missions'];
    requestController = new AbortController();
    const results = await Promise.allSettled(paths.map(path => readJson(path, requestController.signal)));
    if (!stopped && root.isConnected && document.visibilityState !== 'hidden') {
      state.errors = [];
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') state[['projects', 'missions', 'status', 'pools'][index]] = result.value;
        else {
          state[['projects', 'missions', 'status', 'pools'][index]] = index < 2 ? [] : null;
          state.errors.push(paths[index] + '：' + result.reason.message);
        }
      });
      paint();
    }
    busy = false;
  };
  root.addEventListener('change', event => {
    if (event.target.matches('[data-project-select]')) location.hash = '#/projects/' + encodeURIComponent(event.target.value);
  });
  const timer = setInterval(() => { if (!root.isConnected) stop(); else void pull(); }, 5000);
  const onHash = () => stop();
  const onVisibility = () => { if (document.visibilityState === 'hidden') requestController?.abort(); else void pull(); };
  function stop() {
    stopped = true;
    controller.abort();
    requestController?.abort();
    clearInterval(timer);
    window.removeEventListener('hashchange', onHash);
    document.removeEventListener('visibilitychange', onVisibility);
  }
  window.addEventListener('hashchange', onHash);
  document.addEventListener('visibilitychange', onVisibility);
  active = { stop };
  root.innerHTML = '<div class="note">加载中…</div>';
  await pull();
}
