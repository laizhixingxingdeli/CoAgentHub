/**
 * 观测面。零依赖、无构建：一个字符串常量，由 server.ts 直接吐出去。
 *
 * 视觉沿用 v4 前端的设计语言——**色彩令牌是从 v4 的 index.css 逐字搬过来的
 * oklch 值**，不是"看着差不多调一个"。浏览器原生支持 oklch，所以照搬不需要
 * 任何构建步骤，而同一套令牌意味着两代产品是同一个东西的两个版本，
 * 不是两个碰巧都叫 CoAgentHub 的界面。
 *
 * 三栏：Mission 列表 | 详情与时间线 | 实时输出。
 *
 * 只读。放行/打回走 src/l3.ts —— 规则只该有一份实现，界面再加一份迟早分叉。
 */

export const WEB_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>CoAgentHub v5</title>
<style>
/* ===== 色彩令牌：与 v4 packages/frontend/web/src/index.css 同源 ===== */
:root {
  --radius: 0.75rem;
  --background: oklch(0.991 0.001 106.423);
  --foreground: oklch(0.257 0.017 248.477);
  --card: oklch(1 0 0);
  --muted: oklch(0.972 0.002 197.122);
  --muted-foreground: oklch(0.577 0.027 250.248);
  --accent: oklch(0.596 0.1 208.085);
  --accent-foreground: oklch(0.983 0.007 197.036);
  --accent-faint: oklch(0.96 0.015 202.053);
  --destructive: oklch(0.577 0.245 27.325);
  --border: oklch(0.929 0.005 228.822);

  --status-queued: oklch(0.659 0.029 246.525);
  --status-running: oklch(0.596 0.1 208.085);
  --status-done: oklch(0.579 0.101 159.037);
  --status-failed: oklch(0.602 0.168 31.205);
  --status-cancelled: oklch(0.654 0.009 84.583);
  --status-unconfirmed: oklch(0.651 0.137 64.456);

  --role-coordinator: oklch(0.491 0.128 258.661);
  --role-reviewer: oklch(0.513 0.134 305.845);
  --role-executor: oklch(0.45 0.026 250.209);

  /* 终端块在明暗两个主题下都是深色的——它模拟的是终端，不是页面。 */
  --terminal-bg: oklch(0.201 0.011 242.328);
  --terminal-fg: oklch(0.956 0.005 228.819);
  --terminal-dim: oklch(0.667 0.023 248.166);
}
:root[data-theme="dark"] {
  --background: oklch(0.201 0.011 242.328);
  --foreground: oklch(0.956 0.005 228.819);
  --card: oklch(0.235 0.013 243.456);
  --muted: oklch(0.264 0.015 244.246);
  --muted-foreground: oklch(0.667 0.023 248.166);
  --accent: oklch(0.75 0.112 205.427);
  --accent-foreground: oklch(0.208 0.016 210.057);
  --accent-faint: oklch(0.266 0.034 207.899);
  --destructive: oklch(0.704 0.191 22.216);
  --border: oklch(0.309 0.02 248.49);

  --status-queued: oklch(0.667 0.023 248.166);
  --status-running: oklch(0.75 0.112 205.427);
  --status-done: oklch(0.704 0.113 158.311);
  --status-failed: oklch(0.683 0.153 31.1);
  --status-cancelled: oklch(0.674 0.011 81.789);
  --status-unconfirmed: oklch(0.75 0.131 73.684);

  --role-coordinator: oklch(0.631 0.119 258.408);
  --role-reviewer: oklch(0.65 0.12 305.732);
  --role-executor: oklch(0.631 0.026 250.209);

  --terminal-bg: oklch(0.17 0.01 242.328);
}

* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  background: var(--background);
  color: var(--foreground);
  font: 14px/1.55 "Segoe UI", -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
}
.mono {
  font-family: ui-monospace, "Cascadia Mono", Consolas, "Courier New", monospace;
  font-size: 12px;
}
.muted { color: var(--muted-foreground); }

