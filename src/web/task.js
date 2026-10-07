/**
 * 任务详情页（hash `#/missions/<missionId>`）。
 *
 * 与 projects.js 同一分界：**上面全是纯函数**（喂数据 → 回字符串），
 * 只有底部 renderTaskPage 碰 DOM 与 fetch。这么分不是为了洁癖：浏览器不在
 * 测试里，而"字段名读错了"这类错在页面上是没有声音的——那一格永远是 —，
 * 页面照样跑。纯函数才能在 node 里把真 JSON 喂进去把它抓出来。
 *
 * 呈现层是一条运行时间线（一个环节 = 同一个 attemptId 下的一跳），
 * 选中环节的沟通与用量独立呈现，当前实时输出始终可见。
 * 事件流不再平铺：一条跑完的任务有三十几条事件，摊开之后人找不到
 * 「现在走到哪一段、这一跳花了多少、上一个 agent 到底说了什么」。
 *
 * 只读。没有任何写操作：页头上那个「停止任务」是 disabled 的，而且刻意
 * 不绑事件——写操作要等鉴权（见那颗按钮的 title）。界面里再实现一份
 * 「什么时候可以取消」的规则，迟早和平台判的不一样。
 */

import { esc, nextRefresh, num, stateChip, stageChip } from './projects.js';
import {
  changesEmptyText,
  changesErrorText,
  changesFileCountText,
  changesFileLinesText,
  changesLineDeltaText,
  changesLoadingText,
  changesTitle,
  commandCountLabel,
  commandDetail,
  contextMetricLegendLine,
  contextMetricsMissingText,
  contextMetricsTitle,
  diffSummaryLabel,
  evidenceKindLabel,
  fieldLabel,
  finalReviewSummary,
  formatAttemptId,
  formatUsage,
  isRuntimeCommand,
  narrateEvent,
  newFileLabel,
  nowDoing,
  outputTailTitle,
  pendingMemoryNote,
  PLATFORM_ROLE_LABEL,
  reasonText,
  revisionLabel,
  roleBadge,
  roleOfAttempt,
  roleTone,
  roleUsageLine,
  stageName,
  usageLine,
  usageTypeLine,
} from './narrate.js';

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
 * 修订号上屏必须带名词：「规划 r2」而不是一个孤零零的 r2——光看 r2，
 * 人既不知道那是谁的版本，也看不出它比上一版动了什么。
 */
function revisionLine(v) {
  const parts = [];
  if (Number.isFinite(Number(v.contractRevision))) {
    parts.push(revisionLabel('contract', v.contractRevision));
  }
  if (Number.isFinite(Number(v.planRevision))) {
    parts.push(revisionLabel('plan', v.planRevision));
  }
  return parts.length
    ? '<div class="revision-line">' + esc(parts.join(' · ')) + '</div>'
    : '';
}

/**
 * 页头：标题 + 两根 chip + 「现在在干什么」+ 两格时间统计 + 停止按钮。
 *
 * 创建时间取 activity 按时间顺序的第一条（通常是 mission.created）：
 * MissionView **没有 createdAt**，而为了这一格去改内核/后端不值当——
 * 事件流本来就是"这条任务什么时候开始的"的权威来源。
 *
 * Token 那一格搬走了（见 usageCardHtml）：按角色拆需要一块自己的地方。
 *
 * nowIso 由调用方传入，理由见 formatDuration。
 */
export function headerHtml(view, activity, nowIso) {
  const v = view || {};
  const intent = (v.contract && v.contract.intent) || '（没有契约）';
  const created = firstAt(activity);
  // 终态的"结束"是它最后一次动过（updatedAt 就是最后一条事件落下的时间），
  // 拿不到才退回末条事件；活着的任务才用"现在"。
  const ended = isTerminal(v.status)
    ? v.updatedAt || lastAt(activity)
    : nowIso;
  // 戳在头上的那一句「现在在干什么」：一屏黑话里最缺的就是它。
  // 状态 chip 只说"走走停停"，这一句说"在等谁、在跑哪一个"。
  const doing = nowDoing(v);
  // 停机原因是第二根轴上的具体情形。等待时它必须看得见——只写「等待中」
  // 等于把「在等什么」留给人自己去猜（或者去翻事件流）。
  const waiting = Boolean(v.paused || v.waitReason || v.waitDetail);
  return '<div class="task-eyebrow"><span class="mono">#' + esc(v.missionId || '') + '</span>'
    + '<span>' + esc(v.projectId || '') + '</span></div>'
    + '<h1 class="task-title">' + esc(intent) + '</h1>'
    + '<div class="task-chips">'
    +   stageChip(v.status)
    +   stateChip(v)
    + '</div>'
    + revisionLine(v)
    + '<div class="now-doing">现在在干什么：' + esc(doing) + '</div>'
    + (waiting
      ? '<div class="wait-reason">停机原因：' + esc(reasonText(v) || '（没有写原因）') + '</div>'
      : '')
    + '<dl class="task-stats">'
    +   '<div class="stat"><dt>运行时长</dt><dd class="mono">'
    +     esc(formatDuration(created, ended)) + '</dd></div>'
    +   '<div class="stat"><dt>创建时间</dt><dd class="mono">'
    +     esc(formatTime(created)) + '</dd></div>'
    + '</dl>'
    + (isTerminal(v.status)
      ? '<button class="stop-btn" type="button" disabled>任务已结束</button>'
      : '<button class="stop-btn danger" type="button" data-task-cancel>取消任务</button>');
}

/* ===================== 环节分组 ===================== */

/**
 * activity → 环节数组。一个环节 = 同一个 attemptId 下的所有事件。
 *
 * **按 attemptId 首次出现顺序成组**，不是「attemptId 一变就新开一组」的连续
 * 分段。这不是口味问题：activity 是 append-only 的，而没有 attemptId 的事件
 * （发起任务、最终检视、契约修订）会散落在流的**头和尾**。连续分段会在开头多
 * 切出一个组，W4 那种形状就从 6 个环节变成 7 个，而多出来的那个「开头的 L3 组」
 * 和真正收尾的那个 L3 组永远合不到一起——一个人分成两段显示，比少一段更误导。
 *
 * 所以：没有 attemptId 的事件按**真实角色**收成收尾组，仍放在最后。
 * 只让平台 / L3 进平台组与 L3 组——L1/L2 的 orphan 硬塞进 L3，任务结束后
 * 那一组看起来像检视者还在跑，比少一组更误导。
 */
export function groupActivity(activity) {
  const rows = activity || [];
  const order = [];
  const buckets = new Map();
  const orphans = {
    coordinator: [],
    executor: [],
    other: [],
    platform: [],
    reviewer: [],
  };
  for (const e of rows) {
    const id = e && e.attemptId ? String(e.attemptId) : '';
    if (!id) {
      orphans[orphanRole(e)].push(e);
      continue;
    }
    if (!buckets.has(id)) {
      buckets.set(id, []);
      order.push(id);
    }
    buckets.get(id).push(e);
  }
  const groups = order.map((id) => ({
    attemptId: id,
    role: roleOfAttempt(id),
    events: buckets.get(id),
  }));
  // 收尾组：L1/L2 不进 L3；平台与 L3 分开，L3 永远在最后（终审在尾上）。
  const pushOrphan = (role) => {
    const events = orphans[role];
    if (events.length > 0) groups.push({ attemptId: '', role, events });
  };
  pushOrphan('coordinator');
  pushOrphan('executor');
  pushOrphan('other');
  pushOrphan('platform');
  pushOrphan('reviewer');
  return groups;
}

/**
 * 没有 attemptId 的事件归哪一组。看 narrate 的徽章，不在页面再写一份 kind 表——
 * 两份表一定会漂，漏一条就把 L2 的 waiting 画成 L3。
 */
function orphanRole(event) {
  const told = narrateEvent(event);
  if (told && told.untranslated) return 'other';
  const badge = told && told.badge ? String(told.badge) : '';
  if (badge === PLATFORM_ROLE_LABEL) return 'platform';
  if (badge === 'L3' || badge.startsWith('L3')) return 'reviewer';
  if (badge === 'L1' || badge.startsWith('L1')) return 'executor';
  if (badge === 'L2' || badge.startsWith('L2')) return 'coordinator';
  return 'other';
}

/**
 * 环节在 DOM / 展开集里的键。有 attemptId 用它；收尾组不能都写成空串，
 * 否则点开「平台」会把「L3」一起展开。L3 仍用空串，和旧的 data-attempt-id="" 对齐。
 */
function stageKey(group) {
  if (group && group.attemptId) return String(group.attemptId);
  const role = group && group.role;
  if (role === 'platform') return 'platform';
  if (role && role !== 'reviewer') return 'orphan-' + role;
  return '';
}

/**
 * 呈现用角色。平台有自己的徽章，色条跟 L3 同一档（都不是 L1/L2 那一跳）。
 * 详情和列表必须走同一份：两份表一定会把平台画成检视者。
 */
function presentRole(group) {
  const role = (group && group.role) || roleOfAttempt(group && group.attemptId);
  if (role === 'platform') {
    return { role, tone: roleTone('reviewer'), badge: PLATFORM_ROLE_LABEL };
  }
  const toneRole = !role || role === 'other' ? 'coordinator' : role;
  return { role, tone: roleTone(toneRole), badge: roleBadge(toneRole) };
}

/**
 * 环节名。平台组不能走 stageName：空 attemptId 会被当成 L3。
 * L1/L2 orphan 同样不能把空 id 喂给 stageName，否则「协调」会写成「L3 检视者」。
 */
function stageLabel(group, context) {
  if (group && group.role === 'platform') return PLATFORM_ROLE_LABEL;
  if (group && group.attemptId) return stageName(group.events, context);
  if (!group || group.role === 'reviewer' || !group.role) return stageName(group && group.events, context);
  const fakeId = group.role === 'executor' ? 'orphan.exec-1' : 'coord-orphan';
  const fake = (group.events || []).map((e) => Object.assign({}, e, { attemptId: fakeId }));
  return stageName(fake, context);
}

