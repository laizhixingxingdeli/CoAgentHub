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
import { renderTaskPage } from './task.js';
import { renderAgentsPage } from './agents.js';
import { renderSettingsPage } from './settings.js';
import { renderPoolPage } from './pool.js';
import { renderPlanRunListPage, renderPlanRunPage } from './plan-run.js';
import { renderPlatformPage } from './platform.js';

/* ===== 主题 =====
 * 暗色令牌挂在 :root[data-theme="dark"] 上（与观测面同一套写法），所以这里
 * 只负责把这个属性写对，一个颜色都不复制。跟随系统而不是默认亮色：
 * 人已经在暗色环境里了，页面在夜里就该是块黑纸而不是一块白板。
 */
const darkScheme = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  document.documentElement.dataset.theme = darkScheme.matches ? 'dark' : 'light';
}
applyTheme();
// 系统中途切主题（macOS 的"日落到日出"）时跟着切，不要求人刷新。
darkScheme.addEventListener('change', applyTheme);

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
const navItems = [...document.querySelectorAll('.nav [data-route]')];

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

function renderChrome(route) {
  // 任务页归在「项目」下：它是从项目页的任务表点进去的，没有自己的入口。
  const active = route.name === 'home' ? 'home' : route.name === 'mission' ? 'projects' : route.name === 'inbox' ? 'inbox'
    : route.name === 'agents' ? 'agents'
    : route.name === 'settings' ? 'settings'
    : route.name === 'pool' ? 'pool'
    : route.name === 'platform' ? 'platform'
    : (route.name === 'plan-runs' || route.name === 'plan-run') ? 'plan-runs'
    : 'projects';
  for (const el of navItems) {
    if (el.dataset.route === active) el.dataset.active = '1';
    else el.removeAttribute('data-active');
  }

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
  lastHash = location.hash;


  if (route.name === 'unknown') {
    location.hash = '#/projects';
    return;
  }

  renderChrome(route);
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
    void renderPoolPage(view);
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
    void renderTaskPage(view, route.missionId, route.selectedStep);
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
