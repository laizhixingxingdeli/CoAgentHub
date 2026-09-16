/**
 * 项目页：左栏项目列表，右栏详情卡 + 任务表。
 *
 * 只走 /api/*，只读。写操作（放行/打回/取消）刻意不做：规则该只有一份实现，
 * 界面里再写一份，迟早和平台判的不一样（观测面同理，见 src/api/web.ts 顶部）。
 *
 * 生成 HTML 的函数都是纯函数（喂数据 → 回字符串），DOM 写入只在这一个文件
 * 底部的 renderProjectsPage 里。这么分是因为浏览器不在测试里：纯函数能直接在
 * node 里喂一条假 Mission 断言列与 chip，而这些恰恰是最容易悄悄改错的部分
 * （少一个字段只是那一格空着，不报错）。
 */

/** 插入 DOM 的字段一律转义：projectId、intent、waitDetail 全是外部输入。 */
export const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const DASH = '—';

/** 阶段 = 内核 MissionStatus（src/kernel/mission.ts），不是设计稿里的词。 */
export const STAGE_CN = {
  investigating: '调查中',
  planning: '规划中',
  executing: '执行中',
  awaiting_review: '等你检视',
  completed: '已完成',
  blocked: '已中止',
};
/**
 * 取色。逐个对着观测面 .badge 抄（src/api/web.ts）。改一边就得改另一边，
 * 否则同一状态在两个界面里是两种颜色。只经由 stageChip 出去。
 */
const STAGE_TONE = {
  investigating: 'queued',
  planning: 'queued',
  executing: 'running',
  awaiting_review: 'unconfirmed',
  completed: 'done',
  blocked: 'failed',
};

/** 停机原因翻译成人话。只贴一个 enum 名字等于没贴——那是给写代码的人看的。 */
export const WAIT_REASON = {
  no_available_agent: '候选全在冷却，等一会儿重跑',
  platform_unreachable: '连不上平台自己 —— 平台侧故障，不是候选的问题',
  waiting_l3: '等你处理',
  escalated: '执行者升级了问题，等你答复',
  project_busy: '同项目有别的 Mission 占着改动名额',
  attempt_limit_reached: '尝试到上限了 —— 继续换候选不会产生新信息',
  target_changed: '目标分支在检视期间变了',
  base_revision_stale: '分叉基线已过期，需要重新核对',
  cancelled_by_user: '被叫停了',
};

const chip = (tone, text) => '<span class="chip ' + esc(tone) + '">' + esc(text) + '</span>';

/**
 * 阶段 chip：内核 MissionStatus → 中文 + 取色。
 *
 * 抽出来而不是让任务详情页再抄一份：中文表与取色表一旦有两份，加一个状态就会
 * 只改到一处，另一处的 chip 静悄悄退回默认灰——那种错没人会当 bug 报。
 */
export function stageChip(status) {
  return chip(STAGE_TONE[status] || 'queued', STAGE_CN[status] || status);
}

/**
 * 状态是第二根轴：阶段说"走到哪了"，这根说"为什么不动"。
 * 合成一个 chip 就只能显示其中一半，而"排着队"和"卡住了"在一张表里
 * 是完全不同的两件事——人就是照这一列决定先看哪条的。
 */
export function stateChip(row) {
  if (row.paused) return chip('cancelled', '已暂停');
  if (row.waitReason) return chip('unconfirmed', '等待中');
  if (row.status === 'completed') return chip('done', '已完成');
  if (row.status === 'blocked') return chip('failed', '已中止');
  return chip('running', '进行中');
}

/** waitDetail 优先：那是平台写下的具体情形，比 enum 翻出来的套话有用。 */
export function reasonText(row) {
  if (row.waitDetail) return row.waitDetail;
  if (!row.waitReason) return DASH;
  return WAIT_REASON[row.waitReason] || row.waitReason;
}

// 任务详情页也要这个数（总消耗 tokens 那一格），所以是导出的。
export const num = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString('en-US') : '0');

export function projectListHtml(projects, selectedId) {
  if (!projects || projects.length === 0) return '<li class="empty">还没有项目</li>';
  return projects
    .map(
      (p) =>
        '<li class="proj" data-id="' + esc(p.projectId) + '"' +
        (p.projectId === selectedId ? ' data-active="1"' : '') + '>' +
        '<div class="name">' + esc(p.projectId) + '</div>' +
        '<div class="meta">' + esc(num(p.missions)) + ' 个任务 · 改动名额 ' +
        (p.mutating ? '已占' : '空闲') + '</div>' +
        '</li>',
    )
    .join('');
}

