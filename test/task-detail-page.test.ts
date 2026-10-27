/**
 * 任务详情页的组合层（src/web/task-detail-page.js）。
 *
 * 只写两条，对应本单的两条验收：
 *   1. 三页签切换真的显隐对应面板；展开 intent 不改 mission id；direct 页头不出现
 *      编造的模型名。
 *   2. 实时 Attempt 与历史 Attempt 可以不同；定位当前只选 data-current 那一跳；
 *      切换工作项不改实时 id；文件面板不显示 missionDiff。
 *
 * 这些错了浏览器都不报错：屏幕上看着都挺合理，只是把上一跳的结尾当成正在跑的进度、
 * 或者把整条任务改过的文件记到某一跳名下。
 *
 * 必须 import 真实的子视图与投影，不 stub：本单的验收正是「把它们拼对了」，stub 掉就
 * 只测了自己写的那半边，子视图改了会静默失配。
 *
 * 夹具写在文件里，不读仓库外的 JSON（外部文件一改，测试静默换了意思）。DOM 用仓库
 * 里已有的 happy-dom（经 npm workspaces 装在根 node_modules），不装新依赖。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Window } from 'happy-dom';

import { bindTaskDetail, taskDetailHtml } from '../src/web/task-detail-page.js';

const PAGE_CSS = readFileSync(new URL('../src/web/task-detail-page.css', import.meta.url), 'utf8');
const OUTPUT_CSS = readFileSync(new URL('../src/web/task-detail-output.css', import.meta.url), 'utf8');

/** 取一条规则的声明块。取**最后一处**：.td-history 同时出现在合并选择器和它自己的
 * 尺寸规则里，indexOf 会取到前者，那里的宽高是共享声明。 */
function rule(styles: string, selector: string): string {
  const at = styles.lastIndexOf(selector + ' {');
  if (at < 0) return '';
  const end = styles.indexOf('}', at);
  return end < 0 ? '' : styles.slice(at + selector.length + 1, end);
}

const window = new Window({ url: 'http://127.0.0.1:3101/#/missions/CUI3-task-detail-20261026' });
const document = window.document as unknown as Document;

function mount(model: Record<string, unknown>, handlers: Record<string, unknown> = {}) {
  document.body.innerHTML = '<div id="view"></div>';
  const container = document.getElementById('view') as unknown as HTMLElement;
  container.innerHTML = taskDetailHtml(model);
  const root = container.querySelector('.td-page') as HTMLElement;
  assert.ok(root, '没有渲染出详情页根节点');
  bindTaskDetail(root, handlers);
  const q = (selector: string) => root.querySelector(selector) as HTMLElement | null;
  return { container, root, q };
}

const click = (el: Element | null): void => {
  assert.ok(el, '要点的元素不在页面上');
  el.dispatchEvent(new window.Event('click', { bubbles: true }) as unknown as Event);
};

/** 面板是否可见：hidden 属性是唯一依据，不看 CSS（测试里没有层叠上下文）。 */
const shown = (el: HTMLElement | null): boolean => el !== null && !el.hasAttribute('hidden');

/* ============================ 夹具 ============================ */

/** 一条 direct、standard、执行中的 Mission：页头那几格说的就是它。 */
function directView(): Record<string, unknown> {
  return {
    missionId: 'CUI3-task-detail-20261026',
    projectId: 'coagenthub-v5',
    coordinationMode: 'direct',
    executionMode: 'standard',
    status: 'executing',
    contract: {
      intent: '原始意图',
      acceptance: ['三页签切换会显隐对应面板'],
      constraints: ['不发请求'],
      nonGoals: null,
      guardrails: ['不碰 .idea/'],
    },
    usage: { cost: 0, quality: 'unknown' },
    workItems: [
      {
        id: 'W-1',
        title: '任务详情页组合',
        status: 'dispatched',
        attemptIds: ['W-1.exec-1', 'W-1.exec-2'],
        order: { orderRevision: 'r1', allowedScope: ['src/web/task-detail-page.js'] },
      },
    ],
    updatedAt: '2026-10-26T10:00:00.000Z',
  };
}

