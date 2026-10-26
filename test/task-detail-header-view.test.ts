/**
 * 任务详情页头的渲染层（src/web/task-detail-header-view.js）。
 *
 * 只写两条，对应验收的两条：
 *   1. direct 且没有 costCap 时，页头说的是真话：完整编号、原始 intent、状态词与
 *      补修分开、费用「主控未计 / 上限未知」且不补成 $10、不出现编造的主控模型。
 *      这些错了浏览器里都不报错——屏幕上的字看着都挺合理。
 *   2. 点击真的改视图：intent 能展开并换按钮文案，页签能切；已完成残留的 waitInfo
 *      不能把「已结束，没有待办」改写成「等你处理」，也不把已上报费用标成估算。
 *
 * DOM 用仓库里已有的 happy-dom（经 npm workspaces 装在根 node_modules），不装新依赖。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Window } from 'happy-dom';

import { bindTaskHeader, taskHeaderHtml } from '../src/web/task-detail-header-view.js';

const CSS = readFileSync(new URL('../src/web/task-detail-header.css', import.meta.url), 'utf8');
const PAGE_CSS = readFileSync(new URL('../src/web/task-detail-page.css', import.meta.url), 'utf8');

/** 一条 direct、还没结账的 Mission：契约里「不虚构 L2 模型或费用」说的就是它。 */
function directView(): Record<string, unknown> {
  return {
    missionId: 'CUI3-task-detail-20261026',
    projectId: 'coagenthub-v5',
    coordinationMode: 'direct',
    executionMode: 'standard',
    status: 'executing',
    usage: { cost: 0, quality: 'unknown' },
    contract: { intent: '  修设备边界  ' },
    workItems: [{ id: 'W-12', title: '补修原项 W-12' }],
    waitInfo: { owner: 'l3', autoResume: false, activeAgent: false },
    updatedAt: '2026-10-26T10:00:00.000Z',
    // 没有 costCap 这一格 = 上限未知，不是「上限是 10」。
  };
}

const options = {
  createdAt: '2026-10-26T09:00:00.000Z',
  nowIso: '2026-10-26T09:30:00.000Z',
};

const window = new Window({ url: 'http://127.0.0.1:3101/#/missions/CUI3-task-detail-20261026' });
const document = window.document as unknown as Document;

function mount(view: Record<string, unknown>, opts: Record<string, unknown> = {}) {
  document.body.innerHTML = '<div id="view"></div>';
  const container = document.getElementById('view') as unknown as HTMLElement;
  container.innerHTML = taskHeaderHtml(view, { ...options, ...opts });
  const root = container.querySelector('.td-header') as HTMLElement;
  bindTaskHeader(root);
  const q = (selector: string) => root.querySelector(selector) as HTMLElement | null;
  return { container, root, q };
}

const click = (el: Element | null): void => {
  assert.ok(el, '要点的元素不在页面上');
  el.dispatchEvent(new window.Event('click', { bubbles: true }) as unknown as Event);
};

