/**
 * 交付验证六层投影（src/web/task-detail-delivery.js）。
 *
 * 只写两条，对应工单里两条验收：这一层的错都不报错也不崩——把重派后残留的旧报告/
 * 旧交卷说成「当前已通过」、把 direct 的验收写成「协调者验收」、把标准任务的独立复核
 * 写成「未知」、把「没有 master 证据」说成「未合入」。夹具写在文件里，不读仓库外的
 * JSON（外部文件一改，测试静默换了意思）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { projectDelivery } from '../src/web/task-detail-delivery.js';

/** 重派形状：dispatch 不清旧结果，所以旧报告与旧交卷都还挂在这一项上。 */
test('重派未交回：旧报告与旧交卷都不算当前结果', () => {
  const delivery = projectDelivery({
    missionId: 'CUI3-task-detail-20261026',
    status: 'executing',
    coordinationMode: 'hierarchical',
    executionMode: 'standard',
    workItems: [
      {
        id: 'W-895',
        title: '交付验证六层纯投影',
        status: 'dispatched',
        // 派了两次：第一次跑完被打回，这次还没交回。
        attemptIds: ['W-895.exec-1', 'W-895.exec-2'],
        // 上一跳留下的通过报告：挂的是旧的 submittedAttemptId，讲不出这一跳过没过。
        validationReport: { reportId: 'VR-616', passed: true, commands: [] },
        executionResult: { outcome: 'completed', summary: '上一跳的交卷', changedFiles: ['src/web/x.js'] },
        lastReview: { verdict: 'accept' },
        order: { verification: ['node --test test/x.test.ts'] },
      },
    ],
  }, { selectedWorkItemId: 'W-895' });

  const byKey = Object.fromEntries(delivery.layers.map((l) => [l.key, l]));
  assert.deepEqual(delivery.layers.map((l) => l.key), ['machine', 'role', 'independent', 'final', 'integration', 'master']);

  // 当前未交回：残留的 passed 不得变成这一跳的「通过」。
  assert.equal(delivery.currentReturned, false);
  assert.equal(byKey.machine.state, 'not_returned');
  assert.equal(byKey.machine.stateText, '当前未交回');
  assert.notEqual(byKey.machine.state, 'passed');
  assert.equal(byKey.machine.detail.includes('VR-616'), true);
  assert.equal(byKey.machine.detail.includes('不作为当前结果'), true);

  // 残留的 accept 同样不算当前验收结论。
  assert.notEqual(byKey.role.state, 'passed');
  assert.equal(byKey.role.state, 'not_returned');

  // 上一跳的交卷不是这一跳的交卷：摘要不当前，文件也不抄进 currentFiles。
  assert.equal(delivery.submission.current, false);
  assert.equal(delivery.submission.changedFiles, null);
  assert.equal(delivery.submission.currentFiles, null);
  // verification 只来自工单，并标明不是已跑结果。
  assert.deepEqual(delivery.submission.verification.commands, ['node --test test/x.test.ts']);
  assert.equal(delivery.submission.verification.note.includes('不是已跑结果'), true);
});