/* ===== 顶栏 ===== */
header {
  display: flex; align-items: center; gap: 12px;
  padding: 0 16px; height: 48px;
  border-bottom: 1px solid var(--border);
  background: var(--card);
  position: sticky; top: 0; z-index: 10;
}
header .brand { font-weight: 600; letter-spacing: .2px; }
header .grow { flex: 1; }
.pill {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 2px 10px; border-radius: 999px;
  border: 1px solid var(--border); background: var(--muted);
  font-size: 12px; color: var(--muted-foreground);
}
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--status-done); }
.dot.stale { background: var(--status-failed); }
button.ghost {
  border: 1px solid var(--border); background: var(--card); color: var(--foreground);
  border-radius: calc(var(--radius) - 4px); padding: 4px 10px; cursor: pointer; font-size: 12px;
}
button.ghost:hover { background: var(--muted); }

/* ===== 三栏 ===== */
.shell {
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr) minmax(0, 460px);
  height: calc(100vh - 48px);
}
.col { overflow: auto; padding: 12px; }
.col + .col { border-left: 1px solid var(--border); }
@media (max-width: 1200px) {
  .shell { grid-template-columns: 260px minmax(0, 1fr); }
  .col.live { display: none; }
}

/* ===== 卡片 ===== */
.card {
  background: var(--card); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 12px; margin-bottom: 10px;
}
.card h3 { margin: 0 0 8px; font-size: 13px; font-weight: 600; }
.section-title {
  font-size: 11px; font-weight: 600; letter-spacing: .6px; text-transform: uppercase;
  color: var(--muted-foreground); margin: 14px 0 6px;
}

/* ===== Mission 列表项 ===== */
.mission {
  border: 1px solid var(--border); border-radius: var(--radius);
  padding: 10px; margin-bottom: 8px; cursor: pointer; background: var(--card);
}
.mission:hover { border-color: var(--accent); }
.mission[data-active="1"] {
  border-color: var(--accent); background: var(--accent-faint);
}
.mission .title { font-weight: 600; font-size: 13px; }
.mission .intent {
  color: var(--muted-foreground); font-size: 12px; margin-top: 4px;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.row { display: flex; align-items: center; gap: 8px; }
.row.wrap { flex-wrap: wrap; }
.grow { flex: 1; min-width: 0; }

/* ===== 状态徽章：颜色语义与 v4 一致 ===== */
.badge {
  display: inline-block; padding: 1px 8px; border-radius: 999px;
  font-size: 11px; font-weight: 600; border: 1px solid transparent;
  color: var(--status-queued);
  background: color-mix(in oklch, var(--status-queued) 14%, transparent);
  border-color: color-mix(in oklch, var(--status-queued) 35%, transparent);
}
.badge.investigating, .badge.planning { --s: var(--status-queued); }
.badge.executing, .badge.dispatched, .badge.in_progress { --s: var(--status-running); }
.badge.awaiting_review, .badge.submitted { --s: var(--status-unconfirmed); }
.badge.completed, .badge.accepted, .badge.succeeded { --s: var(--status-done); }
.badge.blocked, .badge.rejected, .badge.failed { --s: var(--status-failed); }
.badge.created, .badge.cancelled { --s: var(--status-cancelled); }
.badge[class*=" "] , .badge {
  color: var(--s, var(--status-queued));
  background: color-mix(in oklch, var(--s, var(--status-queued)) 14%, transparent);
  border-color: color-mix(in oklch, var(--s, var(--status-queued)) 35%, transparent);
}
.role {
  font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 4px;
  color: var(--role-executor);
  background: color-mix(in oklch, var(--role-executor) 13%, transparent);
}
.role.coordinator {
  color: var(--role-coordinator);
  background: color-mix(in oklch, var(--role-coordinator) 13%, transparent);
}
.role.reviewer {
  color: var(--role-reviewer);
  background: color-mix(in oklch, var(--role-reviewer) 13%, transparent);
}

/* ===== 停机原因 ===== */
.waiting {
  border-left: 3px solid var(--status-unconfirmed);
  background: color-mix(in oklch, var(--status-unconfirmed) 9%, transparent);
  padding: 8px 10px; border-radius: 0 6px 6px 0; margin-top: 8px; font-size: 13px;
}
.waiting .detail { color: var(--muted-foreground); margin-top: 4px; }

/* ===== Token 用量 ===== */
.usage { display: flex; gap: 8px; flex-wrap: wrap; }
.metric {
  flex: 1 1 88px; border: 1px solid var(--border); border-radius: 8px;
  padding: 8px 10px; background: var(--background);
}
.metric .k {
  font-size: 10px; letter-spacing: .5px; text-transform: uppercase;
  color: var(--muted-foreground);
}
.metric .v { font-size: 17px; font-weight: 600; font-variant-numeric: tabular-nums; }
.metric.cost .v { color: var(--accent); }
.bar { display: flex; height: 6px; border-radius: 3px; overflow: hidden; margin-top: 8px; background: var(--muted); }
.bar i { display: block; height: 100%; }

/* ===== 终端块：明暗主题下都是深色 ===== */
pre.term {
  margin: 0; background: var(--terminal-bg); color: var(--terminal-fg);
  border-radius: 8px; padding: 10px 12px;
  font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
  font-size: 12px; line-height: 1.5;
  white-space: pre-wrap; word-break: break-word;
  max-height: 100%; overflow: auto;
}
pre.term .t { color: var(--terminal-dim); }
pre.term .tool { color: oklch(0.75 0.112 205.427); font-weight: 600; }
.live-wrap { display: flex; flex-direction: column; height: 100%; }
.live-wrap pre.term { flex: 1; min-height: 240px; }

.chip {
  display: inline-block; padding: 1px 7px; margin: 0 3px 3px 0;
  border: 1px solid var(--border); border-radius: 4px;
  background: var(--background); font-size: 11px;
}
.chip.coagent { border-color: var(--accent); color: var(--accent); }

ul.plain { list-style: none; margin: 0; padding: 0; }
ul.plain li { padding: 4px 0; border-bottom: 1px dashed var(--border); }
ul.plain li:last-child { border-bottom: 0; }
.tl { display: grid; grid-template-columns: 74px 1fr; gap: 6px 10px; font-size: 12px; }
.tl .when { color: var(--muted-foreground); font-variant-numeric: tabular-nums; }
.clickable { cursor: pointer; }
.clickable:hover { color: var(--accent); }
.empty { color: var(--muted-foreground); text-align: center; padding: 40px 12px; }
</style>
</head>
<body>
<header>
  <span class="brand">CoAgentHub <span class="muted">v5</span></span>
  <span class="pill" id="conn"><i class="dot"></i><span id="conn-text">连接中…</span></span>
  <span class="grow"></span>
  <span class="pill mono" id="api"></span>
  <button class="ghost" id="theme">主题</button>
</header>

<div class="shell">
  <div class="col" id="list"></div>
  <div class="col" id="detail"><div class="empty">左边选一条 Mission</div></div>
  <div class="col live" id="live"></div>
</div>

<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
/* 一律转本地时间。后端存的是 UTC，直接切字符串会让时间线和实时输出差
   几个小时——而人恰恰是拿这两处的时间去对"它卡在哪一步、卡了多久"。 */
const time = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' '
    + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
};
const num = (n) => (n ?? 0).toLocaleString('en-US');

