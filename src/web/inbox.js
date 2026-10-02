import { esc, num, stageChip, stateChip } from './projects.js';
import { formatUsage } from './narrate.js';

const ROLE_BY_STATUS = {
  investigating: ['检视者', 'reviewer'],
  planning: ['协调者', 'coordinator'],
  executing: ['执行者', 'executor'],
  awaiting_review: ['检视者', 'reviewer'],
  completed: ['检视者', 'reviewer'],
  blocked: ['协调者', 'coordinator'],
};

const TERMINAL = new Set(['completed', 'blocked']);
const FILTERS = [
  ['all', '全部'],
  ['running', '运行中'],
  ['waiting', '等待中'],
  ['completed', '已完成'],
  ['failed', '失败'],
];

async function get(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(path + ' → HTTP ' + res.status);
  return res.json();
}

function classOf(row) {
  if (row.status === 'blocked') return 'failed';
  if (row.status === 'completed') return 'completed';
  if (row.paused || row.waitReason) return 'waiting';
  return 'running';
}

function roleHtml(row) {
  const [label, role] = ROLE_BY_STATUS[row.status] || ['协调者', 'coordinator'];
  return '<span class="role-pill ' + role + '">' + label + '</span>';
}

function progressOf(row) {
  const total = Number(row.workItems) || 0;
  const done = Number(row.accepted) || 0;
  if (row.status === 'completed') return { done: Math.max(done, total || 1), total: Math.max(total, 1), pct: 100 };
  if (!total) return { done: 0, total: 0, pct: row.status === 'executing' ? 45 : row.status === 'planning' ? 25 : 10 };
  return { done, total, pct: Math.max(4, Math.min(100, Math.round((done / total) * 100))) };
}

