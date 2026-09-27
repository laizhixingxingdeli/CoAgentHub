/**
 * 早上的交接面：一屏看完方案这一晚走到哪、为什么停、要你定什么。
 *
 * 唯一的设计原则：**每个非成功项都写「要你定什么」**，不只是「哪里错了」。
 * 首行给用时 / 墙钟、总花销、停止原因——用户拿它校准阈值。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { renderPlanHandoff } from '../src/application/plan-handoff.ts';
import { PlanRun } from '../src/application/plan-run.ts';

const T0 = '2026-09-23T22:00:00.000Z';
const MIN = 60_000;
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * MIN).toISOString();

/** 六个功能，四种结局都有：✓ ⊘（重划删掉的依赖）⏸（过期）○（叫停后没轮到）。 */
function night() {
  const run = PlanRun.start({
    id: 'PLAN-x-20260923-2200',
    planId: 'PLAN-x',
    projectId: 'p',
    integrationBranch: 'auto/plan-x',
    reviewer: 'claude',
    stopConditions: { unresolvedEscalations: 5, wallClockMs: 8 * 60 * MIN, escalationTimeoutMs: 20 * MIN },
    featureIds: ['F1', 'F2', 'F3', 'F4', 'F5', 'F6'],
    titles: { F1: '记下是谁放行的', F2: '机器 L3', F3: '升级握手', F4: '驱动', F5: '交接面', F6: '清理' },
    startedAt: T0,
  });
  run.startFeature('F1', 'R-F1');
  run.markMerged('F1');
  run.startFeature('F2', 'R-F2');
  const e1 = run.openEscalation({ featureId: 'F2', missionId: 'R-F2', failure: '集成验证红', question: 'F2 怎么办？' }, at(40));
  run.choose(e1.id, { action: 'rescope', reason: 'F3 用到 F2 的新字段', decidedBy: 'claude', dropFeatures: ['F3'] }, at(45));
  run.startFeature('F4', 'R-F4');
  const e2 = run.openEscalation({ featureId: 'F4', missionId: 'R-F4', failure: '协调者卡住', question: 'F4 要不要拆小？' }, at(80));
  run.expire(e2.id, at(100));
  run.startFeature('F5', 'R-F5');
  const e3 = run.openEscalation({ featureId: 'F5', missionId: 'R-F5', failure: '合并冲突', question: 'F5 要不要停？' }, at(130));
  run.choose(e3.id, { action: 'stop', reason: '集成分支上的测试夹具整体坏了', decidedBy: 'claude' }, at(135));
  return run;
}