export function detailCardHtml(project, workspace) {
  const slot = project.mutating ? '1/1' : '0/1';
  return '<div class="card"><h2>' + esc(project.projectId) + '</h2>'
    + '<dl class="fields">'
    +   '<dt>项目 ID</dt><dd class="mono">' + esc(project.projectId) + '</dd>'
    +   '<dt>代码仓库</dt><dd class="mono">' + esc(workspace.projectRoot || DASH) + '</dd>'
    +   '<dt>目标分支</dt><dd class="mono">' + esc(workspace.branch || DASH) + '</dd>'
    // 改动名额是内核那条"同项目同时只放一条改动"的不变量。显示成 n/1，
    // 是为了让人一眼看出下一条派得出去派不出去，而不是去猜。
    +   '<dt>变更中任务</dt><dd>' + chip(project.mutating ? 'unconfirmed' : 'queued', slot)
    +     ' <span class="muted">同一项目同时只放一条改动</span></dd>'
    + '</dl></div>';
}

/** 任务表表头。列名与顺序一起写死，测试照着这七个断言。 */
export const TASK_COLUMNS = ['任务 ID', '标题', '阶段', '状态', '原因', '最新更新时间', '总 Token'];

export function taskTableHtml(rows) {
  if (!rows || rows.length === 0) {
    return '<div class="card"><div class="empty">这个项目还没有任务</div></div>';
  }
  const head = TASK_COLUMNS.map((t) => '<th>' + esc(t) + '</th>').join('');
  const body = rows
    .map(
      (m) => '<tr data-mission-id="' + esc(m.missionId) + '">'
      + '<td class="mono">' + esc(m.missionId) + '</td>'
      + '<td class="cell-title">' + esc(m.intent || '（没有契约）') + '</td>'
      + '<td>' + stageChip(m.status) + '</td>'
      + '<td>' + stateChip(m) + '</td>'
      + '<td class="cell-reason">' + esc(reasonText(m)) + '</td>'
      // 列表 API 不返回时间戳。宁可显示 —，也不要拿"本页生成时间"冒充每条任务的
      // 更新时间——那是个会让人据此判断"谁卡住了"的假数字。
      + '<td class="muted">' + DASH + '</td>'
      + '<td class="mono">' + esc(num(m.usage && m.usage.total)) + '</td>'
      + '</tr>',
    )
    .join('');
  return '<div class="card"><div class="pane-title">任务</div><div class="table-wrap">'
    + '<table class="tasks"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>'
    + '</div></div>';
}

/* ===================== 下面才是碰 DOM 的部分 ===================== */

async function get(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(path + ' → HTTP ' + res.status);
  return res.json();
}

let mounted = null;
/** 上一次成功读到的列表。拉失败时保留它，界面继续显示旧数据而不是变成白板。 */
let data = null;
let selected = '';
/** 每个项目的仓库/分支要另拉一次 Mission 详情，拉过就不再拉。 */
const workspaceCache = new Map();

function skeleton() {
  return '<div class="page">'
    + '<div><div class="pane-title">项目</div><ul class="proj-list" id="proj-list"></ul></div>'
    + '<div id="proj-detail"><div class="empty">加载中…</div></div>'
    + '</div>';
}

/**
 * 拿哪条 Mission 去问仓库和分支：优先正占用改动名额的那条。
 * 只有真开过工作区的 Mission 才有 workspaceRef，先拿一条还没跑的去问，
 * 得到的是"没有"，而项目其实是有仓库的。
 */
function probeMission(projectId) {
  const rows = ((data && data.missions) || []).filter((m) => m.projectId === projectId);
  return rows.find((m) => m.isMutating) || rows[0];
}

async function loadWorkspace(projectId) {
  if (workspaceCache.has(projectId)) return workspaceCache.get(projectId);
  const probe = probeMission(projectId);
  if (!probe) return {};
  try {
    const view = await get('/api/missions/' + encodeURIComponent(probe.missionId));
    const ref = (view && view.workspaceRef) || {};
    const found = { projectRoot: ref.projectRoot, branch: ref.branch };
    // 两个字段都拿不到，说的是"这条还没开工作区"，不是"这个项目没有仓库"。
    // 连这个结果一起缓存住的话，Mission 跑起来以后那一栏也会永远是 —，
    // 除非人刷新页面——而他会以为那是后端给错了。
    if (found.projectRoot || found.branch) workspaceCache.set(projectId, found);
    return found;
  } catch {
    // 读不到不算错误态：这一栏只是顺带告诉你代码在哪，拿不到就显示 —，
    // 不该让整张详情卡塌掉。也不缓存失败——下次也许就好了。
    return {};
  }
}

