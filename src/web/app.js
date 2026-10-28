/**
 * 外壳逻辑：hash 路由、导航高亮、面包屑、主题。
 *
 * 路由走 location.hash 而不是 History API：静态服务只认一层扁平文件名
 * （src/api/static.ts 的 SAFE_NAME），`/projects/<id>` 那种路径它给不出
 * index.html，要用就得给后端加一条"未知路径回退到 index.html"的路由。
 * hash 把这件事留在浏览器里。
 *
 * 这个文件只管"现在在看哪"，一格数据都不读；数据与渲染在 projects.js。
 * 分开是为了加任务详情页时外壳不用动。
 */

import { renderProjectsPage } from './projects.js';
import { renderOverviewPage } from './overview.js';
import { renderModelPriorityPage, leaveModelPriorityPage } from './model-priority.js';
import { renderProjectCatalogPage } from './project-catalog.js';
import { renderProjectSpecPage } from './project-spec.js';
import { renderInboxPage } from './inbox.js';
import { renderTaskDetailPage } from './task-detail-controller.js';
import { renderAgentsPage } from './agents.js';
import { renderSettingsPage } from './settings.js';
import { renderResourcePage, leaveResourcePage } from './resource-console.js';
import { renderPlanRunListPage, renderPlanRunPage } from './plan-run.js';
import { renderPlatformPage } from './platform.js';
import { createShell } from './console-shell.js';

/* ===== 主题 =====
 * 外壳固定浅色，**不跟着系统的 prefers-color-scheme 翻暗**。
 *
 * 已批准的三张画板只有暖白纸面一套值（DESIGN.md 的 paper / ink）。按系统切到
 * 暗色，等于把一套没评审过的配色推给人看；而 tokens.css 里那块
 * :root[data-theme="dark"] 是给旧页面留的兼容，不是给外壳用的。
 *
 * 仍然把 data-theme="light" 写上：tokens.css 的暗色块挂在 [data-theme="dark"]
 * 上，显式写 light 就不会有别的脚本（或历史 bookmark 里的状态）把它切过去。
 */
document.documentElement.dataset.theme = 'light';

/* ===== 路由 ===== */

/**
 * hash → 视图。空 hash 和认不出的写法都交给上层回 #/projects：
 * 手打的、从旧链接改的、地址栏清空重来的，都该落到一个有内容的地方，
 * 而不是停在"页面是白的"。
 *
 * 任务页是 `#/missions/<missionId>`（不是 `#/tasks`）：`missionId` 就是
 * 后端那个 id，路由与 API 用同一个名字，读代码的人不用在脑子里做映射。
 */
