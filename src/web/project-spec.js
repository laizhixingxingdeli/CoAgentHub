import { esc } from './projects.js';

async function get(path) {
  const res = await fetch(path, { cache:'no-store' });
  if (!res.ok) throw new Error(path + ' → HTTP ' + res.status);
  return res.json();
}

function tabs(projectId) {
  const id = encodeURIComponent(projectId);
  return '<div class="project-detail-tabs">'
    + '<a href="#/projects/' + id + '">概览</a>'
    + '<a href="#/projects/' + id + '">任务</a>'
    + '<a class="active" href="#/projects/' + id + '/spec">项目规范</a>'
    + '<a href="#/projects/' + id + '">活动</a>'
    + '</div>';
}

function indexHtml(ctx, selected) {
  const specs = Array.isArray(ctx?.specs) ? ctx.specs : [];
  const decisions = Array.isArray(ctx?.decisions) ? ctx.decisions : [];
  const item = (row, type) => '<button type="button" data-spec-slug="' + esc(row.slug) + '"'
    + (selected === row.slug ? ' data-active="1"' : '') + '>'
    + '<span>' + esc(row.title || row.slug) + '</span><small>' + esc(type) + '</small></button>';
  return '<div class="spec-nav">'
    + '<div class="pane-title">项目规范</div>'
    + (specs.length ? specs.map((x) => item(x,'Spec')).join('') : '<div class="row-sub">暂无规范</div>')
    + '<div class="pane-title" style="margin-top:18px">架构决策</div>'
    + (decisions.length ? decisions.map((x) => item(x,'ADR')).join('') : '<div class="row-sub">暂无决策</div>')
    + '</div>';
}

function docHtml(doc, ctx) {
  if (!doc) {
    return '<div class="empty-state"><div><strong>选择一份规范</strong><span>从左侧选择 Living Spec 或架构决策。</span></div></div>';
  }
  if (doc.available === false) {
    return '<div class="empty-state"><div><strong>规范不可用</strong><span>' + esc(doc.note || '没有内容') + '</span></div></div>';
  }
  return '<article class="spec-doc"><div class="screen-head"><div><div class="row-sub">' + esc(doc.slug || '') + '</div><h1 class="screen-title" style="font-size:22px">' + esc(doc.title || '项目规范') + '</h1></div>'
    + '<span class="chip queued">只读</span></div>'
    + '<div class="spec-body">' + esc(doc.body || '').replace(/\n/g,'<br>') + '</div></article>';
}

function pageHtml(st) {
  const profile = st.context?.projectProfile || '';
  return '<section class="screen"><div class="screen-head"><div><h1 class="screen-title">' + esc(st.context?.projectName || st.projectId) + '</h1>'
    + '<div class="screen-subtitle">' + esc(profile || '项目长期记忆与工程规范') + '</div></div></div>'
    + tabs(st.projectId)
    + (st.context?.available === false
      ? '<div class="card"><div class="empty-state"><div><strong>项目规范暂不可读</strong><span>' + esc(st.context.note || '') + '</span></div></div></div>'
      : '<div class="spec-layout"><aside class="card">' + indexHtml(st.context, st.selected) + '</aside><div class="card">' + docHtml(st.doc, st.context) + '</div></div>')
    + '</section>';
}

let epoch = 0;

export async function renderProjectSpecPage(container, projectId) {
  epoch += 1;
  const current = epoch;
  container.innerHTML = '<section data-project-spec-root class="screen"><div class="card"><div class="skeleton" style="height:360px"></div></div></section>';
  const root = container.querySelector('[data-project-spec-root]');
  const st = { root, projectId, context:null, doc:null, selected:'', missionId:'' };
  try {
    const missions = await get('/api/missions');
    if (current !== epoch || !root.isConnected) return;
    const rows = (Array.isArray(missions) ? missions : []).filter((m) => m.projectId === projectId);
    const candidate = rows.find((m) => m.isMutating) || rows[0];
    if (!candidate) {
      st.context = { available:false, note:'这个项目还没有 Mission，无法定位工作区读取 .coagent/ 项目记忆。' };
      root.innerHTML = pageHtml(st);
      return;
    }
    st.missionId = candidate.missionId;
    st.context = await get('/api/missions/' + encodeURIComponent(st.missionId) + '/project-context');
    if (current !== epoch || !root.isConnected) return;
    const first = st.context?.specs?.[0] || st.context?.decisions?.[0];
    if (first) {
      st.selected = first.slug;
      st.doc = await get('/api/missions/' + encodeURIComponent(st.missionId) + '/project-context?slug=' + encodeURIComponent(first.slug));
    }
    if (current !== epoch || !root.isConnected) return;
    root.innerHTML = pageHtml(st);
  } catch (err) {
    root.innerHTML = '<div class="empty-state"><div><strong>项目规范加载失败</strong><span>' + esc(err.message) + '</span></div></div>';
    return;
  }
  root.addEventListener('click', async (ev) => {
    const button = ev.target.closest && ev.target.closest('[data-spec-slug]');
    if (!button) return;
    st.selected = button.dataset.specSlug;
    root.innerHTML = pageHtml(st);
    st.doc = await get('/api/missions/' + encodeURIComponent(st.missionId) + '/project-context?slug=' + encodeURIComponent(st.selected)).catch((err) => ({ available:false, note:err.message }));
    if (current === epoch && root.isConnected) root.innerHTML = pageHtml(st);
  });
}