function timeText(iso) {
  const t = Date.parse(String(iso || ''));
  if (!Number.isFinite(t)) return '—';
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function rowHtml(row) {
  const p = progressOf(row);
  const usage = formatUsage(row.usage);
  return '<tr data-clickable="1" data-mission-id="' + esc(row.missionId) + '">'
    + '<td><div class="row-title">' + esc(row.intent || '（没有契约）') + '</div><div class="row-sub">#' + esc(row.missionId) + '</div></td>'
    + '<td><div class="row-title">' + esc(row.projectId) + '</div></td>'
    + '<td>' + stageChip(row.status) + '<div class="row-sub">' + stateChip(row) + '</div></td>'
    + '<td>' + roleHtml(row) + '</td>'
    + '<td><div class="progress"><div class="progress-track"><div class="progress-fill" style="width:' + p.pct + '%"></div></div>'
    + '<span>' + (p.total ? esc(p.done + '/' + p.total) : esc(p.pct + '%')) + '</span></div></td>'
    + '<td><div class="row-title mono">' + esc(num(usage.total)) + '</div><div class="row-sub">tokens</div></td>'
    + '<td class="muted">' + esc(timeText(row.updatedAt)) + '</td>'
    + '<td>⋯</td></tr>';
}

function counts(rows) {
  const out = { all: rows.length, running: 0, waiting: 0, completed: 0, failed: 0 };
  for (const row of rows) out[classOf(row)] += 1;
  return out;
}

function screenHtml(state) {
  const c = counts(state.rows);
  const projects = [...new Set(state.rows.map((r) => r.projectId))].sort();
  const shown = state.rows.filter((row) => {
    if (state.filter !== 'all' && classOf(row) !== state.filter) return false;
    if (state.project && row.projectId !== state.project) return false;
    const q = state.query.trim().toLowerCase();
    return !q || [row.missionId, row.projectId, row.intent].some((v) => String(v || '').toLowerCase().includes(q));
  });
  const tabs = FILTERS.map(([key, label]) => '<button class="tab" data-filter="' + key + '"'
    + (state.filter === key ? ' data-active="1"' : '') + '>' + label + ' (' + c[key] + ')</button>').join('');
  const options = '<option value="">全部项目</option>' + projects.map((p) => '<option value="' + esc(p) + '"'
    + (state.project === p ? ' selected' : '') + '>' + esc(p) + '</option>').join('');
  const body = shown.length ? shown.map(rowHtml).join('') : '<tr><td colspan="8"><div class="empty-state"><div><strong>没有符合条件的任务</strong><span>调整筛选条件或创建一个新任务。</span></div></div></td></tr>';
  return '<section class="screen inbox-screen">'
    + '<div class="screen-head"><div><h1 class="screen-title">任务收件箱</h1><div class="screen-subtitle">跨项目查看任务状态、当前 Agent、进度与 Token。</div></div>'
    + '<div class="screen-actions"><button class="primary" data-new-task>＋ 新建任务</button></div></div>'
    + '<div class="tabs">' + tabs + '</div>'
    + '<div class="toolbar"><input class="search" type="search" data-search placeholder="搜索任务名称、项目、任务 ID..." value="' + esc(state.query) + '" />'
    + '<select data-project>' + options + '</select><span class="push muted">每 5 秒自动刷新</span></div>'
    + '<div class="card data-card"><table class="data-table"><thead><tr>'
    + '<th>任务名称</th><th>所属项目</th><th>状态</th><th>当前 Agent</th><th>进度</th><th>Token</th><th>更新时间</th><th></th>'
    + '</tr></thead><tbody>' + body + '</tbody></table></div></section>';
}

function modalHtml(projects) {
  const opts = projects.map((p) => '<option value="' + esc(p.projectId) + '"></option>').join('');
  return '<div class="modal-backdrop" data-modal><div class="modal"><h2>新建任务</h2>'
    + '<form data-create-form><div class="form-grid">'
    + '<div class="form-field"><label>所属项目</label><input type="text" name="projectId" list="project-options" required placeholder="已有项目或输入新 Project ID" /><datalist id="project-options">' + opts + '</datalist></div>'
    + '<div class="form-field"><label>任务名称 / 需求</label><input type="text" name="intent" required placeholder="例如：实现车速实时显示功能" /></div>'
    + '<div class="form-field"><label>验收标准（可选，一行一条）</label><textarea name="acceptance" placeholder="速度变化时 UI 能实时更新&#10;异常值有明确降级显示"></textarea></div>'
    + '</div><div class="notice" style="margin-top:14px">后端创建接口要求 Project + Contract；这里不会伪造执行模式，创建后由现有调度链路决定如何运行。</div>'
    + '<div class="modal-actions"><button type="button" data-close-modal>取消</button><button class="primary" type="submit">创建任务</button></div>'
    + '<div class="row-sub" data-form-error></div></form></div></div>';
}

let mounted = null;
let epoch = 0;

async function pull(st) {
  try {
    const [rows, projects] = await Promise.all([get('/api/missions'), get('/api/projects')]);
    if (st.epoch !== epoch || !st.root.isConnected) return;
    st.rows = Array.isArray(rows) ? rows : [];
    st.projects = Array.isArray(projects) ? projects : [];
    paint(st);
  } catch (err) {
    if (st.epoch !== epoch || !st.root.isConnected) return;
    st.root.innerHTML = '<div class="empty-state"><div><strong>加载失败</strong><span>' + esc(err.message) + '</span><div style="margin-top:12px"><button data-retry>重试</button></div></div></div>';
  }
}

function paint(st) {
  st.root.innerHTML = screenHtml(st);
}

function bind(st) {
  st.root.addEventListener('click', (ev) => {
    const row = ev.target.closest && ev.target.closest('[data-mission-id]');
    if (row) { location.hash = '#/missions/' + encodeURIComponent(row.dataset.missionId); return; }
    const tab = ev.target.closest && ev.target.closest('[data-filter]');
    if (tab) { st.filter = tab.dataset.filter; paint(st); return; }
    if (ev.target.closest && ev.target.closest('[data-new-task]')) {
      document.body.insertAdjacentHTML('beforeend', modalHtml(st.projects));
      return;
    }
    if (ev.target.closest && ev.target.closest('[data-close-modal]')) {
      document.querySelector('[data-modal]')?.remove();
      return;
    }
    if (ev.target.closest && ev.target.closest('[data-retry]')) void pull(st);
  });
  st.root.addEventListener('input', (ev) => {
    if (!ev.target.matches('[data-search]')) return;
    st.query = ev.target.value;
    paint(st);
    const input = st.root.querySelector('[data-search]');
    input?.focus();
    if (input) input.setSelectionRange(input.value.length, input.value.length);
  });
  st.root.addEventListener('change', (ev) => {
    if (ev.target.matches('[data-project]')) { st.project = ev.target.value; paint(st); }
  });
  if (document.body.dataset.inboxCreateBound === '1') return;
  document.body.dataset.inboxCreateBound = '1';
  document.addEventListener('click', (ev) => {
    const close = ev.target && ev.target.closest && ev.target.closest('[data-close-modal]');
    if (close || (ev.target && ev.target.matches && ev.target.matches('[data-modal]'))) {
      document.querySelector('[data-modal]')?.remove();
    }
  });
  document.addEventListener('submit', async function create(ev) {
    const form = ev.target.closest && ev.target.closest('[data-create-form]');
    if (!form) return;
    ev.preventDefault();
    const fd = new FormData(form);
    const acceptance = String(fd.get('acceptance') || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const body = {
      projectId: String(fd.get('projectId') || ''),
      contract: { intent: String(fd.get('intent') || '').trim(), acceptance, constraints: [], nonGoals: [], guardrails: [] },
    };
    const error = form.querySelector('[data-form-error]');
    try {
      const res = await fetch('/api/missions', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.message || ('HTTP ' + res.status));
      document.querySelector('[data-modal]')?.remove();
      if (json.missionId) location.hash = '#/missions/' + encodeURIComponent(json.missionId);
    } catch (err) {
      error.textContent = '创建失败：' + err.message;
    }
  }, { once:false });
}

export async function renderInboxPage(container) {
  if (mounted && mounted.root?.isConnected && mounted.container === container) return;
  epoch += 1;
  container.innerHTML = '<section class="screen" data-inbox-root><div class="card"><div class="skeleton" style="height:28px;width:180px"></div><div class="skeleton" style="height:260px;margin-top:18px"></div></div></section>';
  const st = { container, root: container.querySelector('[data-inbox-root]'), epoch, rows:[], projects:[], filter:'all', project:'', query:'', timer:null };
  mounted = st;
  bind(st);
  await pull(st);
  st.timer = setInterval(() => {
    if (!st.root.isConnected) { clearInterval(st.timer); return; }
    if (document.visibilityState !== 'hidden') void pull(st);
  }, 5000);
}