function renderList() {
  const list = mounted.list;
  const projects = data ? data.projects : [];
  list.innerHTML = projectListHtml(projects, selected);
  if (projects.length === 0) return;
  // 点击只写 hash，不自己算视图：地址是唯一真相来源，绕开它就会出现
  // 地址和画面不一致的刷新，而那种刷新是没法发给别人看的。
  for (const el of list.querySelectorAll('.proj')) {
    el.onclick = () => {
      const id = el.dataset.id;
      if (id === selected) return;
      location.hash = '#/projects/' + encodeURIComponent(id);
    };
  }
}

async function renderDetail() {
  const box = mounted.detail;
  const project = data && data.projects.find((p) => p.projectId === selected);
  if (!project) {
    box.innerHTML = '<div class="empty">没有这个项目：' + esc(selected) + '</div>';
    return;
  }
  const projectId = project.projectId;
  const workspace = await loadWorkspace(projectId);
  // await 期间人可能又点了别的项目。只画当前选中的那个，否则先发出的请求
  // 后回来，会把新项目的详情盖成旧项目的。
  if (selected !== projectId) return;
  const rows = data.missions.filter((m) => m.projectId === projectId);
  box.innerHTML = detailCardHtml(project, workspace) + taskTableHtml(rows);
  // 行 → 任务详情页。监听写在 DOM 段而不是内联 onclick：内联的话这里能测到形状、
  // 测不到行为，而行为（点了去哪）才是要紧的那半。
  for (const tr of box.querySelectorAll('tr[data-mission-id]')) {
    tr.onclick = () => {
      location.hash = '#/missions/' + encodeURIComponent(tr.dataset.missionId);
    };
  }
}

function paint(error) {
  if (error && !data) {
    // 一次都没读到过。这时候写「还没有项目」是鋳了：人会以为平台真空了，
    // 而实际是 API 挂了。这两件事在屏幕上必须分得出采。
    mounted.list.innerHTML = '<li class="empty">读不到项目列表：' + esc(error.message) + '</li>';
    mounted.detail.innerHTML = '<div class="empty">刷新一下重试</div>';
    return;
  }
  renderList();
  if (!selected) {
    // 没选中就没内容。同时甩一句"读不到"和一句"先选一个项目"是自相矛盾的，
    // 所以没选中时只报提示。
    mounted.detail.innerHTML = '<div class="empty">左边选一个项目</div>';
    return;
  }
  if (error) {
    mounted.detail.innerHTML = '<div class="empty">读不到：' + esc(error.message) + '</div>';
    return;
  }
  void renderDetail();
}

/** 一次导航要取两个列表；连着点两下不该发出四份请求。 */
let inflight = null;
function load() {
  if (inflight) return inflight;
  inflight = Promise.all([get('/api/projects'), get('/api/missions')])
    .then(([projects, missions]) => {
      data = { projects, missions };
      return null;
    })
    .catch((err) => err)
    .finally(() => {
      // 落地就清。不清掉的话，下一次导航会拿到同一个已完成的 promise，
      // 页面从此再也看不到新开的 Mission。
      inflight = null;
    });
  return inflight;
}

export async function renderProjectsPage(container, projectId) {
  // 比 isConnected 而不是只比 container：从 #/resources 切回 #/projects 时，
  // 外壳把容器内容清空重建了，mounted 还指着一堆已离屏的节点。不检这一目的话
  // 列表会静静地写到一个不在树上的 ul 上——整屏白且不报错。
  if (!mounted || mounted.container !== container || !mounted.list.isConnected) {
    container.innerHTML = skeleton();
    mounted = {
      container,
      list: container.querySelector('#proj-list'),
      detail: container.querySelector('#proj-detail'),
    };
  }
  selected = projectId;

  // 旧数据先上一屏：人点下去要的是立刻看到选中态变了，不是等两个请求回来。
  // 没缓存时不抢这一下——骨架里那句「加载中」比一句「没有这个项目」诚实。
  if (data) paint(null);
  const error = await load();
  // 拉失败也照画：data 还是上一次的，界面继续显示旧数据。
  // 直接清空的话，一次瞬时故障看起来像"项目被删了"。
  paint(error);
}
