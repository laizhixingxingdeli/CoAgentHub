import { esc, stageChip, stateChip } from './projects.js';

/**
 * 活跃 Agent 数：只从已有 `GET /api/platform/status` 的 occupancy.activeLeases 读。
 *
 * 为什么不自己数「有多少条 Mission 在跑」：一个 Mission 可以有 0 个活动租约
 * （在退避、在等人），也可以有一条协调者 + 一条执行者同时活。拿任务数顶上去
 * 是两个数看着像、含义完全不同，而屏幕上分不出哪个是哪个。
 *
 * 读不到就是「未知」：0 是一个有意义的答案（真的没有 Agent 在跑），把「没读到」
 * 画成 0 会让首屏在接口还没回来时就断言「没有 Agent」。而且这个数**不影响任务
 * 状态**——Agent=0 不表示任务都做完了，任务完成与否只看 Mission 自己的阶段。
 */
export function activeAgentText(status) {
  const occupancy = status && typeof status === 'object' ? status.occupancy : undefined;
  if (!occupancy || typeof occupancy !== 'object' || occupancy.inapplicable === true) return '未知';
  const n = occupancy.activeLeases;
  // **只认真正的非负整数 number**。这里不做 Number() 转换：那会把 '2'、false（→0）、
  // ''（→0）、null（→0）都悄悄变成数字，而屏幕上一个「0 个」和「这一格没读到」
  // 长得一模一样——前者是「真的没有 Agent」，后者是「不知道」。把不知道说成 0，
  // 首屏就在断言一件没人核对过的事。0 本身是合法答案（真的没有 Agent），保留。
  // 负数、小数不是占用数的形状（占用是条数），同样按未知处理，不四舍五入成 0。
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? String(n) : '未知';
}

export function newestMissions(rows) {
  return [...rows].sort((a, b) => {
    const delta = (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
    return delta || String(a.missionId).localeCompare(String(b.missionId));
  });
}

export function missionTableHtml(rows) {
  if (!rows.length) return '<div class="empty">暂无任务</div>';
  // 标题只留两行预览（样式在 ui.css 的 .mission-title）：长标题一行占满会把首屏
  // 之后的列表全推到看不见的地方。完整原文放在 title 上、也放在任务详情页的
  // h1 里，所以裁剪不会藏掉信息；链接仍是真 <a href>，键盘与读屏都照旧能进。
  return '<div class="table-wrap"><table class="tasks"><thead><tr><th>任务</th><th>状态</th><th>最近活动</th></tr></thead><tbody>'
    + newestMissions(rows).map(row => '<tr><td><a class="mission-title" title="' + esc(row.intent || row.missionId)
      + '" href="#/missions/' + encodeURIComponent(row.missionId) + '">'
      + esc(row.intent || row.missionId) + '</a><div class="row-sub">' + esc(row.missionId) + '</div></td>'
      + '<td>' + stageChip(row.status) + ' ' + stateChip(row) + '</td><td class="mono">'
      + esc(row.updatedAt ? new Date(row.updatedAt).toLocaleString('zh-CN') : '未知') + '</td></tr>').join('')
    + '</tbody></table></div>';
}

export function overviewHtml(data) {
  const rows = Array.isArray(data.missions) ? data.missions : [];
  // 执行阶段任务：还在流水线里走（调查 / 规划 / 执行中）且没停在暂停或等待上的那几条。
  // 这是「有多少条任务在走」，与「有多少个 Agent 在跑」是两个数——一条任务可以有
  // 0 个活动租约（在退避、在等人），也可以同时有协调者 + 执行者两条租约。拿任务数
  // 顶活跃数，屏幕上谁也分不出哪个是哪个；反过来拿活跃数改任务数，Agent=0 就会
  // 让还在等的任务看起来都做完了。所以两个数各写一句，谁也不推谁。
  const running = rows.filter(row => row.status !== 'completed' && row.status !== 'blocked'
    && !row.paused && !row.waitReason && ['executing', 'investigating', 'planning'].includes(row.status));
  const pools = Object.values(data.pools || {}).filter(Array.isArray).flat();
  const unhealthy = pools.filter(row => row.health?.circuit?.state === 'open').length;
  const errors = Array.isArray(data.errors) ? data.errors : [];
  return '<section class="screen"><h1 class="screen-title">首页</h1><div class="card platform-strip">'
    + '<strong>平台状态</strong><span>服务：' + (data.status ? '已连接' : '未读取') + '</span>'
    + '<span title="还在流水线里走（调查 / 规划 / 执行中）且没停在暂停或等待上的任务数；和下面的活跃 Agent 不是一个数">执行阶段任务：' + running.length + ' 项</span>'
    + '<span data-active-agents="1">活跃 Agent：' + esc(activeAgentText(data.status)) + ' 个</span>'
    + '<span>模型熔断：' + (data.pools ? unhealthy : '未知') + '</span>'
    + '<span>检视投递：未提供汇总</span></div>'
    + (errors.length ? '<div class="note">部分数据未更新：' + esc(errors.join('；')) + '</div>' : '')
    + '<section class="card"><h2>执行阶段的任务</h2>' + missionTableHtml(running) + '</section></section>';
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