/* 主题跟随系统，人工切换后记住选择。 */
const savedTheme = localStorage.getItem('coagent-theme');
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
document.documentElement.dataset.theme = savedTheme || (prefersDark ? 'dark' : 'light');
$('theme').onclick = () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('coagent-theme', next);
};

/** 停机原因翻译成人话。光显示一个 enum 名字等于没显示。 */
const WAIT_REASON = {
  no_available_agent: '候选全在冷却，等一会儿重跑',
  platform_unreachable: '连不上平台自己 —— 平台侧故障，不是候选的问题',
  waiting_l3: '等你处理',
  escalated: '执行者升级了问题，等你答复',
  project_busy: '同项目有别的 Mission 占着改动名额',
  attempt_limit_reached: '尝试到上限了 —— 继续换候选不会产生新信息',
  target_changed: '目标分支在检视期间变了',
  base_revision_stale: '分叉基线已过期，需要重新核对',
  cancelled_by_user: '被叫停了',
  runaway_suspected: '一跳跑太久，已停下来等人看',
  execution_budget_exceeded: '执行预算硬上限已耗尽',
  mission_cost_cap_reached: '票级费用已到上限，等检视者批准追加预算',
  work_item_checkpoint: '工作项已到检查点，等检视者判断是否拆票',
};

const STATUS_CN = {
  investigating: '调查中', planning: '规划中', executing: '执行中',
  awaiting_review: '等你检视', completed: '已完成', blocked: '已中止',
  created: '待派发', dispatched: '执行中', submitted: '待验收',
  accepted: '已验收', rejected: '被打回',
};