describe('交接面', () => {
  test('HA 待决展示证据和两条完整命令；各终态不展示可执行命令', () => {
    const makeRun = () => {
      const run = PlanRun.start({ id: 'R-ha', planId: 'P', projectId: 'p', integrationBranch: 'main', reviewer: 'claude', stopConditions: { unresolvedEscalations: 2, wallClockMs: 100000, escalationTimeoutMs: 1000 }, featureIds: ['F1'], startedAt: T0 });
      run.startFeature('F1', 'M-F1');
      run.openHaRelease({ featureId: 'F1', missionId: 'M-F1', reviewedCommit: 'sha1', attemptId: 'A1', validationReportId: 'VR1', reviewerId: 'claude', integrationBranch: 'main', openedAt: at(1), deadline: at(20), verification: [{ command: 'npm test', timeoutMs: 1000 }] });
      return run;
    };
    const pending = makeRun();
    const text = renderPlanHandoff(pending, { now: at(2), recordPath: 'C:/R-ha.json' }).join('\n');
    for (const evidence of ['M-F1', 'sha1', 'A1', 'VR1', 'main', at(20)]) assert.ok(text.includes(evidence));
    const featureRow = text.split('\n').find((line) => /\sF1\s/.test(line)) ?? '';
    assert.match(featureRow, /HA 待放行/);
    assert.match(featureRow, /等检视者决定/);
    assert.match(featureRow, /M-F1/);
    assert.match(featureRow, new RegExp(at(20)));
    assert.doesNotMatch(featureRow, /在跑\(/);
    assert.match(text, /plan approve M-F1 .*--run/);
    assert.match(text, /plan send-back M-F1 .*--run/);
    assert.ok(text.includes('--run "C:/R-ha.json"'));
    const terminals = [
      (() => { const run = makeRun(); run.decideHaRelease({ featureId: 'F1', missionId: 'M-F1', reviewedCommit: 'sha1', attemptId: 'A1', validationReportId: 'VR1', target: 'main', as: 'claude', confirmedBy: 'human', action: 'approve' }, at(10)); return run; })(),
      (() => { const run = makeRun(); run.decideHaRelease({ featureId: 'F1', missionId: 'M-F1', reviewedCommit: 'sha1', attemptId: 'A1', validationReportId: 'VR1', target: 'main', as: 'claude', confirmedBy: 'human', action: 'send_back', reason: '补证' }, at(10)); return run; })(),
      (() => { const run = makeRun(); run.expireHaRelease('F1', at(20)); return run; })(),
      (() => { const run = makeRun(); run.invalidateHaRelease('F1', '证据变化', at(10)); return run; })(),
      (() => { const run = makeRun(); run.halt('crashed', '中止', at(5)); return run; })(),
    ];
    for (const run of terminals) {
      const output = renderPlanHandoff(run, { now: at(2), recordPath: 'C:/R-ha.json' }).join('\n');
      assert.doesNotMatch(output, /plan approve/);
      assert.doesNotMatch(output, /plan send-back/);
    }
  });
  test('已决审批记录摘要包含理由、确认人与合入状态', () => {
    const make = (action: 'approve' | 'send_back', final: 'merged' | 'suspended' | 'running') => {
      const run = PlanRun.start({ id: `R-${action}-${final}`, planId: 'P', projectId: 'p', integrationBranch: 'main', reviewer: 'claude', stopConditions: { unresolvedEscalations: 2, wallClockMs: 100000, escalationTimeoutMs: 1000 }, featureIds: ['F1'], startedAt: T0 });
      run.startFeature('F1', 'M-F1');
      run.openHaRelease({ featureId: 'F1', missionId: 'M-F1', reviewedCommit: 'sha1', attemptId: 'A1', validationReportId: 'VR1', reviewerId: 'claude', integrationBranch: 'main', openedAt: at(1), deadline: at(20), verification: [{ command: 'npm test', timeoutMs: 1000 }] });
      run.decideHaRelease({ featureId: 'F1', missionId: 'M-F1', reviewedCommit: 'sha1', attemptId: 'A1', validationReportId: 'VR1', target: 'main', as: 'claude', confirmedBy: 'human', action, ...(action === 'send_back' ? { reason: '补充证据' } : {}) }, at(10));
      if (final === 'merged') run.markMerged('F1');
      if (final === 'suspended') run.suspendFeature('F1', '墙钟到点，等待人工核对');
      return run;
    };
    const sendBack = renderPlanHandoff(make('send_back', 'running'), { now: at(11) }).join('\n').split('\n').find((line) => line.includes('HA 放行记录')) ?? '';
    assert.match(sendBack, /send_back/);
    assert.match(sendBack, /补充证据/);
    assert.match(sendBack, /claude 经 human 确认/);
    const merged = renderPlanHandoff(make('approve', 'merged'), { now: at(11) }).join('\n').split('\n').find((line) => line.includes('HA 放行记录')) ?? '';
    assert.match(merged, /approve/);
    assert.match(merged, /已合入/);
    const suspended = renderPlanHandoff(make('approve', 'suspended'), { now: at(11) }).join('\n').split('\n').find((line) => line.includes('HA 放行记录')) ?? '';
    assert.match(suspended, /approve/);
    assert.match(suspended, /未合并/);
  });

  test('四种状态各有记号且各就各位；每个非成功项都写要你定什么', () => {
    const lines = renderPlanHandoff(night(), { now: at(200) });
    const row = (id: string) => lines.find((l) => new RegExp(`\\s${id}\\s`).test(l)) ?? '';
    assert.match(row('F1'), /✓/);
    assert.match(row('F2'), /⊘/);
    assert.match(row('F3'), /⊘/);
    assert.match(row('F4'), /⏸/);
    assert.match(row('F5'), /⏸/);
    assert.match(row('F6'), /○/);
    for (const id of ['F2', 'F3', 'F4', 'F5', 'F6']) {
      assert.match(row(id), /要你定/, `${id} 是非成功项，必须写要你定什么`);
    }
    assert.doesNotMatch(row('F1'), /要你定/, '合进去的不用人定');
    // 记号彼此可区分：同一行不出现两个记号。
    for (const id of ['F1', 'F2', 'F3', 'F4', 'F5', 'F6']) {
      assert.equal(row(id).match(/[✓⏸⊘○▶]/g)?.length, 1, `${id} 那一行记号不唯一`);
    }
    assert.match(row('F1'), /记下是谁放行的/, '标题照抄');
  });

  test('首行给用时 / 墙钟、总花销、停止原因与未解决计数——拿它校准阈值', () => {
    const [head] = renderPlanHandoff(night(), {
      now: at(200),
      costs: { missions: 2.9, routing: 0.51, unknownRuns: 0 },
    });
    assert.match(head, /PLAN-x/);
    assert.match(head, /2\.3h/, '用时算到停下那一刻（第 135 分钟）');
    assert.match(head, /8h/);
    assert.match(head, /\$3\.41/);
    assert.match(head, /检视者叫停/);
    assert.match(head, /测试夹具整体坏了/);
    assert.match(head, /未解决 1\/5/);
    assert.match(head, /升级单 3\/5/);
  });

  test('花销不全就说不全，不把未知当 0', () => {
    const [head] = renderPlanHandoff(night(), { now: at(200), costs: { missions: 1, routing: 0, unknownRuns: 2 } });
    assert.match(head, /\$1\.00/);
    assert.match(head, /2 条没报/);
  });

  test('还在跑且有开着的升级单：点出截止时间，并给检视者一行照抄就能用的命令', () => {
    const run = PlanRun.start({
      id: 'R-live',
      planId: 'PLAN-x',
      projectId: 'p',
      integrationBranch: 'auto/plan-x',
      reviewer: 'claude',
      stopConditions: { unresolvedEscalations: 5, wallClockMs: 8 * 60 * MIN, escalationTimeoutMs: 20 * MIN },
      featureIds: ['F1', 'F2'],
      startedAt: T0,
    });
    run.startFeature('F1', 'R-F1');
    run.openEscalation({ featureId: 'F1', missionId: 'R-F1', failure: '集成验证红（报告 IVAL-3）', question: 'F1 怎么办？' }, at(30));
    const text = renderPlanHandoff(run, { now: at(35), recordPath: 'C:/x/R-live.json' }).join('\n');
    assert.match(text, /还在跑/);
    assert.match(text, /E-1/);
    assert.match(text, /IVAL-3/);
    assert.match(text, new RegExp(at(50).slice(11, 16)), '截止时间要看得见');
    assert.match(text, /l3\.ts plan decide E-1 --action/);
    assert.match(text, /--as claude/);
    assert.match(text, /--run "C:\/x\/R-live\.json"/);
    assert.match(text, /▶/);
  });

  test('一屏：六个功能 + 首行 + 图例，不超过 11 行', () => {
    const lines = renderPlanHandoff(night(), { now: at(200) });
    assert.ok(lines.length <= 11, `一共 ${lines.length} 行`);
  });

  test('源方案未纳入另列一段；源 skipped 不用 ⊘；旧记录缺清单照常读', () => {
    const old = PlanRun.start({
      id: 'R-old',
      planId: 'PLAN-x',
      projectId: 'p',
      integrationBranch: 'auto/plan-x',
      reviewer: 'claude',
      stopConditions: { unresolvedEscalations: 5, wallClockMs: 8 * 60 * MIN, escalationTimeoutMs: 20 * MIN },
      featureIds: ['F1'],
      startedAt: T0,
    });
    const snap = old.toSnapshot();
    assert.equal('sourceExclusions' in snap, false);
    const restored = PlanRun.restore(JSON.parse(JSON.stringify(snap)));
    assert.equal(restored.sourceExclusions, undefined);
    const oldText = renderPlanHandoff(restored, { now: at(1) }).join('\n');
    assert.doesNotMatch(oldText, /源方案/);

    const run = PlanRun.start({
      id: 'R-ex',
      planId: 'PLAN-x',
      projectId: 'p',
      integrationBranch: 'auto/plan-x',
      reviewer: 'claude',
      stopConditions: { unresolvedEscalations: 5, wallClockMs: 8 * 60 * MIN, escalationTimeoutMs: 20 * MIN },
      featureIds: ['Ok'],
      titles: { Ok: '可跑' },
      startedAt: T0,
      sourceExclusions: [
        {
          featureId: 'A4',
          title: '软预算',
          sourceStatus: 'skipped',
          reason: '本次未纳入：源方案标 skipped；查看 skipReason，重新开工须由 L3 修订。',
        },
      ],
    });
    const text = renderPlanHandoff(run, { now: at(1) }).join('\n');
    assert.match(text, /本次未纳入（源方案，不是本次运行的检视者跳过）/);
    assert.match(text, /A4 源状态 skipped/);
    assert.match(text, /源方案标 skipped/);
    const a4 = text.split('\n').find((l) => l.includes('A4')) ?? '';
    assert.doesNotMatch(a4, /⊘/, '源 skipped 不得伪装成检视者跳过');
    assert.deepEqual(PlanRun.restore(JSON.parse(JSON.stringify(run.toSnapshot()))).sourceExclusions, run.sourceExclusions);
  });

  test('有过隔离重跑或正开着升级单的功能显示重跑 k/M', () => {
    const run = PlanRun.start({
      id: 'R-rerun',
      planId: 'PLAN-x',
      projectId: 'p',
      integrationBranch: 'auto/plan-x',
      reviewer: 'claude',
      stopConditions: {
        unresolvedEscalations: 5,
        wallClockMs: 8 * 60 * MIN,
        escalationTimeoutMs: 20 * MIN,
        maxRerunsPerFeature: 2,
      },
      featureIds: ['F1', 'F2'],
      startedAt: T0,
    });
    run.startFeature('F1', 'R-F1');
    const e1 = run.openEscalation(
      { featureId: 'F1', missionId: 'R-F1', failure: '红', question: '怎么办？' },
      at(10),
    )!;
    run.choose(e1.id, { action: 'rerun_isolated', reason: 'flake', decidedBy: 'claude' }, at(12));
    run.startFeature('F1', 'R-F1-r2');
    run.openEscalation(
      { featureId: 'F1', missionId: 'R-F1-r2', failure: '又红', question: '再选？' },
      at(40),
    );
    const text = renderPlanHandoff(run, { now: at(45) }).join('\n');
    assert.match(text, /升级单 2\/5/);
    const f1 = text.split('\n').find((l) => /\sF1\s/.test(l)) ?? '';
    assert.match(f1, /重跑 1\/2/);
    const f2 = text.split('\n').find((l) => /\sF2\s/.test(l)) ?? '';
    assert.doesNotMatch(f2, /重跑/);
  });

  test('重跑额度用完时 decide 模板不含 rerun_isolated', () => {
    const run = PlanRun.start({
      id: 'R-spent',
      planId: 'PLAN-x',
      projectId: 'p',
      integrationBranch: 'auto/plan-x',
      reviewer: 'claude',
      stopConditions: {
        unresolvedEscalations: 5,
        wallClockMs: 8 * 60 * MIN,
        escalationTimeoutMs: 20 * MIN,
        maxRerunsPerFeature: 1,
      },
      featureIds: ['F1'],
      startedAt: T0,
    });
    run.startFeature('F1', 'R-F1');
    const e1 = run.openEscalation(
      { featureId: 'F1', missionId: 'R-F1', failure: '红', question: '怎么办？' },
      at(10),
    )!;
    run.choose(e1.id, { action: 'rerun_isolated', reason: '再来', decidedBy: 'claude' }, at(12));
    run.startFeature('F1', 'R-F1-r2');
    run.openEscalation(
      { featureId: 'F1', missionId: 'R-F1-r2', failure: '又红', question: '再选？' },
      at(40),
    );
    const text = renderPlanHandoff(run, { now: at(45) }).join('\n');
    assert.match(text, /--action <skip\|rescope\|stop>/);
    assert.doesNotMatch(text, /rerun_isolated/);
  });

  test('escalation_limit 停止时给出标签，不出 decide 命令', () => {
    const run = PlanRun.start({
      id: 'R-cap',
      planId: 'PLAN-x',
      projectId: 'p',
      integrationBranch: 'auto/plan-x',
      reviewer: 'claude',
      stopConditions: {
        unresolvedEscalations: 5,
        wallClockMs: 8 * 60 * MIN,
        escalationTimeoutMs: 20 * MIN,
        maxEscalations: 1,
      },
      featureIds: ['F1', 'F2'],
      startedAt: T0,
    });
    run.startFeature('F1', 'R-F1');
    const e1 = run.openEscalation(
      { featureId: 'F1', missionId: 'R-F1', failure: '红', question: 'F1 怎么办？' },
      at(10),
    )!;
    run.choose(e1.id, { action: 'skip', reason: '过', decidedBy: 'claude' }, at(12));
    run.startFeature('F2', 'R-F2');
    run.openEscalation(
      { featureId: 'F2', missionId: 'R-F2', failure: '也红', question: 'F2 怎么办？' },
      at(20),
    );
    const lines = renderPlanHandoff(run, { now: at(25) });
    const text = lines.join('\n');
    assert.match(text, /升级单到上限/);
    assert.match(text, /也红/);
    assert.match(text, /R-F2/);
    assert.doesNotMatch(text, /plan decide/);
  });
});
