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

import { Window, noHappyDom } from './helpers/happy-dom.ts';

import { bindTaskFlow, taskFlowHtml } from '../src/web/task-detail-flow-view.js';

const CSS = readFileSync(new URL('../src/web/task-detail-flow.css', import.meta.url), 'utf8');
/** 渲染层源码：标题里的数字必须从投影来，不能是写进源码的字面量。 */
const VIEW_SRC = readFileSync(new URL('../src/web/task-detail-flow-view.js', import.meta.url), 'utf8');

/** 取一条规则的声明块。CSS 里同名选择器只该有一条，取到的就是那一条。 */
function rule(styles: string, selector: string): string {
  const at = styles.indexOf(selector + ' {');
  if (at < 0) return '';
  const end = styles.indexOf('}', at);
  return end < 0 ? '' : styles.slice(at + selector.length + 1, end);
}

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

const window = Window ? new Window({ url: 'http://127.0.0.1:3101/#/missions/CUI3-task-detail-20261026' }) : undefined;
const document = window?.document as unknown as Document;

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

test('未指定选择：选中未结束的工作项，近期环节只含它的已发生事件且旧在前，当前标记指向未结束的 Attempt', { skip: noHappyDom }, () => {
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
  assert.equal(q('[data-action="toggle-history"]')?.textContent, '收起历史');
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

  // 收起时白板按画板锁 194px（figma-2-140.txt 41:445）：不锁就随卡片内容长高，
  // 下面的实时输出被一路推下去。锁死只许发生在收起态，展开历史时锁住会剪掉历史。
  const collapsedBoard = rule(CSS, ".td-flow[data-expanded='false'] .td-flow-board");
  assert.ok(/height:\s*194px;/.test(collapsedBoard), '收起白板没有 194px 高度：' + collapsedBoard);
  assert.equal(/height:/.test(rule(CSS, '.td-flow .td-flow-board')), false,
    '展开态的白板也被锁了高度，历史会被剪掉');
  assert.ok(/max-height:/.test(rule(CSS, '.td-flow .td-history')), '纵向历史没有自家的滚动高度');

  // 卡片 274×136 且 min-width: 0：flex 项默认 min-width:auto，长 profile/model
  // 会把卡撑宽、把后面的卡挤出可见区。
  const stage = rule(CSS, '.td-flow .td-stage');
  assert.ok(/274px/.test(stage), '卡片宽度不是 274px：' + stage);
  assert.ok(/height:\s*136px;/.test(stage), '卡片高度不是 136px：' + stage);
  assert.ok(/min-width:\s*0;/.test(stage), '卡片缺 min-width: 0，长身份会把卡撑宽：' + stage);

  // 身份行换行、不截省略号：截过的 `executor-openrouter-qwe…` 让两个不同候选看起来一样。
  const identityCss = rule(CSS, '.td-flow .td-stage-identity');
  assert.equal(/white-space:\s*nowrap/.test(identityCss), false,
    '身份行还是 nowrap，真 profile/model 被截掉：' + identityCss);
  assert.equal(/text-overflow:\s*ellipsis/.test(identityCss), false, '身份行还在用省略号：' + identityCss);
  assert.ok(/white-space:\s*normal/.test(identityCss), '身份行没有改回换行：' + identityCss);

  // 身份行不再被 40px 封顶：卡槽本身 136px + overflow:hidden 已经在裁，再给身份行
  // 加一层 max-height 只是多藏一段且看不出来。只对身份规则断言，不对整份 CSS 断言：
  // 明细行 .td-stage-detail 仍该有 max-height:40px。
  assert.equal(/max-height\s*:/.test(identityCss), false, '身份行又被 max-height 封顶：' + identityCss);
  assert.equal(/overflow\s*:\s*hidden/.test(identityCss), false, '身份行又 overflow:hidden：' + identityCss);
  assert.ok(/max-height:\s*40px;/.test(rule(CSS, '.td-flow .td-stage-detail')),
    '明细行的 40px 封顶被当成身份行一起删了');

  // 选择器与白板之间 14px：12px 贴得太紧，16px 又把白板与输出一起下沉。
  assert.ok(/gap:\s*14px;/.test(rule(CSS, '.td-flow')), '.td-flow 的 gap 不是 14px');
  // 一排卡之间的 16px 与这一块内部的纵向间距是两件事，不能被一起改走。
  assert.ok(/gap:\s*16px;/.test(rule(CSS, '.td-flow .td-flow-stages')), '一排卡之间的 16px 被改了');
});

/**
 * 展开纵向历史时，标题说的是**完整历史的事实**（原项 W-899/W-904/W-909 的补修）。
 *
 * 两个数字必须是投影给的真值：夹具里 W-B 只有两次执行、两条环节。写死成样板里那对
 * 「15 个已发生环节 / 13 次执行」在屏幕上完全合理，而本单的事一条都对不上。
 */
