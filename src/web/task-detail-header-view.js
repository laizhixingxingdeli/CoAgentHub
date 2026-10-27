/**
 * 任务详情页头的渲染层：把 task-detail-header.js 已经算好的投影拼成 HTML，
 * 再绑上几个只在本页头内生效的点击（展开 intent、切页签、开合费用明细）。
 *
 * **为什么投影与渲染分两个文件**：这一层要断言的每一条都是「看起来对、其实在说谎」
 * 的写法——把补修塞进状态词、给 direct 编一个主控模型、把缺省 costCap 补成 10、
 * 把编号用省略号截断、终态残留的 waitInfo 说成「等你处理」。判断一律留在
 * task-detail-header.js（那里是纯函数，node 里喂假详情就能断言），这里只负责
 * 转义和 DOM，**不重算六态、费用或补修**：抄第二份判断，两处迟早只改到一处，
 * 而漏改的那边在界面上只是一句不一样的话，不报错也不崩。
 *
 * **不 import task.js**：那边是详情页的渲染模块，它要 import 本模块来接线页头；
 * 互相 import 在浏览器原生 ES module 下不成环报错，只会让某一侧拿到 undefined，
 * 然后整页白掉。同理不 import application 层——前端只走 `/api/*` 的 view。
 */
import { esc } from './projects.js';
import { projectTaskHeader } from './task-detail-header.js';
import { taskCostDetailHtml } from './task-detail-cost-view.js';

/**
 * 状态前面的那颗 16×16 图标**只按 statusKey 认**，不看中文、不看 statusText。
 *
 * 按文案映射的话，状态词从 narrate 的 STAGE_CN 改一个字（「待检视」→「待检视者确认」
 * 之类）图标就静默退成灰点，屏幕上只是「有点不像画板」，没人会去查。也是
 * console-assets.json 里登记过的那几张图，不另画。
 */
const STATUS_ICON = new Map([
  ['executing', '/console-icon-running.svg'],
  ['awaiting_review', '/console-icon-review.svg'],
  ['completed', '/console-icon-complete.svg'],
  ['blocked', '/console-icon-aborted.svg'],
  ['investigating', '/console-icon-dot.svg'],
  ['planning', '/console-icon-dot.svg'],
]);
const STATUS_ICON_FALLBACK = '/console-icon-dot.svg';

function statusIcon(statusKey) {
  return STATUS_ICON.get(statusKey) || STATUS_ICON_FALLBACK;
}

const NEXT_STEP_PREFIX = '下一步：';
const NEXT_STEP_UNKNOWN = '未知';

/**
 * 费用明细框的开合状态放在本模块里，不放 controller。
 *
 * 它是一次纯本地交互（点开、看、返回），跟 Mission 的数据无关；塞进 controller 就要
 * 为它加一条 state 字段和一次重渲染，而重渲染会把整页（正文、时间线）重建一遍——
 * 用户只是想看一眼费用，滚到的位置却丢了。放这里，刷新（重调 taskHeaderHtml）时
 * 开合也跟着保留，这正是「刷新不丢开合」那条验收要的行为。
 *
 * 归属用 missionId 记住：换一条任务时不该把上一条的框带过来。
 */
let costOpen = false;
let costMissionId = '';
let costHashBound = false;
/** hashchange 关闭时要改的是「当前这块 DOM」，绑定那一刻的根节点就是它。 */
let costRoot = null;

/** 三个页签的顺序与文案就是详情页的三块内容，不按数据动态生成。 */
const TABS = [
  { key: 'workflow', label: '工作流' },
  { key: 'delivery', label: '交付与验证' },
  { key: 'contract', label: '契约' },
];

/** 未知页签退回工作流：留一个不是页签的 key，三个按钮就全不选中，页头看起来像坏了。 */
function tabKey(value) {
  const key = String(value ?? '').trim();
  return TABS.some((tab) => tab.key === key) ? key : 'workflow';
}

const INTENT_EXPANDED_LABEL = '收起 intent';
const INTENT_COLLAPSED_LABEL = '展开 intent';

/**
 * 页头 HTML。根节点 section.td-header。
 *
 * 编号**全文**放两处：data-mission-id（接线与测试用）和可见文本。页头是人对身份
 * 的最后一道确认，中间省略过的编号看着像完整编号，复制出去却对不上任何一条 Mission。
 *
 * 状态词只出现在 .td-status-text，每个附标各占 .td-marks 下的一个子节点：混在
 * statusText 里，「执行中 · 直接主控 · 补修」就会被读成一个不存在的第七种状态。
 * 处理人、恢复方式与下一步同处 .td-decision 但各占一个子节点：合成一句之后，
 * 人分不清「谁该动」「会不会自己好」和「下一步干什么」。
 *
 * 全文字段（intent 也是外部输入）一律经 esc。
 */