/** direct + 标准任务已交回：验收方是外部主控，独立复核不适用，master 只说未记录。 */test('direct 已交回：外部主控验收、独立复核不适用、master 未记录', () => {
  const delivery = projectDelivery({
    missionId: 'CUI3-task-detail-20261026',
    status: 'executing',
    coordinationMode: 'direct',
    executionMode: 'standard',
    // 还没到检视，也没有终审：集成层只能是未开始，不能从别处借一个结论。
    workItems: [
      {
        id: 'W-895',
        title: '交付验证六层纯投影',
        status: 'submitted',
        attemptIds: ['W-895.exec-1'],
        validationReport: { reportId: 'VR-1', passed: false, commands: [] },
        executionResult: { outcome: 'partial', summary: '改完待验', changedFiles: ['src/web/a.js'] },
        order: { verification: ['node --test test/a.test.ts'] },
      },
    ],
  }, { selectedWorkItemId: 'W-895' });

  const byKey = Object.fromEntries(delivery.layers.map((l) => [l.key, l]));

  assert.equal(delivery.currentReturned, true);

  // 报告说没过就是没过，并且要点出是哪一份报告。
  assert.equal(byKey.machine.state, 'failed');
  assert.equal(byKey.machine.attribution.includes('VR-1'), true);

  // direct：主控在平台外面验收，标题不能是「协调者验收」。
  assert.equal(byKey.role.title, '外部主控验收');
  assert.equal(byKey.role.title.includes('协调者验收'), false);
  assert.equal(byKey.role.detail.includes('协调者验收'), false);
  // 交回了但还没有验收结论：待处理，不能因为报告或旧记录写成通过。
  assert.equal(byKey.role.state, 'pending');
  assert.equal(byKey.role.stateText, '待处理');

  // 标准任务不需要独立复核：不适用，不是未知。
  assert.equal(byKey.independent.state, 'inapplicable');
  assert.equal(byKey.independent.detail, '仅高保障任务需要');

  assert.equal(byKey.integration.state, 'not_started');

  // master 没有可读字段：只说未记录，不替平台断言合没合。
  assert.equal(byKey.master.state, 'unknown');
  assert.equal(byKey.master.stateText, '未知');
  assert.equal(byKey.master.detail.includes('未记录'), true);
  assert.equal(byKey.master.detail.includes('未合入'), false);
  assert.equal(byKey.master.detail.includes('已合入 master'), false);
});

/**
 * 契约改版后回到待检视：内核不清 finalReview，上一轮的 send_back 还挂在那里。
 * 那是上一轮的退回，不是这一轮终审未通过——这一轮的终审还没发生。
 */
test('awaiting_review 且残留上轮 send_back：终审是待处理，上轮退回只带出处另记', () => {
  const delivery = projectDelivery({
    missionId: 'CUI3-task-detail-20261026',
    status: 'awaiting_review',
    coordinationMode: 'hierarchical',
    executionMode: 'standard',
    // 契约更新留下的旧结论：reasons 是上一轮的打回理由，讲不出这一轮。
    finalReview: { verdict: 'send_back', reasons: ['验收 4 未满足'], mergedInto: '' },
    workItems: [
      {
        id: 'W-910',
        title: '补修交付三栏',
        status: 'submitted',
        attemptIds: ['W-910.exec-1'],
        validationReport: { reportId: 'VR-1182', passed: true, commands: [] },
        executionResult: { outcome: 'completed', summary: '改完待检视', changedFiles: ['src/web/a.js', 'src/web/b.js'] },
        order: { verification: ['node --test test/a.test.ts'] },
      },
    ],
  }, { selectedWorkItemId: 'W-910' });

  const byKey = Object.fromEntries(delivery.layers.map((l) => [l.key, l]));
  const final = byKey.final;

  // 当前这一层：待处理，不是拿上一轮的 send_back 画成未通过。
  assert.equal(final.state, 'pending');
  assert.equal(final.stateText, '待处理');
  assert.notEqual(final.state, 'failed');
  assert.equal(final.detail, '任务已到待检视，还没有本轮终审结论');

  // 上轮退回要另记，且写明不算当前结论，并带出处。
  assert.equal(final.priorNote.includes('send_back'), true);
  assert.equal(final.priorNote.includes('不作为当前结论'), true);
  assert.equal(final.attribution, '上一轮终审记录');
  assert.equal(final.detail.includes('send_back'), false);

  // 待检视时这一轮没有终审时刻；上轮的 mergedAt 不得拿来做这一层的时间。
  assert.equal(final.timeText, '未知');
  assert.equal(byKey.machine.timeText, '未知');

  // 未合入/未记录仍分开说：残留终审不替平台断言合没合。
  assert.equal(byKey.master.state, 'unknown');
  assert.equal(byKey.integration.state, 'not_started');
});