test('展开时标题写真实的环节数与执行次数，近期卡与白底白框都由 CSS 撤掉', { skip: noHappyDom }, () => {
  const { root, q, all } = mount(view(), activity(), { expanded: true });

  assert.equal(root.getAttribute('data-expanded'), 'true');
  const title = q('.td-flow-title')?.textContent || '';
  assert.ok(title.includes('2 个已发生环节'), '展开标题缺真实环节数：' + title);
  assert.ok(title.includes('2 次执行'), '展开标题缺真实执行次数：' + title);
  assert.equal(title.includes('15 个已发生环节'), false, '展开标题出现了写死的环节数：' + title);
  assert.equal(title.includes('13 次执行'), false, '展开标题出现了写死的次数：' + title);
  // 整区渲染都不能出现那对样板数字：只查标题的话，写死的“15 个已发生环节”跑到
  // 行尾或徽章里就漏过去了。
  const wholeText = root.textContent || '';
  assert.equal(wholeText.includes('15 个已发生环节'), false, '展开渲染里出现了写死的环节数');
  assert.equal(wholeText.includes('13 次执行'), false, '展开渲染里出现了写死的次数');
  // 源码里也不能有那对字面量：把它们写进模板串后，夹具里那两条断言还是能过（夹具
  // 恰好不是 15/13），而真实任务上就会把样板数字当事实端上来。
  assert.equal(VIEW_SRC.includes('15 个已发生环节'), false, '渲染层源码里写死了环节数');
  assert.equal(VIEW_SRC.includes('13 次执行'), false, '渲染层源码里写死了次数');
  // 轮次仍只用已有的 round.label，不合成区间。
  assert.ok(title.includes('第 3 轮'), '展开标题丢了轮次：' + title);
  assert.equal(/第 1[-–]3 轮/.test(title), false, '轮次被合成成了区间：' + title);

  // 卡片与历史行**都还在 DOM 里**，隐藏只靠 CSS（bindTaskFlow 只翻 data-expanded）。
  assert.equal(all('.td-flow-stages .td-stage').length, 2, '展开时近期卡不应被从 DOM 里删掉');
  assert.equal(all('.td-history .td-history-row').length, 2, '展开时历史行不在 DOM 里');

  // CSS：展开态近期卡整排 display:none，白底与描边撤掉（不把横条与全历史套在一个白框里）。
  const hidden = rule(CSS, ".td-flow[data-expanded='true'] .td-flow-stages");
  assert.ok(/display:\s*none;/.test(hidden), '展开态近期卡没有被 CSS 隐藏：' + hidden);
  const board = rule(CSS, ".td-flow[data-expanded='true'] .td-flow-board");
  assert.ok(/background:\s*transparent;/.test(board), '展开态白底没有撤成透明：' + board);
  assert.ok(/border:\s*none;/.test(board), '展开态描边没有撤掉：' + board);

  // 收起态标题仍用原来那句（投影给的 executionLabel），不受展开态分支影响。
  const collapsed = mount(view(), activity());
  const collapsedTitle = collapsed.q('.td-flow-title')?.textContent || '';
  assert.ok(collapsedTitle.includes('已记录 2 次执行'), '收起标题没改用回原文案：' + collapsedTitle);
  assert.equal(collapsedTitle.includes('个已发生环节'), false, '收起标题用了展开态的写法：' + collapsedTitle);
});

/**
 * 长 profile/model 要被看得全：卡槽 136px 放不下时，至少有一条能读到全文的路，
 * 且不能靠把卡撑高/撑宽——那会把后面的卡挤出可见区，而屏幕上看不出谁被挤走了。
 */
test('长身份可以看全：title 与节点文字相同，卡槽仍是 274×136', { skip: noHappyDom }, () => {
  const v = {
    missionId: 'CUI3-task-detail-20261026',
    coordinationMode: 'hierarchical',
    workItems: [
      { id: 'W-1', title: '长身份', status: 'dispatched', attemptIds: ['W-1.exec-1'] },
    ],
  };
  // 身份来自 attempt.started 的 data.profile（不是随便一个字段）：长 profileId 与长
  // provider/model 都会进身份行，这才是真会被 136px 卡槽裁掉的那种形状。
  const events = [
    {
      kind: 'attempt.started',
      attemptId: 'W-1.exec-1',
      workItemId: 'W-1',
      at: '2026-10-26T09:00:00.000Z',
      data: {
        kind: 'executor',
        profile: {
          profileId: 'executor-openrouter-qwen3-coder-plus-2026-10-26-long-live-profile-name',
          facts: [
            { key: 'provider', value: 'openrouter-long-provider-identifier' },
            { key: 'model', value: 'anthropic/claude-sonnet-4-5-very-long-model-name-20261026' },
            { key: 'reasoning', value: 'high' },
          ],
        },
      },
    },
  ];

  const { q, all } = mount(v, events, { selectedWorkItemId: 'W-1' });
  const identity = q('.td-flow-stages .td-stage .td-stage-identity');
  assert.ok(identity, '没有渲染出身份行');
  const said = identity?.textContent || '';
  assert.ok(said.length > 80, '夹具不够长，没覆盖到超过 40px 的情形：' + said);
  // title 与节点文字同一份：悬停看到的必须就是卡上那句，不许另算一个缩写。
  assert.equal(identity?.getAttribute('title'), said, '身份的 title 与节点文字不是同一句');
  // 历史行共用同一份身份来源（.td-history-identity），title 仍是全文。
  for (const row of all('.td-history .td-history-row .td-history-identity')) {
    assert.equal(row.getAttribute('title'), row.textContent, '历史行的身份缺 title');
  }
  // 看得全靠 title，不靠把卡改大。
  const stage = rule(CSS, '.td-flow .td-stage');
  assert.ok(/274px/.test(stage), '卡片宽度不再是 274px：' + stage);
  assert.ok(/height:\s*136px;/.test(stage), '卡片高度不再是 136px：' + stage);
});