const badge = (s) => '<span class="badge ' + esc(s) + '">' + esc(STATUS_CN[s] || s) + '</span>';

/* ===================== 状态 ===================== */
let selected = null;
let listSig = '';
let detailSig = '';
/** 实时输出游标：只取上次之后的。刷新页面也能从头拉。 */
let liveCursor = 0;
let liveLines = [];
let liveMission = null;
let liveUsage = null;
let failures = 0;

async function get(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(path + ' → HTTP ' + res.status);
  return res.json();
}

/* ===================== 列表 ===================== */
function renderList(rows) {
  if (rows.length === 0) {
    $('list').innerHTML = '<div class="empty">还没有 Mission</div>';
    return;
  }
  const byProject = new Map();
  for (const m of rows) {
    if (!byProject.has(m.projectId)) byProject.set(m.projectId, []);
    byProject.get(m.projectId).push(m);
  }
  let html = '';
  for (const [projectId, missions] of byProject) {
    html += '<div class="section-title">' + esc(projectId) + '</div>';
    for (const m of missions) {
      html += '<div class="mission" data-id="' + esc(m.missionId) + '"'
        + ' data-active="' + (m.missionId === selected ? '1' : '0') + '">'
        + '<div class="row"><span class="title grow">' + esc(m.missionId) + '</span>' + badge(m.status) + '</div>'
        + '<div class="intent">' + esc(m.intent || '（没有契约）') + '</div>'
        + '<div class="row wrap muted mono" style="margin-top:6px">'
        +   '<span>' + m.accepted + '/' + m.workItems + ' 工作项</span>'
        +   (m.isMutating ? '<span>· 占用改动名额</span>' : '')
        +   (m.paused ? '<span>· 已暂停</span>' : '')
        +   (m.openEscalations ? '<span style="color:var(--status-unconfirmed)">· 待答复 ' + m.openEscalations + '</span>' : '')
        +   (m.usage && m.usage.cost ? '<span>· $' + m.usage.cost.toFixed(2) + '</span>' : '')
        + '</div>'
        + (m.waitReason
            ? '<div class="waiting">⏸ ' + esc(WAIT_REASON[m.waitReason] || m.waitReason) + '</div>'
            : '')
        + '</div>';
    }
  }
  $('list').innerHTML = html;
  for (const el of document.querySelectorAll('.mission')) {
    el.onclick = () => {
      if (selected === el.dataset.id) return;
      selected = el.dataset.id;
      detailSig = ''; listSig = '';
      // 换 Mission 就换实时流：不清的话上一条的输出会接在下一条后面。
      liveCursor = 0; liveLines = []; liveUsage = null; liveMission = selected;
      tick();
    };
  }
}

/* ===================== 用量 ===================== */
function usageCard(usage, live) {
  if (!usage) return '';
  const u = usage;
  const inPart = u.input || 0, outPart = u.output || 0, cached = u.cacheRead || 0;
  const total = Math.max(1, inPart + outPart + cached);
  const pct = (n) => (n / total * 100).toFixed(1) + '%';
  return '<div class="card">'
    + '<h3>Token 用量 <span class="muted" style="font-weight:400">'
    +   (u.quality === 'reported' ? '全部由运行时上报' : u.quality === 'estimated' ? '部分为估算' : '未知')
    +   (live ? ' · 实时' : '') + '</span></h3>'
    + '<div class="usage">'
    +   '<div class="metric"><div class="k">输入</div><div class="v">' + num(inPart) + '</div></div>'
    +   '<div class="metric"><div class="k">输出</div><div class="v">' + num(outPart) + '</div></div>'
    +   '<div class="metric"><div class="k">缓存命中</div><div class="v">' + num(cached) + '</div></div>'
    +   '<div class="metric"><div class="k">合计</div><div class="v">' + num(u.total) + '</div></div>'
    +   (u.cost !== undefined
          ? '<div class="metric cost"><div class="k">花费</div><div class="v">$' + Number(u.cost).toFixed(4) + '</div></div>'
          : '')
    + '</div>'
    // 一眼看出钱花在哪：缓存命中占比高说明续跑在省钱，输出占比高说明它在真写东西。
    + '<div class="bar">'
    +   '<i style="width:' + pct(inPart) + ';background:var(--status-queued)"></i>'
    +   '<i style="width:' + pct(outPart) + ';background:var(--accent)"></i>'
    +   '<i style="width:' + pct(cached) + ';background:var(--status-done)"></i>'
    + '</div>'
    + '<div class="row wrap muted mono" style="margin-top:6px;gap:12px">'
    +   '<span>输入 ' + pct(inPart) + '</span><span>输出 ' + pct(outPart) + '</span><span>缓存 ' + pct(cached) + '</span>'
    + '</div>'
    + '</div>';
}

