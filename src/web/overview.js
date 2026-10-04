import { esc, stageChip, stateChip } from './projects.js';

export function newestMissions(rows) {
  return [...rows].sort((a, b) => {
    const delta = (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
    return delta || String(a.missionId).localeCompare(String(b.missionId));
  });
}

export function missionTableHtml(rows) {
  if (!rows.length) return '<div class="empty">暂无任务</div>';
  return '<div class="table-wrap"><table class="tasks"><thead><tr><th>任务</th><th>状态</th><th>最近活动</th></tr></thead><tbody>'
    + newestMissions(rows).map(row => '<tr><td><a href="#/missions/' + encodeURIComponent(row.missionId) + '">'
      + esc(row.intent || row.missionId) + '</a><div class="row-sub">' + esc(row.missionId) + '</div></td>'
      + '<td>' + stageChip(row.status) + ' ' + stateChip(row) + '</td><td class="mono">'
      + esc(row.updatedAt ? new Date(row.updatedAt).toLocaleString('zh-CN') : '未知') + '</td></tr>').join('')
    + '</tbody></table></div>';
}

export function overviewHtml(data) {
  const running = data.missions.filter(row => row.status !== 'completed' && row.status !== 'blocked'
    && !row.paused && !row.waitReason && ['executing', 'investigating', 'planning'].includes(row.status));
  const pools = Object.values(data.pools || {}).filter(Array.isArray).flat();
  const unhealthy = pools.filter(row => row.health?.circuit?.state === 'open').length;
  return '<section class="screen"><h1 class="screen-title">首页</h1><div class="card platform-strip">'
    + '<strong>平台状态</strong><span>服务：' + (data.status ? '已连接' : '未读取') + '</span>'
    + '<span>进行中任务：' + running.length + ' 项</span><span>模型熔断：' + (data.pools ? unhealthy : '未知') + '</span>'
    + '<span>检视投递：未提供汇总</span></div>'
    + (data.errors.length ? '<div class="note">部分数据未更新：' + esc(data.errors.join('；')) + '</div>' : '')
    + '<section class="card"><h2>进行中的任务</h2>' + missionTableHtml(running) + '</section></section>';
}

async function readJson(path, signal) {
  const response = await fetch(path, { cache: 'no-store', signal });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return response.json();
}

let active = null;

/** 页面所有请求共用 AbortController，离页与隐藏立即取消，防止旧响应覆盖。 */
export async function renderOverviewPage(container, projectId = null) {
  active?.stop();
  const root = document.createElement('section');
  container.replaceChildren(root);
  const controller = new AbortController();
  const state = { projects: [], missions: [], status: null, pools: null, errors: [] };
  let stopped = false;
  let busy = false;
  let requestController = null;
  const paint = () => {
    if (projectId === null) { root.innerHTML = overviewHtml(state); return; }
    const selected = projectId || state.projects[0]?.projectId || '';
    root.innerHTML = '<section class="screen"><h1 class="screen-title">项目任务列表</h1><div class="toolbar"><label>项目 <select data-project-select>'
      + state.projects.map(p => '<option value="' + esc(p.projectId) + '"' + (selected === p.projectId ? ' selected' : '') + '>' + esc(p.projectId) + '</option>').join('')
      + '</select></label></div>' + (state.errors.length ? '<div class="note">' + esc(state.errors.join('；')) + '</div>' : '')
      + '<section class="card">' + missionTableHtml(state.missions.filter(m => m.projectId === selected)) + '</section></section>';
  };
  const pull = async () => {
    if (busy || stopped || document.visibilityState === 'hidden') return;
    busy = true;
    const paths = projectId === null ? ['/api/projects', '/api/missions', '/api/platform/status', '/api/pools'] : ['/api/projects', '/api/missions'];
    requestController = new AbortController();
    const results = await Promise.allSettled(paths.map(path => readJson(path, requestController.signal)));
    if (!stopped && root.isConnected && document.visibilityState !== 'hidden') {
      state.errors = [];
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') state[['projects', 'missions', 'status', 'pools'][index]] = result.value;
        else {
          state[['projects', 'missions', 'status', 'pools'][index]] = index < 2 ? [] : null;
          state.errors.push(paths[index] + '：' + result.reason.message);
        }
      });
      paint();
    }
    busy = false;
  };
  root.addEventListener('change', event => {
    if (event.target.matches('[data-project-select]')) location.hash = '#/projects/' + encodeURIComponent(event.target.value);
  });
  const timer = setInterval(() => { if (!root.isConnected) stop(); else void pull(); }, 5000);
  const onHash = () => stop();
  const onVisibility = () => { if (document.visibilityState === 'hidden') requestController?.abort(); else void pull(); };
  function stop() {
    stopped = true;
    controller.abort();
    requestController?.abort();
    clearInterval(timer);
    window.removeEventListener('hashchange', onHash);
    document.removeEventListener('visibilitychange', onVisibility);
  }
  window.addEventListener('hashchange', onHash);
  document.addEventListener('visibilitychange', onVisibility);
  active = { stop };
  root.innerHTML = '<div class="note">加载中…</div>';
  await pull();
}
