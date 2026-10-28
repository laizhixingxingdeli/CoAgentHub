/**
 * 任务总览页：五列任务记录（编号/intent、主状态/附标、处理人/下一步、费用、更新时间）
 * + 三组投影 + 六态页签 + 分页。
 *
 * 这一层**只做呈现**：一行要说什么由 console-overview-model.js 决定，这里只负责
 * 转义、配色、尺寸和链接。状态词、处理人、费用质量、分组、排序都从那份纯模型取，
 * 不在这份文件里再算一遍——同一个判断写两处，加一个状态时只会改到一处，另一处
 * 静悄悄地退回默认值，而屏幕上看起来完全正常。
 *
 * 事件与请求（筛选项、定时刷新、取消、迟到响应作废）在 console-overview-controller.js：
 * 渲染函数是纯的，喂什么画什么，所以 node 里能直接断言一段 HTML；控制器被注入本文件
 * 的 overviewHtml，反过来依赖就成了环（浏览器里先求值的那一个会拿到半个模块）。
 * 本文件对外只留 renderOverviewPage 这个小入口，它不承载任何新逻辑。
 */
import { esc, stageChip, stateChip } from './projects.js';
import {
  UNKNOWN,
  OVERVIEW_STATUS_ORDER,
  buildOverview,
  stageText,
} from './console-overview-model.js';
import { createOverviewController } from './console-overview-controller.js';
import { applyOverlay } from './console-overview-enrich.js';

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
 * 补充投影带来的整句（落地未记录、运行中）：只认**非空字符串**。
 * 缺失、null、数字一律当没有——把它们 String() 一下就会在屏幕上出现一格
 * 「undefined」，而人读到的是一句像事实的话。
 */
const lineText = (value) => (typeof value === 'string' ? value.trim() : '');

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
 *   4. 真有活动 Agent（activeAgent === true）或真实 in_progress 的 Attempt
 *      （liveAttempt === true）→ running 蓝，这是唯一该用蓝的地方；
 *   5. 其余（含「不知道」）→ 墨色点：不确定不是故障。
 *
 * liveAttempt 排在这个位置而不是最前面：它只能把「说不清在不在跑」的行染蓝，
 * 不能把已完成/已中止画成蓝、不能把等人工答复画成蓝、也不能压过灰色时钟——
 * 那三种情况下蓝色的意思是「别再看了，它自己会动」，恰好是相反的意思。
 */
function statusView(row) {
  if (row.terminal) {
    return row.statusKey === 'completed' ? STATUS_VIEW.complete : STATUS_VIEW.aborted;
  }
  const owner = row.owner && typeof row.owner === 'object' ? row.owner : {};
  if (owner.autoResume === true) return STATUS_VIEW.auto;
  if (owner.key === 'l3' || owner.key === 'user') return STATUS_VIEW.waiting;
  if (row.liveAttempt === true || owner.activeAgent === true) return STATUS_VIEW.running;
  return STATUS_VIEW.default;
}

/* ============================ 读取状态 ============================ */

/**
 * 读取失败的原因照实说，三类**不合并**：HTTP 5xx 说明服务活着但这一页读不出来
 * （先别重启），连不上说明进程没了（该去看服务），返回的不是列表说明接口变了。
 * 合成一句「加载失败」会让人对着三种情况做同一个动作。
 */
export function loadErrorText(error) {
  if (!error || typeof error !== 'object') return '原因未知';
  if (error.kind === 'http') return '服务返回 HTTP ' + String(error.status);
  if (error.kind === 'invalid') return '接口返回的不是任务列表';
  return '连不上服务';
}

/**
 * 一次都没成功取到列表时的说明。
 *
 * **不画任何计数**：这时候「全部 0」是编出来的，人会以为平台上一条任务都没有，
 * 而真相是这一页根本没读到。真正空集合是另一句话（列表读到了，长度就是 0），
 * 两件事在屏幕上必须长得不一样。
 */
function loadNoteHtml(load) {
  if (load.status === 'error') {
    return '<div class="note" role="status" data-overview-state="error">任务列表读取失败：'
      + esc(loadErrorText(load.error)) + '；还没读到过列表，因此这里没有条数可显示。</div>';
  }
  return '<div class="note" role="status" data-overview-state="loading">正在读取任务列表…</div>';
}

/**
 * 已经有旧数据时刷新失败：保留那份数据，另加一条「这是什么时候的」。
 *
 * 清空列表最省事，但等于把「刚刚还看得到的事实」换成「什么都不知道」，
 * 而屏幕上只是少了一屏、没有报错。留着旧行 + 最后成功时刻，人才知道自己在看
 * 几分钟前的世界，而不是现在的。
 */
