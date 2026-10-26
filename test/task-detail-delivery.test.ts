/**
 * 交付验证六层投影（src/web/task-detail-delivery.js）。
 *
 * 只写四条，对应工单里三条验收：这一层的错都不报错也不崩——把重派后残留的旧报告/
 * 旧交卷说成「当前已通过」、把 direct 的验收写成「协调者验收」、把标准任务的独立复核
 * 写成「未知」、把「没有 master 证据」说成「未合入」；以及已交回时三处时间与已跑命令
 * 能不能从 activity / 完整报告组对。夹具写在文件里，不读仓库外的 JSON（外部文件
 * 一改，测试静默换了意思）。
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
 * 已交回且事件链对得上：三处时间分别是对应事件的 at，受评执行是执行者而不是评审者。
 *
 * 这里错一笔都不报错——屏幕上只是「提交时间未知」或者「受评执行 coord-8」，而人正靠
 * 这一行判断结论是对着哪一跳下的。
 */
test('已交回：提交 / 机器 / 角色三处时间来自对应事件，受评执行不是评审者', () => {
  const delivery = projectDelivery({
    missionId: 'CUI3-task-detail-20261026',
    status: 'executing',
    coordinationMode: 'hierarchical',
    executionMode: 'standard',
    workItems: [
      {
        id: 'W-906',
        title: '交卷证据时间',
        status: 'accepted',
        attemptIds: ['W-906.exec-1'],
        lastReview: { verdict: 'accept', attemptId: 'coord-8' },
        validationReport: { reportId: 'VR-639', passed: true },
        executionResult: { outcome: 'completed', summary: '补齐时间', changedFiles: ['src/web/a.js'] },
        order: { verification: ['node --test test/a.test.ts'] },
      },
    ],
  }, {
    selectedWorkItemId: 'W-906',
    activity: [
      {
        kind: 'execution_result.submitted',
        at: '2026-10-26T13:29:13.113Z',
        attemptId: 'W-906.exec-1',
        workItemId: 'W-906',
        data: { orderRevision: 'r2' },
      },
      {
        kind: 'validation.reported',
        at: '2026-10-26T13:31:17.987Z',
        workItemId: 'W-906',
        data: { reportId: 'VR-639', submittedAttemptId: 'W-906.exec-1' },
      },
      {
        kind: 'review.recorded',
        at: '2026-10-26T13:33:47.061Z',
        attemptId: 'coord-8',
        workItemId: 'W-906',
        data: { verdict: 'accept' },
      },
    ],
    validationReport: {
      id: 'VR-639',
      missionId: 'CUI3-task-detail-20261026',
      workItemId: 'W-906',
      attemptId: 'W-906.exec-1',
      passed: true,
      checks: [
        {
          kind: 'command',
          passed: true,
          command: {
            argv: ['node', '--test'],
            cwd: '/repo',
            exitCode: 0,
            timedOut: false,
            durationMs: 1000,
            outputTail: '# tests 2033\n# pass 2033\n# fail 0\n',
          },
        },
        // 行数只认 diff-size 的可计里程：有才写，没有就是未知。
        { kind: 'diff-size', passed: true, diffSize: { limits: {}, used: { changedLines: 37 }, unknown: [] } },
      ],
    },
  });

  const byKey = Object.fromEntries(delivery.layers.map((l) => [l.key, l]));
  assert.equal(byKey.machine.timeText, '2026-10-26T13:31:17.987Z');
  assert.equal(byKey.role.timeText, '2026-10-26T13:33:47.061Z');
  assert.equal(delivery.submission.submittedAtText, '2026-10-26T13:29:13.113Z');
  assert.equal(delivery.submission.lineDeltaText, '37 行');

  // 受评的是执行者；评审者（coord-8）只用来对齐事件。
  assert.ok(delivery.submission.reviewedExecution.includes('W-906.exec-1'));
  assert.equal(delivery.submission.reviewedExecution.includes('coord-8'), false,
    '受评执行写成了评审者：' + delivery.submission.reviewedExecution);

  // 已跑命令与计数只从归属对得上的完整报告来。
  assert.deepEqual(delivery.submission.ranCommands, ['node --test']);
  assert.equal(delivery.submission.ranCounts, 'tests 2033 · pass 2033');
  // 工单要求那一份仍在，并标明不是已跑结果。
  assert.deepEqual(delivery.submission.verification.commands, ['node --test test/a.test.ts']);
  assert.equal(delivery.submission.verification.note.includes('不是已跑结果'), true);
});

/**
 * 未交回：即使残留报告、残留评审事件、甚至把完整报告递进来，三处时间与已跑命令都是未知。
 *
 * 这是上面那条的反面。缺了它，「当前未交回时继承旧报告」这种错就没人看得见。
 */
test('未交回（dispatched）：三处时间与已跑命令仍未知，不采用残留报告', () => {
  const delivery = projectDelivery({
    missionId: 'CUI3-task-detail-20261026',
    status: 'executing',
    coordinationMode: 'hierarchical',
    executionMode: 'standard',
    workItems: [
      {
        id: 'W-906',
        title: '交卷证据时间',
        status: 'dispatched',
        attemptIds: ['W-906.exec-1'],
        lastReview: { verdict: 'accept', attemptId: 'coord-8' },
        validationReport: { reportId: 'VR-639', passed: true },
        executionResult: { outcome: 'completed', summary: '上一跳', changedFiles: [] },
        order: { verification: ['node --test test/a.test.ts'] },
      },
    ],
  }, {
    selectedWorkItemId: 'W-906',
    activity: [
      {
        kind: 'execution_result.submitted',
        at: '2026-10-26T13:29:13.113Z',
        attemptId: 'W-906.exec-1',
        workItemId: 'W-906',
      },
      {
        kind: 'validation.reported',
        at: '2026-10-26T13:31:17.987Z',
        workItemId: 'W-906',
        data: { reportId: 'VR-639', submittedAttemptId: 'W-906.exec-1' },
      },
      {
        kind: 'review.recorded',
        at: '2026-10-26T13:33:47.061Z',
        attemptId: 'coord-8',
        workItemId: 'W-906',
        data: { verdict: 'accept' },
      },
    ],
    validationReport: {
      id: 'VR-639',
      missionId: 'CUI3-task-detail-20261026',
      workItemId: 'W-906',
      attemptId: 'W-906.exec-1',
      passed: true,
      checks: [
        {
          kind: 'command',
          passed: true,
          command: { argv: ['node', '--test'], cwd: '/repo', exitCode: 0, outputTail: '# tests 2033\n# pass 2033\n' },
        },
      ],
    },
  });

  const byKey = Object.fromEntries(delivery.layers.map((l) => [l.key, l]));
  assert.equal(delivery.currentReturned, false);
  assert.equal(byKey.machine.timeText, '未知');
  assert.equal(byKey.role.timeText, '未知');
  assert.equal(delivery.submission.submittedAtText, '未知');
  assert.equal(delivery.submission.lineDeltaText, '未知');
  assert.equal(delivery.submission.ranCommands, null);
  assert.equal(delivery.submission.ranCounts, null);
  assert.equal(delivery.submission.reviewedExecution, null);
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