/** 组内最能代表这一跳的事件：优先非开关门、也非命令族（命令族折叠，不当摘要）。 */
function representativeEvent(events) {
  const rows = events || [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const kind = rows[i] && rows[i].kind;
    if (!kind || kind === 'attempt.started' || kind === 'attempt.ended') continue;
    if (isRuntimeCommand(kind)) continue;
    return rows[i];
  }
  // 只剩开关门时仍用末条（那一跳确实只有开关）；命令族不当代表——
  // 它们不在翻译表里，拿来当摘要会变成「未翻译」。
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const kind = rows[i] && rows[i].kind;
    if (kind && !isRuntimeCommand(kind)) return rows[i];
  }
  return null;
}

/**
 * 实际执行过的命令：只计 runtime.command.started。
 * command_tracking 是开关，不是一条命令；同一 callId 打两次 started 仍是一条
 * （平台会在重试/心跳里重复，按条数显示会把 1 条说成 20 条）。
 */
function startedCommands(events) {
  const out = [];
  const seen = new Set();
  for (const e of events || []) {
    if (!e || e.kind !== 'runtime.command.started') continue;
    const callId = e.data && e.data.callId;
    if (callId !== undefined && callId !== null && String(callId) !== '') {
      const key = String(callId);
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(e);
  }
  return out;
}

function commandFoldHtml(events) {
  const cmds = startedCommands(events);
  if (cmds.length === 0) return '';
  const items = cmds
    .map((e) => '<li class="cmd">' + esc(commandDetail(e)) + '</li>')
    .join('');
  return '<details class="cmd-fold">'
    + '<summary class="cmd-fold-head">' + esc(commandCountLabel(cmds.length)) + '</summary>'
    + '<ul class="cmd-list">' + items + '</ul>'
    + '</details>';
}

/** 这一跳的用量一句话。没有 ended 事件时说的是原因，不是一个孤零零的 —。 */
function stageUsageLine(events, group, ctx) {
  const rows = events || [];
  const role = (group && group.role) || roleOfAttempt(group && group.attemptId);
  const ended = rows.find((e) => e && e.kind === 'attempt.ended');
  const usage = ended && ended.data && ended.data.usage;
  if (usage && usage.quality !== 'unknown') return usageLine(usage);
  if (ended) return '这一跳没有上报用量';
  const reviewTail = !(group && group.attemptId) && (role === 'reviewer' || role === 'platform');
  if (ctx && isTerminal(ctx.status)) {
    // 任务已经结束还说「这一跳还没结束」是说谎——L3/平台尾段改报终审。
    // 结论人话只出 narrate.finalReviewSummary：这里再写一份 verdict 映射一定会漂。
    if (reviewTail) return finalReviewSummary(ctx.finalReview);
    return '这一跳没有上报用量';
  }
  if (!group?.attemptId) return '事件记录 · 不单独计量';
  const provisional = ctx?.usageByAttempt?.[group.attemptId];
  if (provisional && provisional.quality !== 'unknown') return '暂计 · ' + usageLine(provisional);
  return '进行中 · 用量暂未上报';
}

/* ===================== 顶部：独立用量卡 ===================== */

/**
 * 按角色拆用量。
 *
 * 只从 activity 里 `kind === 'attempt.ended'` 且带 `data.usage` 的事件算，
 * **不**为算用量去逐个拉 `/attempts/<id>`：那会把一次进页变成 N+1 个请求，
 * 而 ended 事件本来就把这一跳的用量写全了。
 *
 * 占比分母用 L2+L1 之和而不是 view.usage.total：在途那一跳还没 ended，
 * total 会比两 role 之和大，拿 total 当分母算出来的两个百分比加起来不等于
 * 100%，看起来像漏了一笔钱。
 */
export function usageByRole(activity) {
  const acc = {
    coordinator: { tokens: 0, cost: 0, costReported: false, attempts: 0 },
    executor: { tokens: 0, cost: 0, costReported: false, attempts: 0 },
    reviewer: { tokens: 0, cost: 0, costReported: false, attempts: 0 },
  };
  for (const e of activity || []) {
    if (!e || e.kind !== 'attempt.ended') continue;
    const usage = e.data && e.data.usage;
    if (!usage) continue;
    const bucket = acc[roleOfAttempt(e.attemptId)];
    bucket.tokens += formatUsage(usage).total;
    bucket.attempts += 1;
    if (Number.isFinite(Number(usage.cost))) {
      bucket.cost += Number(usage.cost);
      bucket.costReported = true;
    }
  }
  const total = acc.coordinator.tokens + acc.executor.tokens + acc.reviewer.tokens;
  const withPct = (bucket) => Object.assign({}, bucket, {
    pct: total > 0 ? (bucket.tokens / total) * 100 : 0,
    costText: bucket.costReported ? '$' + bucket.cost.toFixed(4) : '',
  });
  return {
    coordinator: withPct(acc.coordinator),
    executor: withPct(acc.executor),
    reviewer: withPct(acc.reviewer),
    total,
  };
}

const roleLine = (role, bucket) =>
  '<li class="usage-role tone-' + esc(roleTone(role)) + ' role-' + esc(role) + '">'
  +   esc(roleUsageLine(role, bucket.tokens, bucket.pct, bucket.costText))
  + '</li>';

/**
 * 顶部独立用量卡：总计 → 按角色 → 按类型，三层。
 *
 * 单独一块而不是继续挤在页头那行统计里：按角色拆要看得清 L2/L1 各占多少，
 * 页头那一行放不下两行也看不清占比，而「钱花在协调还是执行」正是这一页
 * 最该一眼回答的问题。
 */
export function usageCardHtml(view, activity) {
  const v = view || {};
  const totals = formatUsage(v.usage);
  const byRole = usageByRole(activity);
  // 一次 ended 都没有（任务刚起步，第一跳还没结束）时不能报 0 占比——
  // 那是「还不知道」，不是「没花钱」。
  const known = byRole.total > 0;
  return '<div class="usage-card-head">'
    +   '<span class="usage-num mono">' + esc(num(totals.total)) + '</span>'
    +   '<span class="usage-unit">tokens</span>'
    +   '<span class="usage-cost">' + esc(totals.costText) + '</span>'
    + '</div>'
    + '<ul class="usage-roles">'
    +   (known
      ? roleLine('reviewer', byRole.reviewer) + roleLine('coordinator', byRole.coordinator) + roleLine('executor', byRole.executor)
      : '<li class="usage-pending">还没有结束的一跳，暂时算不出按角色的占比。</li>')
    + '</ul>'
    + '<div class="usage-type">' + esc(usageTypeLine(v.usage)) + '</div>';
}

/* ===================== 左栏：按环节折叠的进度视图 ===================== */

/**
 * 组内一条事件。仍是 narrateEvent 那三件套（徽章 / 动作 / 细节）。
 *
 * `data-event-key` 是它在**整条 activity** 里的下标：选中态与详情都按这个键，
 * 而下标对 append-only 的 activity 稳定且唯一（历史事件不保证带 messageId）。
 */
function eventRowHtml(event, index, selectedKey, ctx) {
  const told = narrateEvent(event, ctx);
  const refs = [];
  if (event && event.workItemId) {
    refs.push(fieldLabel('WorkItem') + ' <span class="mono">' + esc(event.workItemId) + '</span>');
  }
  if (event && event.attemptId) {
    const attempt = formatAttemptId(event.attemptId);
    // 人话标签在前，原始 id 紧跟在括号里：排障时人要拿它去 grep 日志。
    refs.push(fieldLabel('attempt') + ' ' + esc(attempt.label)
      + ' <span class="mono muted">（' + esc(attempt.raw) + '）</span>');
  }
  return '<li class="evt" data-event-key="' + index + '"'
    + (selectedKey === index ? ' data-active="1"' : '') + '>'
    + '<div class="evt-top">'
    +   '<span class="evt-badge">' + esc(told.badge) + '</span>'
    +   '<span class="evt-action">' + esc(told.action) + '</span>'
    +   '<span class="evt-time">' + esc(formatTime(event && event.at)) + '</span>'
    + '</div>'
    + '<div class="evt-detail">' + esc(told.detail) + '</div>'
    + (refs.length ? '<div class="evt-refs">' + refs.join(' · ') + '</div>' : '')
    + '</li>';
}

/**
 * 环节列表。每个环节一个 `<details>`，**默认收起**（不写 open 属性）。
 *
 * 默认展开等于没折叠：三十几条事件摊开还是三十几条，人照样找不到
 * 「现在走到哪一段」。
 *
 * 环节头那一行自足：环节名 + 角色徽章 + 耗时 + 这一跳的 token 与费用 +
 * 一句话摘要，不展开也看得懂这一段是什么、跑了多久、花了多少、在干什么。
 * 另加一栏阶段耗时（见 stagePhaseLine）：它与 `.stage-dur` 是两回事——后者只是
 * 组内首末事件在墙上跨了多久，答不了「这些时间花在哪一类阶段上、哪一段根本没测到」。
 *
 * 左侧色条、环节头、角色徽章三处同源（都走 roleTone），与 projects.js
 * stageTone 同一套 `--status-*` 令牌——同一环节在任务页与项目页是一个颜色。
 *
 * `expandedIds` 是**用户已经展开过的 attemptId**（数组或 Set）。纯函数读不到
 * 浏览器的 `<details>.open`，而环节列表是整块重画的：不把展开过的组再写回
 * open，重画一次就把人刚点开的那一组折回去，组内逐条事件永远看不到。
 * 不传（首屏）时一个 open 都不写。
 */
/* ===================== 时间归因（后端算好的阶段投影） ===================== */

/**
 * 归因阶段的 kind → 中文。闭集与后端 TIME_PHASE_KINDS 对齐；认不出的 kind
 * 落回 kind 原文，不另编一个类别——编出来的类别会让人以为那一段已经测清了。
 */
const PHASE_KIND_LABELS = {
  queue: '排队',
  hop_backoff: '退避等待',
  schedule_select: '调度选候选',
  agent_run: '运行',
  tool: '工具',
  validation: '验证',
  l2_review: '评审',
  waiting_decision: '等待决定',
  pause: '暂停',
  park: '搁置',
  unclassified: '未分类',
};

/**
 * 毫秒 → 人话时长。起点给 epoch 的 ISO 而不是数字 0：formatDuration 走
 * `Date.parse(String(x))`，传数字 0 会被解析成 2000 年，整段差三十年。
 */
function durationFromMs(ms) {
  return formatDuration(new Date(0).toISOString(), new Date(ms).toISOString());
}

/**
 * 这一组的归因阶段。有 attemptId 就按它关联（后端本来也是按 attempt 归的）。
 *
 * 无 attemptId 的收尾组（平台 / L3）只在**工单对得上、且起止都能定下来**时才认：
 * 不设这两道，一段没有归属的真实耗时会被挂到「平台」头上，看起来像平台自己在跑，
 * 比不显示更误导。
 */
function phasesOfGroup(group, attribution) {
  const phases = (attribution && attribution.phases) || [];
  const attemptId = group && group.attemptId;
  if (attemptId) return phases.filter((p) => p && p.attemptId === attemptId);
  const workItemIds = new Set(
    (group && group.events || [])
      .map((e) => (e && e.workItemId !== undefined && e.workItemId !== null ? String(e.workItemId) : ''))
      .filter((id) => id !== ''),
  );
  if (workItemIds.size === 0) return [];
  return phases.filter((p) => p && !p.attemptId
    && p.workItemId !== undefined && p.workItemId !== null && workItemIds.has(String(p.workItemId))
    && typeof p.start === 'string' && typeof p.end === 'string');
}

/**
 * 环节头的阶段耗时一栏。
 *
 * 与 `.stage-dur`（组内首末事件的跨度）是两回事：后者答「这一跳在墙上跨了多久」，
 * 答不了「这些时间花在哪一类阶段上、哪一段根本没测到」。所以这里只渲染后端
 * 已经算好的投影，**不在浏览器重新归因**——两份算法一定会漂。
 *
 * `durationMs === null` 一律说「未知」；没有投影也说「未知」，不按事件间隔
 * 凑一个数出来。阶段投影不用当前时间闭合（所以这里不读 ctx.nowIso）。
 */
function stagePhaseLine(group, ctx) {
  const phases = phasesOfGroup(group, ctx && ctx.timeAttribution);
  if (phases.length === 0) return '阶段耗时 · 未知';
  const parts = phases.map((p) => {
    const label = PHASE_KIND_LABELS[p.kind] || String(p.kind);
    const dur = (p.durationMs === null || p.durationMs === undefined) ? '未知' : durationFromMs(p.durationMs);
    return label + ' ' + dur;
  });
  return '阶段耗时 · ' + parts.join(' · ');
}

export function stageListHtml(activity, selectedAttemptId, selectedKey, ctx, expandedIds) {
  const groups = groupActivity(activity).sort((a, b) => {
    const left = Date.parse(firstAt(a.events)), right = Date.parse(firstAt(b.events));
    return Number.isFinite(left) && Number.isFinite(right) ? left - right : 0;
  });
  if (groups.length === 0) return '<div class="empty">还没有事件。这条任务刚开始。</div>';
  const context = ctx || {};
  const expanded = new Set(expandedIds || []);
  // 组内那一行用的是整条 activity 的下标，所以先建一张「事件对象 → 下标」的表。
  const indexOf = new Map();
  (activity || []).forEach((e, i) => {
    if (!indexOf.has(e)) indexOf.set(e, i);
  });
  return groups
    .map((g) => {
      const shown = presentRole(g);
      const tone = shown.tone;
      const name = stageLabel(g, context);
      const badge = shown.badge;
      const key = stageKey(g);
      const head = representativeEvent(g.events);
      const summary = head && !isRuntimeCommand(head.kind) ? narrateEvent(head, context).action : '';
      const rows = g.events
        .filter((e) => !isRuntimeCommand(e && e.kind))
        .map((e) => eventRowHtml(e, indexOf.has(e) ? indexOf.get(e) : -1, selectedKey, context))
        .join('');
      const cmds = startedCommands(g.events);
      const selected = selectedAttemptId !== null && key === selectedAttemptId;
      // 只有**用户真的展开过**的那几组才写 open：默认收起是硬要求，
      // 一上来就给所有环节加 open 等于没折叠。
      return '<details class="stage tone-' + esc(tone) + ' role-' + esc(shown.role || 'other') + '"'
        + ' data-attempt-id="' + esc(key) + '"'
        + (selected ? ' data-active="1"' : '')
        + (expanded.has(key) ? ' open' : '') + '>'
        + '<summary class="stage-head" data-stage-select>'
        +   '<span class="stage-name">' + esc(name) + '</span>'
        +   '<span class="chip ' + esc(tone) + '">' + esc(badge) + '</span>'
        +   '<span class="stage-clock mono">' + esc(formatClock(firstAt(g.events))) + ' → ' + esc(g.attemptId && !g.events.some(e => e.kind === 'attempt.ended') && !isTerminal(context.status) ? '进行中' : formatClock(lastAt(g.events))) + '</span>'
        +   '<span class="stage-dur mono">'
        +     esc(formatDuration(firstAt(g.events), g.attemptId && !g.events.some(e => e.kind === 'attempt.ended') && !isTerminal(context.status) && context.nowIso ? context.nowIso : lastAt(g.events))) + '</span>'
        +   '<span class="stage-phase">' + esc(stagePhaseLine(g, context)) + '</span>'
        +   '<span class="stage-usage">' + esc(stageUsageLine(g.events, g, context)) + '</span>'
        +   (cmds.length > 0
          ? '<span class="stage-cmds">' + esc('跑了 ' + commandCountLabel(cmds.length)) + '</span>'
          : '')
        +   (summary ? '<span class="stage-summary">' + esc(summary) + '</span>' : '')
        +   (contextMetricsFromEvents(g.events) ? contextMetricsCompactHtml(g.events) : '')
        + '</summary>'
        + '<ul class="evt-list">' + rows + '</ul>'
        + commandFoldHtml(g.events)
        + '</details>';
    })
    .join('');
}

/* ===================== 右上：选中环节的详情（agent 之间传递的正文） ===================== */

const field = (label, value, mono) =>
  '<dt>' + esc(label) + '</dt><dd' + (mono ? ' class="mono"' : '') + '>' + esc(value) + '</dd>';

const section = (title, body) =>
  '<section class="detail-block"><h3 class="detail-block-title">' + esc(title) + '</h3>'
  + body + '</section>';

const MISSING = '（这一项没有内容）';

/** 字符串字段：缺了给解释句，不给一个孤零零的 —（那和「读不到」在屏幕上长得一样）。 */
const txt = (value) =>
  value === undefined || value === null || String(value).trim() === '' ? MISSING : String(value);

/** 列表字段：空数组也是解释句，不印一个空的 <ul>。 */
function listField(items) {
  const rows = Array.isArray(items)
    ? items.filter((x) => x !== undefined && x !== null && String(x).trim() !== '')
    : [];
  if (rows.length === 0) return '<div class="muted">' + esc(MISSING) + '</div>';
  return '<ul class="detail-list">' + rows.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>';
}

const workItemOf = (ctx, workItemId) => {
  const items = (ctx && ctx.workItems) || [];
  const id = workItemId === undefined || workItemId === null ? '' : String(workItemId);
  return items.find((it) => it && String(it.id) === id);
};

/** 协调者调查规划：plan 的五块正文。 */
function planBlock(plan) {
  const p = plan || {};
  return section('调查与规划结论（当前版本）', '<dl class="fields">'
    + field('发现', txt(p.findings))
    + field('根因', p.rootCause === undefined || p.rootCause === null ? '没有单独记根因' : p.rootCause)
    + '</dl>'
    + '<div class="field-label">排除掉的假设</div>' + listField(p.rejectedHypotheses)
    + '<div class="field-label">定下的决策</div>' + listField(p.decisions)
    + '<dl class="fields">' + field('方向', txt(p.direction)) + '</dl>');
}

/** 派发：被派工作项的工单正文——执行者拿到的就是这一份。 */
function dispatchBlock(ctx, events) {
  const ids = [];
  for (const e of events || []) {
    const list = e && e.data && e.data.ids;
    if (Array.isArray(list)) {
      for (const id of list) if (!ids.includes(id)) ids.push(id);
    }
  }
  if (ids.length === 0) {
    return section('派发的工单', '<div class="note">这一跳没有写派了哪些工作项。</div>');
  }
  return section('派发的工单', ids
    .map((id) => {
      const item = workItemOf(ctx, id);
      const order = item && item.order;
      if (!order) {
        return '<div class="order-card"><div class="tech-id mono">' + esc(id) + '</div>'
          + '<div class="note">读不到这张工单的正文（可能已经被作废）。</div></div>';
      }
      return '<div class="order-card">'
        + '<div class="tech-id mono">' + esc(id) + ' · ' + esc(txt(item.title)) + '</div>'
        + '<dl class="fields">' + field('目标', txt(order.objective)) + '</dl>'
        + '<div class="field-label">允许改动的范围</div>' + listField(order.allowedScope)
        + '<div class="field-label">验证命令</div>' + listField(order.verification)
        + '<div class="field-label">验收标准</div>' + listField(order.acceptance)
        + '</div>';
    })
    .join(''));
}

/**
 * 证据清单。内容从旧的「验证结果」tab 整块搬过来——不许丢掉，只是换个地方。
 *
 * 每条 kind / summary / command / exitCode 都要在：「已修复」必须有可验证证据，
 * 界面同理。output 也带上，那才是能被复核的东西。
 */
function evidenceListHtml(evidence) {
  const rows = evidence || [];
  if (rows.length === 0) {
    return '<div class="note">这一跳还没有证据。要么还没提交，要么这一跳不是执行者在干活。</div>';
  }
  return '<ul class="evidence">'
    + rows
        .map(
          (e) => '<li>'
          + '<div class="ev-top">'
          +   '<span class="chip queued">' + esc(evidenceKindLabel(e && e.kind)) + '</span>'
          +   '<span>' + esc(txt(e && e.summary)) + '</span>'
          +   (e && e.exitCode !== undefined && e.exitCode !== null
              ? '<span class="mono muted">退出码 ' + esc(e.exitCode) + '</span>'
              : '<span class="mono muted">没有退出码</span>')
          + '</div>'
          + (e && e.command ? '<div class="mono muted">' + esc(e.command) + '</div>' : '')
          + (e && e.output ? '<div class="ev-output mono muted">' + esc(e.output) + '</div>' : '')
          + '</li>',
        )
        .join('')
    + '</ul>';
}

/** 执行者：这一跳工作项的 executionResult + 证据清单。 */
function executorBlock(ctx, events, attempt) {
  const carrier = (events || []).find((e) => e && e.workItemId);
  const item = workItemOf(ctx, carrier && carrier.workItemId);
  const historical = item?.attemptIds?.length && attempt?.attemptId && item.attemptIds.at(-1) !== attempt.attemptId;
  const result = historical ? null : item && item.executionResult;
  const parts = [item?.order ? '<div class="field-label">协调者 → 执行者 · 工单（当前版本）</div>'
    + '<dl class="fields">' + field('目标', txt(item.order.objective)) + field('要求', txt(item.order.requiredBehaviour)) + '</dl>'
    + '<div class="field-label">验收标准</div>' + listField(item.order.acceptance) : ''];
  parts.push(result
    ? '<dl class="fields">'
      +   field('结果', txt(result.summary))
      +   field('遗留说明', result.notes && String(result.notes).trim() ? result.notes : '没有写遗留问题')
      + '</dl>'
      + '<div class="field-label">改动的文件</div>' + listField(result.changedFiles)
    : '<div class="note">' + (historical ? '本次历史交回正文未保留，请查看本环节输出与证据。' : '这一跳还没有执行者交回结果。') + '</div>');
  parts.push('<div class="field-label">证据</div>' + evidenceListHtml(attempt && attempt.evidence));
  return section('执行者交回的正文', parts.join(''));
}

/** 技术验收：对应工作项 lastReview 的结论与要求。 */
function reviewBlock(ctx, events) {
  const ids = [];
  for (const e of events || []) {
    if (e && e.kind === 'review.recorded' && e.workItemId && !ids.includes(e.workItemId)) {
      ids.push(e.workItemId);
    }
  }
  if (ids.length === 0) {
    return section('技术验收', '<div class="note">这一跳没有写验收的是哪个工作项。</div>');
  }
  return section('技术验收（当前记录）', ids
    .map((id) => {
      const item = workItemOf(ctx, id);
      const review = item && item.lastReview;
      if (!review) {
        return '<div class="review-card"><div class="tech-id mono">' + esc(id) + '</div>'
          + '<div class="note">读不到这个工作项的验收结论。</div></div>';
      }
      return '<div class="review-card">'
        + '<div class="tech-id mono">' + esc(id) + ' · ' + esc(txt(item.title)) + '</div>'
        + '<dl class="fields">'
        +   field('结论', review.verdict === 'accept' ? '通过'
              : review.verdict === 'reject' ? '打回重做' : txt(review.verdict))
        + '</dl>'
        + '<div class="field-label">理由</div>' + listField(review.reasons)
        + '<div class="field-label">打回时要改什么</div>' + listField(review.requiredChanges)
        + '</div>';
    })
    .join(''));
}

/**
 * 升级问答：L2 与 L3 之间那封往来邮件的原文（从旧的「相关消息」tab 搬过来）。
 *
 * 按环节的 attemptId 去配 escalationLog；配不上时（答复是 L3 写的、没带同一个
 * attemptId）宁可把整份问答列出来，也不要在这种一眼能看出「少了什么」的地方
 * 留一个空块。
 */
function escalationBlock(log, attemptId) {
  const rows = log || [];
  const mine = attemptId ? rows.filter((x) => x && String(x.attemptId) === String(attemptId)) : [];
  const shown = mine.length > 0 ? mine : rows;
  if (shown.length === 0) {
    return section('升级问答', '<div class="note">这条任务没有升级过问题。</div>');
  }
  return section('升级问答', '<ul class="escalations">'
    + shown
        .map(
          (e) => '<li>'
          + '<div class="q">' + esc(txt(e && e.question)) + '</div>'
          + '<div class="why">' + esc(e && e.why ? e.why : '（没有说明为什么需要 L3）') + '</div>'
          + (e && e.optionsConsidered && e.optionsConsidered.length
            ? '<ul class="options">' + e.optionsConsidered.map((o) => '<li>' + esc(o) + '</li>').join('') + '</ul>'
            : '')
          + '<div class="a">'
          +   (e && e.answer ? esc('答复：' + e.answer) : '<span class="muted">还没有答复 —— 这一条在等人。</span>')
          + '</div>'
          + '</li>',
        )
        .join('')
    + '</ul>');
}

/**
 * 平台收尾组：把组内事件已有的人话列出来，不套 L3 终审。
 * 终审块会把别人的 SHA 贴到投递/记忆落地上，看起来像平台在放行。
 */
function platformEventsBlock(events, ctx) {
  const rows = (events || []).filter((e) => e && !isRuntimeCommand(e.kind));
  // 仅命令族时不另开空态 section：下面 stageDetailHtml 已有「还没有把正文写回平台」。
  // 这里再写一句人话就是第二份叙事，和 narrate 会漂。
  if (rows.length === 0) return '';
  return section(PLATFORM_ROLE_LABEL, '<ul class="detail-list">'
    + rows.map((e) => {
      const told = narrateEvent(e, ctx);
      const line = told.detail ? told.action + ' · ' + told.detail : told.action;
      return '<li>' + esc(line) + '</li>';
    }).join('')
    + '</ul>');
}

/** L3 最终检视：结论、理由、改动落到哪。 */
function finalReviewBlock(finalReview) {
  const r = finalReview;
  if (!r) {
    return section('L3 最终检视', '<div class="note">还没有最终检视结论 —— 这条任务正在等你看。</div>');
  }
  const verdictCn = r.verdict === 'merge' ? '放行并落地'
    : r.verdict === 'send_back' ? '打回'
    : r.verdict === 'abandon' ? '放弃这批改动'
    : txt(r.verdict);
  return section('L3 最终检视', '<dl class="fields">'
    + field('结论', verdictCn)
    + field('落到哪', r.mergedInto ? r.mergedInto : '还没有落地（打回或还没放行）')
    + '</dl>'
    + '<div class="field-label">理由</div>' + listField(r.reasons));
}

/**
 * 选中环节的详情。回答的是「这一跳实际传递了什么」：协调者写回的结论、派给
 * 执行者的工单正文、执行者交回的结果与证据、验收的结论、升级的问答、L3 的判断。
 *
 * 旧的事件详情（causationId / profile / 单条事件字段）被它取代——那些解释的是
 * 「事件之间的连线」，而人打开这一页要问的是「两个 agent 之间到底说了什么」。
 * 技术 ID 仍留在「技术信息」那一行，只是不再是第一眼。
 *
 * 一个环节同时有几类事件就同时渲染几块（例：「技术验收、派发」）。除证据外
 * 全部读已经取到的 MissionView，不为详情新开接口。
 */
export function stageDetailHtml(group, ctx, attempt) {
  if (!group) {
    return '<div class="note">左边还没有选中环节。点一个环节头，这里会显示这一跳'
      + '实际传给下一跳的正文。</div>';
  }
  const context = ctx || {};
  const events = group.events || [];
  const shown = presentRole(group);
  const role = shown.role;
  const kinds = new Set(events.map((e) => (e && e.kind) || ''));
  const blocks = [];

  if (role === 'reviewer') {
    // L3 自己动手的那一组：发起任务、改契约、最终检视，以及对升级的答复。
    blocks.push(finalReviewBlock(context.finalReview));
    const answered = (context.escalationLog || []).filter((x) => x && x.answer);
    if (answered.length > 0) blocks.push(escalationBlock(answered, ''));
  } else if (role === 'platform') {
    const plat = platformEventsBlock(events, context);
    if (plat) blocks.push(plat);
  } else {
    if (kinds.has('plan.updated') || kinds.has('work_item.created')) {
      blocks.push(planBlock(context.plan));
    }
    if (kinds.has('work_item.dispatched')) {
      blocks.push(dispatchBlock(context, events.filter((e) => e && e.kind === 'work_item.dispatched')));
    }
    if (kinds.has('review.recorded')) blocks.push(reviewBlock(context, events));
    if (role === 'executor') blocks.push(executorBlock(context, events, attempt));
    if (kinds.has('escalated') || kinds.has('escalation.raised')) {
      blocks.push(escalationBlock(context.escalationLog, group.attemptId));
    }
  }

  const head = representativeEvent(events);
  const workItemIds = [];
  for (const e of events) {
    if (e && e.workItemId && !workItemIds.includes(e.workItemId)) workItemIds.push(e.workItemId);
  }
  const causation = (events.find((e) => e && e.causationId) || {}).causationId;
  const endedUsageEvent = [...events].reverse().find((e) => e && e.kind === 'attempt.ended' && e.data && e.data.usage);
  const observedUsage = endedUsageEvent?.data.usage || attempt?.usage;
  const stepTokens = observedUsage && observedUsage.quality !== 'unknown' ? formatUsage(observedUsage).total : null;
  // 非 L3 的无 attemptId 不能套 L3 那句「自己动手」——那是谎。
  // 不新写叙事：就用 formatAttemptId 对空 id 的已有说明。
  const attemptShown = group.attemptId
    ? fieldLabel('attempt') + ' ' + String(group.attemptId)
    : (role === 'reviewer'
      ? fieldLabel('attempt') + ' 这一组事件不属于任何一跳（L3 自己动手的）'
      : formatAttemptId('').label);

  return '<div class="detail-head">'
    +   '<span class="detail-title">' + esc(stageLabel(group, context)) + '</span>'
    +   '<span class="chip ' + esc(shown.tone) + '">' + esc(shown.badge) + '</span>'
    + '</div>'
    + (head
      ? '<div class="detail-sub">' + esc(narrateEvent(head, context).detail) + '</div>'
      : '<div class="detail-sub muted">这一跳还没有能说明白它在干什么的事件。</div>')
    + '<div class="detail-tech mono muted">'
    +   esc(attemptShown)
    +   (workItemIds.length ? ' · ' + esc(fieldLabel('WorkItem')) + ' ' + esc(workItemIds.join('、')) : '')
    +   (causation ? ' · ' + esc(fieldLabel('causationId')) + ' ' + esc(causation) : '')
    + '</div>'
    + '<div class="detail-step-token"><span>本步骤词元</span><strong class="mono">' + (stepTokens === null ? '未上报' : esc(num(stepTokens))) + '</strong></div>'
    + usageFieldsHtml(observedUsage)
    + (contextMetricsFromEvents(events) ? contextMetricsBlockHtml(events) : '')
    + (blocks.length > 0 ? blocks.join('') : '<div class="note">这一跳还没有把正文写回平台。</div>')
    + (attempt?.output ? '<details class="detail-block"><summary>本环节输出</summary><pre class="term">' + esc(String(attempt.output).slice(-20000)) + '</pre></details>' : '');
}

/* ===================== 上下文采集（attempt.ended.contextMetrics） ===================== */

/**
 * 一组事件里最后一次 attempt.ended 的 contextMetrics。
 *
 * 没这个键就是没上报：返回 null，调用方必须说「没有上报」，
 * **不能**拿 0 字节顶上——0 看起来像「采集了，结果是空的」。
 */
export function contextMetricsFromEvents(events) {
  let seen = false;
  let metrics = null;
  for (const e of events || []) {
    if (!e || e.kind !== 'attempt.ended') continue;
    const data = e.data;
    if (!data || typeof data !== 'object'
      || !Object.prototype.hasOwnProperty.call(data, 'contextMetrics')) {
      seen = false;
      metrics = null;
      continue;
    }
    seen = true;
    metrics = data.contextMetrics;
  }
  if (!seen) return null;
  if (!metrics || typeof metrics !== 'object') return null;
  return metrics;
}

function reportedNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * 已上报的分类字节。某一类没出现在 payload 里就不进数组——缺席不是 0。
 * 返回 null 表示整份都没上报（或上报了但没有任何可显示的数字）。
 */
export function contextMetricSegments(metrics) {
  if (!metrics || typeof metrics !== 'object') return null;
  const cats = [];
  const briefBytes = metrics.brief ? reportedNumber(metrics.brief.renderedUtf8Bytes) : null;
  if (briefBytes !== null) cats.push({ key: 'brief', bytes: briefBytes });
  const tools = Array.isArray(metrics.tools) ? metrics.tools : [];
  const order = ['read', 'grep', 'find', 'ls', 'bash'];
  const seen = new Set();
  for (const kind of order) {
    let reported = false;
    let sum = 0;
    for (const t of tools) {
      if (!t || t.kind !== kind) continue;
      const n = reportedNumber(t.returnedUtf8Bytes);
      if (n === null) continue;
      sum += n;
      reported = true;
    }
    if (reported) {
      cats.push({ key: kind, bytes: sum });
      seen.add(kind);
    }
  }
  for (const t of tools) {
    const kind = t && t.kind;
    if (!kind || seen.has(kind) || order.includes(kind)) continue;
    const n = reportedNumber(t.returnedUtf8Bytes);
    if (n === null) continue;
    cats.push({ key: String(kind), bytes: n });
    seen.add(kind);
  }
  return cats.length > 0 ? cats : null;
}

function metricColor(key) {
  return ({
    brief: 'var(--status-queued)',
    read: 'var(--status-running)',
    grep: 'var(--status-unconfirmed)',
    find: 'var(--status-done)',
    ls: 'var(--accent)',
    bash: 'var(--status-failed)',
  })[key] || 'var(--muted-foreground)';
}

function contextMetricsBarHtml(cats) {
  const rows = cats || [];
  if (rows.length === 0) return '';
  const total = rows.reduce((s, c) => s + (c.bytes > 0 ? c.bytes : 0), 0);
  return '<div style="display:flex;height:8px;width:100%;background:var(--muted);border-radius:999px;overflow:hidden;margin:6px 0">'
    + rows.map((c) => {
      const flex = total > 0 ? Math.max(0, c.bytes) : 0;
      return '<span style="flex:' + String(flex) + ';background:' + metricColor(c.key) + '"></span>';
    }).join('')
    + '</div>';
}

function contextMetricsLegendHtml(cats) {
  const rows = cats || [];
  if (rows.length === 0) return '';
  return '<ul class="detail-list">'
    + rows.map((c) => '<li>' + esc(contextMetricLegendLine(c.key, c.bytes)) + '</li>').join('')
    + '</ul>';
}

export function contextMetricsBlockHtml(events) {
  const cats = contextMetricSegments(contextMetricsFromEvents(events));
  const body = cats
    ? contextMetricsBarHtml(cats) + contextMetricsLegendHtml(cats)
    : '<div class="note">' + esc(contextMetricsMissingText()) + '</div>';
  return '<section class="detail-block">'
    + '<h3 class="detail-block-title">' + esc(contextMetricsTitle()) + '</h3>'
    + body
    + '</section>';
}

function contextMetricsCompactHtml(events) {
  const cats = contextMetricSegments(contextMetricsFromEvents(events));
  const line = cats
    ? cats.map((c) => contextMetricLegendLine(c.key, c.bytes)).join(' · ')
    : contextMetricsMissingText();
  return '<span class="stage-usage">' + esc(line) + '</span>';
}

/* ===================== 任务改动（GET /api/missions/:id/diff） ===================== */

/**
 * 拆 git diff --stat 文本。数字只在这一行真的写了才认；
 * 没有 summary 行就让 added/deleted 留空，不补 0。
 */
export function parseDiffStat(stat) {
  const files = [];
  let added = null;
  let deleted = null;
  const raw = stat == null ? '' : String(stat);
  for (const line of raw.split(/\r?\n/)) {
    const summary = /(\d+)\s+files?\s+changed(?:.*?(\d+)\s+insertions?\(\+\))?(?:.*?(\d+)\s+deletions?\(-\))?/.exec(line);
    if (summary && line.indexOf('|') === -1) {
      added = summary[2] != null ? Number(summary[2]) : 0;
      deleted = summary[3] != null ? Number(summary[3]) : 0;
      continue;
    }
    const pipe = /^(.*?)\s+\|\s+(.*)$/.exec(line);
    if (!pipe) continue;
    const path = pipe[1].trim();
    const right = pipe[2].trim();
    if (right === '新建') {
      files.push({ path, created: true, changed: null, raw: line });
      continue;
    }
    const count = /^(\d+)\b/.exec(right);
    files.push({
      path,
      created: false,
      changed: count ? Number(count[1]) : null,
      raw: line,
    });
  }
  return { files, added, deleted };
}

/**
 * 任务改动卡。空结果和失败都给解释句，不画一套空文件假装有改动。
 * payload.error 是加载失败；files 空则信 stat 上的空态原文。
 */
export function changesCardHtml(payload) {
  if (!payload) {
    return '<div class="note">' + esc(changesLoadingText()) + '</div>';
  }
  if (payload.error) {
    return '<div class="note">' + esc(changesErrorText(payload.error)) + '</div>';
  }
  const files = Array.isArray(payload.files) ? payload.files.map((x) => String(x)) : [];
  const pending = Array.isArray(payload.pendingMemory) ? payload.pendingMemory.map((x) => String(x)) : [];
  const stat = payload.stat == null ? '' : String(payload.stat);
  const parsed = parseDiffStat(stat);
  const byPath = new Map(parsed.files.map((f) => [f.path, f]));
  if (files.length === 0 && pending.length === 0) {
    const msg = stat.trim() ? stat.trim() : changesEmptyText();
    return '<div class="detail-block-title">' + esc(changesTitle()) + '</div>'
      + '<div class="note">' + esc(msg) + '</div>';
  }
  const delta = changesLineDeltaText(parsed.added, parsed.deleted);
  const head = [changesFileCountText(files.length), delta].filter(Boolean).join(' · ');
  const items = files.map((path) => {
    const hit = byPath.get(path);
    const bits = [path];
    if (hit && hit.created) bits.push(newFileLabel());
    else if (hit && hit.changed !== null && hit.changed !== undefined) {
      const lines = changesFileLinesText(hit.changed);
      if (lines) bits.push(lines);
    }
    const inner = hit && hit.raw
      ? '<pre class="term">' + esc(hit.raw) + '</pre>'
      : '<div class="note">' + esc(path) + '</div>';
    return '<li><details class="order-card">'
      + '<summary class="mono">' + esc(bits.join(' · ')) + '</summary>'
      + inner
      + '</details></li>';
  }).join('');
  const pendingNote = pendingMemoryNote(pending.length);
  const pendingList = pending.length
    ? '<div class="field-label">' + esc(pendingNote) + '</div>'
      + '<ul class="detail-list">' + pending.map((p) => '<li class="mono">' + esc(p) + '</li>').join('') + '</ul>'
    : '';
  const fullStat = stat.trim()
    ? '<details class="order-card"><summary>' + esc(diffSummaryLabel()) + '</summary>'
      + '<pre class="term">' + esc(stat) + '</pre></details>'
    : '';
  return '<div class="detail-block-title">' + esc(changesTitle()) + '</div>'
    + (head ? '<div class="detail-sub">' + esc(head) + '</div>' : '')
    + (items ? '<ul class="file-list">' + items + '</ul>' : '')
    + pendingList
    + fullStat;
}

/* ===================== 右下：常驻实时输出 ===================== */

/**
 * 终端块里面那一块。
 *
 * `kind === 'usage'` 的 chunk **不当终端行**：它没有 text，塞进终端会吐出一行
 * `undefined`；它是累计用量，所以单独摆一行数字（见 liveMetaHtml）。
 *
 * `kind === 'note'` 的行也不进正文——那是后端裁剪历史时补的「前面没了」，
 * 混在正文末尾会被读成「后面还有」，意思正好反过来，所以拎出去挂横幅
 * （见 liveNoteHtml）。
 *
 * 空的时候必须有一句说明，而且要看任务还在不在跑：
 *   - 已经不跑了：输出不会再来，直接说这里没留下行。**不能**再说「完整输出在
 *     下面的原始输出里」——原始数据 tab 已经删了，那句会把人指向一个空处。
 *   - 还可能开跑：一句话告诉人这一块不是坏的。
 * 两种情况都不能留空白：黑空的一块看起来像坏了。
 */
export function liveLinesHtml(chunks, running) {
  const lines = [];
  for (const c of chunks || []) {
    if (c && c.kind !== 'usage' && c.kind !== 'note') lines.push(c);
  }
  if (lines.length === 0) {
    return running === false
      ? '<span class="t">这一跳没有在这里留下输出行。</span>'
      : '<span class="t">还没有实时输出。agent 跑起来时这里会一行行出现。</span>';
  }
  return lines
    .map((c) => (c.kind === 'tool'
      ? '<span class="tool">▸ ' + esc(c.text) + '</span>'
      : '<span class="t">' + esc(formatClock(c.at)) + '</span>  ' + esc(c.text)))
    .join('\n');
}

/**
 * 裁剪说明横幅：挂在终端**上方**，不是正文里的一行。
 *
 * 后端 finish() 只删最早的、留尾部若干行，然后补一条 kind='note' 排在**末尾**
 * （append-only 的表没法往前插）。所以那句话必须由界面挪到上面去说，否则它读
 * 起来像「接下来还有」，而它说的恰好是「前面没了」。
 */
export function liveNoteHtml(chunks) {
  const notes = (chunks || []).filter((c) => c && c.kind === 'note' && c.text);
  if (notes.length === 0) return '';
  return '<div class="live-note">'
    + notes.map((c) => '<div>' + esc(c.text) + '</div>').join('')
    + '</div>';
}

/** 终端块右上角那一行元信息（行数与累计用量）。勾选框不在里面，不被每秒重写。 */
export function liveMetaHtml(live) {
  const lines = (live && live.lines) || [];
  const count = lines.filter((c) => c && c.kind !== 'usage' && c.kind !== 'note').length;
  return '<span class="muted">' + esc(num(count)) + ' 行</span>'
    + (live && live.usage ? '<span class="mono muted">词元 ' + esc(num(live.usage.total)) + '</span>' : '');
}

/**
 * 实时输出的外框：勾选框 + 元信息 + 裁剪横幅 + 终端块。
 *
 * 只有首帧整块建；之后 pushLive 逐次只重写 pre / 元信息 / 横幅里面。外框每秒
 * 重建一次，「自动滚动」勾选框和它的焦点就每秒被丢一次，人正要点它时永远点不中。
 */
function liveTextLines(chunks) {
  const lines = [];
  for (const c of chunks || []) {
    if (c && c.kind !== 'usage' && c.kind !== 'note') lines.push(c);
  }
  return lines;
}

function historicalOutputText(live) {
  if (!live) return '';
  const raw = live.historicalOutput;
  if (raw === undefined || raw === null) return '';
  const s = String(raw);
  return s.trim() === '' ? '' : s;
}

export function livePanelHtml(live) {
  const lines = (live && live.lines) || [];
  const hasLive = liveTextLines(lines).length > 0;
  // 有实时行就只画实时：旧跳的 output 不是当前在途输出，塞进终端会让人以为还在跑。
  const historical = hasLive ? '' : historicalOutputText(live);
  const note = historical
    ? '<div class="live-note"><div>' + esc(outputTailTitle()) + '</div></div>'
    : liveNoteHtml(lines);
  const term = historical
    ? esc(historical)
    : liveLinesHtml(lines, !live || live.running !== false);
  return '<div class="live-bar">'
    +   '<label class="auto-scroll"><input type="checkbox" data-autoscroll'
    +     (live && live.autoScroll === false ? '' : ' checked') + ' /> 自动滚动</label>'
    +   '<span class="live-meta" data-live-meta>' + liveMetaHtml(live) + '</span>'
    + '</div>'
    + '<div data-live-note>' + note + '</div>'
    + '<pre class="term" data-term>'
    +   term
    + '</pre>';
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
    s = { cursor: 0, lines: [], usage: null, usageByAttempt: {} };
    liveStates.set(missionId, s);
  }
  return s;
}