/* ===================== 详情 ===================== */
function renderDetail(view, events, usageReport) {
  const p = [];
  p.push('<div class="row" style="margin-bottom:10px">'
    + '<h2 class="grow" style="margin:0;font-size:18px">' + esc(view.missionId) + '</h2>'
    + badge(view.status) + (view.paused ? ' <span class="badge cancelled">已暂停</span>' : '') + '</div>');

  if (view.waitReason) {
    p.push('<div class="waiting" style="margin-bottom:10px">⏸ '
      + esc(WAIT_REASON[view.waitReason] || view.waitReason)
      + (view.waitDetail ? '<div class="detail mono">' + esc(view.waitDetail) + '</div>' : '')
      + '</div>');
  }

  if (view.contract) {
    p.push('<div class="card"><h3>契约 <span class="muted">r' + view.contractRevision + '</span></h3>'
      + '<div>' + esc(view.contract.intent) + '</div>'
      + (view.contract.acceptance?.length
          ? '<div class="section-title">验收标准</div><ul class="plain">'
            + view.contract.acceptance.map((a) => '<li>' + esc(a) + '</li>').join('') + '</ul>'
          : '')
      + (view.contract.guardrails?.length
          ? '<div class="section-title">红线</div><ul class="plain">'
            + view.contract.guardrails.map((a) => '<li>' + esc(a) + '</li>').join('') + '</ul>'
          : '')
      + '</div>');
  }

  p.push(usageCard(view.usage, false));

  if (view.plan) {
    p.push('<div class="card"><h3>规划 <span class="muted">r' + view.planRevision + '</span></h3>'
      + '<div>' + esc(view.plan.direction) + '</div>'
      + (view.plan.rejectedHypotheses?.length
          ? '<div class="section-title">已排除的假设</div><ul class="plain">'
            + view.plan.rejectedHypotheses.map((a) => '<li>' + esc(a) + '</li>').join('') + '</ul>'
          : '')
      + '</div>');
  }

  // S11.5：这条 Mission 的钱花在哪个角色、哪个模型上。
  // 只有一个总数的话，"贵"这件事没法归因，也就没法改。
  if (usageReport && usageReport.byFact.length + usageReport.byRole.length > 0) {
    const rows = (list, label) => list.map((r) =>
      '<div class="tl"><div class="when mono">' + esc(label(r)) + '</div>'
      + '<div class="mono">' + num(r.usage.total) + ' tok'
      + (r.usage.cost ? ' · $' + Number(r.usage.cost).toFixed(4) : '')
      + ' <span class="muted">' + r.attempts + ' 跳</span></div></div>').join('');
    p.push('<div class="card"><h3>用量归因</h3>'
      + '<div class="section-title" style="margin-top:0">按角色</div>'
      + rows(usageReport.byRole, (r) => r.key === 'coordinator' ? 'L2 协调者' : 'L1 执行者')
      + (usageReport.byFact.length
          ? '<div class="section-title">按运行时</div>'
            + rows(usageReport.byFact, (r) => r.key + '=' + r.value)
          : '')
      + (usageReport.unattributed
          // 单列出来而不是摊给某一家：摊给谁都是编的，而这个数本身就是信号。
          ? '<div class="muted" style="margin-top:6px">'
            + usageReport.unattributed + ' 跳没有身份记录，未计入上表</div>'
          : '')
      + '</div>');
  }

  if (view.workItems?.length) {
    let html = '<div class="card"><h3>工作项</h3>';
    for (const w of view.workItems) {
      html += '<div style="padding:8px 0;border-top:1px solid var(--border)">'
        + '<div class="row"><span class="grow">' + esc(w.title) + '</span>' + badge(w.status) + '</div>'
        + '<div class="row wrap mono muted" style="margin-top:4px">'
        +   '<span>' + esc(w.id) + '</span>'
        +   (w.attemptIds || []).map((id) =>
              '<span class="chip clickable" data-attempt="' + esc(id) + '">' + esc(id) + '</span>').join('')
        + '</div>'
        + '</div>';
    }
    p.push(html + '</div>');
  }

  if (view.coordinatorAttemptIds?.length) {
    p.push('<div class="card"><h3>协调者尝试</h3><div class="row wrap">'
      + view.coordinatorAttemptIds.map((id) =>
          '<span class="chip clickable coagent" data-attempt="' + esc(id) + '">' + esc(id) + '</span>').join('')
      + '</div></div>');
  }

  if (view.result) {
    p.push('<div class="card"><h3>L2 交卷 ' + badge(view.result.outcome) + '</h3>'
      + '<div>' + esc(view.result.summary) + '</div>'
      + (view.result.openRisks?.length
          ? '<div class="section-title">遗留风险</div><ul class="plain">'
            + view.result.openRisks.map((a) => '<li>' + esc(a) + '</li>').join('') + '</ul>'
          : '')
      + '</div>');
  }

  if (events?.length) {
    const rows = events.slice().reverse().map((e) =>
      '<div class="when mono">' + esc(time(e.at)) + '</div>'
      + '<div><span class="mono">' + esc(e.kind) + '</span>'
      + (e.workItemId ? ' <span class="muted mono">' + esc(e.workItemId) + '</span>' : '')
      + (e.attemptId ? ' <span class="chip clickable" data-attempt="' + esc(e.attemptId) + '">' + esc(e.attemptId) + '</span>' : '')
      + '</div>').join('');
    p.push('<div class="card"><h3>时间线 <span class="muted">' + events.length + '</span></h3>'
      + '<div class="tl">' + rows + '</div></div>');
  }

  $('detail').innerHTML = p.join('');
  for (const el of document.querySelectorAll('[data-attempt]')) {
    el.onclick = () => showAttempt(view.missionId, el.dataset.attempt);
  }
}