test('自动改派环节显示平台徽章，不归协调者', { skip: noHappyDom }, () => {
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
test('选择器在白板外，已验收芯片只留相邻一项，定位当前与展开在标题带内', { skip: noHappyDom }, () => {
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

/**
 * 展开后的历史行是**三列**（标题 / 身份 / 时间+结果），不是把横向卡搬一遁。
 *
 * 三件错在浏览器里都不报错：复用 stageBody 时行里出现 徽章/明细/状态 一整套，看起来
 * 像“卡片变小了一点”；时刻只写 HH:MM 时跨天的历史全是同一个时刻；结果词写回状态词时
 * 「上游调用失败」就变成「已记录」。
 */
test('历史行是标题/身份/时间三列，时间是本地 MM-DD HH:mm，结果与全文都可在 title 查看', { skip: noHappyDom }, () => {
  const v = {
    missionId: 'CUI3-task-detail-20261026',
    coordinationMode: 'hierarchical',
    workItems: [
      { id: 'W-930', title: '补修历史三列', status: 'dispatched', attemptIds: ['W-930.exec-1'] },
    ],
  };
  const iso = '2026-10-25T09:02:00.000Z';
  const events = [
    {
      kind: 'attempt.started',
      attemptId: 'W-930.exec-1',
      workItemId: 'W-930',
      at: iso,
      data: {
        kind: 'executor',
        profile: {
          profileId: 'executor-openrouter-qwen3-coder-plus-2026-10-25-long-live-profile-name',
          facts: [{ key: 'model', value: 'anthropic/claude-sonnet-4-5-very-long-model-name-20261025' }],
        },
      },
    },
    {
      kind: 'attempt.ended',
      attemptId: 'W-930.exec-1',
      workItemId: 'W-930',
      at: '2026-10-25T09:30:00.000Z',
      data: { endedBy: 'upstream_failure' },
    },
  ];

  const { q, all } = mount(v, events, { selectedWorkItemId: 'W-930', expanded: true });
  const row = all('.td-history .td-history-row')[0];
  assert.ok(row, '没有渲染出历史行');

  // 三列各一个节点，横向卡那一套（.td-stage-detail）不得出现在历史行里。
  const title = row.querySelector('.td-history-title') as HTMLElement | null;
  const identity = row.querySelector('.td-history-identity') as HTMLElement | null;
  const time = row.querySelector('.td-history-time') as HTMLElement | null;
  assert.ok(title, '历史行缺标题列 .td-history-title');
  assert.ok(identity, '历史行缺身份列 .td-history-identity');
  assert.ok(time, '历史行缺时间列 .td-history-time');
  assert.equal(row.querySelector('.td-stage-detail'), null, '历史行仍在复用横向卡的 .td-stage-detail');

  // 时间用同一 ISO 在测试里算成本地 MM-DD HH:mm，不比对写死的字面量（写死的是时区依赖的假值）。
  const when = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  const local = pad(when.getMonth() + 1) + '-' + pad(when.getDate()) + ' ' + pad(when.getHours()) + ':' + pad(when.getMinutes());
  assert.equal(time?.textContent, local + ' · 上游调用失败');
  // 原始 ISO 留在 title：本地时间对不对只能靠它核。
  assert.equal(time?.getAttribute('title'), iso);

  // 身份列裁切，全文只能在 title 里看到；标题列同样 title = 全文。
  assert.equal(identity?.getAttribute('title'), identity?.textContent);
  assert.ok((identity?.textContent || '').length > 80, '夹具不够长，没覆盖到会被裁的身份：' + identity?.textContent);
  assert.equal(title?.getAttribute('title'), title?.textContent);

  // 展开按钮这句是本单的新文案，与 task-detail-page 那一份必须同一句话。
  assert.equal(q('[data-action="toggle-history"]')?.textContent, '收起历史');
  assert.equal((row.textContent || '').includes('验收通过'), false, '历史行里凭空出现了验收通过');
});
