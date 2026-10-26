/**
 * 任务详情「契约」页签的渲染层：把 task-detail-contract.js 已经算好的投影拼成
 * 只读六格，再挂一次同源样式。
 *
 * **为什么投影与渲染分成两个文件**：这一块最容易出的错都不报错、也不影响任何
 * 其它断言——把缺掉的 nonGoals 画成一个空列表（页面看起来像「这份契约明确没有
 * 非目标」，真相是「这份契约没记这一格」）、把 intent 截成一句摘要（契约页的
 * 全部价值就是原文，截掉的那半句在屏幕上永远看不到）、把 contractRevision 缺省
 * 补成 1（人以为自己看的是第一版）、把几个工作项的 allowedScope 合起来展示
 * （看起来像一张更大的工单，实际哪儿都不是）。判断一律留在 task-detail-contract.js
 * （纯函数，node 里喂假 view 就能断言），这里只负责转义与 DOM，**不自己挑工作
 * 项、不自己判缺失**：抄第二份判断，两处迟早只改到一处，而漏改的那边在界面上
 * 只是少了一句话。
 *
 * **不 import task.js**：那边是详情页的渲染模块，它要 import 本模块来接线；互相
 * import 在浏览器原生 ES module 下不成环报错，只会让某一侧拿到 undefined，然后
 * 整页白掉。前端只走 `/api/*` 投影出来的 view。
 *
 * **这一区只读**：契约是一份被记录下来的事实，不是一个可以在这里动手的地方。
 * 审批、恢复、终审、合入各走各自的入口，在这一区补一个按钮，屏幕上就会出现一个
 * 看起来能点、其实没有业务含义的控件。
 */
import { esc } from './projects.js';
import { projectContractPage } from './task-detail-contract.js';

/** 缺失与空数组之外的第三种状态写成这个词：它同时是页面上给人看的那句话。 */
const MISSING_TEXT = '未记录';

/**
 * 六格的固定顺序与标题。顺序本身就是契约的读法（意图 → 验收 → 约束 → 不做什么
 * → 护栏 → 允许范围），由这里定死，不从数据里推断。
 */
const CARDS = [
  { field: 'intent', title: 'intent · 任务意图', kind: 'text' },
  { field: 'acceptance', title: 'acceptance · 验收条件', kind: 'list' },
  { field: 'constraints', title: 'constraints · 约束', kind: 'list' },
  { field: 'nonGoals', title: 'nonGoals · 不做什么', kind: 'list' },
  { field: 'guardrails', title: 'guardrails · 护栏', kind: 'list' },
  { field: 'allowedScope', title: 'allowedScope · 允许范围', kind: 'list' },
];

/**
 * 修订号：数字就原文（0 也是合法的修订号），null 才是未记录。
 *
 * 不补默认值：写成「契约修订 1」会让人以为自己看的是第一版契约，而真相是这条
 * Mission 上没有记录修订号。
 */
function revisionText(revision) {
  if (typeof revision !== 'number' || !Number.isFinite(revision)) return MISSING_TEXT;
  return String(revision);
}

/** 字符串字段原样放入：这里一次 slice 都不要做，截掉的部分页面上再也看不到。 */
function textBody(value) {
  if (typeof value !== 'string') return '<p class="td-contract-missing">' + esc(MISSING_TEXT) + '</p>';
  return '<p class="td-contract-text">' + esc(value) + '</p>';
}

/**
 * 列表字段的三种状态必须画出区别来：
 *   - null（契约没记这一格）→ 「未记录」；
 *   - []（记了，且是空）→ 一个空 ul，**正文不写「未记录」**；
 *   - 有项 → 逐项 li，不截断、不合并。
 * 两种状态画成同一个样子之后，页面再也说不出「没写非目标」和「明确没有非目标」。
 */
function listBody(value) {
  if (!Array.isArray(value)) return '<p class="td-contract-missing">' + esc(MISSING_TEXT) + '</p>';
  const items = value.map((entry) => `<li class="td-contract-item">${esc(entry)}</li>`).join('');
  return '<ul class="td-contract-list">' + items + '</ul>';
}

function cardHtml(card, page) {
  const value = page[card.field];
  const body = card.kind === 'text' ? textBody(value) : listBody(value);
  return '<article class="td-contract-card" data-field="' + esc(card.field) + '">'
    + '<h2 class="td-contract-card-title">' + esc(card.title) + '</h2>'
    + body
    + '</article>';
}

/**
 * 契约区 HTML。根节点 section.td-contract，data-readonly 恒为 true。
 *
 * data-readonly 写死而不是取 page.readOnly：投影里那个字段也是写死的 true，
 * 两处都取等于给「这一区可写」留了一条没人会去测的缝。
 *
 * 六卡一次性全画：只画有内容的几格，人就分不清「这份契约没写护栏」和「这个页面
 * 没做护栏这一格」。
 */
export function taskContractHtml(view, options) {
  const page = projectContractPage(view, options);
  const selected = page.selectedWorkItemId === null ? '' : String(page.selectedWorkItemId);

  return '<section class="td-contract"'
    + ' data-readonly="true"'
    + ' data-selected-work-item="' + esc(selected) + '">'
    + '<p class="td-contract-revision">'
    + '<span class="td-contract-revision-label">契约修订</span>'
    + '<span class="td-contract-revision-value">' + esc(revisionText(page.contractRevision)) + '</span>'
    + '<span class="td-contract-readonly">只读</span>'
    + '</p>'
    + '<div class="td-contract-grid">' + CARDS.map((card) => cardHtml(card, page)).join('') + '</div>'
    + '</section>';
}

/**
 * 只挂一次同源样式，挂法与 ensureTaskFlowStylesheet 一致。
 *
 * 不写进 index.html：那份文件所有页面共用，契约六格的排版进去之后，别的页面改
 * 一次全局样式就可能连带改到这里的卡片。按 href 判断是否已存在：每次挂载都会
 * 调到，不查就会每换一条任务多叠一张表。
 */
export function ensureTaskContractStylesheet(doc) {
  if (!doc || typeof doc.createElement !== 'function') return;
  const head = doc.head || doc.documentElement;
  if (!head) return;
  const href = '/task-detail-contract.css';
  if (doc.querySelector('link[href="' + href + '"]')) return;
  const link = doc.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  head.appendChild(link);
}
