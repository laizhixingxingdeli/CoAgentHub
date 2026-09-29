/**
 * 方案运行页（hash `#/plan-runs` 列表、`#/plan-runs/<id>` 详情）。
 *
 * 与 projects.js / task.js 同一分界：**上面全是纯函数**（喂数据 → 回字符串），
 * 只有底部 render* 碰 DOM 与 fetch。浏览器不在测试里，字段名读错了界面照样
 * 渲染——那一格永远是空的。纯函数才能在 node 里把真 JSON 喂进去把它抓出来。
 *
 * 只读。升级单上的动作是给人看的标签，不做成按钮：写接口要等鉴权，界面里
 * 再实现一份「什么时候可以决定」迟早和平台判的不一样。
 *
 * 文案（状态 / 停止原因 / 票状态 / 花费）全部从 narrate.js 来，不在这一页
 * 再抄一份——后续项目页要复用同一张表。
 */

import { esc, stageTone } from './projects.js';
import { formatClock, formatDuration, formatTime } from './task.js';
import {
  planActionText,
  planCostText,
  planFeatureText,
  planHaDecisionText,
  planStatusText,
  planStopText,
  STAGE_CN,
} from './narrate.js';

const DASH = '—';
const POLL_MS = 3000;

const FEATURE_TONE = {
  pending: 'queued',
  running: 'running',
  merged: 'done',
  suspended: 'unconfirmed',
  skipped: 'cancelled',
};

function list(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  return value === undefined || value === null ? '' : String(value);
}

function featureTone(status) {
  return FEATURE_TONE[status] || 'queued';
}

