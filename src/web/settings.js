import { esc, num } from './projects.js';
import { formatUsage } from './narrate.js';

async function get(path) {
  const res = await fetch(path, { cache:'no-store' });
  if (!res.ok) throw new Error(path + ' → HTTP ' + res.status);
  return res.json();
}

const TABS = [
  ['models','模型 Provider'],
  ['usage','Token 与成本'],
  ['execution','任务执行'],
  ['notifications','通知'],
];

function modelPane(st) {
  const rows = st.catalog?.available === true && Array.isArray(st.catalog.models)
    ? st.catalog.models.map((m) => '<tr><td class="row-title">' + esc(m.provider || '—') + '</td><td>' + esc(m.model || '—') + '</td><td>' + esc(m.label || '—') + '</td><td><span class="chip done">可用</span></td></tr>').join('')
    : '<tr><td colspan="4" class="empty">模型清单当前不可用</td></tr>';
  return '<div class="card"><h2>运行时模型</h2><div class="screen-subtitle">模型目录来自后端运行时适配层；当前没有通用配置写接口，因此本页保持只读。</div>'
    + '<div class="data-card" style="margin-top:14px"><table class="data-table"><thead><tr><th>Provider</th><th>模型</th><th>标签</th><th>状态</th></tr></thead><tbody>' + rows + '</tbody></table></div></div>';
}
function usagePane(st) {
  const total = formatUsage(st.usage?.total);
  const rows = Array.isArray(st.usage?.byRole) ? st.usage.byRole : [];
  return '<div class="metric-grid">'
    + '<div class="card metric-card metric"><span>总 Token</span><strong>' + esc(num(total.total)) + '</strong></div>'
    + '<div class="card metric-card metric"><span>新增 Token</span><strong>' + esc(num(total.added)) + '</strong></div>'
    + '<div class="card metric-card metric"><span>缓存命中</span><strong>' + esc(total.cachePctText) + '</strong></div>'
    + '<div class="card metric-card metric"><span>费用</span><strong style="font-size:16px">' + esc(total.costText) + '</strong></div></div>'
    + '<div class="card"><h2>按角色聚合</h2><div class="data-card"><table class="data-table"><thead><tr><th>角色</th><th>Attempts</th><th>Token</th><th>费用</th></tr></thead><tbody>'
    + (rows.length ? rows.map((r) => { const u = formatUsage(r.usage); return '<tr><td>' + esc(r.key) + '</td><td>' + esc(r.attempts) + '</td><td>' + esc(num(u.total)) + '</td><td>' + esc(u.costText) + '</td></tr>'; }).join('') : '<tr><td colspan="4" class="empty">还没有用量</td></tr>')
    + '</tbody></table></div></div>';
}

function executionPane(st) {
  const p = st.platform || {};
  const q = p.queue?.counts || {};
  return '<div class="metric-grid"><div class="card metric-card metric"><span>排队</span><strong>' + esc(q.queued || 0) + '</strong></div>'
    + '<div class="card metric-card metric"><span>已领取</span><strong>' + esc(q.claimed || 0) + '</strong></div>'
    + '<div class="card metric-card metric"><span>等待重试</span><strong>' + esc(q.retry_wait || 0) + '</strong></div>'
    + '<div class="card metric-card metric"><span>死信</span><strong>' + esc(q.dead_letter || 0) + '</strong></div></div>'
    + '<div class="card"><h2>平台执行配置（只读）</h2><dl class="fields"><dt>仓储</dt><dd>' + esc(typeof p.store === 'string' ? p.store : '未读到') + '</dd>'
    + '<dt>默认适配层</dt><dd>' + esc(typeof p.defaultAdapter === 'string' ? p.defaultAdapter : '未读到') + '</dd></dl>'
    + '<div class="notice" style="margin-top:14px">后端当前没有通用 Settings 写接口，因此这里不提供无效的保存开关。</div></div>';
}
function notificationsPane() {
  return '<div class="card"><h2>通知</h2><div class="empty-state" style="min-height:220px"><div><strong>后端尚未提供通知配置接口</strong><span>该页保留信息架构位置，不创建无效开关。</span></div></div></div>';
}

function pageHtml(st) {
  const pane = st.tab === 'usage' ? usagePane(st) : st.tab === 'execution' ? executionPane(st) : st.tab === 'notifications' ? notificationsPane() : modelPane(st);
  const menu = TABS.map(([key,label]) => '<button type="button" data-setting-tab="' + key + '"' + (st.tab === key ? ' data-active="1"' : '') + '>' + label + '</button>').join('');
  return '<section class="screen"><div class="screen-head"><div><h1 class="screen-title">设置</h1><div class="screen-subtitle">以当前后端真实能力为准。</div></div></div>'
    + '<div class="settings-layout"><aside class="card settings-menu">' + menu + '</aside><div>' + pane + '</div></div></section>';
}

let epoch = 0;
export async function renderSettingsPage(container) {
  epoch += 1;
  const current = epoch;
  container.innerHTML = '<section data-settings-root class="screen"><div class="card"><div class="skeleton" style="height:300px"></div></div></section>';
  const root = container.querySelector('[data-settings-root]');
  const st = { root, tab:'models', catalog:null, usage:null, runtimeUsage:null, platform:null };
  const [catalog, usage, runtimeUsage, platform] = await Promise.all([
    get('/api/runtime/models').catch((err) => ({ available:false, note:err.message })),
    get('/api/usage').catch(() => null),
    get('/api/runtime/usage').catch(() => ({ available:false })),
    get('/api/platform/status').catch(() => null),
  ]);
  if (current !== epoch || !root.isConnected) return;
  Object.assign(st, { catalog, usage, runtimeUsage, platform });
  const paint = () => { root.innerHTML = pageHtml(st); };
  paint();
  root.addEventListener('click', (ev) => {
    const tab = ev.target.closest && ev.target.closest('[data-setting-tab]');
    if (!tab) return;
    st.tab = tab.dataset.settingTab;
    paint();
  });
}
