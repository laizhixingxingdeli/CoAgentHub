import { esc } from './projects.js';

const ROLE_META = {
  independent_reviewer: { label:'检视者', cls:'reviewer', avatar:'R', desc:'独立检视与高保障审查' },
  coordinator: { label:'协调者', cls:'coordinator', avatar:'C', desc:'任务调查、拆解与调度' },
  executor: { label:'执行者', cls:'executor', avatar:'E', desc:'代码执行、验证与结果提交' },
};

async function get(path) {
  const res = await fetch(path, { cache:'no-store' });
  if (!res.ok) throw new Error(path + ' → HTTP ' + res.status);
  return res.json();
}

function fact(row, key) {
  const hit = (Array.isArray(row?.facts) ? row.facts : []).find((x) => x && x.key === key);
  return hit ? String(hit.value ?? '') : '';
}

function flatten(snapshot) {
  const out = [];
  for (const role of ['independent_reviewer','coordinator','executor']) {
    for (const row of snapshot?.[role] || []) out.push({ ...row, role });
  }
  return out;
}

function roleBadge(role) {
  const meta = ROLE_META[role] || ROLE_META.executor;
  return '<span class="role-pill ' + meta.cls + '">' + meta.label + '</span>';
}

function avatar(role) {
  const meta = ROLE_META[role] || ROLE_META.executor;
  return '<span class="agent-avatar ' + meta.cls + '">' + meta.avatar + '</span>';
}

function circuit(row) {
  const state = row?.health?.circuit?.state || 'unknown';
  if (state === 'closed') return '<span class="chip done">正常</span>';
  if (state === 'open') return '<span class="chip failed">熔断</span>';
  if (state === 'half_open') return '<span class="chip unconfirmed">半开</span>';
  return '<span class="chip queued">未知</span>';
}

function runtime(row) {
  const r = row?.health?.runtime;
  if (r?.running) return '<span class="chip running">运行中</span>';
  return '<span class="chip queued">空闲</span>';
}

function successText(row) {
  const w = row?.health?.window7d || {};
  const attempts = Number(w.attempts) || 0;
  const successes = Number(w.successes) || 0;
  if (!attempts) return '—';
  return Math.round((successes / attempts) * 100) + '%';
}

function quotaText(row) {
  const u = row?.health?.usage;
  if (!u || typeof u !== 'object') return '未上报';
  const remain = Number(u.remainingPercent);
  return Number.isFinite(remain) ? '剩余 ' + remain + '%' : (u.plan || '已连接');
}

function rowHtml(row) {
  const meta = ROLE_META[row.role] || ROLE_META.executor;
  const provider = fact(row,'provider');
  const model = fact(row,'model');
  return '<tr data-clickable="1" data-agent-id="' + esc(row.profileId) + '">'
    + '<td><div style="display:flex;align-items:center;gap:10px">' + avatar(row.role)
    + '<div><div class="row-title">' + esc(row.profileId) + '</div><div class="row-sub">' + esc(meta.desc) + '</div></div></div></td>'
    + '<td>' + roleBadge(row.role) + '</td>'
    + '<td><div class="row-title">' + esc(model || '未声明') + '</div><div class="row-sub">' + esc(provider || row.runtime || '—') + '</div></td>'
    + '<td>' + runtime(row) + '<div class="row-sub">' + circuit(row) + '</div></td>'
    + '<td>' + esc(successText(row)) + '</td>'
    + '<td>' + esc(quotaText(row)) + '</td>'
    + '<td><span class="switch on" title="候选来自后端配置，当前页面不提供禁用写接口"></span></td>'
    + '<td>⋯</td></tr>';
}

function listHtml(st) {
  const roles = [
    ['all','全部'],
    ['independent_reviewer','检视者'],
    ['coordinator','协调者'],
    ['executor','执行者'],
  ];
  const counts = Object.fromEntries(roles.map(([k]) => [k, k === 'all' ? st.rows.length : st.rows.filter((r) => r.role === k).length]));
  const q = st.query.trim().toLowerCase();
  const shown = st.rows.filter((r) => (st.role === 'all' || r.role === st.role)
    && (!q || [r.profileId, fact(r,'provider'), fact(r,'model'), r.endpoint].some((x) => String(x || '').toLowerCase().includes(q))));
  const tabs = roles.map(([key,label]) => '<button class="tab" data-role="' + key + '"' + (st.role === key ? ' data-active="1"' : '') + '>'
    + label + ' (' + counts[key] + ')</button>').join('');
  return '<section class="screen"><div class="screen-head"><div><h1 class="screen-title">智能体</h1>'
    + '<div class="screen-subtitle">真实数据来自候选池；检视者映射 independent_reviewer。</div></div>'
    + '<div class="screen-actions"><a class="button" href="#/pool">管理候选池</a></div></div>'
    + '<div class="tabs">' + tabs + '</div>'
    + '<div class="toolbar"><input class="search" type="search" data-agent-search placeholder="搜索智能体、模型、Provider..." value="' + esc(st.query) + '" />'
    + '<span class="push muted">健康状态由后端熔断与运行占用计算</span></div>'
    + '<div class="card data-card"><table class="data-table"><thead><tr><th>智能体</th><th>角色</th><th>模型</th><th>状态</th><th>近 7 日成功率</th><th>请求额度</th><th>启用</th><th></th></tr></thead>'
    + '<tbody>' + (shown.length ? shown.map(rowHtml).join('') : '<tr><td colspan="8" class="empty">没有符合条件的智能体</td></tr>') + '</tbody></table></div></section>';
}

