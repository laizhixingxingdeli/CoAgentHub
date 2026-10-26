/**
 * 工作流环节区的渲染层（src/web/task-detail-flow-view.js）。
 *
 * 只写两条，对应验收的两条：
 *   1. 没指定选择时，界面把「当前活」那一条选出来，近期环节只含它的已发生事件、
 *      按发生顺序、当前标记落在没结束的那一跳上；展开后顺序不变，且不出现样板里
 *      写死的「执行第 13 次」。
 *   2. 机器自动退回画的是平台的动作，不归协调者。
 *
 * 这些错了浏览器都不报错：屏幕上的字看着都挺合理，只是把还没发生的事、或者别的
 * 工单的事，说成了这一张的。
 *
 * 夹具写在文件里，不读仓库外的 JSON（外部文件一改，测试静默换了意思）。
 * DOM 用仓库里已有的 happy-dom（经 npm workspaces 装在根 node_modules），不装新依赖。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Window } from 'happy-dom';

import { bindTaskFlow, taskFlowHtml } from '../src/web/task-detail-flow-view.js';

const CSS = readFileSync(new URL('../src/web/task-detail-flow.css', import.meta.url), 'utf8');

/** 两个工作项：W-A 已验收，W-B 还在跑、派过两轮。 */
function view(): Record<string, unknown> {
  return {
    missionId: 'CUI3-task-detail-20261026',
    coordinationMode: 'hierarchical',
    workItems: [
      // 已验收那张排在前面：默认该选的是还在跑的那张，不是第一项。
      { id: 'W-A', title: '补修原项', status: 'accepted', attemptIds: ['W-A.exec-1'] },
      {
        id: 'W-B',
        title: '工作流环节纯投影',
        status: 'dispatched',
        attemptIds: ['W-B.exec-1', 'W-B.exec-2'],
        order: { orderRevision: 'r3' },
      },
    ],
  };
}

function activity(): Array<Record<string, unknown>> {
  return [
    // 已验收那张的痕迹：它们在 activity 里，但不属于 W-B，不能混进这一区。
    { kind: 'attempt.started', attemptId: 'W-A.exec-1', workItemId: 'W-A', at: '2026-10-26T09:00:00.000Z', data: { kind: 'executor' } },
    { kind: 'attempt.ended', attemptId: 'W-A.exec-1', workItemId: 'W-A', at: '2026-10-26T09:10:00.000Z' },
    // W-B 第一次：跑完被打回。
    { kind: 'attempt.started', attemptId: 'W-B.exec-1', workItemId: 'W-B', at: '2026-10-26T10:00:00.000Z', data: { kind: 'executor' } },
    { kind: 'attempt.ended', attemptId: 'W-B.exec-1', workItemId: 'W-B', at: '2026-10-26T10:20:00.000Z' },
    // W-B 第二次：只有 started，还在跑。
    { kind: 'attempt.started', attemptId: 'W-B.exec-2', workItemId: 'W-B', at: '2026-10-26T11:00:00.000Z', data: { kind: 'executor' } },
  ];
}

const window = new Window({ url: 'http://127.0.0.1:3101/#/missions/CUI3-task-detail-20261026' });
const document = window.document as unknown as Document;

function mount(
  v: Record<string, unknown>,
  events: Array<Record<string, unknown>>,
  options: Record<string, unknown> = {},
) {
  document.body.innerHTML = '<div id="view"></div>';
  const container = document.getElementById('view') as unknown as HTMLElement;
  container.innerHTML = taskFlowHtml(v, events, options);
  const root = container.querySelector('.td-flow') as HTMLElement;
  bindTaskFlow(root);
  const q = (selector: string) => root.querySelector(selector) as HTMLElement | null;
  const all = (selector: string) => [...root.querySelectorAll(selector)] as HTMLElement[];
  return { container, root, q, all };
}

const click = (el: Element | null): void => {
  assert.ok(el, '要点的元素不在页面上');
  el.dispatchEvent(new window.Event('click', { bubbles: true }) as unknown as Event);
};

