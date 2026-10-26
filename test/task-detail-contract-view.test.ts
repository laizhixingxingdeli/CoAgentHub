/**
 * 契约页签只读六格的渲染层（src/web/task-detail-contract-view.js）。
 *
 * 只写两条，对应验收的两条：
 *   1. 修订号、intent、acceptance 按原文进页面；缺失的 nonGoals 画成「未记录」而不是
 *      空列表；allowedScope 只含所选工作项的路径，且整区没有按钮。
 *   2. 契约与工作项都没有时，intent / acceptance / allowedScope 都说「未记录」，
 *      页面不抛错、仍然是只读的。
 *
 * 这些错了浏览器都不报错：屏幕上的字看着都挺合理，只是把「这份契约没写非目标」说成
 * 「本任务没有非目标」，或者把别的工作项的允许范围当成这一张的。
 *
 * 夹具写在文件里，不读仓库外的 JSON（外部文件一改，测试静默换了意思）。DOM 用仓库
 * 里已有的 happy-dom（经 npm workspaces 装在根 node_modules），不装新依赖。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Window } from 'happy-dom';

import { taskContractHtml } from '../src/web/task-detail-contract-view.js';

const CSS = readFileSync(new URL('../src/web/task-detail-contract.css', import.meta.url), 'utf8');

/** 断言要看规则、不看注释：注释里写着「不设 line-clamp」，按整份文件搜就会搜到自己。 */
const CSS_RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

const window = new Window({ url: 'http://127.0.0.1:3101/#/missions/CUI3-task-detail-20261026' });
const document = window.document as unknown as Document;

function mount(view: Record<string, unknown>, options: Record<string, unknown> = {}) {
  document.body.innerHTML = '<div id="view"></div>';
  const container = document.getElementById('view') as unknown as HTMLElement;
  container.innerHTML = taskContractHtml(view, options);
  const root = container.querySelector('.td-contract') as HTMLElement;
  assert.ok(root, '没有渲染出契约区根节点');
  const q = (selector: string) => root.querySelector(selector) as HTMLElement | null;
  const all = (selector: string) => [...root.querySelectorAll(selector)] as HTMLElement[];
  const card = (field: string) => {
    const el = root.querySelector('[data-field="' + field + '"]') as HTMLElement | null;
    assert.ok(el, '没有渲染出 ' + field + ' 卡');
    return el;
  };
  return { root, q, all, card };
}

test('修订号与契约原文按原文出现，缺失的 nonGoals 说未记录，allowedScope 只认所选工作项且无按钮', () => {
  // 一整句超过 80 字的 intent：页面上必须整句都在，不能被截成摘要。
  const intent = '本单只改契约页签的只读投影与渲染两层，把已经验收的投影原样铺成六格，'
    + '不得改动 task-detail-contract.js 里的判断，也不得顺手给这一页补上审批或恢复的入口，'
    + '否则屏幕上会出现一个看起来能点、其实没有业务含义的控件。';

  const { root, all, card } = mount({
    missionId: 'CUI3-task-detail-20261026',
    contractRevision: 4,
    contract: {
      intent,
      acceptance: ['修订号、intent、acceptance 按原文出现在 HTML', '缺失的 nonGoals 显示未记录而不是空列表'],
      constraints: ['不截断原文'],
      guardrails: ['不读取或输出凭据'],
      // nonGoals 故意不设：这说的是「这份契约没记这一格」，不是「没有非目标」。
    },
    workItems: [
      { id: 'W-1', title: '另一项', status: 'accepted', order: { allowedScope: ['src/secret.ts'] } },
      { id: 'W-2', title: '契约页只读视图', status: 'dispatched', order: { allowedScope: ['src/web/task.js'] } },
    ],
  }, { selectedWorkItemId: 'W-2' });

  assert.equal(root.getAttribute('data-readonly'), 'true', '契约区不是只读的');
  assert.equal(root.getAttribute('data-selected-work-item'), 'W-2');

  // 修订号原文（含数字本身），不补默认值、不改写成「第 4 版」。
  const revision = card('intent').closest('.td-contract')?.querySelector('.td-contract-revision-value');
  assert.equal((revision?.textContent || '').trim(), '4', '修订号不是原文：' + (revision?.textContent || ''));

  // intent 整句都在，含句尾——被截断时恰恰是老实的开头还在、尾巴没了。
  assert.ok(card('intent').textContent?.includes(intent), 'intent 没有按原文出现（可能被截断）');

  // acceptance 两条都在，且是两条 li，不是合成一段。
  const acceptance = all('[data-field="acceptance"] .td-contract-item').map((el) => el.textContent || '');
  assert.deepEqual(acceptance, ['修订号、intent、acceptance 按原文出现在 HTML', '缺失的 nonGoals 显示未记录而不是空列表']);

  // 缺失的 nonGoals：正文是「未记录」，而不是一个空列表。
  const nonGoals = card('nonGoals');
  assert.equal((nonGoals.textContent || '').includes('未记录'), true, '缺失的 nonGoals 没说未记录');
  assert.equal(nonGoals.querySelector('ul'), null, '缺失的 nonGoals 被画成了空列表');

  // allowedScope 只含所选 W-2 的路径，不含另一项的。
  const scope = card('allowedScope').textContent || '';
  assert.ok(scope.includes('src/web/task.js'), 'allowedScope 没有所选工作项的路径：' + scope);
  assert.equal(scope.includes('src/secret.ts'), false, 'allowedScope 混进了另一项的路径：' + scope);

  // 这一区只读：页面上不该冒出按钮。
  assert.equal(all('button').length, 0, '契约区出现了按钮');

  // 样式：颜色只从 --color-* 进来（写死十六进制会与 tokens.css 分叉），
  // 每条规则都挂在 .td-contract 下，否则会改到 ui.css 的 .card。
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(CSS), false, 'CSS 里出现了十六进制色值');
  for (const selector of ['.td-contract-columns', '.td-contract-column', '.td-contract-card', '.td-contract-card-title', '.td-contract-missing']) {
    assert.ok(CSS.includes('.td-contract ' + selector), selector + ' 没有 .td-contract 作用域');
  }
});

