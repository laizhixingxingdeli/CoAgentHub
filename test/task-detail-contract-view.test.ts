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
  for (const selector of ['.td-contract-grid', '.td-contract-card', '.td-contract-card-title', '.td-contract-missing']) {
    assert.ok(CSS.includes('.td-contract ' + selector), selector + ' 没有 .td-contract 作用域');
  }
});

function cssRuleBody(selector: string) {
  const start = CSS.indexOf(selector);
  assert.ok(start >= 0, 'CSS 里没有 ' + selector);
  const open = CSS.indexOf('{', start);
  const close = CSS.indexOf('}', open);
  return CSS.slice(open + 1, close);
}

/**
 * 列的顺序。格子顺序在 DOM 里是 CARDS 的固定顺序，怎么分成两列由 .td-contract-grid
 * 的流向决定：按列填时前 N 项进第一列（N 是声明了三行），剩下的进第二列。
 *
 * 只读声明、不读渲染结果：浏览器算出来的位置在 happy-dom 里没有布局，量不出来。
 * 这条错的时候页面六格都在、每格都有自己的标题，看上去完全正常，只有读的人把
 * 「不做什么」当成了验收条件的续句。
 */
function columnsFromGrid() {
  const grid = cssRuleBody('.td-contract .td-contract-grid');
  assert.match(grid, /grid-auto-flow:\s*column/, '六格不是按列堆叠，会是左 intent / 右 acceptance 的交错');
  const rows = Number(/grid-template-rows:\s*repeat\(\s*(\d+)/.exec(grid)?.[1]);
  assert.equal(rows, 3, '列高不是三行，六格分不成左三右三');
  return rows;
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

  const rows = columnsFromGrid();
  const fields = all('[data-field]').map((el) => el.getAttribute('data-field') || '');

  const columns: string[][] = [];
  fields.forEach((field, index) => {
    const col = Math.floor(index / rows);
    (columns[col] ||= []).push(field);
  });

  assert.deepEqual(columns, [
    ['intent', 'acceptance', 'constraints'],
    ['nonGoals', 'guardrails', 'allowedScope'],
  ], '左右列不是左三右三：' + JSON.stringify(columns));

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