let mounted = null;
/** 一次导航一个代号：await 期间可能又切了页，旧请求的落地必须被丢掉。 */
let epoch = 0;

/**
 * 骨架。导出来是为了能拿它对一下 renderTaskPage 取的那些 id（拼错一个就是白屏）。
 *
 * 三个锚点区：页头（含独立用量卡）、左栏环节列表、右栏（上详情 / 下常驻终端）。
 * 实时输出不再有 tab，所以它的外框**始终在**——每切一次环节都不该把它重建掉。
 */
export function skeletonHtml() {
  return '<div class="task mission-process">'
    + '<header class="card task-head" id="task-head"><div class="note">加载中…</div></header>'
    + '<section class="card timeline-panel"><div class="timeline-toolbar"><h2>运行时间线</h2><button data-stage-collapse>收起历史</button><button data-stage-current>定位当前</button></div><div class="stage-list" id="task-stages"></div></section>'
    + '<div class="task-cols"><section class="card current-output"><h2>当前实时输出</h2><div id="task-live"></div></section>'
    + '<section class="task-right"><div class="card task-side-card"><div class="task-panel-tabs"><button class="task-panel-tab active" data-task-panel-tab="detail">环节沟通与用量</button><button class="task-panel-tab" data-task-panel-tab="files">修改的文件</button></div><div data-task-panel="detail" id="task-detail"></div><div data-task-panel="files" hidden id="task-changes"></div></div></section></div><details class="card" id="mission-usage-summary"><summary>任务累计用量</summary><section id="task-usage"></section></details><details class="card"><summary>完整任务契约</summary><pre id="task-contract"></pre></details></div>';
}