/**
 * 取一条规则的花括号内容。
 *
 * 不能直接 `CSS.indexOf(selector)`：`.td-contract-column` 是 `.td-contract-columns`
 * 的前缀，先命中的会是外层那一行，于是读到的 gap 是列间距离而不是列内距离——
 * 断言看着过了，验的却是另一条规则。这里只认后面不接标识符字符的那一次出现。
 */
function cssRuleBody(selector: string) {
  let from = 0;
  let start = -1;
  for (;;) {
    const at = CSS.indexOf(selector, from);
    if (at < 0) break;
    const next = CSS.charAt(at + selector.length);
    if (!/[\w-]/.test(next)) {
      start = at;
      break;
    }
    from = at + selector.length;
  }
  assert.ok(start >= 0, 'CSS 里没有 ' + selector);
  const open = CSS.indexOf('{', start);
  const close = CSS.indexOf('}', open);
  return CSS.slice(open + 1, close);
}

/**
 * 两列是 DOM 里两个独立的列容器，不是一张网格的两个行位：列归属写在 DOM 上，
 * 不再靠 grid-auto-flow + 三行从全局顺序里推算。推出来的那一套曾经让每格的列
 * 归在了对的卡上，但三行共享行高，两列各自的 16px 就变成了一列 62px、一列
 * 264px 的空白。
 */
function columnDom(all: (selector: string) => HTMLElement[]) {
  const side = (name: string) => all('[data-column="' + name + '"]');
  const left = side('left');
  const right = side('right');
  assert.equal(left.length, 1, '左列容器不是恰好一个');
  assert.equal(right.length, 1, '右列容器不是恰好一个');
  const fieldsOf = (column: HTMLElement[]) => [...column[0].querySelectorAll('[data-field]')]
    .map((el) => el.getAttribute('data-field') || '');
  return { left: fieldsOf(left), right: fieldsOf(right) };
}

test('六格分左三右三：左 intent/acceptance/constraints，右 nonGoals/guardrails/allowedScope', () => {
  const { all } = mount({
    missionId: 'CUI3-task-detail-20261026',
    contractRevision: 2,
    contract: {
      intent: '把契约页签按画板铺成两列六格。',
      acceptance: ['左列三项顺序正确'],
      constraints: ['不改投影'],
      nonGoals: ['不新增写操作'],
      guardrails: ['不读取凭据'],
    },
    workItems: [
      { id: 'W-1', title: '契约页只读视图', status: 'dispatched', order: { allowedScope: ['src/web/task.js'] } },
    ],
  }, { selectedWorkItemId: 'W-1' });

  assert.deepEqual(columnDom(all), {
    left: ['intent', 'acceptance', 'constraints'],
    right: ['nonGoals', 'guardrails', 'allowedScope'],
  }, '左右列不是左三右三');

  // 每列各自纵向堆叠、16px：间距写在一张共享的行高网格上时，量出来是左 62px、
  // 右 264px，而卡片都在、看起来只像多了一点空白。
  const column = cssRuleBody('.td-contract .td-contract-column');
  assert.match(column, /flex-direction:\s*column/, '列不是独立纵向堆叠');
  assert.match(column, /gap:\s*16px/, '列内间距不是 16px');
  assert.equal(/grid-auto-flow/.test(CSS_RULES), false, 'CSS 又回到了按网格流向排两列');

  // 原文不因样式被截短：这两条一旦出现在正文规则里，被收起来的那半句在屏幕上
  // 再也看不到，而卡片看起来是满的。
  const text = cssRuleBody('.td-contract .td-contract-text');
  assert.equal(/max-height\s*:/.test(text), false, '正文被 max-height 截短');
  assert.equal(/line-clamp/.test(CSS_RULES), false, 'CSS 规则里出现了 line-clamp');
});

test('没有契约也没有工作项：三格说未记录，不抛错，仍然是只读', () => {
  const { root, card } = mount({ missionId: 'CUI3-task-detail-20261026', workItems: [] });

  assert.equal(root.getAttribute('data-readonly'), 'true');

  for (const field of ['intent', 'acceptance', 'allowedScope']) {
    const body = card(field).textContent || '';
    assert.ok(body.includes('未记录'), field + ' 卡没说未记录：' + body);
    assert.equal(card(field).querySelector('ul'), null, field + ' 卡把「没记」画成了空列表');
  }
});
