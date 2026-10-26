/**
 * 交付与验证区的渲染层（src/web/task-detail-delivery-view.js）。
 *
 * 只写两条，对应验收的两条：
 *   1. 派出去了但还没交回时，机器层说的是「当前未交回」，残留的通过报告只是残留；
 *      交卷摘要也不抄上一跳的改动文件。
 *   2. direct 的角色层标题是「外部主控验收」，标准任务的独立复核是「不适用」，
 *      master 只说未记录、不说未合入。
 *
 * 这些错了浏览器都不报错：屏幕上的字看着都挺合理，只是把上一跳的通过贴到这一跳头上，
 * 或者替平台断言一件它没有证据的事。
 *
 * 夹具写在文件里，不读仓库外的 JSON（外部文件一改，测试静默换了意思）。DOM 用仓库
 * 里已有的 happy-dom（经 npm workspaces 装在根 node_modules），不装新依赖。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Window } from 'happy-dom';

import { taskDeliveryHtml } from '../src/web/task-detail-delivery-view.js';

const CSS = readFileSync(new URL('../src/web/task-detail-delivery.css', import.meta.url), 'utf8');

const window = new Window({ url: 'http://127.0.0.1:3101/#/missions/CUI3-task-detail-20261026' });
const document = window.document as unknown as Document;

function mount(view: Record<string, unknown>, options: Record<string, unknown> = {}) {
  document.body.innerHTML = '<div id="view"></div>';
  const container = document.getElementById('view') as unknown as HTMLElement;
  container.innerHTML = taskDeliveryHtml(view, options);
  const root = container.querySelector('.td-delivery') as HTMLElement;
  assert.ok(root, '没有渲染出交付区根节点');
  const q = (selector: string) => root.querySelector(selector) as HTMLElement | null;
  return { root, q };
}

test('重派未交回：机器层不说通过，交卷摘要不抄上一跳的文件', () => {
  // dispatch 不清旧结果：旧报告、旧交卷、旧验收都还挂在这一项上。
  const { root, q } = mount({
    missionId: 'CUI3-task-detail-20261026',
    status: 'executing',
    coordinationMode: 'hierarchical',
    executionMode: 'standard',
    workItems: [
      {
        id: 'W-900',
        title: '交付验证六层视图',
        status: 'dispatched',
        attemptIds: ['W-900.exec-1', 'W-900.exec-2'],
        validationReport: { reportId: 'VR-616', passed: true },
        executionResult: { outcome: 'completed', summary: '上一跳的交卷', changedFiles: ['src/web/x.js'] },
        lastReview: { verdict: 'accept' },
        order: { verification: ['node --test test/task-detail-delivery-view.test.ts'] },
      },
    ],
  }, { selectedWorkItemId: 'W-900' });

  const machine = q('[data-layer="machine"]');
  assert.ok(machine, '没有机器层');
  const state = machine.querySelector('.td-layer-state') as HTMLElement | null;
  assert.ok(state, '机器层缺状态节点');
  assert.equal(state.getAttribute('data-state'), 'not_returned');
  assert.equal(state.textContent, '当前未交回');

  const detail = machine.querySelector('.td-layer-detail')?.textContent || '';
  assert.ok(detail.includes('VR-616'), '机器层没点出残留是哪一份报告：' + detail);
  assert.ok(detail.includes('不作为当前结果'), '机器层没说清残留不算当前：' + detail);

  // 整层都不能出现「通过」：残留的 passed 一旦被写成通过，屏幕上就是这一跳过了。
  assert.equal((machine.textContent || '').includes('通过'), false,
    '机器层把残留的旧报告写成了通过：' + (machine.textContent || ''));

  const submission = q('.td-submission');
  assert.ok(submission, '没有交卷摘要');
  const said = submission.textContent || '';
  assert.ok(said.includes('当前未交回'), '交卷摘要没说清当前未交回：' + said);
  assert.equal(said.includes('src/web/x.js'), false, '交卷摘要抄了上一跳的改动文件：' + said);

  // 命令仍要列出来（它是工单要求），但必须标明不是已跑结果。
  assert.ok(said.includes('node --test test/task-detail-delivery-view.test.ts'), '交了任务却没列工单验证命令');
  assert.ok(said.includes('不是已跑结果'), '命令与「跑过没有」没分开：' + said);

  // 样式：颜色只从 --color-* 进来；每条规则都挂在 .td-delivery 下，否则会改到 ui.css 的 .card。
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(CSS), false, 'CSS 里出现了十六进制色值');
  for (const selector of ['.td-layer', '.td-submission', '.td-delivery-layers']) {
    assert.ok(CSS.includes('.td-delivery ' + selector), selector + ' 没有 .td-delivery 作用域');
  }

  assert.ok(root.getAttribute('data-current-returned'), '根节点没记当前是否交回');
});

test('direct 已交回未验收：外部主控验收待处理、独立复核不适用、master 只说未记录', () => {
  const { q } = mount({
    missionId: 'CUI3-task-detail-20261026',
    status: 'executing',
    coordinationMode: 'direct',
    executionMode: 'standard',
    workItems: [
      {
        id: 'W-900',
        title: '交付验证六层视图',
        status: 'submitted',
        attemptIds: ['W-900.exec-1'],
        validationReport: { reportId: 'VR-1', passed: false },
        executionResult: { outcome: 'partial', summary: '改完待验', changedFiles: ['src/web/a.js'] },
        order: { verification: ['node --test test/a.test.ts'] },
        // 没有 lastReview：交回了但还没有验收结论。
      },
    ],
    // 没有 finalReview：还没到检视。
  }, { selectedWorkItemId: 'W-900' });

  const role = q('[data-layer="role"]');
  assert.ok(role, '没有角色层');
  assert.equal(role.querySelector('.td-layer-title')?.textContent, '外部主控验收');
  const roleState = role.querySelector('.td-layer-state') as HTMLElement | null;
  assert.equal(roleState?.getAttribute('data-state'), 'pending');
  assert.equal(roleState?.textContent, '待处理');
  // direct 的 Mission 里没有 L2：整区不许出现「协调者验收」，人凭它去找一个不存在的角色。
  assert.equal((role.textContent || '').includes('协调者验收'), false);

  const independent = q('[data-layer="independent"]');
  assert.ok(independent, '没有独立复核层');
  const independentState = independent.querySelector('.td-layer-state') as HTMLElement | null;
  assert.equal(independentState?.getAttribute('data-state'), 'inapplicable');
  assert.equal(independentState?.textContent, '不适用');

  const master = q('[data-layer="master"]');
  assert.ok(master, '没有 master 层');
  const masterSaid = master.textContent || '';
  assert.ok(masterSaid.includes('未记录'), 'master 层没说未记录：' + masterSaid);
  assert.equal(masterSaid.includes('未合入'), false, 'master 层把「没有证据」写成了「未合入」：' + masterSaid);

  // 交回了但还没验收：不得出现「未合入」这种替平台断言的结论。
  const whole = q('.td-delivery')?.textContent || '';
  assert.equal(whole.includes('未合入'), false, '交付区出现了未合入：' + whole);
});