test('direct 且无成本上限：完整编号、原始 intent、状态与补修分开、主控未计且上限未知', () => {
  const html = taskHeaderHtml(directView(), options);
  const { container, root, q } = mount(directView());

  // 编号全文可见，不用省略号截断：截断过的编号看着像完整编号，复制出去对不上任何 Mission。
  assert.equal(q('.td-mission-id')?.textContent, 'CUI3-task-detail-20261026');
  assert.equal(root.getAttribute('data-mission-id'), 'CUI3-task-detail-20261026');

  // 标题是原始 intent（两端空白去掉），不是 L2 改写过的目标。
  assert.equal(q('.td-intent')?.textContent, '修设备边界');

  // 六态词与附标分两个节点：合在一句里，「执行中 · 补修」会被读成第七种状态。
  assert.equal(q('.td-status-text')?.textContent, '执行中');
  assert.equal((q('.td-status-text')?.textContent || '').includes('补修'), false);
  const marks = [...root.querySelectorAll('.td-marks .td-mark')].map((el) => el.textContent);
  assert.ok(marks.includes('补修'), '补修附标没出现在 .td-marks 里');

  // 处理人与恢复方式各占一个节点：合成一句就分不清「谁该动」和「会不会自己好」。
  assert.equal(q('.td-owner')?.textContent, '需要检视者（L3）处理');
  assert.equal(q('.td-recovery')?.textContent, '不会自动恢复');

  // 费用未知不能说成 $0.00，上限缺失不能补成 10（那是从没生效过的门禁）。
  const cost = q('.td-cost')?.textContent || '';
  assert.ok(cost.includes('主控未计'), 'direct 的费用要标出主控未计');
  assert.ok(cost.includes('上限未知'), '没有 costCap 时上限是未知');
  assert.equal(cost.includes('$10'), false);

  // direct 不虚构 L2 模型：整份 HTML 里不该有这一格的名字，更不该有模型 id。
  assert.equal(html.includes('coordinatorModel'), false);
  assert.equal(container.textContent?.includes('coordinatorModel') ?? false, false);

  // 事实带四格齐全，时间那句带创建时刻。
  assert.ok(q('.td-assurance')?.textContent?.includes('执行保障'));
  assert.ok(q('.td-collaboration')?.textContent?.includes('协作方式'));
  assert.ok((q('.td-time')?.textContent || '').includes('创建于'));

  // 样式：40px 事实带是画板值；颜色只从 --color-* 进来，写死十六进制会与设计令牌分叉。
  assert.ok(CSS.includes('.td-header .td-facts {'), '事实带规则要有 .td-header 作用域');
  assert.ok(/\.td-header \.td-facts \{[^}]*height: 40px;/.test(CSS), '事实带高度不是 40px');
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(CSS), false, 'CSS 里出现了十六进制色值');
});

test('点击展开 intent 并切页签；已完成残留 waitInfo 仍是已结束，已上报费用带上限且不标估算', () => {
  const { root, q } = mount(directView());

  // 展开：只翻 data-expanded 与按钮文案，身份不能被一次交互改掉。
  click(q('[data-action="toggle-intent"]'));
  assert.equal(q('.td-intent')?.getAttribute('data-expanded'), 'true');
  assert.equal(q('[data-action="toggle-intent"]')?.textContent, '收起 intent');
  assert.equal(root.getAttribute('data-mission-id'), 'CUI3-task-detail-20261026');

  // 切页签：根节点记住当前页签，被点的那一个 aria-selected=true。
  click(q('[data-tab="contract"]'));
  assert.equal(root.getAttribute('data-tab'), 'contract');
  assert.equal(q('[data-tab="contract"]')?.getAttribute('aria-selected'), 'true');
  assert.equal(q('[data-tab="workflow"]')?.getAttribute('aria-selected'), 'false');
  assert.equal(q('[data-tab="delivery"]')?.getAttribute('aria-selected'), 'false');

  // 已完成：残留的 waitInfo 不能把「已结束，没有待办」改写成「等你处理」。
  const done = mount({
    missionId: 'CUI3-task-detail-20261026',
    coordinationMode: 'hierarchical',
    executionMode: 'standard',
    status: 'completed',
    usage: { cost: 2.11, quality: 'reported' },
    costCap: 10,
    contract: { intent: '修设备边界' },
    waitInfo: { owner: 'user', autoResume: false, activeAgent: false, action: '去答复' },
    workItems: [],
    updatedAt: '2026-10-26T09:45:00.000Z',
  });

  const owner = done.q('.td-owner')?.textContent || '';
  assert.equal(owner.includes('已结束'), true, '终态处理人不是「已结束」');
  assert.equal(owner.includes('没有待办'), true);
  assert.equal(owner.includes('用户'), false, '残留 waitInfo 被当成了待办');

  // 已上报就是已上报：带上限，且不能被说成估算。
  const cost = done.q('.td-cost')?.textContent || '';
  assert.equal(cost.includes('$2.11'), true);
  assert.equal(cost.includes('上限 $10.00'), true);
  assert.equal(cost.includes('≈'), false);
});