export function taskHeaderHtml(view, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const header = projectTaskHeader(view, opts);
  const tab = tabKey(opts.tab);
  const intentExpanded = opts.intentExpanded === true;
  // 编号原样取出，不经任何截断/摘要函数：页头是身份的最后一道确认。
  const missionId = header.missionId;
  const marks = Array.isArray(header.marks) ? header.marks : [];

  // 换了一条 Mission 就先关掉费用框：上一条打开着，下一条一进来也是打开的，
  // 而框里的数字已经换成新任务的，人以为看到的是自己刚点开的那个。
  if (missionId !== costMissionId) {
    costOpen = false;
    costMissionId = missionId;
  }
  const costIsOpen = costOpen === true;

  // 下一步只认平台给的 waitInfo.action，没有就是「未知」。executing 只说明处在哪一
  // 个阶段，不证明下一步是什么；照着状态编一句「继续执行」，人会等一件没人要做的事。
  const nextStep = String(header.nextStep ?? '').trim();
  const nextStepText = NEXT_STEP_PREFIX + (nextStep === '' ? NEXT_STEP_UNKNOWN : nextStep);

  const markNodes = marks.map((mark) => (
    '<span class="td-mark" data-mark="' + esc(mark.key) + '">' + esc(mark.text) + '</span>'
  ));

  const tabs = TABS.map((item) => (
    '<button type="button" class="td-tab" data-tab="' + esc(item.key) + '"'
    + ' aria-selected="' + (item.key === tab ? 'true' : 'false') + '"'
    + (item.key === tab ? ' data-active="1"' : '') + '>'
    + esc(item.label) + '</button>'
  )).join('');

  // 返回链接是页头最上面一行（画板 2:140 节点 41:419）。做成真链接而不是按钮：
  // 按钮要靠本页的点击处理器改 hash，处理器漏绑时它就是个不动的装饰。
  return '<section class="td-header" data-mission-id="' + esc(missionId)
    + '" data-tab="' + esc(tab) + '"'
    + (costIsOpen ? ' data-cost-open="true"' : '') + '>'
    + '<a class="td-back" href="#/projects">返回任务列表</a>'
    + '<div class="td-identity">'
    + '<h1 class="td-mission-id">' + esc(missionId) + '</h1>'
    // intent 与展开按钮同一行：按钮单独占一行会把身份块撑成三行，页头比页签还高。
    + '<div class="td-intent-row">'
    + '<p class="td-intent" data-expanded="' + (intentExpanded ? 'true' : 'false') + '">'
    + esc(header.intent) + '</p>'
    + '<button type="button" class="td-intent-toggle" data-action="toggle-intent">'
    + esc(intentExpanded ? INTENT_EXPANDED_LABEL : INTENT_COLLAPSED_LABEL) + '</button>'
    + '</div>'
    + '</div>'
    + '<div class="td-status-row">'
    // 图标与状态词同一个节点：分成两格时，列宽一改图标就与词脱开，读起来像两个事实。
    // 文字仍只有 header.statusText——附标、处理人、下一步各自另有节点。
    + '<span class="td-status-text" data-status-key="' + esc(header.statusKey) + '">'
    + '<img class="td-status-dot" src="' + esc(statusIcon(header.statusKey)) + '" width="16" height="16" alt="" />'
    + esc(header.statusText) + '</span>'
    + '<span class="td-marks">' + markNodes.join('') + '</span>'
    + '<span class="td-decision">'
    + '<span class="td-owner">' + esc(header.owner && header.owner.text) + '</span>'
    + '<span class="td-recovery">' + esc(header.recovery && header.recovery.text) + '</span>'
    + '<span class="td-next">' + esc(nextStepText) + '</span>'
    + '</span>'
    + '</div>'
    // 40px 单行事实带：保障 / 协作 / 费用 / 时间四格。这里不出现协调者模型字段——
    // direct 的两层协作里平台拿不到主控会话的模型，写一个占位 id 就是凭空造事实。
    + '<div class="td-facts">'
    + '<span class="td-assurance">' + esc(header.assurance) + '</span>'
    + '<span class="td-collaboration">' + esc(header.collaboration) + '</span>'
    // 费用格是真按钮：用 span 挂点击在键盘上按不到，也没有 button 的语义。
    // 可见文字仍是 header.cost.line 那一句，明细框里才展开标价折算的细节。
    + '<button type="button" class="td-cost" data-action="open-cost">'
    + esc(header.cost && header.cost.line) + '</button>'
    + '<span class="td-time">运行 ' + esc(header.time && header.time.runningText)
    + ' · 创建于 ' + esc(header.time && header.time.createdText) + '</span>'
    + '</div>'
    + '<nav class="td-tabs">' + tabs + '</nav>'
    // 费用框放在页头最后：它是 fixed 居中的浮层，不进页头的纵向排版，
    // 放在事实带或页签之间会让「下一块从哪儿开始」读错。
    + taskCostDetailHtml(header.cost, costIsOpen)
    + '</section>';
}