/**
 * 面包屑要哪几段。抽成纯函数是因为这一格全凭一个字符串拼错就错，
 * 而合同（项目 / <projectId> / 任务 <missionId>）是能被验收的。
 * 方案跑出来的 Mission 多一段可点的方案运行：只认 origin.clientType==='plan-run'
 * 且 conversationRef 为 `plan-run:<id>`——其它形状一律当普通任务，
 * 猜一段链到不存在的 #/plan-runs/ 比少一段更误导。
 *
 * 末段不带 href：它是当前页。给它一个指回自己的链接，看着就像还能往下点。
 * projectId 为空（后端挂了、读不到 view）时中间那段干脆没有——拿 — 当项目名
 * 链到一个不存在的项目页，比少一段更误导人。
 */
export function crumbParts(projectId, missionId, origin) {
  const parts = [{ text: '项目', href: '#/projects' }];
  if (projectId) {
    parts.push({ text: String(projectId), href: '#/projects/' + encodeURIComponent(projectId) });
  }
  const planRunId = planRunIdFromOrigin(origin);
  if (planRunId) {
    parts.push({
      text: '方案运行',
      href: '#/plan-runs/' + encodeURIComponent(planRunId),
    });
  }
  parts.push({ text: '任务 ' + (missionId ?? ''), here: true });
  return parts;
}