test('未指定选择：选中未结束的工作项，近期环节只含它的已发生事件且旧在前，当前标记指向未结束的 Attempt', () => {
  const { root, q, all } = mount(view(), activity());

  // 选择落在还在跑的那张上，且已验收的那张只作为标记出现、不占选中位。
  const select = q('select.td-work-item') as unknown as HTMLSelectElement;
  assert.ok(select, '没有工作项选择器');
  assert.equal(select.value, 'W-B');
  assert.equal(root.getAttribute('data-selected-work-item'), 'W-B');
  const options = all('select.td-work-item option');
  assert.deepEqual(options.map((option) => option.textContent), ['W-A 补修原项', 'W-B 工作流环节纯投影']);
  assert.deepEqual(options.map((option) => option.hasAttribute('selected')), [false, true]);
  assert.deepEqual(all('.td-accepted').map((el) => el.textContent), ['W-A 已验收']);

  // 标题带轮次与真实次数：次数来自投影，不按卡片条数另算（收起时只显示最近几条）。
  const title = q('.td-flow-title')?.textContent || '';
  assert.ok(title.includes('第 3 轮'), '标题缺轮次：' + title);
  assert.ok(title.includes('已记录 2 次执行'), '标题缺执行次数：' + title);

  // 近期环节只含 W-B 的两组，顺序与发生顺序一致；W-A 的两次尝试不能混进来。
  const cards = all('.td-flow-stages .td-stage');
  assert.deepEqual(cards.map((card) => card.getAttribute('data-attempt')), ['W-B.exec-1', 'W-B.exec-2']);
  assert.deepEqual(cards.map((card) => card.getAttribute('data-key')), ['W-B.exec-1', 'W-B.exec-2']);

  // 当前标记指向没结束的那一跳，且只标一条。
  const current = all('.td-flow-stages [data-current="true"]');
  assert.equal(current.length, 1, '当前标记应恰好一条');
  assert.equal(current[0].getAttribute('data-key'), 'W-B.exec-2');

  // 样板里写死的「执行第 13 次」不能出现；也不铺没发生过的环节。
  const whole = root.textContent || '';
  assert.equal(whole.includes('执行第 13 次'), false, '出现了写死的次数');
  assert.equal(whole.includes('未来'), false, '出现了预铺的未来环节');

  // 展开：纵向历史按同样顺序，旧在前；按钮文案翻转，根上记住展开状态。
  assert.equal(root.getAttribute('data-expanded'), 'false');
  assert.equal(q('[data-action="toggle-history"]')?.textContent, '展开纵向历史');
  assert.deepEqual(
    all('.td-history .td-history-row').map((row) => row.getAttribute('data-attempt')),
    ['W-B.exec-1', 'W-B.exec-2'],
    '收起时纵向历史也应当是完整且旧在前的（显示与否由 CSS 决定）',
  );

  click(q('[data-action="toggle-history"]'));
  assert.equal(root.getAttribute('data-expanded'), 'true');
  assert.equal(q('[data-action="toggle-history"]')?.textContent, '收起纵向历史');
  assert.deepEqual(
    all('.td-history .td-history-row').map((row) => row.getAttribute('data-attempt')),
    ['W-B.exec-1', 'W-B.exec-2'],
    '展开后顺序变了',
  );

  // 样式：颜色只从 --color-* 进来（写死十六进制会与 tokens.css 分叉，改一处忘另一处）；
  // 当前项是 2px 强调色左边框；每条规则都挂在 .td-flow 下，否则会改到 ui.css 的 .card / .chip。
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(CSS), false, 'CSS 里出现了十六进制色值');
  assert.ok(/\[data-current='true'\] \{[^}]*border-left: 2px solid var\(--color-accent\);/.test(CSS),
    '当前项没有用 2px 强调色左边框');
  for (const selector of ['.td-flow-stages', '.td-stage', '.td-history', '.td-history-row', '.td-badge']) {
    assert.ok(CSS.includes('.td-flow ' + selector), selector + ' 没有 .td-flow 作用域');
  }
});