/** 一个工作项、一跳已结束、一跳还在跑：这正是「实时与历史不是同一跳」的形状。 */
function attemptView(): Record<string, unknown> {
  return {
    missionId: 'CUI3-task-detail-20261026',
    projectId: 'coagenthub-v5',
    coordinationMode: 'direct',
    executionMode: 'standard',
    status: 'executing',
    contract: { intent: '原始意图' },
    usage: { cost: 0, quality: 'unknown' },
    workItems: [
      {
        id: 'W-1',
        title: '任务详情页组合',
        status: 'dispatched',
        attemptIds: ['W-1.exec-1', 'W-1.exec-2'],
        order: { orderRevision: 'r1' },
      },
      // 另一张工单：只为了有 option 可切，切它不能把实时那一跳带走。
      { id: 'W-2', title: '输出区独立', status: 'planned', attemptIds: [] },
    ],
    updatedAt: '2026-10-26T10:00:00.000Z',
  };
}

function twoAttempts(): Array<Record<string, unknown>> {
  return [
    { kind: 'attempt.started', attemptId: 'W-1.exec-1', workItemId: 'W-1', at: '2026-10-26T09:00:00.000Z', data: { kind: 'executor' } },
    { kind: 'attempt.ended', attemptId: 'W-1.exec-1', workItemId: 'W-1', at: '2026-10-26T09:10:00.000Z' },
    { kind: 'attempt.started', attemptId: 'W-1.exec-2', workItemId: 'W-1', at: '2026-10-26T09:20:00.000Z', data: { kind: 'executor' } },
  ];
}

/* ============================ 用例 ============================ */

test('三页签切换显隐对应面板，展开 intent 不改 mission id，direct 页头不出现编造的模型名', () => {
  const model = {
    view: directView(),
    activity: [{ kind: 'mission.created', at: '2026-10-26T09:00:00.000Z' }],
    nowIso: '2026-10-26T09:30:00.000Z',
  };
  const { root, q } = mount(model);

  const missionId = 'CUI3-task-detail-20261026';
  // 编号全文，不截断：截过的编号看着像完整编号，复制出去对不上任何 Mission。
  assert.equal(q('.td-mission-id')?.textContent, missionId);
  assert.equal(root.getAttribute('data-mission-id'), missionId);
  assert.equal(q('.td-intent')?.textContent?.includes('原始意图'), true);

  // 协作方式那一格认 coordinationMode：direct 就是直接主控。
  assert.equal(q('.td-collaboration')?.textContent, '协作方式：直接主控');
  // direct 下平台看不见主控会话用的模型，页头里不许出现编造的模型名。
  const headerText = (q('.td-header')?.textContent || '').toLowerCase();
  assert.equal(headerText.includes('claude'), false, '页头出现了编造的协调者模型名');
  assert.equal(headerText.includes('gpt'), false, '页头出现了编造的协调者模型名');

  // 缺省落在工作流页签：另外两个面板不占位。
  assert.equal(root.getAttribute('data-tab'), 'workflow');
  assert.equal(shown(q('[data-panel="workflow"]')), true);
  assert.equal(shown(q('[data-panel="delivery"]')), false);
  assert.equal(shown(q('[data-panel="contract"]')), false);

  // 点「契约」：契约面板可见且是契约原文，工作流面板收起。
  const contractTab = [...root.querySelectorAll('button[data-tab]')]
    .find((el) => el.getAttribute('data-tab') === 'contract') as HTMLElement | undefined;
  click(contractTab ?? null);
  assert.equal(root.getAttribute('data-tab'), 'contract');
  assert.equal(shown(q('[data-panel="workflow"]')), false);
  assert.equal(shown(q('[data-panel="contract"]')), true);
  assert.equal(q('[data-panel="contract"]')?.textContent?.includes('原始意图'), true);

  // 展开 intent：按钮换文案，mission id 一个字都不动（它是身份，不是状态）。
  click(q('[data-action="toggle-intent"]'));
  const toggle = q('[data-action="toggle-intent"]');
  assert.equal(toggle?.textContent, '收起 intent');
  assert.equal(root.getAttribute('data-mission-id'), missionId);
  assert.equal(q('.td-mission-id')?.textContent, missionId);

  // 输出区只挂在工作流面板里：页面上只有一份，且它的祖先面板就是 workflow。
  const outputRoot = q('.td-output');
  assert.ok(outputRoot, '没有渲染出输出区');
  assert.equal(outputRoot?.closest('[data-panel]')?.getAttribute('data-panel'), 'workflow',
    '输出区的祖先面板不是工作流');
  assert.equal(root.querySelectorAll('.td-output').length, 1, '页面上出现了不止一份输出区');

  // 切到契约后，输出区跟着工作流面板一起 hidden，交付 / 契约面板里也没有「当前实时输出」。
  assert.equal(shown(outputRoot?.closest('[data-panel]') as HTMLElement | null), false,
    '切到契约后输出区仍然可见');
  assert.equal((q('[data-panel="delivery"]')?.textContent || '').includes('当前实时输出'), false,
    '交付面板里挂了输出区');
  assert.equal((q('[data-panel="contract"]')?.textContent || '').includes('当前实时输出'), false,
    '契约面板里挂了输出区');
});

