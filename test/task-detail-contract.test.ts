/**
 * 契约页签只读投影（src/web/task-detail-contract.js）。
 *
 * 只写两条，对应工单里两条验收：这一层的错都不报错也不崩——把缺掉的 nonGoals 写成
 * `[]`、把 allowedScope 合并成两个工作项并集、把长 acceptance 截断，界面上都长得像对的，
 * 只有对着真实投影断言才问得出来。夹具写在文件里，不读仓库外的 JSON。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { projectContractPage } from '../src/web/task-detail-contract.js';

/** 完整契约 + 两个工作项：allowedScope 只认所选那一项，缺掉的 nonGoals 必须是 null。 */
test('完整契约：原文不截断，nonGoals 缺失是 null，allowedScope 只来自所选工单', () => {
  // 句子长到任何「顺手截一下」都会露馅。
  const intent = '把任务详情页的契约页签改成只读投影，让页面上读到的 intent 与验收标准逐字等于契约原文，'
    + '而不是协调者改写过的摘要；这一页不提供任何审批、恢复或终审动作，动作留在别的页签。';
  const acceptanceFirst = 'contractRevision、intent、acceptance 按详情原样可读；缺失的 nonGoals 是 null 而不是空数组。';
  const acceptanceSecond = 'allowedScope 只来自所选工作项工单，不含另一项的路径。';

  const page = projectContractPage({
    missionId: 'CUI3-task-detail-20261026',
    status: 'executing',
    contractRevision: 4,
    contract: {
      intent,
      acceptance: [acceptanceFirst, acceptanceSecond],
      constraints: ['只新增投影模块与测试文件。'],
      guardrails: ['不引入构建步骤。'],
      // nonGoals 故意缺：契约里没写，页面就不能替它说「没有非目标」。
    },
    workItems: [
      {
        id: 'W-1',
        title: '前一项',
        status: 'accepted',
        order: { allowedScope: ['src/secret.ts'] },
      },
      {
        id: 'W-2',
        title: '当前一项',
        status: 'dispatched',
        order: { allowedScope: ['src/web/task.js'] },
      },
    ],
  }, { selectedWorkItemId: 'W-2' });

  assert.equal(page.contractRevision, 4);
  assert.equal(page.intent, intent);
  assert.deepEqual(page.acceptance, [acceptanceFirst, acceptanceSecond]);
  assert.deepEqual(page.constraints, ['只新增投影模块与测试文件。']);
  assert.deepEqual(page.guardrails, ['不引入构建步骤。']);

  // 缺字段是「没记」，不是「一条都没有」。
  assert.equal(page.nonGoals, null);
  assert.notDeepEqual(page.nonGoals, []);

  // 另一项工作项的路径绝不能混进来。
  assert.deepEqual(page.allowedScope, ['src/web/task.js']);
  assert.equal(page.allowedScope.includes('src/secret.ts'), false);

  assert.equal(page.selectedWorkItemId, 'W-2');
  assert.equal(page.readOnly, true);
});

/** 空详情：不抛错，不臆造，每一格都是「不知道」或「没有」。 */
test('没有契约也没有工作项：各格为 null，不抛错，仍只读', () => {
  const page = projectContractPage({ missionId: 'CUI3-task-detail-20261026' }, { selectedWorkItemId: 'W-2' });

  // 只有契约页签该有的几格：没有审批 / 恢复 / 终审那些动作字段。
  assert.deepEqual(Object.keys(page).sort(), [
    'acceptance',
    'allowedScope',
    'constraints',
    'contractRevision',
    'guardrails',
    'intent',
    'nonGoals',
    'readOnly',
    'selectedWorkItemId',
  ]);
  assert.equal(page.intent, null);
  assert.equal(page.acceptance, null);
  assert.equal(page.allowedScope, null);
  // revision 缺省不补成 1：补了就是替平台说「这是第一版契约」。
  assert.equal(page.contractRevision, null);
  assert.equal(page.selectedWorkItemId, null);
  assert.equal(page.readOnly, true);
});