/** 取某条选择器的声明块正文；找不到就是空串，后面的断言会直接说出来。 */
function rule(styles: string, selector: string): string {
  const at = styles.indexOf(selector + ' {');
  if (at < 0) return '';
  const end = styles.indexOf('}', at);
  return end < 0 ? '' : styles.slice(at + selector.length + 1, end);
}

test('页头是有返回链接的整幅白带，纵向基线落在画板上，页内不自加 padding', () => {
  const { q } = mount(directView());

  // 返回链接必须真的指向任务总览：做成不跳转的按钮，人点了留在原地还以为坏了。
  const back = q('a.td-back');
  assert.ok(back, '页头没有 a.td-back 返回链接');
  assert.equal(back.textContent, '返回任务列表');
  assert.equal(back.getAttribute('href'), '#/projects');

  // 页头是主栏上的白色平铺带（画板 82:4091 / 82:4092）：background:none 会让白带
  // 整个消失，圆角卡会让首字从 x224 内缩到 x256，两种都不像画板，而且屏幕上不报错。
  const header = rule(CSS, '.td-header');
  assert.ok(header.length > 0, '.td-header 规则不见了');
  assert.ok(header.includes('background: var(--color-white)'), '.td-header 不是白底平铺带');
  assert.ok(header.includes('margin-top: calc(1px - var(--shell-view-inset))'), '白带顶边没拉到 y69');
  assert.ok(header.includes('padding-top: 19px'), '返回链接顶边没落在 y88');
  assert.ok(header.includes('border-bottom: 1px solid var(--color-line)'), '白带底部没有 1px 分界');
  assert.equal(header.includes('background: none'), false, '白带被 background:none 抹掉了');
  assert.equal(header.includes('border-radius: 6px'), false, '.td-header 不该是圆角卡');

  // 纵向基线：69+19+22+12+28+12+44+8+28+6+40+6+40=334。间距写错时页签会漂到
  // 白带外面，但浏览器只当合法的 CSS 收下，只有逐条对算式才看得出。
  assert.ok(rule(CSS, '.td-header .td-mission-id').includes('margin: 12px 0 0'), '标题基线不是 y122');
  assert.ok(rule(CSS, '.td-header .td-intent-row').includes('margin-top: 12px'), 'intent 行基线不是 y162');
  assert.ok(rule(CSS, '.td-header .td-status-row').includes('margin-top: 8px'), '状态行基线不是 y214');
  const facts = rule(CSS, '.td-header .td-facts');
  assert.ok(facts.includes('margin-top: 6px'), '事实带基线不是 y248');
  assert.ok(facts.includes('height: 40px'), '事实带高度不是 40px');
  const tabs = rule(CSS, '.td-header .td-tabs');
  assert.ok(tabs.includes('margin-top: 6px'), '页签基线不是 y294');
  assert.ok(tabs.includes('height: 40px'), '页签带高度不是 40px');
  assert.ok(rule(CSS, '.td-header .td-intent').includes('min-height: 44px'), '收起态 intent 不再稳占两行');
  assert.ok(rule(CSS, ".td-header .td-tab[data-tab='workflow']").includes('width: 110px'));
  assert.ok(rule(CSS, ".td-header .td-tab[data-tab='delivery']").includes('width: 150px'));
  assert.ok(rule(CSS, ".td-header .td-tab[data-tab='contract']").includes('width: 100px'));

  // 页内不自加 padding：外壳已有 40px gutter，叠一层就偏离画板列位置。
  assert.ok(/padding:\s*0;/.test(rule(PAGE_CSS, '.td-page')), '.td-page 没有把 padding 归零');
});