function refreshNoteHtml(load, nowMs) {
  const at = Number.isFinite(Number(load.lastOkAt)) ? Number(load.lastOkAt) : null;
  const when = at === null ? '上一次成功时刻未知' : '最后成功 ' + formatUpdated(new Date(at).toISOString(), nowMs);
  return '<div class="note" role="status" data-overview-state="stale">刷新失败：'
    + esc(loadErrorText(load.error)) + '；' + esc(when) + '，下面是那一刻读到的数据。</div>';
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

/**
 * 工具栏：搜索是**真的** input，暂停是**真的** button。
 *
 * 旧版这里是一个 span 冒充占位文字、一个 span 冒充开关：它们没有 value、不能输入、
 * 不能 Tab 到、按回车也没有任何反应，而屏幕上和能用的控件长得一模一样——人试两次
 * 之后就会认为整个筛选功能坏了。图标仍是画板里那张 16x16 原图，位置在左：
 * ConsoleField Search（39:315）就是 icon 后接输入区，反过来会被读成「先有文字，
 * 后面跟了个别的东西」。
 *
 * 开关用 button + aria-pressed 而不是自己接 keydown：原生按钮本来就能 Tab 到、
 * 空格/回车能触发、读屏软件会念出按下状态；自己接键盘等于把这些都重写一遍，
 * 且一定会漏（漏掉的那一次无声无息）。
 */
function toolbarHtml(filter) {
  const pausedOn = filter.pausedOnly === true;
  const query = String(filter.query ?? '');
  return '<div class="co-toolbar">'
    + '<div class="co-field" data-overview-search>'
    + '<img class="co-field-icon" src="/console-icon-search.svg" width="16" height="16" alt="" />'
    + '<input class="co-field-input" type="search" data-overview-query'
    + ' value="' + esc(query) + '" placeholder="搜索编号或 intent" aria-label="搜索编号或 intent" />'
    + '</div>'
    + '<button class="co-switch" type="button" data-overview-paused="' + (pausedOn ? '1' : '0') + '"'
    + ' aria-pressed="' + (pausedOn ? 'true' : 'false') + '">'
    + '<img class="co-switch-track" src="/' + (pausedOn ? 'console-icon-switch-on.svg' : 'console-icon-switch.svg')
    + '" width="34" height="20" alt="" /><span class="co-switch-label">仅看已暂停</span></button>'
    + '</div>';
}

/**
 * 六态页签。计数用模型给的 counts（只按状态以外的条件统计），不是当前可见批次：
 * 用可见批次算，点进「已完成」会看到 0，而它明明有 12 条。
 *
 * 选中态由真实 filter.status 决定，首屏默认的「全部」也是过滤条件的真实取值，
 * 不是画板上的静态高亮——写死一个选中，页签和列表就会各说各的。
 *
 * 用原生 <button>：页签是要点的，div 只能靠脚本模拟，键盘用户按不到。
 */
function tabsHtml(filter, counts) {
  const current = String(filter.status ?? '') === '' ? 'all' : String(filter.status);
  const tab = (key, label, count) => {
    const selected = key === current;
    return '<button class="co-tab" type="button" role="tab" data-overview-status="' + key + '"'
      + ' data-selected="' + (selected ? '1' : '0') + '" aria-selected="' + (selected ? 'true' : 'false') + '">'
      + esc(label) + ' ' + String(count) + '</button>';
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
  // 顺序是「谁处理 → 在跑什么 → 会不会自己恢复」：先说谁，再说此刻，最后说下一步。
  // 空段直接丢掉，不留一个孤零零的「 · 」。row.owner / row.owner.text 一个字都不改，
  // 别的渲染方拿到的是同一份处理人事实。
  const ownerLine = [row.owner.text, lineText(row.runningText), resume]
    .filter((part) => part !== '')
    .join(' · ');
  // 附标：暂停/补修/问题升级这些「为什么不动」的标记，加上落地那一句。
  // 两者拼在一格里是因为它们都属于「附标」，多开一格会把 64px 的记录撑成两行。
  const marksLine = [lineText(row.marksText), lineText(row.landingLine)]
    .filter((part) => part !== '')
    .join(' · ');
  const retry = retryText(row.owner.retry);
  const nextLine = [retry, row.nextStep].filter((part) => part !== '').join(' · ');
  const ownerTitle = [ownerLine, nextLine].filter((part) => part !== '').join(' · ');

  // data-mission-id 给重画后的焦点还原用：整棵子树被 innerHTML 换掉之后，
  // 原来的节点已经离开文档，只有语义位置还认得出来。
  return '<a class="co-row" href="#/missions/' + encodeURIComponent(row.missionId) + '"'
    + attr('data-mission-id', row.missionId)
    + attr('data-group', row.group) + (selected ? ' data-selected="1"' : '') + '>'
    + '<div class="co-cell co-identity">'
    + '<p class="co-id"' + attr('title', row.missionId) + '>' + esc(middleEllipsis(row.missionId)) + '</p>'
    + '<p class="co-intent"' + attr('title', row.intent) + '>' + esc(row.intent) + '</p></div>'
    + '<div class="co-cell co-status"><span class="co-status-line">'
    + '<img class="co-icon" src="/' + view.icon + '" width="16" height="16" alt="" />'
    + '<span class="co-status-text" data-tone="' + view.tone + '">' + esc(row.statusText) + '</span></span>'
    + '<p class="co-marks"' + attr('title', marksLine) + '>' + esc(marksLine) + '</p></div>'
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

/**
 * 把补充投影套到即将画出去的那批行上。
 *
 * 每个 group 复制一份、rows 逐个换成 applyOverlay 的副本：就地改会把行上的补丁
 * 留在模型里，下一次刷新（或同时打开的另一个视图）就会看到上一轮叠加出来的附标。
 * 这里只动 groups，不动 built.counts / built.page / built.matched —— 那三个数说的是
 * 完整匹配集，与这一屏叠了几条详情无关。
 */
function overlayGroups(groups, overlay) {
  if (overlay === null) return groups;
  return groups.map((group) => ({
    ...group,
    rows: group.rows.map((row) => applyOverlay(row, overlay[row.missionId])),
  }));
}

function groupsHtml(groups, options) {
  // 空组不画空标题：三个组头下面都没有行，看起来像加载失败。
  const shown = groups.filter((group) => group.rows.length > 0);
  if (shown.length === 0) {
    // 「一条任务都没有」与「筛选之后没有」是两件事：前者说明平台上还什么都没有，
    // 后者说明条件太窄。写成同一句，人会去放宽一个本来就不需要放宽的筛选。
    const text = options.emptyAll ? '平台上还没有任务' : '没有符合条件的任务';
    return '<div class="co-empty" data-overview-empty="' + (options.emptyAll ? 'all' : 'filtered') + '">'
      + text + '</div>';
  }
  return shown.map((group) => '<div class="co-group" data-group="' + esc(group.key) + '">'
    + '<div class="co-group-head">' + esc(group.title) + '</div>'
    + group.rows.map((row) => rowHtml(row, options)).join('')
    + '</div>').join('');
}

/**
 * 分页条。「加载更早」是**真的** button：一次点击把 shown 加一个具名批次，
 * 由控制器接着重画。旧版这里是一个 span 冒充按钮，点它没有任何反应，
 * 而屏幕上看不出它其实没接线。
 */
function pageHtml(page) {
  return '<div class="co-page"><span class="co-page-count">显示 ' + String(page.shown)
    + ' / ' + String(page.total) + '</span>'
    + (page.hasMore
      ? '<button class="co-more" type="button" data-overview-more>加载更早</button>'
      : '')
    + '</div>';
}

/* ============================ 页面 ============================ */

/**
 * 总览页的完整 HTML（纯函数：同样的入参永远同样的字符串）。
 *
 * options 全部可选：
 *   - `filter`  真实的筛选条件（projectId / status / pausedOnly / query），
 *               页签选中态、开关轨道、搜索框的值、计数都从它和模型来；
 *   - `shown`   这一屏显示多少条（缺省 OVERVIEW_PAGE_SIZE）；
 *   - `now`     判定「同一天」用的当前时刻，测试里固定它才能断言时间格式；
 *   - `selectedId` 当前打开的任务。不传就没有任何行是选中的——首屏不编一个
 *               默认选中，那会让人以为进来就点开了一条；
 *   - `load`    读取状态 `{ status, error, lastOkAt }`。看不出来源时一律当成
 *               「已经拿到列表」，这样纯渲染调用方不必凭空造一个状态对象；
 *   - `overlay` 按 missionId 索引的补充投影（补修/问题/落地/真实运行），
 *               只作用于这一屏可见的行；缺了就画模型原样给的事实。
 */
export function overviewHtml(data, options) {
  const d = data && typeof data === 'object' ? data : {};
  const opts = options && typeof options === 'object' ? options : {};
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
  const filter = opts.filter && typeof opts.filter === 'object' ? opts.filter : {};
  const load = opts.load && typeof opts.load === 'object' ? opts.load : {};
  // 列表是否**曾经**读到过：null / 缺失都不是空集合，空集合是一个真实的 []。
  const read = Array.isArray(d.missions);
  const status = load.status === 'error' || load.status === 'loading'
    ? load.status
    : (read ? 'ready' : 'loading');

  const title = '<h1 class="fixed-page-title co-title">任务总览</h1>';
  const open = '<section class="screen console-overview">';

  // 未成功取到列表：不画页签、不画计数、不画空态。它们的每一个数字都会变成
  // 「平台上一条任务都没有」这句话。
  if (!read) {
    return open + title + toolbarHtml(filter) + loadNoteHtml({ ...load, status }) + '</section>';
  }

  // 补充投影只套在**即将画出去的那一批**（built.groups）上，不套在进 buildOverview
  // 的 missions 上：补修/运行中/落地都不参与筛选、分组和计数，套在入参上会让
  // 「全部 60」跟着页面上叠了几层详情变成别的数字。overlay 不是对象就当没有——
  // 一个字符串或数组不会是「每行的补充事实」，猜下去只会画出没有来源的行。
  const overlay = opts.overlay !== null && typeof opts.overlay === 'object' ? opts.overlay : null;

  const built = buildOverview(d.missions, {
    filter,
    shown: opts.shown,
    // 重试时刻用同一套本地格式：页面上两处时间必须是同一个时区、同一种写法。
    formatTime: (iso) => formatUpdated(iso, now),
  });
  const needsYou = built.matched.filter((row) => row.group === 'needs_you');
  const rowOptions = {
    now,
    selectedId: typeof opts.selectedId === 'string' ? opts.selectedId : '',
    emptyAll: d.missions.length === 0,
    // 重试时刻与「更新时间」用同一个格式化函数：同一格里出现 14:36 与 ISO 两种写法，
    // 人会以为它们不是同一个时区。
    formatTime: (iso) => formatUpdated(iso, now),
  };

  return open
    + title
    + (status === 'error' ? refreshNoteHtml(load, now) : '')
    + bannerHtml(built, needsYou)
    + toolbarHtml(built.filter)
    + '<div class="co-board">'
    + tabsHtml(built.filter, built.counts)
    + '<div class="co-table">' + HEAD_HTML + groupsHtml(overlayGroups(built.groups, overlay), rowOptions) + '</div></div>'
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
  // 标题只留两行预览（样式在 ui.css 的 .mission-title）：长标题一行占满会把首屏
  // 之后的列表全推到看不见的地方。完整原文放在 title 上、也放在任务详情页的
  // h1 里，所以裁剪不会藏掉信息；链接仍是真 <a href>，键盘与读屏都照旧能进。
  return '<div class="table-wrap"><table class="tasks"><thead><tr><th>任务</th><th>状态</th><th>最近活动</th></tr></thead><tbody>'
    + newestMissions(rows).map(row => '<tr><td><a class="mission-title" title="' + esc(row.intent || row.missionId)
      + '" href="#/missions/' + encodeURIComponent(row.missionId) + '">'
      + esc(row.intent || row.missionId) + '</a><div class="row-sub">' + esc(row.missionId) + '</div></td>'
      + '<td>' + stageChip(row.status) + ' ' + stateChip(row) + '</td><td class="mono">'
      + esc(row.updatedAt ? new Date(row.updatedAt).toLocaleString('zh-CN') : '未知') + '</td></tr>').join('')
    + '</tbody></table></div>';
}

/* ============================ 入口 ============================ */

/**
 * 总览页入口：把纯视图交给控制器，剩下的事归 console-overview-controller.js。
 *
 * 项目范围只从 hash 路由来（`#/` 与 `#/projects` 是全部项目，`#/projects/<id>` 是
 * 某个项目）。旧版这里还渲染了一个页内「项目」下拉，并在没指定项目时静默选中
 * `projects[0]`——那等于替人做了一个它没做的选择：屏幕上看的是「P-1」，而地址栏
 * 什么都没说，刷新一次又换一个项目。同一个项目范围现在由公共的顶栏控件表达。
 */
export function renderOverviewPage(container, projectId = null) {
  const controller = createOverviewController({
    container,
    projectId,
    render: (state) => overviewHtml(
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
  });
  return controller.start();
}