function parseRoute(hash) {
  const full = String(hash ?? '').replace(/^#/, '');
  const raw = full.split('?')[0];
  const query = new URLSearchParams(full.includes('?') ? full.slice(full.indexOf('?') + 1) : '');
  if (raw === '' || raw === '/') return { name: 'home' };
  if (raw === '/inbox') return { name: 'inbox' };
  if (raw === '/settings') return { name: 'settings' };
  const agentHit = /^\/agents(?:\/(.+))?$/.exec(raw);
  if (agentHit) {
    let agentId = agentHit[1] || '';
    try { agentId = decodeURIComponent(agentId); } catch { /* 保留原样 */ }
    return { name: 'agents', agentId };
  }
  const specHit = /^\/projects\/([^/]+)\/spec$/.exec(raw);
  if (specHit) {
    let projectId = specHit[1];
    try { projectId = decodeURIComponent(projectId); } catch { /* 保留原样 */ }
    return { name: 'project-spec', projectId };
  }
  const hit = /^\/projects(?:\/(.+))?$/.exec(raw);
  if (hit) {
    let projectId = hit[1] || '';
    try {
      projectId = decodeURIComponent(projectId);
    } catch {
      // 百分号写坏了就用原样：这个 id 可能真的存在，只是人手工改过地址栏。
      // 为了解码失败把整页打回默认路由，会把"我明明点进来的那条"弄丢。
    }
    return { name: 'projects', projectId };
  }
  // 没 id 的 `#/missions` 不匹配（`.+`），落到下面当未知处理：它不指向任何一条任务。
  const missionHit = /^\/missions\/(.+)$/.exec(raw);
  if (missionHit) {
    let missionId = missionHit[1];
    try {
      missionId = decodeURIComponent(missionId);
    } catch {
      // 与项目 id 同一策略。
    }
    return { name: 'mission', missionId, selectedStep: query.get('step') };
  }
  // 资源池是静态的一条路由（没有参数），所以匹配落在这里而不是上面那几条正则里。
  // 不再认原来那个占位地址（resources）：两个地址指同一个页面，而人一旦把旧
  // 地址发出去，就得永远维护它。未知 hash 统一回 #/projects。
  if (raw === '/pool') return { name: 'pool' };
  if (raw === '/platform') return { name: 'platform' };
  // 没 id 的 `#/plan-runs` 是列表（侧栏入口）；带 id 才是详情。
  // 空的 `#/plan-runs/` 不匹配，落到未知再回项目页——它不指向任何一次运行。
  if (raw === '/plan-runs') return { name: 'plan-runs' };
  const planHit = /^\/plan-runs\/(.+)$/.exec(raw);
  if (planHit) {
    let planRunId = planHit[1];
    try {
      planRunId = decodeURIComponent(planRunId);
    } catch {
      // 与项目 id 同一策略。
    }
    return { name: 'plan-run', planRunId };
  }
  return { name: 'unknown' };
}

const crumbs = document.getElementById('crumbs');
const view = document.getElementById('view');

/**
 * 外壳（导航选中态、顶栏项目控件、同步状态）在 console-shell.js。
 * 这里只把「现在在哪」告诉它，一行业务数据都不传：外壳要的只有路由名。
 */
const shell = createShell();

const node = (text, className) => {
  const span = document.createElement('span');
  if (className) span.className = className;
  // textContent 而不是 innerHTML 拼：面包屑里会出现地址栏来的项目 id，
  // 而"记得转义"是每加一个字段就可能漏一次的事，不给它机会。
  span.textContent = text;
  return span;
};

const link = (text, href) => {
  const a = document.createElement('a');
  a.href = href;
  a.textContent = text;
  return a;
};

/**
 * 导航高亮由外壳按**一级入口**决定（任务 / 资源），见 console-shell.js 的
 * navKeyForRoute：这里不再逐个路由算一遍 active——同一个判断写两处，加一个路由
 * 就会只改到一处，另一处的高亮停在上一个页面。
 *
 * 剩在这里的只有面包屑。它是**兼容层**：task.js 与 plan-run.js 会往 #crumbs 里
 * 写片段，而一级入口收敛成两个之后这段不该再显示（它在 DOM 里但视觉隐藏）。
 * 外壳自己画的那份不再假装知道 projectId —— 那是任务页的数据。
 */
function renderChrome(route) {
  crumbs.replaceChildren();
  if (route.name === 'home') { crumbs.appendChild(node('首页', 'here')); return; }
  if (route.name === 'inbox') {
    crumbs.appendChild(node('任务收件箱', 'here'));
    return;
  }
  if (route.name === 'agents') {
    if (route.agentId) crumbs.append(link('智能体', '#/agents'), node('/', 'sep'), node(route.agentId, 'here'));
    else crumbs.appendChild(node('角色与模型', 'here'));
    return;
  }
  if (route.name === 'settings') {
    crumbs.appendChild(node('设置', 'here'));
    return;
  }
  if (route.name === 'pool') {
    crumbs.appendChild(node('资源池', 'here'));
    return;
  }
  if (route.name === 'platform') {
    crumbs.appendChild(node('平台', 'here'));
    return;
  }
  if (route.name === 'plan-runs') {
    crumbs.appendChild(node('方案运行', 'here'));
    return;
  }
  if (route.name === 'plan-run') {
    // 详情页拿到快照后还是这个面包屑：运行 id 已经在地址栏里，不必等接口。
    crumbs.append(
      link('方案运行', '#/plan-runs'),
      node('/', 'sep'),
      node(route.planRunId, 'here'),
    );
    return;
  }
  if (route.name === 'mission') {
    // 三段面包屑的中间那段是 projectId，外壳不读数据、拿不到，
    // 所以这里只先搭个不骗人的样子，任务页拿到 MissionView 后自己重写。
    crumbs.append(
      link('项目', '#/projects'),
      node('/', 'sep'),
      node('任务 ' + route.missionId, 'here'),
    );
    return;
  }
  if (!route.projectId) {
    crumbs.appendChild(node('项目', 'here'));
    return;
  }
  crumbs.append(
    link('项目', '#/projects'),
    node('/', 'sep'),
    node(route.projectId, 'here'),
  );
}

let lastHash = location.hash;
function render() {
  const route = parseRoute(location.hash);
  if (!(route.name === 'agents' && !route.agentId) && !leaveModelPriorityPage()) {
    history.replaceState(null, '', lastHash || '#/'); return;
  }
  // 资源页本单没有草稿，leaveResourcePage 永远放行；仍然照同一模式调一次：
  // 下一张单（保存草稿）要在这里拦人，留好这个位置比事后再插回滚少一次改动。
  if (route.name !== 'pool' && !leaveResourcePage()) {
    history.replaceState(null, '', lastHash || '#/'); return;
  }
  lastHash = location.hash;


  if (route.name === 'unknown') {
    location.hash = '#/projects';
    return;
  }

  renderChrome(route);
  // 换页第一件事是让外壳重置自己在飞的那一轮请求：旧响应晚到会把项目名和同步
  // 时刻写进新页面。update() 返回的 promise 不 await —— 业务页不该等顶栏。
  void shell.update(route);
  if (route.name === 'home') { void renderOverviewPage(view); return; }

  if (route.name === 'inbox') {
    void renderInboxPage(view);
    return;
  }

  if (route.name === 'agents') {
    if (route.agentId) void renderAgentsPage(view, route.agentId);
    else void renderModelPriorityPage(view);
    return;
  }

  if (route.name === 'settings') {
    void renderSettingsPage(view);
    return;
  }

  if (route.name === 'pool') {
    void renderResourcePage(view);
    return;
  }

  if (route.name === 'platform') {
    void renderPlatformPage(view);
    return;
  }

  if (route.name === 'plan-runs') {
    void renderPlanRunListPage(view);
    return;
  }

  if (route.name === 'plan-run') {
    void renderPlanRunPage(view, route.planRunId);
    return;
  }

  if (route.name === 'mission') {
    // view 是外壳给的 DOM 容器，不是 Mission JSON：控制器自己拉只读接口。
    // 入口在这里取数会把"只读详情"变成外壳的职责，外壳就不再只管"在看哪"。
    void renderTaskDetailPage(view, route.missionId, route.selectedStep);
    return;
  }

  if (route.name === 'project-spec') {
    void renderProjectSpecPage(view, route.projectId);
    return;
  }

  if (route.name === 'projects' && !route.projectId) {
    void renderOverviewPage(view, '');
    return;
  }

  void renderOverviewPage(view, route.projectId);
}

window.addEventListener('hashchange', render);
render();