function planRunIdFromOrigin(origin) {
  if (!origin || origin.clientType !== 'plan-run') return '';
  const ref = origin.conversationRef;
  if (typeof ref !== 'string' || !ref.startsWith('plan-run:')) return '';
  const id = ref.slice('plan-run:'.length);
  return id ? id : '';
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
  const nodes = crumbParts(st.view && st.view.projectId, st.missionId, st.view && st.view.origin).map((part) => {
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

/** 选中的那个环节。selectedAttemptId 为 null 表示谁都没选。 */
function selectedGroup(st) {
  if (st.selectedAttemptId === null) return null;
  return groupActivity(st.activity).find((g) => stageKey(g) === st.selectedAttemptId) || null;
}

function paintHead(st) {
  if (!st.view) return;
  // 当前时间是 DOM 层的事；纯函数只收字符串。
  st.els.head.innerHTML = headerHtml(st.view, st.activity, new Date().toISOString());
  const contract = st.container.querySelector('#task-contract');
  if (contract) contract.textContent = JSON.stringify(st.view.contract || {}, null, 2);
}

function paintUsage(st) {
  if (!st.view) return;
  st.els.usage.innerHTML = usageCardHtml(st.view, st.activity);
}

/**
 * 详情与环节共用的上下文。
 *
 * 全取自已经拉到的 MissionView——详情**不许**为某个字段新开接口，
 * 证据是唯一的例外（那里本来就没有）。
 */
function detailCtx(st) {
  const v = st.view || {};
  return {
    intent: v.contract && v.contract.intent,
    plan: v.plan,
    workItems: v.workItems || [],
    result: v.result,
    escalationLog: v.escalationLog || [],
    finalReview: v.finalReview,
    status: v.status,
    nowIso: new Date().toISOString(),
    usageByAttempt: st.live.usageByAttempt,
    // 阶段投影由后端算好随 GET /api/missions/:id 一起下来（v.timeAttribution）。
    // 浏览器只渲染，不在这一层重新归因：两份算法一定会漂，而漂了之后
    // 页面上的耗时与后端记录的就对不上了。
    timeAttribution: v.timeAttribution,
  };
}

/**
 * 用户展开过的环节（attemptId 集合）。
 *
 * 原生 `<details>` 的 open 只活在浏览器里，而环节列表是整块 innerHTML 重画的。
 * 所以重画之前先把 DOM 里的 open 收进来，重画时再按它写回 open——不收的话，
 * 人点开一个环节，浏览器刚展开、节点就被换成一份全收起的新表，
 * 组内逐条事件一次都看不到。
 */
function collectExpanded(st) {
  const ids = new Set();
  for (const node of st.els.stages.querySelectorAll('details.stage')) {
    if (node.open) ids.add(String(node.dataset.attemptId || ''));
  }
  return ids;
}

/**
 * 重画环节列表。
 *
 * `expanded` 明确给定时用它；不给就以 DOM 现状为准（原生 toggle 跑完之后
 * DOM 才是真相）。之所以要能明确给定：点环节头那一刻，浏览器的展开动作**还没**
 * 落到 DOM 上（点击的默认行为在事件派发之后才跑），此刻从 DOM 收会收到
 * 「还没展开」，重画反而把刚点开的那一组折回去。
 */
function paintStages(st, expanded) {
  st.expanded = expanded === undefined ? collectExpanded(st) : expanded;
  const scroll = st.els.stages.scrollLeft;
  st.els.stages.innerHTML = stageListHtml(
    st.activity, st.selectedAttemptId, st.selectedKey, detailCtx(st), st.expanded,
  );
  st.els.stages.scrollLeft = scroll;
  const groups = groupActivity(st.activity);
  for (const node of st.els.stages.querySelectorAll('.stage')) {
    const group = groups.find(g => stageKey(g) === node.dataset.attemptId);
    node.hidden = Boolean(st.hideHistory && group?.events.some(e => e.kind === 'attempt.ended') && node.dataset.attemptId !== st.selectedAttemptId);
  }
}

/** 只更新在途数字，不重建时间线，保留用户展开与横向位置。 */
function refreshStageSignals(st) {
  const ctx = detailCtx(st);
  for (const group of groupActivity(st.activity)) {
    if (!group.attemptId || group.events.some(e => e.kind === 'attempt.ended')) continue;
    const node = [...st.els.stages.querySelectorAll('.stage')].find(n => n.dataset.attemptId === stageKey(group));
    if (!node) continue;
    const duration = node.querySelector('.stage-dur');
    const usage = node.querySelector('.stage-usage');
    if (duration && !isTerminal(ctx.status)) duration.textContent = formatDuration(firstAt(group.events), ctx.nowIso);
    if (usage) usage.textContent = stageUsageLine(group.events, group, ctx);
  }
}

function paintDetail(st) {
  const group = selectedGroup(st);
  const provisional = st.live.usageByAttempt?.[st.selectedAttemptId];
  const ended = group?.events.some(event => event.kind === 'attempt.ended');
  const attempt = !ended && provisional ? { ...st.attempt, usage: provisional } : st.attempt;
  st.els.detail.innerHTML = stageDetailHtml(group, detailCtx(st), attempt)
    + (!ended && provisional ? '<div class="note">已上报暂计用量</div>' : '');
}

function paintChanges(st) {
  if (!st.els.changes) return;
  st.els.changes.innerHTML = changesCardHtml(st.changes);
}

/**
 * 任务改动单独拉：不能跟 view/activity 绑在同一条 Promise.all 里——
 * diff 失败不该把已经画出来的页头刷成「读不到这条任务」。
 */
function pullMissionChanges(st) {
  if (st.changesInflight) return st.changesInflight;
  const started = st.epoch;
  st.changesInflight = get(
    '/api/missions/' + encodeURIComponent(st.missionId) + '/diff',
  ).then((body) => {
    if (st.epoch !== started || !writable(st)) return;
    st.changes = body && typeof body === 'object' ? body : { files: [], stat: '', pendingMemory: [] };
    paintChanges(st);
  }).catch((err) => {
    if (st.epoch !== started || !writable(st)) return;
    st.changes = { error: err && err.message ? String(err.message) : '' };
    paintChanges(st);
  }).finally(() => {
    if (st.epoch === started) st.changesInflight = null;
  });
  return st.changesInflight;
}

function attemptOutputText(attempt) {
  if (!attempt) return '';
  const raw = attempt.output;
  if (raw === undefined || raw === null) return '';
  const s = String(raw);
  return s.trim() === '' ? '' : s;
}

/**
 * 这一跳还能不能开跑。终态（结束/中止）、等待停机、暂停都不再会来新输出，
 * 所以终端空着的时候该说「这里没留下输出」，而不是「还没开始」。
 */
function stillRunning(st) {
  const v = st.view;
  if (!v) return true;
  return !(isTerminal(v.status) || v.paused || v.waitReason || v.waitDetail);
}

/** 首帧建外框。之后每秒只重写里面（见 pushLive）。 */
function paintLive(st) {
  st.els.live.innerHTML = livePanelHtml(
    Object.assign({
      autoScroll: st.autoScroll,
      running: stillRunning(st),
      historicalOutput: '',
    }, st.live),
  );
  const term = st.els.live.querySelector('[data-term]');
  if (term) term.scrollTop = term.scrollHeight - term.clientHeight;
}

/**
 * 追新行。只重写终端、那一行元信息、以及裁剪横幅里面，不重建外框。
 *
 * 判据必须在写入**之前**量：追加会先抬高 scrollHeight，写完再量会把
 * 「刚才还贴底」误判成「离底很远」。外框也不重建：那会每秒把
 * 「自动滚动」勾选框与它的焦点丢一次，人正要点它时永远点不中。
 */
function pushLive(st) {
  const term = st.els.live.querySelector('[data-term]');
  if (!term) return; // 首帧还没建好：行已经攒在 st.live 里，建的时候一次画全。
  const follow = shouldFollow({
    autoScroll: st.autoScroll,
    scrollTop: term.scrollTop,
    clientHeight: term.clientHeight,
    scrollHeight: term.scrollHeight,
  });
  term.innerHTML = liveLinesHtml(st.live.lines, stillRunning(st));
  const meta = st.els.live.querySelector('[data-live-meta]');
  if (meta) meta.innerHTML = liveMetaHtml(st.live);
  const banner = st.els.live.querySelector('[data-live-note]');
  if (banner) banner.innerHTML = liveNoteHtml(st.live.lines);
  if (follow) term.scrollTop = term.scrollHeight - term.clientHeight;
}

/**
 * 取选中环节那一次的证据。
 *
 * 钥匙是**环节自己的 attemptId**，不是事件的 causationId：详情页讲的是「这一跳
 * 传递了什么」，而证据挂在执行者自己那一跳上。
 *
 * 没有 attemptId（L3 那一组）就不发这个请求：拿 undefined 去拼 URL 会打到
 * /attempts/undefined，返回的是 UNKNOWN_ATTEMPT 错误——一次没必要的 500。
 * 也不在进页时把每个 attempt 挨个拉一遍（N+1）。
 */
async function loadAttempt(st, attemptId) {
  st.attempt = null;
  if (!attemptId) {
    if (st.epoch === epoch) paintDetail(st);
    return;
  }
  let detail = null;
  try {
    detail = await get(
      '/api/missions/' + encodeURIComponent(st.missionId)
        + '/attempts/' + encodeURIComponent(attemptId),
    );
  } catch (err) {
    detail = { error: err.message };
  }
  // await 期间人可能又点了别的环节，或者整页都换了一条 Mission。
  if (st.epoch !== epoch || st.selectedAttemptId !== attemptId) return;
  st.attempt = detail && detail.error ? null : detail;
  paintDetail(st);
  // 实时还在滚就别重建终端外框（勾选框焦点会丢）；只有空着时才用这一跳的脱敏尾部填。
  if (liveTextLines(st.live && st.live.lines).length === 0) paintLive(st);
}

function isPageVisible() {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

function missionStatus(st) {
  return (st.view && st.view.status) || '';
}

/**
 * 这次响应还能不能写屏幕。
 *
 * 隐藏标签页、已经离页、换了一条任务：写下去就是把过期结果盖到别人的
 * 展开/选中上。hidden 期间尤其不能把终态写进内存——下一次可见会拿
 * 这份过期终态去问 nextRefresh，永远不再核对。
 */
function writable(st) {
  return st.epoch === epoch
    && st.els.head
    && st.els.head.isConnected
    && isPageVisible();
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function clearTimers(st) {
  if (st.viewTimer) clearInterval(st.viewTimer);
  if (st.liveTimer) clearInterval(st.liveTimer);
  st.viewTimer = null;
  st.liveTimer = null;
}

function armTimers(st, plan) {
  clearTimers(st);
  if (!st.els.head || !st.els.head.isConnected) return;
  if (plan.intervalMs) {
    st.viewTimer = setInterval(() => {
      if (!st.els.head || !st.els.head.isConnected) {
        stop(st);
        return;
      }
      void pullView(st);
    }, plan.intervalMs);
  }
  // 还没读到 view 时不算在途：首屏终态成功之前就拉 live，已结束的任务
  // 会永远每秒打一次实时输出。
  if (plan.liveIntervalMs && st.view) {
    st.liveTimer = setInterval(() => {
      if (!st.els.head || !st.els.head.isConnected) {
        stop(st);
        return;
      }
      void pollLive(st);
    }, plan.liveIntervalMs);
  }
}

function syncRefresh(st) {
  if (!writable(st)) return;
  armTimers(st, nextRefresh('mission', missionStatus(st), true));
}

function handleVisibility(st) {
  if (st !== mounted || st.epoch !== epoch) return;
  if (!st.els.head || !st.els.head.isConnected) {
    stop(st);
    return;
  }
  const visible = document.visibilityState !== 'hidden';
  if (!visible) {
    clearTimers(st);
    return;
  }
  const plan = nextRefresh('mission', missionStatus(st), true);
  // missedApply：隐藏期间有响应没落盘。就算内存里已经像终态，也先核对
  // view/activity，否则会按过期终态停死、永远不再刷。
  if (st.missedApply || plan.paths.includes('view') || plan.paths.includes('activity')) {
    st.missedApply = false;
    void pullView(st);
  }
  // 还没有 view 时 status 是空串，nextRefresh 会含 live；真去拉会把
  // 「首屏终态不打 live」打穿。有 view 且仍在途才立刻补一刀。
  if (st.view && plan.paths.includes('live')) void pollLive(st);
  armTimers(st, plan);
}

/** 一轮游标拉取。只取 cursor 之后的，不从头。 */
async function pollLive(st) {
  if (st.polling) return;
  if (!isPageVisible()) return;
  if (st.epoch !== epoch) return;
  st.polling = true;
  try {
    const body = await get(
      '/api/missions/' + encodeURIComponent(st.missionId)
        + '/live?cursor=' + st.live.cursor,
    );
    if (!writable(st)) {
      st.missedApply = true;
      return;
    }
    const chunks = (body && body.chunks) || [];
    for (const c of chunks) {
      if (c && c.kind === 'usage') {
        st.live.usage = c.usage || st.live.usage;
        if (c.attemptId && c.usage) st.live.usageByAttempt[c.attemptId] = c.usage;
        continue;
      }
      st.live.lines.push({ at: c && c.at, kind: (c && c.kind) || 'text', text: (c && c.text) || '' });
    }
    if (st.live.lines.length > MAX_LINES) {
      st.live.lines.splice(0, st.live.lines.length - MAX_LINES);
    }
    const cursor = Number(body && body.cursor);
    if (Number.isFinite(cursor)) st.live.cursor = cursor;
    // 常驻终端：不再判 tab，有新行就写。
    if (chunks.length) { pushLive(st); paintDetail(st); refreshStageSignals(st); }
  } catch {
    // 轮询失败不动界面：下一次心跳自然会补上。把它写成一条错误行，
    // 会让"后端重启了一次"看起来像任务挂了。
  } finally {
    st.polling = false;
  }
}

/** 在途可见才拉 view+activity。失败且已经有旧数据时不把页面刷成白板。 */
function pullView(st) {
  if (!isPageVisible()) return st.viewInflight;
  if (st.viewInflight) return st.viewInflight;
  const started = st.epoch;
  const first = !st.view;
  const enc = encodeURIComponent(st.missionId);
  st.viewInflight = Promise.all([
    get('/api/missions/' + enc),
    get('/api/missions/' + enc + '/activity'),
  ]).then(([view, activity]) => {
    if (st.epoch !== started) return;
    if (!writable(st)) {
      st.missedApply = true;
      return;
    }
    const rows = Array.isArray(activity) ? activity : [];
    const unchanged = !first && sameJson(st.view, view) && sameJson(st.activity, rows);
    st.view = view;
    st.activity = rows;
    if (first && !groupActivity(rows).some(g => stageKey(g) === st.selectedAttemptId)) {
      const groups = groupActivity(rows);
      const latest = groups.filter(g => g.attemptId && !g.events.some(e => e.kind === 'attempt.ended')).at(-1) || groups.at(-1);
      if (latest) st.selectedAttemptId = stageKey(latest);
    }
    if (first) {
      setCrumbs(st);
      paintHead(st);
      paintUsage(st);
      paintStages(st);
      paintDetail(st);
      if (st.selectedAttemptId) void loadAttempt(st, st.selectedAttemptId);
      paintLive(st);
      paintChanges(st);
      void pullMissionChanges(st);
      // 首屏成功且已终态：nextRefresh 不含 live，这里就不会拉。
      if (nextRefresh('mission', missionStatus(st), true).paths.includes('live')) {
        void pollLive(st);
      }
    } else if (!unchanged) {
      const expanded = collectExpanded(st);
      setCrumbs(st);
      paintHead(st);
      paintUsage(st);
      paintStages(st, expanded);
      paintDetail(st);
      void pullMissionChanges(st);
    }
    if (unchanged) refreshStageSignals(st);
    syncRefresh(st);
  }).catch((err) => {
    if (st.epoch !== started) return;
    if (!writable(st)) {
      st.missedApply = true;
      return;
    }
    if (!st.view) {
      // 一次都没读到就写「还没有任务」是撒谎：那是读不到，不是没有。
      st.els.head.innerHTML = '<div class="note">读不到这条任务：' + esc(err.message) + '</div>';
      st.els.stages.innerHTML = '<div class="empty">刷新一下重试</div>';
      setCrumbs(st);
    }
    syncRefresh(st);
  }).finally(() => {
    if (st.epoch === started) st.viewInflight = null;
  });
  return st.viewInflight;
}

function selectStage(st, attemptId, expanded, updateRoute = true) {
  st.selectedAttemptId = attemptId;
  st.selectedKey = null;
  if (updateRoute && typeof location !== 'undefined') location.hash = '#/missions/' + encodeURIComponent(st.missionId) + '?step=' + encodeURIComponent(attemptId);
  paintStages(st, expanded);
  void loadAttempt(st, attemptId);
}

function bind(st) {
  st.container.addEventListener('click', event => {
    if (event.target.closest('[data-stage-collapse]')) {
      st.hideHistory = !st.hideHistory;
      event.target.textContent = st.hideHistory ? '展开历史' : '收起历史';
      paintStages(st, new Set()); return;
    }
    if (event.target.closest('[data-stage-current]')) {
      const groups = groupActivity(st.activity);
      const current = groups.filter(g => g.attemptId && !g.events.some(e => e.kind === 'attempt.ended')).at(-1) || groups.at(-1);
      if (current) {
        selectStage(st, stageKey(current), st.expanded);
        [...st.els.stages.querySelectorAll('.stage')].find(node => node.dataset.attemptId === stageKey(current))?.scrollIntoView({ block: 'nearest', inline: 'center' });
      }
    }
  });
  const side = st.container.querySelector('.task-side-card');
  if (side) {
    side.addEventListener('click', (ev) => {
      const tab = ev.target && ev.target.closest && ev.target.closest('[data-task-panel-tab]');
      if (!tab) return;
      const key = tab.dataset.taskPanelTab;
      for (const btn of side.querySelectorAll('[data-task-panel-tab]')) btn.classList.toggle('active', btn === tab);
      for (const panel of side.querySelectorAll('[data-task-panel]')) panel.hidden = panel.dataset.taskPanel !== key;
    });
  }

  st.els.head.addEventListener('click', async (ev) => {
    const cancel = ev.target && ev.target.closest && ev.target.closest('[data-task-cancel]');
    if (!cancel) return;
    if (!window.confirm('确认取消这条任务？')) return;
    cancel.disabled = true;
    try {
      const res = await fetch('/api/missions/' + encodeURIComponent(st.missionId) + '/cancel', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: '用户从 Web 界面取消' }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.message || ('HTTP ' + res.status));
      await pullView(st);
    } catch (err) {
      window.alert('取消失败：' + (err && err.message ? err.message : String(err)));
      cancel.disabled = false;
    }
  });

  // 监听挂在常驻容器上：环节列表每次选中都整块重写 innerHTML，
  // 绑在里面某个元素上的话，重画一次就丢一次监听（然后页面"点了没反应"）。
  st.els.stages.addEventListener('click', (ev) => {
    const row = ev.target && ev.target.closest && ev.target.closest('[data-event-key]');
    if (row) {
      // 点组内一条事件：选中它，详情仍按**所属环节**的角色正文来，
      // 证据也仍取该环节的 attemptId。
      const stage = row.closest('.stage');
      st.selectedKey = Number(row.dataset.eventKey);
      st.selectedAttemptId = stage ? String(stage.dataset.attemptId || '') : st.selectedAttemptId;
      // 这一步之前没人动过 DOM 的 open，以 DOM 为准重画：当前组与其它已经展开的
      // 组都还在展开集里，点一条事件不会把它们折回去。
      paintStages(st);
      void loadAttempt(st, st.selectedAttemptId);
      return;
    }
    const head = ev.target && ev.target.closest && ev.target.closest('[data-stage-select]');
    if (!head) return;
    const stage = head.closest('.stage');
    if (!stage) return;
    // 点环节头：<details> 仍由浏览器原生展开/折起（不 preventDefault）。但上面
    // 那句「点击的默认行为还没落到 DOM」在这里生效——不能读 DOM 的 open，
    // 要按现有展开集反转出点击后该是什么状态，交给重画写回 open。
    const id = String(stage.dataset.attemptId || '');
    const expanded = collectExpanded(st);
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    selectStage(st, id, expanded);
  });

  st.els.live.addEventListener('change', (ev) => {
    const box = ev.target && ev.target.closest && ev.target.closest('[data-autoscroll]');
    if (!box) return;
    st.autoScroll = box.checked;
  });
}

function stop(st) {
  clearTimers(st);
  if (st.onVisibility) {
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', st.onVisibility);
    }
    st.onVisibility = null;
  }
}

/**
 * 挂载任务页。
 *
 * 同一个容器、同一条 Mission、节点还挂在树上 —— 不重建。重建会把轮询定时器
 * 清掉重开（一次点两下就是两心跳），而实时输出的行是攒在页面里的，清掉就丢。
 */
export async function renderTaskPage(container, missionId, selectedStep = null) {
  const same = mounted
    && mounted.container === container
    && mounted.missionId === missionId
    && mounted.els.head
    && mounted.els.head.isConnected;
  if (same) {
    setCrumbs(mounted);
    const groups = groupActivity(mounted.activity);
    const key = selectedStep !== null && groups.some(g => stageKey(g) === selectedStep) ? selectedStep
      : stageKey(groups.filter(g => g.attemptId && !g.events.some(e => e.kind === 'attempt.ended')).at(-1) || groups.at(-1) || { role: 'platform' });
    if (key !== mounted.selectedAttemptId) selectStage(mounted, key, mounted.expanded, false);
    return;
  }

  if (mounted) stop(mounted);
  epoch += 1;

  container.innerHTML = skeletonHtml();
  const st = {
    container,
    missionId,
    epoch,
    els: {
      usage: container.querySelector('#task-usage'),
      head: container.querySelector('#task-head'),
      stages: container.querySelector('#task-stages'),
      detail: container.querySelector('#task-detail'),
      live: container.querySelector('#task-live'),
      changes: container.querySelector('#task-changes'),
    },
    view: null,
    activity: [],
    changes: null,
    changesInflight: null,
    // 环节与事件的选中态分两个键：环节决定详情取哪一份正文、去不去拉证据；
    // 事件只决定事件流里哪一行高亮。
    selectedAttemptId: selectedStep,
    selectedKey: null,
    // 用户展开过的环节。首屏是空的：默认全部收起。
    expanded: new Set(),
    attempt: null,
    hideHistory: false,
    autoScroll: true,
    live: liveStateOf(missionId),
    polling: false,
    viewInflight: null,
    missedApply: false,
    viewTimer: null,
    liveTimer: null,
    onVisibility: null,
  };
  mounted = st;
  bind(st);
  if (typeof document !== 'undefined') {
    st.onVisibility = () => handleVisibility(st);
    document.addEventListener('visibilitychange', st.onVisibility);
  }
  await pullView(st);
}

export function usageFieldsHtml(usage) {
  const fields = [['input', '输入'], ['output', '输出'], ['cacheRead', '缓存读取'], ['cacheWrite', '缓存写入'], ['total', '总词元'], ['cost', '费用']];
  if (usage?.quality === 'unknown') usage = null;
  return '<dl class="step-usage-grid">' + fields.map(([key, label]) => {
    const value = usage?.[key];
    const text = typeof value === 'number' && Number.isFinite(value) ? (key === 'cost' ? '$' + value.toFixed(4) : num(value)) : '未知';
    return '<div><dt>' + label + '</dt><dd class="mono">' + esc(text) + '</dd></div>';
  }).join('') + '</dl>';
}