/* ===================== 实时输出 =====================
 * 跟随语义照搬 v4 的 R3/R4：
 *   R3 首次渲染定位到最新；
 *   R4 只有「追加前贴着底部」才跟随 —— 人上滚看历史时不被拉回。
 * 判据必须在追加**前**量：追加会先抬高 scrollHeight，追加后再量会把
 * 「刚才还在底部」误判成「离底很远」。
 */
const FOLLOW_PX = 32;

function renderLive() {
  const box = $('live');
  if (!selected) {
    box.innerHTML = '<div class="empty">选一条 Mission 看它的实时输出</div>';
    return;
  }
  const pre = box.querySelector('pre.term');
  const follow = !pre || (pre.scrollHeight - pre.scrollTop - pre.clientHeight <= FOLLOW_PX);

  const body = liveLines.length === 0
    ? '<span class="t">（还没有实时输出。agent 跑起来时这里会一行行出现。）</span>'
    : liveLines.map((c) => c.kind === 'tool'
        ? '<span class="tool">▸ ' + esc(c.text) + '</span>'
        : '<span class="t">' + esc(time(c.at).slice(6)) + '</span>  ' + esc(c.text)).join('\\n');

  box.innerHTML = '<div class="live-wrap">'
    + (liveUsage ? usageCard(liveUsage, true) : '')
    + '<div class="section-title" style="margin-top:0">实时输出'
    +   (liveLines.length ? ' <span class="muted">' + liveLines.length + ' 行</span>' : '')
    + '</div>'
    + '<pre class="term" id="term">' + body + '</pre>'
    + '<div id="attempt-detail"></div>'
    + '</div>';

  const next = box.querySelector('pre.term');
  if (next && follow) next.scrollTop = next.scrollHeight - next.clientHeight;
}