function detailHtml(row) {
  if (!row) return '<div class="empty-state"><div><strong>没有这个智能体</strong><span>候选可能已从资源池移除。</span></div></div>';
  const meta = ROLE_META[row.role] || ROLE_META.executor;
  const provider = fact(row,'provider') || '未声明';
  const model = fact(row,'model') || '未声明';
  const health = row.health || {};
  const w = health.window7d || {};
  const runtimeInfo = health.runtime || {};
  const last = health.lastFailure || {};
  return '<section class="screen"><div class="screen-head"><div style="display:flex;align-items:center;gap:12px">'
    + avatar(row.role) + '<div><div style="display:flex;align-items:center;gap:8px"><h1 class="screen-title" style="font-size:22px">' + esc(row.profileId) + '</h1>' + roleBadge(row.role) + '</div>'
    + '<div class="screen-subtitle">' + esc(meta.desc) + '</div></div></div><div class="screen-actions">' + runtime(row) + '</div></div>'
    + '<div class="tabs"><span class="tab" data-active="1">概览</span><span class="tab">当前任务</span><span class="tab">历史任务</span><span class="tab">Token 使用</span><span class="tab">配置</span></div>'
    + '<div class="metric-grid"><div class="card metric-card metric"><span>近 7 日尝试</span><strong>' + esc(w.attempts || 0) + '</strong></div>'
    + '<div class="card metric-card metric"><span>近 7 日成功</span><strong>' + esc(w.successes || 0) + '</strong></div>'
    + '<div class="card metric-card metric"><span>成功率</span><strong>' + esc(successText(row)) + '</strong></div>'
    + '<div class="card metric-card metric"><span>额度</span><strong style="font-size:16px">' + esc(quotaText(row)) + '</strong></div></div>'
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">'
    + '<div class="card"><h2>基本信息</h2><dl class="fields"><dt>名称</dt><dd>' + esc(row.profileId) + '</dd><dt>角色</dt><dd>' + esc(meta.label) + '</dd><dt>接入点</dt><dd class="mono">' + esc(row.endpoint || '—') + '</dd><dt>适配层</dt><dd>' + esc(row.runtime || 'pi') + '</dd><dt>熔断</dt><dd>' + circuit(row) + '</dd></dl></div>'
    + '<div class="card"><h2>模型配置</h2><dl class="fields"><dt>Provider</dt><dd>' + esc(provider) + '</dd><dt>模型</dt><dd>' + esc(model) + '</dd><dt>当前任务</dt><dd>' + esc(runtimeInfo.hopId || '空闲') + '</dd><dt>运行时类型</dt><dd>' + esc(runtimeInfo.runtimeKind || '—') + '</dd></dl></div>'
    + '</div>'
    + '<div class="card"><h2>最近健康信息</h2><dl class="fields"><dt>最近失败</dt><dd>' + esc(last.failureClass || '没有失败记录') + '</dd><dt>失败时间</dt><dd>' + esc(last.at || '—') + '</dd><dt>近 7 日费用</dt><dd>' + esc(Number.isFinite(Number(w.reportedCost)) ? '$' + Number(w.reportedCost).toFixed(4) : '未上报') + '</dd></dl></div>'
    + '</section>';
}

let mounted = null;
let epoch = 0;

export async function renderAgentsPage(container, agentId) {
  epoch += 1;
  container.innerHTML = '<section class="screen" data-agents-root><div class="card"><div class="skeleton" style="height:300px"></div></div></section>';
  const st = { container, root:container.querySelector('[data-agents-root]'), rows:[], role:'all', query:'', epoch };
  mounted = st;
  const snapshot = await get('/api/pools').catch((err) => ({ __error:err }));
  if (st.epoch !== epoch || !st.root.isConnected) return;
  if (snapshot.__error) {
    st.root.innerHTML = '<div class="empty-state"><div><strong>智能体加载失败</strong><span>' + esc(snapshot.__error.message) + '</span></div></div>';
    return;
  }
  st.rows = flatten(snapshot);
  if (agentId) {
    st.root.innerHTML = detailHtml(st.rows.find((r) => r.profileId === agentId));
    return;
  }
  const paint = () => { st.root.innerHTML = listHtml(st); };
  paint();
  st.root.addEventListener('click', (ev) => {
    const row = ev.target.closest && ev.target.closest('[data-agent-id]');
    if (row) { location.hash = '#/agents/' + encodeURIComponent(row.dataset.agentId); return; }
    const tab = ev.target.closest && ev.target.closest('[data-role]');
    if (tab) { st.role = tab.dataset.role; paint(); }
  });
  st.root.addEventListener('input', (ev) => {
    if (!ev.target.matches('[data-agent-search]')) return;
    st.query = ev.target.value;
    paint();
    const input = st.root.querySelector('[data-agent-search]');
    input?.focus();
    if (input) input.setSelectionRange(input.value.length, input.value.length);
  });
}