/** 开合落到现有 DOM 上：只改属性，不重建节点——重建会把用户滚到的位置丢掉。 */
function applyCostOpen(root, open) {
  if (!root || typeof root.querySelector !== 'function') return;
  const box = root.querySelector('.td-cost-detail');
  if (box) {
    if (open) box.removeAttribute('hidden');
    else box.setAttribute('hidden', '');
  }
  if (open) root.setAttribute('data-cost-open', 'true');
  else root.removeAttribute('data-cost-open');
}

/**
 * hash 指回当前这条 Mission 时才允许费用框继续开着。
 *
 * 用「前缀 + 任务号」而不是整串相等：真实 hash 会带查询串（#/missions/<id>?tab=…），
 * 整串比对会让每一次合法的重进都被判成「离开了」。
 */
function hashKeepsCostOpen(hash) {
  const raw = String(hash ?? '');
  const path = raw.split('?')[0];
  if (costMissionId === '') return false;
  const base = '#/missions/' + costMissionId;
  return path === base || path === '#/missions/' + encodeURIComponent(costMissionId);
}

/**
 * 离页即关：hashchange 只注册一次。
 *
 * addEventListener 反复注册不会覆盖，详情页每次重绑都加一个监听，几次之后一次
 * 离开就触发多遍（今天只是多次置关，将来任何有副作用的处理都会被放大成事故）。
 */
function bindCostHashClose(root) {
  if (costHashBound) return;
  const doc = root && root.ownerDocument ? root.ownerDocument : null;
  const win = doc && doc.defaultView ? doc.defaultView : null;
  if (!win || typeof win.addEventListener !== 'function') return;
  costHashBound = true;
  win.addEventListener('hashchange', () => {
    const hash = win.location ? win.location.hash : '';
    if (hashKeepsCostOpen(hash)) return;
    costOpen = false;
    applyCostOpen(costRoot, false);
  });
}

/**
 * 只绑 root 里的点击。
 *
 * 用 `el.onclick =` 而不是 addEventListener：详情页每次重渲染都会再调一次本函数，
 * 赋值会覆盖上一次的处理器；监听器则会一层层叠上去，点一次「展开」翻转多次，
 * 表现为按钮点了没反应（翻两下正好回到原状）。
 *
 * 展开只翻 data-expanded 与按钮文案，**不动 data-mission-id**：那是身份，
 * 一次交互把它改掉，后续按 missionId 找元素的逻辑就全落空。
 *
 * 费用框同理用 onclick 赋值：换任务时详情页会重渲染，叠监听的话点一次「打开」
 * 会在已经打开之后又被前面的旧处理器关一次，表现为按钮点了没反应。
 */
export function bindTaskHeader(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return;

  costRoot = root;
  bindCostHashClose(root);

  // 用 onclick 赋值而不是 addEventListener：见下方注释，重渲染重绑时不能叠层。
  for (const button of root.querySelectorAll('[data-action="open-cost"]')) {
    button.onclick = () => {
      costOpen = true;
      applyCostOpen(root, true);
    };
  }

  for (const button of root.querySelectorAll('[data-action="close-cost"]')) {
    button.onclick = () => {
      costOpen = false;
      applyCostOpen(root, false);
    };
  }

  for (const button of root.querySelectorAll('[data-action="toggle-intent"]')) {
    button.onclick = () => {
      const intent = root.querySelector('.td-intent');
      if (!intent) return;
      const expanded = intent.getAttribute('data-expanded') !== 'true';
      intent.setAttribute('data-expanded', expanded ? 'true' : 'false');
      button.textContent = expanded ? INTENT_EXPANDED_LABEL : INTENT_COLLAPSED_LABEL;
    };
  }

  for (const button of root.querySelectorAll('[data-tab]')) {
    button.onclick = () => {
      const tab = tabKey(button.getAttribute('data-tab'));
      root.setAttribute('data-tab', tab);
      for (const other of root.querySelectorAll('[data-tab]')) {
        const on = other === button;
        other.setAttribute('aria-selected', on ? 'true' : 'false');
        if (on) other.setAttribute('data-active', '1');
        else other.removeAttribute('data-active');
      }
    };
  }
}

/**
 * 只挂一次同源样式，挂法与 ensureOverviewStylesheet 一致。
 *
 * 不写进 index.html：那份文件是所有页面共用，页头的排版进去之后，别的页面改一次
 * 全局样式就可能连带改到 40px 事实带。按 href 判断是否已存在：每次挂载都会调，
 * 不查就会每换一次任务多叠一张表。
 */
export function ensureTaskHeaderStylesheet(doc) {
  if (!doc || typeof doc.createElement !== 'function') return;
  const head = doc.head || doc.documentElement;
  if (!head) return;
  // 页头与费用框各一张表：费用框只在点开时出现，混进页头样式里会让「40px 事实带」
  // 那份排版文件里塞着 900×520 的浮层规则，改浮层时容易连带改到页头基线。
  for (const href of ['/task-detail-header.css', '/task-detail-cost.css']) {
    if (doc.querySelector('link[href="' + href + '"]')) continue;
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    head.appendChild(link);
  }
}