test('自动改派环节显示平台徽章，不归协调者', () => {
  const only = [
    {
      kind: 'work_item.auto_redispatched',
      workItemId: 'W-B',
      at: '2026-10-26T11:30:00.000Z',
      data: { reason: 'validation_failed', count: 1 },
    },
  ];

  const { root, q, all } = mount(view(), only);

  const badges = all('.td-flow-stages .td-badge');
  assert.equal(badges.length, 1, '自动改派这一条应当有且只有一个徽章');
  assert.equal(badges[0].textContent, '平台');

  const stage = q('.td-flow-stages .td-stage');
  assert.ok(stage, '没有渲染出这条环节');
  const said = stage.textContent || '';
  assert.ok(said.includes('验证没过'), '环节文本没说清退回依据：' + said);
  assert.equal(said.includes('协调者'), false, '机器自动退回被画成了协调者的动作');

  // 整区都不能出现「协调者」：标题、选择器、历史行任何一处冒出来都算归错人。
  assert.equal((root.textContent || '').includes('协调者'), false);
  assert.equal((root.textContent || '').includes('外部主控'), false);
});

/**
 * 结构事实（图审打回项）：选择器不在白板里、白板外只有一处芯片、定位与展开在标题带内。
 *
 * 14 张已验收单全铺出来会把标题带挤成一条收不住的线；选择器留在标题带里则会跟轮次、
 * 展开按钮抢同一行——两处都「看着还行」，只是排版不再是画板那一个。
 */
test('选择器在白板外，已验收芯片只留相邻一项，定位当前与展开在标题带内', () => {
  const many = {
    missionId: 'CUI3-task-detail-20261026',
    coordinationMode: 'hierarchical',
    workItems: [
      ...Array.from({ length: 14 }, (_, i) => ({
        id: 'W-' + (100 + i),
        title: '已验收的工作项 ' + i,
        status: 'accepted',
        attemptIds: ['W-' + (100 + i) + '.exec-1'],
      })),
      { id: 'W-906', title: '选择环节事实概要', status: 'dispatched', attemptIds: ['W-906.exec-1'] },
    ],
  };
  const events = [
    { kind: 'attempt.started', attemptId: 'W-906.exec-1', workItemId: 'W-906', at: '2026-10-26T13:40:00.000Z', data: { kind: 'executor' } },
  ];

  const { root, q, all } = mount(many, events, { selectedWorkItemId: 'W-906' });

  // 芯片最多一枚，且是所选工作项紧邻的上一项，不是全部已验收项的清单。
  const accepted = all('.td-accepted');
  assert.equal(accepted.length, 1, '已验收芯片应只留相邻一项，实际 ' + accepted.length + ' 枚');
  assert.equal(accepted[0].getAttribute('data-work-item'), 'W-113');

  // 选择器在白板之外：贴 .td-flow 挂在 .td-flow-board 的上一条。
  const board = q('.td-flow-board');
  assert.ok(board, '没有白板 .td-flow-board');
  const select = q('select.td-work-item');
  assert.ok(select, '没有工作项选择器');
  assert.equal(board?.contains(select as unknown as Node), false, '选择器仍在白板里');
  assert.ok(q('.td-flow-picker')?.contains(select as unknown as Node), '选择器不在 .td-flow-picker 里');

  // 定位当前与展开都在标题带内，白板里没有别的入口。
  const head = q('.td-flow-head');
  assert.ok(head, '没有标题带');
  assert.ok(head?.querySelector('[data-action="locate-current"]'), '定位当前不在标题带内');
  assert.ok(head?.querySelector('[data-action="toggle-history"]'), '展开不在标题带内');

  // 环节卡在标题带下面，且带身份与状态两行；时刻用事件 at 解析出的本地 HH:MM。
  const card = q('.td-flow-stages .td-stage');
  assert.ok(card, '没有渲染出环节卡');
  const identity = card?.querySelector('.td-stage-identity')?.textContent || '';
  // 这一跳没有记 profile：说「未知」，不编候选名，也不借别处的模型。
  assert.ok(identity.startsWith('执行者'), identity);
  assert.ok(identity.includes('未知'), identity);
  const state = card?.querySelector('.td-stage-state')?.textContent || '';
  assert.ok(state.startsWith('进行中'), state);
  assert.ok(/· \d{2}:\d{2}$/.test(state), '状态行缺事件时刻：' + state);
});
