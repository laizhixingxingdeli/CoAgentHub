/**
 * 任务详情页头的渲染层：把 task-detail-header.js 已经算好的投影拼成 HTML，
 * 再绑上两个只在本页头内生效的点击（展开 intent、切页签）。
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
 * 处理人与恢复方式也分节点：合成一句之后，人分不清「谁该动」和「会不会自己好」。
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

  const markNodes = marks.map((mark) => (
    '<span class="td-mark" data-mark="' + esc(mark.key) + '">' + esc(mark.text) + '</span>'
  ));

  const tabs = TABS.map((item) => (
    '<button type="button" class="td-tab" data-tab="' + esc(item.key) + '"'
    + ' aria-selected="' + (item.key === tab ? 'true' : 'false') + '"'
    + (item.key === tab ? ' data-active="1"' : '') + '>'
    + esc(item.label) + '</button>'
  )).join('');

  return '<section class="td-header" data-mission-id="' + esc(missionId)
    + '" data-tab="' + esc(tab) + '">'
    + '<div class="td-identity">'
    + '<h1 class="td-mission-id">' + esc(missionId) + '</h1>'
    + '<p class="td-intent" data-expanded="' + (intentExpanded ? 'true' : 'false') + '">'
    + esc(header.intent) + '</p>'
    + '<button type="button" class="td-intent-toggle" data-action="toggle-intent">'
    + esc(intentExpanded ? INTENT_EXPANDED_LABEL : INTENT_COLLAPSED_LABEL) + '</button>'
    + '</div>'
    + '<div class="td-status-row">'
    + '<span class="td-status-text">' + esc(header.statusText) + '</span>'
    + '<span class="td-marks">' + markNodes.join('') + '</span>'
    + '<span class="td-owner">' + esc(header.owner && header.owner.text) + '</span>'
    + '<span class="td-recovery">' + esc(header.recovery && header.recovery.text) + '</span>'
    + '</div>'
    // 40px 单行事实带：保障 / 协作 / 费用 / 时间四格。这里不出现协调者模型字段——
    // direct 的两层协作里平台拿不到主控会话的模型，写一个占位 id 就是凭空造事实。
    + '<div class="td-facts">'
    + '<span class="td-assurance">' + esc(header.assurance) + '</span>'
    + '<span class="td-collaboration">' + esc(header.collaboration) + '</span>'
    + '<span class="td-cost">' + esc(header.cost && header.cost.line) + '</span>'
    + '<span class="td-time">运行 ' + esc(header.time && header.time.runningText)
    + ' · 创建于 ' + esc(header.time && header.time.createdText) + '</span>'
    + '</div>'
    + '<nav class="td-tabs">' + tabs + '</nav>'
    + '</section>';
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
 */
export function bindTaskHeader(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return;

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
  const href = '/task-detail-header.css';
  if (doc.querySelector('link[href="' + href + '"]')) return;
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  head.appendChild(link);
}