function chip(tone, label) {
  return '<span class="chip ' + esc(tone) + '">' + esc(label) + '</span>';
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function parseMs(iso) {
  const t = Date.parse(String(iso ?? ''));
  return Number.isFinite(t) ? t : NaN;
}

/** 这一次方案运行自己开过的全部 Mission id（跨次链不进花费合计）。 */
export function missionIdsOfRun(snapshot) {
  const ids = [];
  for (const feature of list(snapshot && snapshot.features)) {
    for (const id of list(feature && feature.missionIds)) {
      if (id) ids.push(String(id));
    }
  }
  return ids;
}

/**
 * 按同 featureId 把各次方案运行记录里的 missionIds 串起来。
 *
 * 列表接口只有摘要：别的运行给得出 featureId + missionIds 就够保留链，
 * 不必等详情。当前快照可能比列表新，所以也并进去。同 id 只留一次。
 * 排序：先按那次运行的 startedAt，再按该功能自己的 missionIds 顺序；
 * 有 Mission.updatedAt 时再按时间稳定重排——没有时间的环仍按原链，
 * 不能因为缺时间就丢。
 */
export function collectFeatureMissionIds(featureId, snapshot, runs) {
  const wanted = text(featureId);
  if (!wanted) return [];
  const records = [];
  const pushRun = (run) => {
    if (!run || run.error) return;
    const hit = list(run.features).find((feature) => feature && text(feature.featureId) === wanted);
    if (!hit) return;
    records.push({
      id: text(run.id),
      startedAt: run.startedAt,
      missionIds: list(hit.missionIds).map((id) => String(id)).filter(Boolean),
    });
  };
  for (const run of list(runs)) pushRun(run);
  pushRun(snapshot);

  records.sort((a, b) => {
    const ta = parseMs(a.startedAt);
    const tb = parseMs(b.startedAt);
    const na = Number.isFinite(ta) ? ta : Number.POSITIVE_INFINITY;
    const nb = Number.isFinite(tb) ? tb : Number.POSITIVE_INFINITY;
    if (na !== nb) return na - nb;
    if (a.id < b.id) return -1;
    if (a.id > b.id) return 1;
    return 0;
  });

  const seen = new Set();
  const ids = [];
  for (const rec of records) {
    for (const id of rec.missionIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/**
 * 有 updatedAt 的按时间排。缺时间的**不**沉底：跨次链里只有摘要的那一环往往
 * 就没有 updatedAt，沉底会把更早的一次运行画到新的后面。两边不都有时间时，
 * 保持 collect 给的相对顺序（那已经按方案运行 startedAt 排过）。
 */
export function orderMissionIds(ids, missions) {
  const byId = new Map();
  for (const row of list(missions)) {
    if (row && row.missionId) byId.set(String(row.missionId), row);
  }
  const original = list(ids).map((id) => String(id));
  const index = new Map(original.map((id, i) => [id, i]));
  return original.slice().sort((a, b) => {
    const ta = parseMs(byId.get(a) && byId.get(a).updatedAt);
    const tb = parseMs(byId.get(b) && byId.get(b).updatedAt);
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
    return (index.get(a) ?? 0) - (index.get(b) ?? 0);
  });
}

/**
 * 一张票的跨次链。纯数据，渲染另走 featureChainHtml。
 *
 * 详情里没有的 Mission 仍留在 chain 里——只有摘要也要看得见「这张票跑过谁」。
 */
export function buildFeatureChains(snapshot, runs, missions) {
  const byId = new Map();
  for (const row of list(missions)) {
    if (row && row.missionId) byId.set(String(row.missionId), row);
  }
  return list(snapshot && snapshot.features).map((feature) => {
    const featureId = text(feature && feature.featureId);
    const collected = collectFeatureMissionIds(featureId, snapshot, runs);
    const ordered = orderMissionIds(collected, missions);
    return {
      featureId,
      title: text(feature && feature.title),
      status: text(feature && feature.status),
      needsDecision: text(feature && feature.needsDecision),
      missionIds: ordered,
      missions: ordered.map((id) => byId.get(id) || { missionId: id }),
    };
  });
}

/**
 * 还要不要轮询。运行中（没有 stopped）且人还看着这一页才拉；
 * 停了、离页、标签隐藏都停——给看不见的人烧配额，还可能把过期结果写进已拆掉的 DOM。
 */
export function planRunRefresh(stopped, visible, onPage) {
  if (!onPage || !visible || stopped) {
    return { intervalMs: null, paths: [] };
  }
  return { intervalMs: POLL_MS, paths: ['record', 'live'] };
}

function usagesFor(ids, missions) {
  const byId = new Map();
  for (const row of list(missions)) {
    if (row && row.missionId) byId.set(String(row.missionId), row);
  }
  return list(ids).map((id) => {
    const row = byId.get(String(id));
    return row ? row.usage : undefined;
  });
}

function countByStatus(features) {
  const counts = { pending: 0, running: 0, merged: 0, suspended: 0, skipped: 0 };
  for (const feature of list(features)) {
    const key = text(feature && feature.status);
    if (key in counts) counts[key] += 1;
  }
  return counts;
}

export function ticketSummaryText(features) {
  const rows = list(features);
  const counts = countByStatus(rows);
  const parts = [rows.length + ' 张票'];
  if (counts.merged) parts.push('已合入 ' + counts.merged);
  if (counts.running) parts.push('在跑 ' + counts.running);
  if (counts.suspended) parts.push('挂起 ' + counts.suspended);
  if (counts.skipped) parts.push('跳过 ' + counts.skipped);
  if (counts.pending) parts.push('没轮到 ' + counts.pending);
  return parts.join(' · ');
}

function stat(label, value) {
  return '<div class="stat"><dt>' + esc(label) + '</dt><dd>' + value + '</dd></div>';
}

/**
 * 详情页头：开始/结束/经过、票数及结果、花费。
 * nowIso 由调用方传入——纯函数里不许 new Date()，否则同一份快照两次运行字不一样。
 */
export function headerHtml(snapshot, missions, nowIso) {
  const run = snapshot || {};
  const start = formatTime(run.startedAt);
  const stoppedAt = run.stopped && run.stopped.at;
  const end = stoppedAt ? formatTime(stoppedAt) : (run.stopped ? DASH : '还在跑');
  const until = stoppedAt || nowIso;
  const elapsed = formatDuration(run.startedAt, until);
  const cost = planCostText(usagesFor(missionIdsOfRun(run), missions));
  const stopLine = planStopText(run.stopped);
  return '<div class="card plan-head" data-plan-head>'
    + '<h1 class="plan-title">' + esc(run.planId || run.id || '方案运行') + '</h1>'
    + '<div class="task-chips">'
    +   chip(run.stopped ? 'cancelled' : 'running', planStatusText(run))
    +   (run.id ? '<span class="mono muted">' + esc(run.id) + '</span>' : '')
    + '</div>'
    + (stopLine ? '<div class="wait-reason" data-plan-stop>' + esc(stopLine) + '</div>' : '')
    + '<dl class="task-stats">'
    +   stat('开始', esc(start))
    +   stat('结束', esc(end))
    +   stat('经过', esc(elapsed))
    +   stat('票', esc(ticketSummaryText(run.features)))
    +   stat('花费', esc(cost))
    + '</dl>'
    + '<div class="muted">项目 ' + esc(run.projectId || DASH)
    +   ' · 集成分支 ' + esc(run.integrationBranch || DASH)
    +   ' · 检视者 ' + esc(run.reviewer || DASH)
    + '</div>'
    + '</div>';
}

function missionOutcomeText(row, detail) {
  const status = text(row && row.status);
  const stage = status ? (STAGE_CN[status] || status) : '';
  const review = detail && detail.finalReview;
  const sha = text(review && review.mergedInto);
  const verdict = text(review && review.verdict);
  const bits = [];
  if (stage) bits.push(stage);
  if (verdict === 'merge' && sha) bits.push('合入 ' + sha);
  else if (verdict === 'abandon') bits.push('放弃');
  else if (verdict === 'send_back') bits.push('打回');
  else if (sha) bits.push('合入 ' + sha);
  return bits.join(' · ') || '（还没有结局）';
}

function ringCostText(row) {
  if (!row || !('usage' in row)) return '费用未上报';
  return planCostText([row.usage]);
}

export function featureChainHtml(chains, details) {
  const rows = list(chains);
  if (rows.length === 0) {
    return '<div class="card"><div class="pane-title">同票跨次</div>'
      + '<div class="empty">这次运行还没有票</div></div>';
  }
  const byDetail = details && typeof details === 'object' ? details : {};
  const blocks = rows.map((chain) => {
    const tone = featureTone(chain.status);
    const title = chain.title ? chain.title + '  ' : '';
    const rings = list(chain.missions);
    const body = rings.length === 0
      ? '<div class="muted">还没有为这张票开过 Mission</div>'
      : '<ol class="plan-chain">' + rings.map((row) => {
        const id = text(row && row.missionId);
        const detail = byDetail[id];
        const when = formatTime(row && row.updatedAt);
        const outcome = missionOutcomeText(row, detail);
        const cost = ringCostText(row);
        const href = '#/missions/' + encodeURIComponent(id);
        const ringTone = (row && row.status) ? stageTone(row.status) : tone;
        return '<li class="plan-ring tone-' + esc(ringTone) + '" data-mission-id="' + esc(id) + '">'
          + '<a class="mono" href="' + esc(href) + '">' + esc(id) + '</a>'
          + '<div class="muted">' + esc(when) + '</div>'
          + '<div>' + esc(outcome) + '</div>'
          + '<div class="muted">' + esc(cost) + '</div>'
          + '</li>';
      }).join('') + '</ol>';
    return '<div class="plan-feature" data-feature-id="' + esc(chain.featureId) + '">'
      + '<div class="plan-feature-head">'
      +   chip(tone, planFeatureText(chain.status))
      +   ' <span class="mono">' + esc(chain.featureId) + '</span>'
      +   (title ? ' <span>' + esc(title.trim()) + '</span>' : '')
      + '</div>'
      + (chain.needsDecision ? '<div class="wait-reason">' + esc(chain.needsDecision) + '</div>' : '')
      + body
      + '</div>';
  }).join('');
  return '<div class="card" data-plan-chains><div class="pane-title">同票跨次</div>'
    + blocks + '</div>';
}

function actionLabels(escalation) {
  const names = ['rerun_isolated', 'skip', 'rescope', 'stop'];
  if (escalation && escalation.answerable === true) names.push('answer');
  return names.map(planActionText).join('、');
}

function resolutionHtml(resolution) {
  if (!resolution) return '<div class="muted">还没有决定</div>';
  if (resolution.kind === 'expired') {
    return '<div>过期于 ' + esc(formatTime(resolution.expiredAt)) + '</div>';
  }
  const action = planActionText(resolution.action);
  const bits = [
    '决定：' + action,
    resolution.reason ? '理由：' + text(resolution.reason) : '',
    resolution.decidedBy ? '由 ' + text(resolution.decidedBy) : '',
    resolution.decidedAt ? formatTime(resolution.decidedAt) : '',
  ].filter(Boolean);
  let html = '<div>' + esc(bits.join(' · ')) + '</div>';
  if (resolution.action === 'answer' && resolution.answer) {
    html += '<div class="a">答复：' + esc(resolution.answer) + '</div>';
  }
  if (list(resolution.dropFeatures).length) {
    html += '<div class="muted">一并删掉：' + esc(list(resolution.dropFeatures).join('、')) + '</div>';
  }
  return html;
}

export function escalationsHtml(escalations) {
  const rows = list(escalations);
  if (rows.length === 0) {
    return '<div class="card"><div class="pane-title">升级单</div>'
      + '<div class="empty">这次运行没有升级单</div></div>';
  }
  const items = rows.map((item) => {
    const e = item || {};
    return '<article class="plan-esc" data-escalation-id="' + esc(e.id) + '">'
      + '<div class="q">' + esc(e.question || '（没有写问题）') + '</div>'
      + '<div class="why">' + esc(e.failure || '（没有写失败原因）') + '</div>'
      + '<div class="muted">可选动作：' + esc(actionLabels(e)) + '</div>'
      + (e.answerable === true ? '<div class="muted">这张单可以答复</div>' : '')
      + '<div class="muted">' + esc(
        (e.featureId || '')
        + (e.missionId ? ' · ' + e.missionId : '')
        + (e.deadline ? ' · 截止 ' + formatTime(e.deadline) : ''),
      ) + '</div>'
      + resolutionHtml(e.resolution)
      + '</article>';
  }).join('');
  return '<div class="card" data-plan-escalations><div class="pane-title">升级单</div>'
    + items + '</div>';
}

export function haReleasesHtml(releases) {
  const rows = list(releases);
  if (rows.length === 0) return '';
  const items = rows.map((item) => {
    const r = item || {};
    const decided = planHaDecisionText(r.decision);
    const d = r.decision || {};
    const who = [d.by, d.confirmedBy].filter(Boolean).join(' / ');
    return '<article class="plan-esc" data-ha-feature="' + esc(r.featureId) + '">'
      + '<div class="q">HA · ' + esc(r.featureId || '') + ' / ' + esc(r.missionId || '') + '</div>'
      + '<div class="muted">提交 ' + esc(r.reviewedCommit || DASH)
      +   ' · 报告 ' + esc(r.validationReportId || DASH)
      +   ' · 截止 ' + esc(formatTime(r.deadline)) + '</div>'
      + (decided
        ? '<div>' + esc(decided)
          + (who ? ' · ' + esc(who) : '')
          + (d.at ? ' · ' + esc(formatTime(d.at)) : '')
          + (d.reason ? ' · ' + esc(d.reason) : '')
          + '</div>'
        : '<div class="muted">还没有 HA 决定</div>')
      + '</article>';
  }).join('');
  return '<div class="card" data-plan-ha><div class="pane-title">HA 决定</div>'
    + items + '</div>';
}

export function liveLinesHtml(chunks) {
  return list(chunks).map((chunk) => {
    const c = chunk || {};
    const cls = c.channel === 'stderr' ? 't' : (c.channel === 'tool' ? 'tool' : '');
    const clock = formatClock(c.at);
    const line = text(c.line);
    return '<span' + (cls ? ' class="' + cls + '"' : '') + '>'
      + esc(clock === DASH ? '' : clock + ' ')
      + esc(line)
      + '\n</span>';
  }).join('');
}

/**
 * 运行输出。reason 是接口说的「为什么没有 live」（非托管、重启后清空）；
 * 有行也把 reason 当横幅——它说的是「前面没了」，不是正文。
 */
export function livePanelHtml(live, stopped) {
  const state = live || {};
  const reason = text(state.reason);
  const chunks = list(state.chunks);
  const empty = chunks.length === 0;
  const emptyNote = empty
    ? (reason || (stopped ? '这里没留下输出' : '还没有输出'))
    : '';
  const banner = reason
    ? '<div class="live-note" data-live-reason>' + esc(reason) + '</div>'
    : (empty ? '<div class="live-note" data-live-reason>' + esc(emptyNote) + '</div>' : '');
  return '<div class="card" data-plan-live><div class="pane-title">运行输出</div>'
    + banner
    + '<pre class="term" data-plan-term>' + liveLinesHtml(chunks) + '</pre>'
    + '</div>';
}

export function planRunPageHtml(snapshot, chains, details, live, nowIso, missions) {
  return '<div class="plan-run" data-plan-root>'
    + headerHtml(snapshot, missions, nowIso)
    + featureChainHtml(chains, details)
    + escalationsHtml(snapshot && snapshot.escalations)
    + haReleasesHtml(snapshot && snapshot.haReleases)
    + livePanelHtml(live, Boolean(snapshot && snapshot.stopped))
    + '</div>';
}

export function planRunListHtml(runs) {
  const rows = list(runs);
  if (rows.length === 0) {
    return '<div class="card"><div class="empty">还没有方案运行记录</div></div>';
  }
  const body = rows.map((row) => {
    const r = row || {};
    if (r.error) {
      return '<tr class="row-failed" data-plan-run-error="' + esc(r.id) + '">'
        + '<td class="mono">' + esc(r.id) + '</td>'
        + '<td colspan="4" class="cell-reason">' + esc(r.error) + '</td>'
        + '</tr>';
    }
    const stop = planStopText(r.stopped);
    const tickets = ticketSummaryText(r.features);
    return '<tr class="row-' + (r.stopped ? 'cancelled' : 'running') + '" data-plan-run-id="' + esc(r.id) + '">'
      + '<td class="mono">' + esc(r.id) + '</td>'
      + '<td>' + esc(r.planId || DASH) + '</td>'
      + '<td>' + chip(r.stopped ? 'cancelled' : 'running', planStatusText(r)) + '</td>'
      + '<td>' + esc(tickets) + '</td>'
      + '<td class="cell-reason">' + esc(stop || '还在跑') + '</td>'
      + '</tr>';
  }).join('');
  return '<div class="card plan-list"><div class="pane-title">方案运行</div>'
    + '<div class="table-wrap"><table class="tasks"><thead><tr>'
    + '<th>运行</th><th>方案</th><th>状态</th><th>票</th><th>停止</th>'
    + '</tr></thead><tbody>' + body + '</tbody></table></div></div>';
}

export function skeletonHtml() {
  return '<div class="plan-run" data-plan-root>'
    + '<div class="note" data-plan-head>正在读取方案运行…</div>'
    + '</div>';
}

/* ===================== 下面才是碰 DOM 的部分 ===================== */

async function get(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) {
    let extra = '';
    try {
      const body = await res.json();
      extra = body && (body.message || body.error) ? ': ' + (body.message || body.error) : '';
    } catch {
      // 502 的 HTML 之类：HTTP 状态码就是全部信息。
    }
    throw new Error(path + ' → HTTP ' + res.status + extra);
  }
  return res.json();
}

function isPageVisible() {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
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
  if (st && st.onVisibility) {
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', st.onVisibility);
    }
    st.onVisibility = null;
  }
}

function writable(st) {
  return st
    && st === mounted
    && st.epoch === epoch
    && st.els.root
    && st.els.root.isConnected;
}

function setCrumbs(planRunId) {
  const bar = document.getElementById('crumbs');
  if (!bar) return;
  const nodes = [];
  const addSep = () => {
    const sep = document.createElement('span');
    sep.className = 'sep';
    sep.textContent = '/';
    nodes.push(sep);
  };
  if (!planRunId) {
    const here = document.createElement('span');
    here.className = 'here';
    here.textContent = '方案运行';
    nodes.push(here);
  } else {
    const a = document.createElement('a');
    a.href = '#/plan-runs';
    a.textContent = '方案运行';
    nodes.push(a);
    addSep();
    const here = document.createElement('span');
    here.className = 'here';
    here.textContent = planRunId;
    nodes.push(here);
  }
  bar.replaceChildren(...nodes);
}

function paintList(st) {
  if (!writable(st)) return;
  if (st.loadError && !st.runs) {
    st.els.root.innerHTML = '<div class="note">读不到方案运行列表：' + esc(st.loadError) + '</div>';
    return;
  }
  st.els.root.innerHTML = planRunListHtml(st.runs);
  for (const tr of st.els.root.querySelectorAll('tr[data-plan-run-id]')) {
    tr.onclick = () => {
      location.hash = '#/plan-runs/' + encodeURIComponent(tr.dataset.planRunId);
    };
  }
}

function nowIso() {
  return new Date().toISOString();
}

function paintDetail(st) {
  if (!writable(st)) return;
  if (!st.snapshot) {
    st.els.root.innerHTML = '<div class="note">读不到这条方案运行：' + esc(st.loadError || '未知错误') + '</div>';
    return;
  }
  const chains = buildFeatureChains(st.snapshot, st.runs, st.missions);
  st.els.root.innerHTML = planRunPageHtml(
    st.snapshot,
    chains,
    st.details,
    st.live,
    nowIso(),
    st.missions,
  );
}

function armTimer(st) {
  clearTimer(st);
  if (!writable(st)) return;
  const plan = planRunRefresh(Boolean(st.snapshot && st.snapshot.stopped), isPageVisible(), true);
  if (!plan.intervalMs) return;
  st.timer = setInterval(() => {
    if (!writable(st)) {
      stop(st);
      return;
    }
    void pullDetail(st, { quiet: true });
    void pollLive(st);
  }, plan.intervalMs);
}

function handleVisibility(st) {
  if (!writable(st)) {
    stop(st);
    return;
  }
  const visible = isPageVisible();
  const plan = planRunRefresh(Boolean(st.snapshot && st.snapshot.stopped), visible, true);
  if (!plan.intervalMs) {
    clearTimer(st);
    return;
  }
  void pullDetail(st, { quiet: true });
  void pollLive(st);
  armTimer(st);
}

async function pollLive(st) {
  if (st.liveInflight) return;
  if (!isPageVisible()) return;
  if (!writable(st)) return;
  if (st.snapshot && st.snapshot.stopped && st.live.fetched) return;
  st.liveInflight = true;
  try {
    const body = await get(
      '/api/plan-runs/' + encodeURIComponent(st.planRunId)
        + '/live?cursor=' + st.live.cursor,
    );
    if (!writable(st)) return;
    const chunks = list(body && body.chunks);
    if (body && body.reason) st.live.reason = text(body.reason);
    for (const chunk of chunks) {
      if (!chunk) continue;
      st.live.chunks.push({
        seq: chunk.seq,
        at: chunk.at,
        channel: chunk.channel,
        line: chunk.line,
      });
    }
    const cursor = Number(body && body.cursor);
    if (Number.isFinite(cursor)) st.live.cursor = cursor;
    st.live.fetched = true;
    if (chunks.length || (body && body.reason)) paintDetail(st);
  } catch (err) {
    if (!writable(st)) return;
    // 没有 live 合同实现、非托管、重启后清空：都该把原因写出来，
    // 不能让终端空着像「还没开始」。
    if (!st.live.fetched) {
      st.live.reason = err && err.message
        ? '没有实时输出：' + err.message
        : '没有实时输出（本机未托管这次运行，或服务重启后输出已清空）';
      st.live.fetched = true;
      paintDetail(st);
    }
  } finally {
    st.liveInflight = false;
  }
}

async function loadMissionDetails(st, ids) {
  const unique = [...new Set(list(ids).map((id) => String(id)).filter(Boolean))];
  const details = { ...st.details };
  await Promise.all(unique.map(async (id) => {
    if (details[id]) return;
    try {
      details[id] = await get('/api/missions/' + encodeURIComponent(id));
    } catch {
      // 列表里有、详情没有：链上仍保留这个 id，只是没有合入 SHA。
    }
  }));
  st.details = details;
}

async function pullDetail(st, opts) {
  if (st.viewInflight) return st.viewInflight;
  const started = st.epoch;
  const quiet = Boolean(opts && opts.quiet);
  st.viewInflight = Promise.all([
    get('/api/plan-runs/' + encodeURIComponent(st.planRunId)),
    get('/api/plan-runs').catch(() => st.runs || []),
    get('/api/missions').catch(() => st.missions || []),
  ]).then(async ([snapshot, runs, missions]) => {
    if (st.epoch !== started) return;
    if (!writable(st)) return;
    const unchanged = quiet
      && sameJson(st.snapshot, snapshot)
      && sameJson(st.runs, runs)
      && sameJson(st.missions, missions);
    st.snapshot = snapshot;
    st.runs = runs;
    st.missions = missions;
    st.loadError = '';
    const chains = buildFeatureChains(snapshot, runs, missions);
    const ids = [];
    for (const chain of chains) {
      for (const id of chain.missionIds) ids.push(id);
    }
    await loadMissionDetails(st, ids);
    if (st.epoch !== started || !writable(st)) return;
    if (!unchanged) paintDetail(st);
    if (!st.live.fetched) void pollLive(st);
    armTimer(st);
  }).catch((err) => {
    if (st.epoch !== started) return;
    if (!writable(st)) return;
    st.loadError = err && err.message ? err.message : String(err);
    if (!st.snapshot) paintDetail(st);
    armTimer(st);
  }).finally(() => {
    if (st.epoch === started) st.viewInflight = null;
  });
  return st.viewInflight;
}

function bindList(st) {
  st.els.root.addEventListener('click', (ev) => {
    const tr = ev.target && ev.target.closest && ev.target.closest('tr[data-plan-run-id]');
    if (!tr) return;
    location.hash = '#/plan-runs/' + encodeURIComponent(tr.dataset.planRunId);
  });
}

/**
 * 列表页。入口在侧栏「方案运行」。点一行改 hash，不在这里 fetch 详情。
 */
export async function renderPlanRunListPage(container) {
  if (mounted) stop(mounted);
  epoch += 1;
  setCrumbs('');
  container.innerHTML = '<div class="plan-run" data-plan-root><div class="note">正在读取方案运行列表…</div></div>';
  const st = {
    kind: 'list',
    container,
    epoch,
    els: { root: container.querySelector('[data-plan-root]') },
    runs: null,
    loadError: '',
    timer: null,
    onVisibility: null,
  };
  mounted = st;
  bindList(st);
  try {
    st.runs = await get('/api/plan-runs');
  } catch (err) {
    st.loadError = err && err.message ? err.message : String(err);
  }
  if (!writable(st)) return;
  paintList(st);
}

/**
 * 详情页。运行中每三秒刷新记录与 live；stopped 或节点离页后停表。
 */
export async function renderPlanRunPage(container, planRunId) {
  const same = mounted
    && mounted.kind === 'detail'
    && mounted.container === container
    && mounted.planRunId === planRunId
    && mounted.els.root
    && mounted.els.root.isConnected;
  if (same) return;

  if (mounted) stop(mounted);
  epoch += 1;
  setCrumbs(planRunId);
  container.innerHTML = skeletonHtml();
  const st = {
    kind: 'detail',
    container,
    planRunId,
    epoch,
    els: { root: container.querySelector('[data-plan-root]') },
    snapshot: null,
    runs: [],
    missions: [],
    details: {},
    loadError: '',
    live: { cursor: 0, chunks: [], reason: '', fetched: false },
    liveInflight: false,
    viewInflight: null,
    timer: null,
    onVisibility: null,
  };
  mounted = st;
  if (typeof document !== 'undefined') {
    st.onVisibility = () => handleVisibility(st);
    document.addEventListener('visibilitychange', st.onVisibility);
  }
  await pullDetail(st);
}
