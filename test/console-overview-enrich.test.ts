/**
 * 总览补充投影（src/web/console-overview-enrich.js）。
 *
 * 只写一条 test：这一层最容易出的错都不报错也不崩——把重跑画成补修、把 executing
 * 当成正在跑、把没上报的落地画成「未合入」、把附录里的样本数（119）当产品事实。
 * 每条断言对应工单里的一句验收，分支不各写一条：同一个判断写第二遍不会更准。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyOverlay,
  candidateAttemptRefs,
  explicitRepair,
  landingLine,
  overlayFromDetail,
} from '../src/web/console-overview-enrich.js';

test('补修 / 落地 / 真实运行 / 附标：只认详情里的真实证据', () => {
  /* ---------- 1. 补修只读工单正文，且要点名原工作项 ---------- */

  // 标题里点名原项。
  assert.equal(
    explicitRepair({ workItems: [{ title: '补修 W-12 的验收后半段' }] }),
    true,
  );
  // 正文里点名原项。
  assert.equal(
    explicitRepair({ workItems: [{ title: '补一张单', order: { requiredBehaviour: '补修原项未覆盖的日志轮转' } }] }),
    true,
  );
  // 只有「补修」没有原项也没有 W-数字：不构成证据。
  assert.equal(explicitRepair({ workItems: [{ title: '补修一下' }] }), false);
  // 重跑是「同一个目标重来一遍」，不是补修。
  assert.equal(explicitRepair({ origin: { rerunOf: 'M-0' }, workItems: [] }), false);
  assert.equal(explicitRepair({ workItems: [{ title: '重跑 W-12' }] }), false);
  // repairOf 在真实数据里不存在，认了就等于给重跑留了后门。
  assert.equal(explicitRepair({ repairOf: 'W-12', workItems: [] }), false);
  // 不是对象 / workItems 不是数组：没有证据。
  assert.equal(explicitRepair(null), false);
  assert.equal(explicitRepair({ workItems: 2 }), false);

  /* ---------- 2. 集成落地：只认 finalReview.mergedInto ---------- */

  const merged = landingLine({ status: 'completed', finalReview: { verdict: 'merge', mergedInto: 'abc123' } });
  assert.equal(merged, '已合入集成 · master 未记录');
  const unrecorded = landingLine({ status: 'completed', finalReview: { verdict: 'merge' } });
  assert.equal(unrecorded, '落地未记录 · master 未记录');
  // 还没走完的状态不催这件事。
  assert.equal(landingLine({ status: 'executing' }), '');
  assert.equal(landingLine(null), '');
  // 平台没有 master 证据，就不替它断言合了还是没合；也不把设计稿的样本总数当事实。
  for (const line of [merged, unrecorded]) {
    assert.ok(!line.includes('master 未合入'), line);
    assert.ok(!line.includes('119'), line);
  }

  /* ---------- 3. Attempt 候选：每个槽位只取最后一条 ---------- */

  assert.deepEqual(
    candidateAttemptRefs({
      missionId: 'M-1',
      coordinatorAttemptIds: ['c1', 'c2'],
      workItems: [{ attemptIds: ['e1', 'e2'] }],
    }),
    [
      { missionId: 'M-1', attemptId: 'c2' },
      { missionId: 'M-1', attemptId: 'e2' },
    ],
  );

  /* ---------- 4. 真实运行：只看 in_progress 的 Attempt ---------- */

  const running = overlayFromDetail(
    { missionId: 'M-1', status: 'executing' },
    [{ id: 'A-1', status: 'completed', kind: 'executor' }, { id: 'A-2', status: 'in_progress', kind: 'executor' }],
  );
  assert.equal(running.liveAttempt, true);
  assert.equal(running.runningText, '执行者运行中');

  // executing / isMutating 不证明有人在跑；openEscalations 的条数不是问题。
  const idle = overlayFromDetail({ status: 'executing', isMutating: true, openEscalations: 3 }, []);
  assert.equal(idle.liveAttempt, false);
  assert.equal(idle.runningText, '');
  assert.equal(idle.problem, false);

  // 一条未答复、且不带平台可信门禁的升级才算问题升级（门禁判断复用 projectMarks）。
  const escalated = overlayFromDetail(
    { status: 'executing', openEscalations: [{ attemptId: 'A-3', question: '改不改接口', why: '契约冲突', optionsConsidered: [] }] },
    [],
  );
  assert.equal(escalated.problem, true);

  /* ---------- 5. 合到行上：返回副本，只追加、不改入参 ---------- */

  const row = { missionId: 'M-1', marks: [{ key: 'paused', text: '已暂停' }], marksText: '已暂停', owner: { key: 'l3', text: '等你检视' } };
  const snapshot = JSON.parse(JSON.stringify(row));
  const mergedRow = applyOverlay(row, { repair: true, problem: false, landingLine: '', liveAttempt: false, runningText: '' });
  assert.deepEqual(row, snapshot);
  assert.notEqual(mergedRow, row);
  assert.ok(mergedRow.marks.some((mark: { key: string }) => mark.text === '补修'));
  assert.ok(mergedRow.marksText.includes('补修'));
  assert.equal(mergedRow.owner.text, '等你检视');
});