/* ===================== Attempt 明细 ===================== */
async function showAttempt(missionId, attemptId) {
  const box = $('attempt-detail') || $('live');
  box.innerHTML = '<div class="card muted">读取中…</div>';
  try {
    const d = await get('/api/missions/' + encodeURIComponent(missionId)
      + '/attempts/' + encodeURIComponent(attemptId));
    const role = d.kind === 'coordinator' ? 'coordinator' : 'executor';
    const evidence = (d.evidence || []).map((e) =>
      '<li><span class="chip">' + esc(e.kind) + '</span> ' + esc(e.summary)
      + (e.exitCode !== undefined && e.exitCode !== null
          ? ' <span class="mono muted">exit=' + e.exitCode + '</span>' : '')
      + (e.command ? '<div class="mono muted">' + esc(e.command) + '</div>' : '')
      + '</li>').join('');
    // 第二层：结构化动作序列。和第三层那一大段文字是两回事——
    // 「它到底动了什么」在这一行就看得出来，不用翻几千字符。
    const tools = (d.toolActivity || []).map((t) =>
      '<span class="chip' + (String(t.name).startsWith('coagent_') ? ' coagent' : '') + '">'
      + esc(t.name) + '</span>').join('');

    box.innerHTML = '<div class="card">'
      + '<div class="row" style="margin-bottom:6px">'
      +   '<span class="role ' + role + '">' + (role === 'coordinator' ? 'L2 协调者' : 'L1 执行者') + '</span>'
      +   '<span class="grow mono">' + esc(attemptId) + '</span>' + badge(d.status)
      + '</div>'
      + '<div class="mono muted">' + esc([d.endedBy, d.profile && d.profile.profileId].filter(Boolean).join(' · ')) + '</div>'
      + (d.failReason ? '<div class="waiting">' + esc(d.failReason) + '</div>' : '')
      + usageCard(d.usage, false)
      + (evidence ? '<div class="section-title">证据</div><ul class="plain">' + evidence + '</ul>' : '')
      + (tools ? '<div class="section-title">工具活动（' + (d.toolActivity || []).length + ' 次）</div>'
                 + '<div class="row wrap">' + tools + '</div>' : '')
      + (d.output
          ? '<div class="section-title">原始输出（只留尾部）</div><pre class="term">' + esc(d.output) + '</pre>'
          : '<div class="muted" style="margin-top:8px">（没有原始输出）</div>')
      + '</div>';
  } catch (err) {
    box.innerHTML = '<div class="card waiting">读不到：' + esc(err.message) + '</div>';
  }
}

/* ===================== 轮询 ===================== */
function setConn(ok, text) {
  $('conn-text').textContent = text;
  $('conn').querySelector('.dot').className = 'dot' + (ok ? '' : ' stale');
}

async function tick() {
  try {
    const rows = await get('/api/missions');
    const sig = JSON.stringify(rows);
    if (sig !== listSig) { listSig = sig; renderList(rows); }

    if (selected) {
      const [view, events, usageReport] = await Promise.all([
        get('/api/missions/' + encodeURIComponent(selected)),
        get('/api/missions/' + encodeURIComponent(selected) + '/activity'),
        get('/api/usage?missionId=' + encodeURIComponent(selected)),
      ]);
      const dsig = JSON.stringify([view, events.length, usageReport]);
      if (dsig !== detailSig) { detailSig = dsig; renderDetail(view, events, usageReport); }

      // 跑完了就把实时用量清掉。留着的话，那张标着「实时」的卡片会一直挂着
      // 最后一次快照——一个不动的数字配上"实时"两个字，比不显示更误导。
      if (!['investigating', 'planning', 'executing'].includes(view.status)) {
        if (liveUsage) { liveUsage = null; renderLive(); }
      }

      // 实时：只取游标之后的。没有新内容时后端把游标原样回来。
      if (liveMission !== selected) { liveMission = selected; liveCursor = 0; liveLines = []; }
      const live = await get('/api/missions/' + encodeURIComponent(selected)
        + '/live?cursor=' + liveCursor);
      if (live.chunks && live.chunks.length) {
        liveCursor = live.cursor;
        for (const c of live.chunks) {
          if (c.kind === 'usage') liveUsage = c.usage;
          else liveLines.push(c);
        }
        // 只留最近一段：这是用来看的，不是用来存的。
        if (liveLines.length > 2000) liveLines = liveLines.slice(-2000);
        renderLive();
      } else if (!$('term')) {
        renderLive();
      }
    } else {
      renderLive();
    }
    failures = 0;
    setConn(true, '已连接 · ' + new Date().toLocaleTimeString('zh-CN'));
  } catch (err) {
    failures += 1;
    setConn(false, '连不上（' + failures + ' 次）：' + err.message);
  }
}

get('/api/version').then((v) => { $('api').textContent = 'api ' + v.api; }).catch(() => {});
tick();
// 1 秒一轮。实时输出要的是"看得见它在动"，2 秒就已经有卡顿感了。
setInterval(tick, 1000);
</script>
</body>
</html>`;