test('实时 Attempt 与历史 Attempt 相互独立：定位当前只选 data-current，切工作项与切面板都不改实时 id', () => {
  const onSelectAttempt: string[] = [];
  const onWorkItem: string[] = [];
  const model = {
    view: attemptView(),
    activity: twoAttempts(),
    nowIso: '2026-10-26T09:30:00.000Z',
    selectedAttemptId: 'W-1.exec-1',
    liveChunks: [
      { attemptId: 'W-1.exec-2', text: '当前' },
      { attemptId: 'W-1.exec-1', text: '旧行' },
    ],
    // 任务级改动：**不许**被塞进某一跳的文件面板。
    missionDiff: ['src/a.js'],
  };
  const { root, q } = mount(model, {
    onSelectAttempt: (attemptId: string) => onSelectAttempt.push(attemptId),
    onWorkItem: (workItemId: string) => onWorkItem.push(workItemId),
  });

  // 选择器带上 .td-output 前缀：环节区里也有一份 .td-history（纵向历史列表），
  // 裸查会先命中的是它，于是断言看着通过、其实读的是另一个元素。
  const live = q('.td-output .td-live');
  const history = q('.td-output .td-history');
  assert.equal(live?.getAttribute('data-live-attempt'), 'W-1.exec-2');
  assert.equal(history?.getAttribute('data-history-attempt'), 'W-1.exec-1');

  // 实时正文只含当前那一跳的行：混进来的「旧行」会被读成这一段正在跑的进度。
  const liveText = q('.td-output .td-live-text')?.textContent || '';
  assert.equal(liveText.includes('当前'), true);
  assert.equal(liveText.includes('旧行'), false);

  // 页面上任何地方都不该出现任务级改动：它记到某一跳名下就是两笔账合成一笔。
  assert.equal((root.textContent || '').includes('src/a.js'), false, 'missionDiff 漏进了页面');

  // 切到「文件」：实时那一跳不动，文件面板说「这一跳没有清单」而不是借用任务级改动。
  const filesButton = [...root.querySelectorAll('.td-output [data-side]')]
    .find((el) => el.getAttribute('data-side') === 'files') as HTMLElement | undefined;
  click(filesButton ?? null);
  assert.equal(q('.td-output .td-live')?.getAttribute('data-live-attempt'), 'W-1.exec-2');
  const filesPanel = q('.td-output [data-panel="files"]');
  assert.equal(shown(filesPanel), true);
  assert.equal(filesPanel?.textContent?.includes('该尝试没有单独的文件清单'), true);
  assert.equal((root.textContent || '').includes('src/a.js'), false);

  // 定位当前：选中的是 [data-current="true"] 那一跳，实时 id 不变。
  const current = root.querySelector('.td-flow [data-current="true"]') as HTMLElement | null;
  assert.ok(current, '环节区没有当前项');
  assert.equal(current.getAttribute('data-attempt'), 'W-1.exec-2');
  click(q('[data-action="locate-current"]'));
  assert.equal(q('.td-flow')?.getAttribute('data-selected-stage'), current.getAttribute('data-key'));
  assert.equal(onSelectAttempt.at(-1), 'W-1.exec-2');
  assert.equal(q('.td-output .td-live')?.getAttribute('data-live-attempt'), 'W-1.exec-2');

  // 换工作项：只把选择报出去，实时那一跳仍是 W-1.exec-2。
  const select = root.querySelector('select.td-work-item') as HTMLSelectElement | null;
  assert.ok(select, '工作项下拉不在页面上');
  assert.equal([...select.options].some((option) => option.value === 'W-2'), true);
  select.value = 'W-2';
  select.dispatchEvent(new window.Event('change', { bubbles: true }) as unknown as Event);
  assert.equal(onWorkItem.at(-1), 'W-2');
  assert.equal(q('.td-output .td-live')?.getAttribute('data-live-attempt'), 'W-1.exec-2');

  // 排版事实（画板 figma-2-140.txt）：白板底到输出顶隔 26px，不隔就把两块读成一块；
  // 右卡页签是标题带里的文字页签（无边框、选中只一条下划线），不是一只只有边按钮。
  assert.ok(/margin-top:\s*26px;/.test(rule(PAGE_CSS, '.td-page .td-output')),
    '.td-page .td-output 没有 26px 上间距');

  // 三个页签各自对准源稿起点：页头之下的 flex gap 16px 只把面板送到 y346 下面 5px，
  // 三块内容在源稿里起于不同高度，所以间距写在各面板自己的 margin-top 上。
  // 改回共用一个 gap 时只能让其中一个对，另两个各偏 5px 或 16px，而偏出来只像「高了
  // 一点」，不会有人报。
  assert.ok(/margin-top:\s*-5px;/.test(rule(PAGE_CSS, '.td-page .td-tab-panel[data-panel="workflow"]')),
    '工作流面板没有抵掉那 5px');
  assert.ok(/margin-top:\s*11px;/.test(rule(PAGE_CSS, '.td-page .td-tab-panel[data-panel="delivery"]')),
    '交付面板没有 11px 上间距');
  assert.ok(/margin-top:\s*11px;/.test(rule(PAGE_CSS, '.td-page .td-tab-panel[data-panel="contract"]')),
    '契约面板没有 11px 上间距');
  // 页头与页签之间的距离仍由 .td-page 的 gap 管，不许为了挪三页把它改掉。
  assert.ok(/gap:\s*16px;/.test(rule(PAGE_CSS, '.td-page')), '.td-page 的 gap 不再是 16px');
  const side = rule(OUTPUT_CSS, '.td-output .td-side');
  assert.ok(/height:\s*40px;/.test(side), '页签不是 40px：' + side);
  assert.ok(/border-bottom:\s*2px solid transparent;/.test(side), '页签没有 2px 下划线位：' + side);
  assert.equal(/border:\s*1px/.test(side), false, '页签仍是有边按钮：' + side);
  assert.ok(/background:\s*transparent;/.test(side), '页签不是透底的文字页签：' + side);
  const selected = rule(OUTPUT_CSS, ".td-output .td-side[aria-selected='true']");
  assert.equal(/border:\s*1px/.test(selected), false, '选中页签仍带描边：' + selected);
  assert.ok(/border-bottom-color:\s*var\(--color-accent\);/.test(selected), '选中页签没有强调色下划线：' + selected);
  assert.ok(/background:\s*transparent;/.test(selected), '选中页签改用色底了：' + selected);

  // 双卡与终端尺寸不能被这次排版改动带走。
  assert.ok(/width:\s*704px;/.test(rule(OUTPUT_CSS, '.td-output .td-live')), '左卡宽度变了');
  assert.ok(/height:\s*566px;/.test(rule(OUTPUT_CSS, '.td-output .td-live')), '左卡高度变了');
  assert.ok(/width:\s*456px;/.test(rule(OUTPUT_CSS, '.td-output .td-history')), '右卡宽度变了');
  assert.ok(/width:\s*656px;/.test(rule(OUTPUT_CSS, '.td-output .td-live-text')), '终端宽度变了');
  assert.ok(/height:\s*444px;/.test(rule(OUTPUT_CSS, '.td-output .td-live-text')), '终端高度变了');
});
