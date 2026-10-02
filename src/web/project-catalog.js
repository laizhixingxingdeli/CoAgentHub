import { esc, num } from './projects.js';
import { formatUsage } from './narrate.js';

async function get(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(path + ' → HTTP ' + res.status);
  return res.json();
}

function projectCard(project, missions) {
  const rows = missions.filter((m) => m.projectId === project.projectId);
  const running = rows.filter((m) => !['completed', 'blocked'].includes(m.status) && !m.paused && !m.waitReason).length;
  const waiting = rows.filter((m) => m.paused || m.waitReason).length;
  const usage = formatUsage(project.usage);
  return '<article class="card project-tile" data-project-id="' + esc(project.projectId) + '">'
    + '<div class="project-tile-head"><div class="project-icon">P</div><div>'
    + '<div class="project-name">' + esc(project.projectId) + '</div>'
    + '<div class="project-meta">' + (project.mutating ? '当前有变更任务占用修改名额' : '当前修改名额空闲') + '</div></div></div>'
    + '<div class="project-stats">'
    + '<div><b>' + esc(project.missions) + '</b><span>任务</span></div>'
    + '<div><b>' + esc(running) + '</b><span>运行中</span></div>'
    + '<div><b>' + esc(num(usage.total)) + '</b><span>Token</span></div>'
    + '</div>'
    + (waiting ? '<div class="row-sub" style="margin-top:10px">等待中任务 ' + waiting + ' 个</div>' : '')
    + '</article>';
}

function pageHtml(projects, missions, query) {
  const q = query.trim().toLowerCase();
  const shown = projects.filter((p) => !q || String(p.projectId).toLowerCase().includes(q));
  return '<section class="screen">'
    + '<div class="screen-head"><div><h1 class="screen-title">项目</h1><div class="screen-subtitle">按项目查看任务、并发占用与累计 Token。</div></div>'
    + '<div class="screen-actions"><a class="button primary" href="#/inbox">＋ 新建任务</a></div></div>'
    + '<div class="toolbar"><input class="search" data-project-search type="search" placeholder="搜索项目..." value="' + esc(query) + '" />'
    + '<span class="push muted">' + esc(shown.length) + ' 个项目</span></div>'
    + '<div class="project-grid">'
    + shown.map((p) => projectCard(p, missions)).join('')
    + '<div class="card create-tile"><div><div style="font-size:28px;color:#3478f6">＋</div><strong>新项目由首个任务自动建立</strong><div class="row-sub">后端没有独立 Project 创建接口</div></div></div>'
    + '</div></section>';
}

let mounted = null;
let epoch = 0;

function paint(st) {
  st.root.innerHTML = pageHtml(st.projects, st.missions, st.query);
}

async function pull(st) {
  try {
    const [projects, missions] = await Promise.all([get('/api/projects'), get('/api/missions')]);
    if (st.epoch !== epoch || !st.root.isConnected) return;
    st.projects = Array.isArray(projects) ? projects : [];
    st.missions = Array.isArray(missions) ? missions : [];
    paint(st);
  } catch (err) {
    if (st.epoch !== epoch || !st.root.isConnected) return;
    st.root.innerHTML = '<div class="empty-state"><div><strong>项目加载失败</strong><span>' + esc(err.message) + '</span><div style="margin-top:12px"><button data-project-retry>重试</button></div></div></div>';
  }
}

export async function renderProjectCatalogPage(container) {
  if (mounted && mounted.container === container && mounted.root?.isConnected) return;
  epoch += 1;
  container.innerHTML = '<section data-project-catalog class="screen"><div class="card"><div class="skeleton" style="width:160px;height:28px"></div><div class="skeleton" style="height:320px;margin-top:18px"></div></div></section>';
  const st = { container, root:container.querySelector('[data-project-catalog]'), projects:[], missions:[], query:'', epoch, timer:null };
  mounted = st;
  st.root.addEventListener('click', (ev) => {
    const card = ev.target.closest && ev.target.closest('[data-project-id]');
    if (card) location.hash = '#/projects/' + encodeURIComponent(card.dataset.projectId);
    if (ev.target.closest && ev.target.closest('[data-project-retry]')) void pull(st);
  });
  st.root.addEventListener('input', (ev) => {
    if (!ev.target.matches('[data-project-search]')) return;
    st.query = ev.target.value;
    paint(st);
    const input = st.root.querySelector('[data-project-search]');
    input?.focus();
    if (input) input.setSelectionRange(input.value.length, input.value.length);
  });
  await pull(st);
  st.timer = setInterval(() => {
    if (!st.root.isConnected) { clearInterval(st.timer); return; }
    if (document.visibilityState !== 'hidden') void pull(st);
  }, 5000);
}
