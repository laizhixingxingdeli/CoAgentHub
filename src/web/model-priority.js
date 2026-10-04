import { esc } from './projects.js';

export const MODEL_ROLES = { classifier: '分类器', coordinator: '协调者', executor: '执行者', independent_reviewer: '独立检视者' };
export function candidateConfig(row) {
  const value = { profileId: row.profileId, endpoint: row.endpoint };
  if (row.facts !== undefined) value.facts = row.facts;
  if (row.enabled !== undefined) value.enabled = row.enabled;
  return value;
}
export function moveCandidate(rows, index, direction) {
  const next = [...rows];
  const target = index + direction;
  if (index >= 0 && index < next.length && target >= 0 && target < next.length) [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function priorityHtml(state) {
  const rows = state.drafts[state.role] || [];
  const dirty = JSON.stringify(rows) !== JSON.stringify(state.saved[state.role] || []);
  return '<section class="screen"><h1 class="screen-title">角色与模型</h1><div class="tabs">'
    + Object.entries(MODEL_ROLES).map(([id, label]) => '<button data-model-role="' + id + '" class="tab"' + (id === state.role ? ' data-active="1"' : '') + '>' + label + '</button>').join('')
    + '</div><section class="card">' + (state.message ? '<p role="status">' + esc(state.message) + '</p>' : '')
    + rows.map((row, index) => '<div class="priority-row"><strong>' + (index + 1) + '. ' + esc(row.profileId) + '</strong>'
      + '<span>' + esc((row.facts || []).find(f => f.key === 'model')?.value || '') + '</span><span>'
      + '<button data-priority-index="' + index + '" data-move="-1"' + (!index || state.busy ? ' disabled' : '') + '>上移</button> '
      + '<button data-priority-index="' + index + '" data-move="1"' + (index === rows.length - 1 || state.busy ? ' disabled' : '') + '>下移</button> '
      + '<button data-priority-index="' + index + '" data-toggle' + (state.busy ? ' disabled' : '') + '>' + (row.enabled === false ? '启用' : '停用') + '</button> '
      + '<button data-priority-index="' + index + '" data-remove' + (state.busy ? ' disabled' : '') + '>移除</button></span></div>').join('')
    + (!rows.length ? '<p>候选为空，该角色无法调度。</p>' : '')
    + '<div class="priority-actions"><span>' + (dirty ? '有未保存修改' : '已保存') + '</span><button data-priority-save' + (!dirty || state.busy || state.conflict ? ' disabled' : '') + '>保存优先级</button>'
    + (state.conflict ? '<button data-priority-compare>读取最新配置</button>' : '') + '</div>'
    + (state.latest ? '<details open><summary>最新配置</summary><pre>' + esc(JSON.stringify(state.latest[state.role], null, 2)) + '</pre><button data-priority-rebase>已比较，保留草稿重试</button></details>' : '')
    + '</section></section>';
}

let mounted = null;
export function leaveModelPriorityPage() {
  if (!mounted) return true;
  if (mounted.dirty() && !window.confirm('模型顺序尚未保存，离开将放弃修改。确认离开？')) return false;
  mounted.stop();
  mounted = null;
  return true;
}
export async function renderModelPriorityPage(container) {
  if (mounted?.root.isConnected) return;
  mounted?.stop();
  const root = document.createElement('section');
  container.replaceChildren(root);
  const controller = new AbortController();
  const state = { role: 'coordinator', saved: {}, drafts: {}, revision: '', busy: false, conflict: false, latest: null, message: '' };
  const dirty = () => Object.keys(MODEL_ROLES).some(role => JSON.stringify(state.saved[role] || []) !== JSON.stringify(state.drafts[role] || []));
  const paint = () => { if (root.isConnected) root.innerHTML = priorityHtml(state); };
  const read = async () => {
    const response = await fetch('/api/pools/config', { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error('读取失败：HTTP ' + response.status);
    return response.json();
  };
  root.innerHTML = '<div class="note">加载中…</div>';
  const unload = event => { if (dirty()) { event.preventDefault(); event.returnValue = ''; } };
  window.addEventListener('beforeunload', unload);
  function stop() { controller.abort(); window.removeEventListener('beforeunload', unload); }
  mounted = { stop, root, dirty };
  try {
    const config = await read();
    state.revision = config.revision;
    for (const role of Object.keys(MODEL_ROLES)) state.saved[role] = (config[role] || []).map(candidateConfig);
    state.drafts = structuredClone(state.saved);
    paint();
  } catch (error) { state.message = error.message; paint(); return; }
  root.addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (!button || button.disabled || state.busy) return;
    if (button.dataset.modelRole) { state.role = button.dataset.modelRole; paint(); return; }
    const index = Number(button.dataset.priorityIndex);
    if (button.hasAttribute('data-move')) state.drafts[state.role] = moveCandidate(state.drafts[state.role], index, Number(button.dataset.move));
    if (button.hasAttribute('data-toggle')) state.drafts[state.role][index].enabled = state.drafts[state.role][index].enabled === false;
    if (button.hasAttribute('data-remove')) state.drafts[state.role].splice(index, 1);
    if (button.hasAttribute('data-priority-rebase')) {
      state.revision = state.latest.revision; state.conflict = false; state.latest = null; state.message = '草稿保留，请重新保存。';
    }
    if (button.hasAttribute('data-priority-compare')) {
      try { state.latest = await read(); } catch (error) { state.message = error.message; }
    }
    if (button.hasAttribute('data-priority-save')) {
      if (!state.drafts[state.role].some(row => row.enabled !== false) && !window.confirm('保存后该角色没有启用候选，将无法调度。确认保存？')) return;
      state.busy = true; paint();
      try {
        const response = await fetch('/api/pools/' + state.role + '/configure', { method: 'POST', signal: controller.signal,
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: state.revision, candidates: state.drafts[state.role] }) });
        const body = await response.json();
        if (!response.ok) { state.conflict = response.status === 409; throw new Error(body.message || '保存失败：HTTP ' + response.status); }
        state.revision = body.revision;
        for (const role of Object.keys(MODEL_ROLES)) {
          const unchanged = JSON.stringify(state.drafts[role] || []) === JSON.stringify(state.saved[role] || []);
          state.saved[role] = (body[role] || []).map(candidateConfig);
          if (role === state.role || unchanged) state.drafts[role] = structuredClone(state.saved[role]);
        }
        state.message = '已保存，下一次调度生效。';
      } catch (error) { state.message = error.message; }
      state.busy = false;
    }
    paint();
  });
}
