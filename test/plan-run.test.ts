/**
 * 方案运行（PlanRun）的规则：升级握手与停止条件。
 *
 * 这里只验纯规则——时间一律从外面传，不碰文件、不起进程。跨进程那一半
 * （另一个进程读到升级单、写回决定）在 plan-run-store.test.ts。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MAX_ESCALATIONS,
  DEFAULT_MAX_RERUNS_PER_FEATURE,
  ESCALATION_TEXT_LIMIT,
  PlanRun,
  REVIEWER_ACTIONS,
} from '../src/application/plan-run.ts';
import { PlatformRuleError } from '../src/application/platform.ts';

const T0 = '2026-09-23T14:00:00.000Z';
const MIN = 60_000;

function at(minutes: number): string {
  return new Date(Date.parse(T0) + minutes * MIN).toISOString();
}

function startRun() {
  return PlanRun.start({
    id: 'R1',
    planId: 'PLAN-x',
    projectId: 'p',
    integrationBranch: 'auto/x',
    reviewer: 'claude',
    stopConditions: {
      unresolvedEscalations: 2,
      wallClockMs: 8 * 60 * MIN,
      escalationTimeoutMs: 20 * MIN,
    },
    featureIds: ['F1', 'F2', 'F3'],
    startedAt: T0,
  });
}

/** F1 在跑，失败了，开了一张升级单（第 10 分钟）。 */
function withEscalation() {
  const run = startRun();
  run.startFeature('F1', 'M-F1');
  const escalation = run.openEscalation(
    {
      featureId: 'F1',
      missionId: 'M-F1',
      failure: '集成验证红：node --test → 1',
      question: 'F1 合进去之后全量测试红了：跳过它，还是隔离重跑？',
    },
    at(10),
  );
  return { run, escalation };
}

function rule(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof PlatformRuleError, `应是 PlatformRuleError，实际 ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

describe('HA 待放行', () => {
  test('checkStop 为升级单、HA 待决、HA 已决定及普通运行分别交接且不改 HA 记录', () => {
    const start = (featureId: string) => PlanRun.start({
      id: `R-${featureId}`, planId: 'PLAN-x', projectId: 'p', integrationBranch: 'auto/x', reviewer: 'claude',
      stopConditions: { unresolvedEscalations: 2, wallClockMs: 30 * MIN, escalationTimeoutMs: 20 * MIN },
      featureIds: [featureId], startedAt: T0,
    });
    const open = (run: PlanRun, featureId: string, missionId: string) => run.openHaRelease({
      featureId, missionId, reviewedCommit: `commit-${featureId}`, attemptId: `A-${featureId}`,
      validationReportId: `VR-${featureId}`, reviewerId: 'claude', integrationBranch: 'auto/x',
      openedAt: at(1), deadline: at(20), verification: [{ command: 'node --test', timeoutMs: 1000 }],
    });

    const escalated = start('E');
    escalated.startFeature('E', 'M-E');
    escalated.openEscalation({ featureId: 'E', missionId: 'M-E', failure: '失败', question: '定动作' }, at(1));
    escalated.checkStop(at(30));
    assert.match(escalated.feature('E')?.needsDecision ?? '', /升级单还没人定/);

    const pending = start('P');
    pending.startFeature('P', 'M-P');
    open(pending, 'P', 'M-P');
    const pendingBefore = pending.haReleases;
    pending.checkStop(at(30));
    assert.match(pending.feature('P')?.needsDecision ?? '', /HA 待放行还没定.*M-P/);
    assert.deepEqual(pending.haReleases, pendingBefore);

    const decided = start('D');
    decided.startFeature('D', 'M-D');
    open(decided, 'D', 'M-D');
    decided.decideHaRelease({ featureId: 'D', missionId: 'M-D', reviewedCommit: 'commit-D', attemptId: 'A-D', validationReportId: 'VR-D', target: 'auto/x', as: 'claude', confirmedBy: 'human', action: 'send_back', reason: '需重做' }, at(10));
    const decidedBefore = decided.haReleases;
    decided.checkStop(at(30));
    assert.match(decided.feature('D')?.needsDecision ?? '', /已有结论 send_back.*需重做.*没有合并，也没开升级单.*M-D/);
    assert.deepEqual(decided.haReleases, decidedBefore);

    const ordinary = start('N');
    ordinary.startFeature('N', 'M-N');
    ordinary.checkStop(at(30));
    assert.match(ordinary.feature('N')?.needsDecision ?? '', /它还在跑.*M-N/);
  });

  function openRelease() {
    const run = startRun();
    run.startFeature('F1', 'M-F1');
    const record = run.openHaRelease({
      featureId: 'F1', missionId: 'M-F1', reviewedCommit: 'abc123', attemptId: 'A1',
      validationReportId: 'VR1', reviewerId: 'claude', integrationBranch: 'auto/x',
      openedAt: at(1), deadline: at(20), verification: [{ command: 'node --test', timeoutMs: 1000 }],
    });
    return { run, record };
  }

  test('open 绑定已记录 Mission，重复待决拒绝，故障计数不变', () => {
    const { run, record } = openRelease();
    assert.equal(record.runId, run.id);
    assert.equal(run.escalationsOpened, 0);
    assert.equal(run.rerunsUsed('F1'), 0);
    assert.throws(() => run.openHaRelease({ ...record, runId: undefined as never }), rule('HA_RELEASE_ALREADY_OPEN'));
  });

  test('approve 与 send_back 是唯一终结，截止时刻拒签', () => {
    const { run, record } = openRelease();
    assert.throws(() => run.decideHaRelease({ featureId: 'F1', missionId: 'M-F1', reviewedCommit: 'abc123', attemptId: 'A1', validationReportId: 'VR1', target: 'auto/x', as: 'claude', confirmedBy: 'human', action: 'approve' }, record.deadline), rule('HA_RELEASE_REJECTED'));
    run.decideHaRelease({ featureId: 'F1', missionId: 'M-F1', reviewedCommit: 'abc123', attemptId: 'A1', validationReportId: 'VR1', target: 'auto/x', as: 'claude', confirmedBy: 'human', action: 'send_back', reason: '需补证' }, at(10));
    assert.equal(run.haReleases[0].decision?.kind, 'send_back');
    assert.throws(() => run.expireHaRelease('F1', at(30)), rule('HA_RELEASE_REJECTED'));
  });

  test('过期与失效记录终结理由', () => {
    const { run } = openRelease();
    assert.throws(() => run.expireHaRelease('F1', at(19)), rule('HA_RELEASE_REJECTED'));
    run.expireHaRelease('F1', at(20));
    assert.equal(run.haReleases[0].decision?.kind, 'expired');
  });
});

describe('升级握手', () => {
  test('开单：截止 = 开单时刻 + escalationTimeoutMs，单子开着等决定', () => {
    const { run, escalation } = withEscalation();
    assert.equal(escalation.openedAt, at(10));
    assert.equal(escalation.deadline, at(30));
    assert.equal(escalation.resolution, undefined);
    assert.equal(run.currentEscalation?.id, escalation.id);
  });

  test('检视者截止前选「跳过」：决定落账，功能记 ⊘，并写明要人定什么', () => {
    const { run, escalation } = withEscalation();
    run.choose(
      escalation.id,
      { action: 'skip', reason: 'F1 的测试夹具与 F2 冲突，今晚不值得再烧', decidedBy: 'claude' },
      at(25),
    );
    const decided = run.escalations.find((e) => e.id === escalation.id);
    assert.deepEqual(decided?.resolution, {
      kind: 'decided',
      action: 'skip',
      reason: 'F1 的测试夹具与 F2 冲突，今晚不值得再烧',
      decidedBy: 'claude',
      decidedAt: at(25),
    });
    assert.equal(run.currentEscalation, undefined);
    const f1 = run.feature('F1');
    assert.equal(f1?.status, 'skipped');
    // 只写「哪里错了」不够：⊘ 的人早上要知道自己该定什么。
    assert.match(f1?.needsDecision ?? '', /要你定/);
    assert.match(f1?.needsDecision ?? '', /今晚不值得再烧/);
  });

  test('截止一到（含）就不再收决定：迟到的决定不能悄悄生效', () => {
    const { run, escalation } = withEscalation();
    assert.throws(
      () =>
        run.choose(escalation.id, { action: 'skip', reason: '晚了', decidedBy: 'claude' }, at(30)),
      rule('ESCALATION_DEADLINE_PASSED'),
    );
    // 被拒的决定一个字都没落下。
    assert.equal(run.currentEscalation?.id, escalation.id);
    assert.equal(run.feature('F1')?.status, 'running');
  });

  test('只有本次运行指定的检视者的决定作数', () => {
    const { run, escalation } = withEscalation();
    assert.throws(
      () =>
        run.choose(escalation.id, { action: 'skip', reason: '我觉得', decidedBy: 'someone-else' }, at(12)),
      rule('NOT_DESIGNATED_REVIEWER'),
    );
    assert.equal(run.currentEscalation?.id, escalation.id);
  });

  test('动作表里没有「通过」和「合并」：检视者永不宣布通过、永不自己发合并', () => {
    const { run, escalation } = withEscalation();
    for (const action of ['merge', 'pass', 'approve', 'accept']) {
      assert.throws(
        () => run.choose(escalation.id, { action, reason: '看着没问题', decidedBy: 'claude' }, at(12)),
        rule('REVIEWER_ACTION_FORBIDDEN'),
      );
    }
    assert.equal(run.currentEscalation?.id, escalation.id);
    assert.equal(run.feature('F1')?.status, 'running');
  });

  test('决定必须带理由：不说清楚，早上的人只能再猜一遍', () => {
    const { run, escalation } = withEscalation();
    assert.throws(
      () => run.choose(escalation.id, { action: 'skip', reason: '  ', decidedBy: 'claude' }, at(12)),
      rule('DECISION_REASON_REQUIRED'),
    );
  });

  test('一张单子只能定一次', () => {
    const { run, escalation } = withEscalation();
    run.choose(escalation.id, { action: 'skip', reason: '先放一放', decidedBy: 'claude' }, at(12));
    assert.throws(
      () => run.choose(escalation.id, { action: 'stop', reason: '改主意了', decidedBy: 'claude' }, at(13)),
      rule('ESCALATION_ALREADY_RESOLVED'),
    );
    const resolution = run.escalations[0].resolution;
    assert.equal(resolution?.kind === 'decided' ? resolution.action : undefined, 'skip');
  });
});

describe('超时与未解决', () => {
  test('截止前不能判过期：检视者还在它的窗口里', () => {
    const { run, escalation } = withEscalation();
    assert.throws(() => run.expire(escalation.id, at(29)), rule('ESCALATION_NOT_DUE'));
    assert.equal(run.unresolvedCount, 0);
    assert.equal(run.currentEscalation?.id, escalation.id);
  });

  test('截止一到判过期：记一次未解决，功能挂起并写明要人定什么', () => {
    const { run, escalation } = withEscalation();
    run.expire(escalation.id, at(30));
    assert.deepEqual(run.escalations[0].resolution, { kind: 'expired', expiredAt: at(30) });
    assert.equal(run.unresolvedCount, 1);
    assert.equal(run.currentEscalation, undefined);
    const f1 = run.feature('F1');
    assert.equal(f1?.status, 'suspended');
    assert.match(f1?.needsDecision ?? '', /要你定/);
    // 要定的就是当初问检视者的那件事，原样交给人。
    assert.match(f1?.needsDecision ?? '', /跳过它，还是隔离重跑/);
    assert.equal(run.stopped, undefined);
  });

  test('判过期与决定互斥：谁先落账谁作数，后到的被明确拒绝', () => {
    const expiredFirst = withEscalation();
    expiredFirst.run.expire(expiredFirst.escalation.id, at(30));
    assert.throws(
      () =>
        expiredFirst.run.choose(
          expiredFirst.escalation.id,
          { action: 'skip', reason: '刚醒', decidedBy: 'claude' },
          at(31),
        ),
      rule('ESCALATION_ALREADY_RESOLVED'),
    );
    assert.equal(expiredFirst.run.escalations[0].resolution?.kind, 'expired');

    const decidedFirst = withEscalation();
    decidedFirst.run.choose(
      decidedFirst.escalation.id,
      { action: 'skip', reason: '先放一放', decidedBy: 'claude' },
      at(29),
    );
    assert.throws(
      () => decidedFirst.run.expire(decidedFirst.escalation.id, at(30)),
      rule('ESCALATION_ALREADY_RESOLVED'),
    );
    assert.equal(decidedFirst.run.escalations[0].resolution?.kind, 'decided');
    assert.equal(decidedFirst.run.unresolvedCount, 0);
  });

  test('未解决累计到阈值（≥）就停，并写明原因；停了之后什么都不再收', () => {
    const { run, escalation } = withEscalation();
    run.expire(escalation.id, at(30));
    assert.equal(run.stopped, undefined, '1 < 阈值 2，不该停');

    run.startFeature('F2', 'M-F2');
    const second = run.openEscalation(
      { featureId: 'F2', missionId: 'M-F2', failure: '协调者连续两轮没有结构化提交', question: 'F2 要不要重划？' },
      at(40),
    );
    run.expire(second.id, at(60));

    assert.equal(run.unresolvedCount, 2);
    assert.equal(run.stopped?.reason, 'unresolved_escalations');
    assert.equal(run.stopped?.at, at(60));
    assert.match(run.stopped?.detail ?? '', /2/);

    assert.throws(() => run.startFeature('F3', 'M-F3'), rule('PLAN_RUN_STOPPED'));
    assert.throws(
      () => run.openEscalation({ featureId: 'F3', failure: 'x', question: 'y' }, at(61)),
      rule('PLAN_RUN_STOPPED'),
    );
    assert.equal(run.feature('F3')?.status, 'pending', '没轮到的保持 ○');
  });
});

describe('墙钟', () => {
  test('没到点不停；到点（含）就停，写明原因，跑着的功能挂起交给人', () => {
    const run = startRun();
    run.startFeature('F1', 'M-F1');
    assert.equal(run.checkStop(at(8 * 60 - 1)), undefined);
    assert.equal(run.stopped, undefined);

    const stop = run.checkStop(at(8 * 60));
    assert.equal(stop?.reason, 'wall_clock');
    assert.equal(run.stopped?.reason, 'wall_clock');
    const f1 = run.feature('F1');
    assert.equal(f1?.status, 'suspended');
    assert.match(f1?.needsDecision ?? '', /要你定/);
    assert.equal(run.feature('F2')?.status, 'pending');
  });

  test('先到者停：已经因未解决停了，墙钟再到也不改原因', () => {
    const { run, escalation } = withEscalation();
    // 阈值 2：连着两张单子等不到就停在第 60 分钟。
    run.expire(escalation.id, at(30));
    run.startFeature('F2', 'M-F2');
    const second = run.openEscalation({ featureId: 'F2', failure: 'x', question: 'y？' }, at(40));
    run.expire(second.id, at(60));
    const later = run.checkStop(at(9 * 60));
    assert.equal(later?.reason, 'unresolved_escalations');
    assert.equal(run.stopped?.at, at(60));
  });
});

describe('检视者的其余三个动作', () => {
  test('重划剩余范围：只能删还没轮到的，当前功能一并 ⊘，各自写明依赖谁', () => {
    const { run, escalation } = withEscalation();
    run.choose(
      escalation.id,
      { action: 'rescope', reason: 'F3 用到 F1 新加的字段', decidedBy: 'claude', dropFeatures: ['F3'] },
      at(12),
    );
    assert.equal(run.feature('F1')?.status, 'skipped');
    const f3 = run.feature('F3');
    assert.equal(f3?.status, 'skipped');
    assert.match(f3?.needsDecision ?? '', /F1/);
    assert.match(f3?.needsDecision ?? '', /要你定/);
    assert.equal(run.feature('F2')?.status, 'pending', '没点名的不动');
    const resolution = run.escalations[0].resolution;
    assert.deepEqual(resolution?.kind === 'decided' ? resolution.dropFeatures : undefined, ['F3']);
  });

  test('重划剩余范围不能删已经走完的、正在跑的或不存在的，也不能空手重划', () => {
    const { run, escalation } = withEscalation();
    for (const dropFeatures of [['F1'], ['F9'], [], undefined]) {
      assert.throws(
        () =>
          run.choose(
            escalation.id,
            { action: 'rescope', reason: '重划', decidedBy: 'claude', dropFeatures },
            at(12),
          ),
        rule('RESCOPE_TARGET_INVALID'),
      );
    }
    assert.equal(run.currentEscalation?.id, escalation.id, '被拒的重划一个字都没落下');
    assert.equal(run.feature('F3')?.status, 'pending');
  });

  test('只有重划带删除名单：跳过 / 停 / 重跑夹带名单会被拒，而不是悄悄忽略', () => {
    const { run, escalation } = withEscalation();
    for (const action of ['skip', 'stop', 'rerun_isolated']) {
      assert.throws(
        () =>
          run.choose(
            escalation.id,
            { action, reason: '顺手', decidedBy: 'claude', dropFeatures: ['F3'] },
            at(12),
          ),
        rule('RESCOPE_TARGET_INVALID'),
      );
    }
    assert.equal(run.feature('F3')?.status, 'pending');
  });

  test('停：方案停下，当前功能挂起交给人，没轮到的保持 ○', () => {
    const { run, escalation } = withEscalation();
    run.choose(
      escalation.id,
      { action: 'stop', reason: '集成分支上的测试夹具整体坏了，再跑只会一路红', decidedBy: 'claude' },
      at(12),
    );
    assert.equal(run.stopped?.reason, 'reviewer_stop');
    assert.match(run.stopped?.detail ?? '', /测试夹具整体坏了/);
    const f1 = run.feature('F1');
    assert.equal(f1?.status, 'suspended');
    assert.match(f1?.needsDecision ?? '', /要你定/);
    assert.equal(run.feature('F2')?.status, 'pending');
    assert.equal(run.unresolvedCount, 0, '检视者定了就不算未解决');
  });

  test('隔离重跑：功能退回待跑，下一个该跑的还是它，Mission 记录累加', () => {
    const { run, escalation } = withEscalation();
    run.choose(
      escalation.id,
      { action: 'rerun_isolated', reason: '像是 flake：同一条用例隔离复跑三次全绿', decidedBy: 'claude' },
      at(12),
    );
    assert.equal(run.feature('F1')?.status, 'pending');
    assert.equal(run.nextPending()?.featureId, 'F1');
    run.startFeature('F1', 'M-F1-r2');
    assert.deepEqual(run.feature('F1')?.missionIds, ['M-F1', 'M-F1-r2']);
  });
});

describe('功能点的流转', () => {
  test('同一时刻只跑一个；只有待跑的能开跑', () => {
    const run = startRun();
    run.startFeature('F1', 'M-F1');
    assert.throws(() => run.startFeature('F2', 'M-F2'), rule('PLAN_FEATURE_BUSY'));
    run.markMerged('F1');
    assert.throws(() => run.startFeature('F1', 'M-F1-again'), rule('PLAN_FEATURE_NOT_PENDING'));
    assert.throws(() => run.startFeature('F9', 'M-F9'), rule('UNKNOWN_PLAN_FEATURE'));
    run.startFeature('F2', 'M-F2');
    assert.equal(run.feature('F2')?.status, 'running');
  });

  test('升级单只能开给正在跑的功能，且同一时刻只开一张', () => {
    const run = startRun();
    assert.throws(
      () => run.openEscalation({ featureId: 'F1', failure: 'x', question: 'y？' }, at(1)),
      rule('PLAN_FEATURE_NOT_RUNNING'),
    );
    run.startFeature('F1', 'M-F1');
    run.openEscalation({ featureId: 'F1', failure: 'x', question: 'y？' }, at(1));
    assert.throws(
      () => run.openEscalation({ featureId: 'F1', failure: 'x2', question: 'y2？' }, at(2)),
      rule('ESCALATION_ALREADY_OPEN'),
    );
  });

  test('等着决定的功能不能被合入或挂起：先把单子了结', () => {
    const { run } = withEscalation();
    assert.throws(() => run.markMerged('F1'), rule('ESCALATION_ALREADY_OPEN'));
    assert.throws(() => run.suspendFeature('F1', '要你定：x'), rule('ESCALATION_ALREADY_OPEN'));
  });

  test('合入：跑着的 → ✓', () => {
    const run = startRun();
    assert.throws(() => run.markMerged('F1'), rule('PLAN_FEATURE_NOT_RUNNING'));
    run.startFeature('F1', 'M-F1');
    run.markMerged('F1');
    assert.equal(run.feature('F1')?.status, 'merged');
    assert.equal(run.feature('F1')?.needsDecision, undefined);
  });

  test('不经升级直接挂起（如判成 high_assurance）：必须写要你定什么', () => {
    const run = startRun();
    assert.throws(() => run.suspendFeature('F1', '  '), rule('NEEDS_DECISION_REQUIRED'));
    run.suspendFeature('F1', '分类为 high_assurance，按规定要人放行。要你定：今晚之后亲自跑它吗？');
    assert.equal(run.feature('F1')?.status, 'suspended');
    assert.equal(run.nextPending()?.featureId, 'F2');
  });

  test('走完：还有待跑或在跑的就不算走完；走完了停在 finished', () => {
    const run = startRun();
    run.startFeature('F1', 'M-F1');
    run.markMerged('F1');
    assert.throws(() => run.finish(at(5)), rule('PLAN_RUN_NOT_FINISHED'));
    run.suspendFeature('F2', '要你定：x');
    run.startFeature('F3', 'M-F3');
    assert.throws(() => run.finish(at(6)), rule('PLAN_RUN_NOT_FINISHED'));
    run.markMerged('F3');
    run.finish(at(7));
    assert.equal(run.stopped?.reason, 'finished');
  });

  test('驱动方主动停（集成分支不安全 / 自己崩了）：写明原因，跑着的挂起', () => {
    const run = startRun();
    run.startFeature('F1', 'M-F1');
    run.halt('unsafe', '集成验证红且回滚失败：集成分支上留着一个没验过的合并', at(9));
    assert.equal(run.stopped?.reason, 'unsafe');
    assert.equal(run.feature('F1')?.status, 'suspended');
    assert.match(run.feature('F1')?.needsDecision ?? '', /没验过的合并/);
    assert.throws(() => run.halt('crashed', '又停一次', at(10)), rule('PLAN_RUN_STOPPED'));
  });
});

describe('开跑参数', () => {
  const base = {
    id: 'R1',
    planId: 'PLAN-x',
    projectId: 'p',
    integrationBranch: 'auto/x',
    reviewer: 'claude',
    stopConditions: { unresolvedEscalations: 5, wallClockMs: 1, escalationTimeoutMs: 1 },
    featureIds: ['F1'],
    startedAt: T0,
  };

  test('停止条件必须是正整数：0 或缺省等于没有这道闸', () => {
    for (const stopConditions of [
      { unresolvedEscalations: 0, wallClockMs: 1, escalationTimeoutMs: 1 },
      { unresolvedEscalations: 5, wallClockMs: -1, escalationTimeoutMs: 1 },
      { unresolvedEscalations: 5, wallClockMs: 1, escalationTimeoutMs: 1.5 },
      { unresolvedEscalations: 5, wallClockMs: 1 },
      { unresolvedEscalations: 5, wallClockMs: 1, escalationTimeoutMs: 1, maxEscalations: 0 },
      { unresolvedEscalations: 5, wallClockMs: 1, escalationTimeoutMs: 1, maxRerunsPerFeature: -1 },
    ]) {
      assert.throws(
        () => PlanRun.start({ ...base, stopConditions: stopConditions as never }),
        rule('PLAN_RUN_INVALID'),
      );
    }
  });

  test('必须指定检视者、至少一个功能、功能不重名', () => {
    assert.throws(() => PlanRun.start({ ...base, reviewer: ' ' }), rule('PLAN_RUN_INVALID'));
    assert.throws(() => PlanRun.start({ ...base, featureIds: [] }), rule('PLAN_RUN_INVALID'));
    assert.throws(() => PlanRun.start({ ...base, featureIds: ['F1', 'F1'] }), rule('PLAN_RUN_INVALID'));
  });
});

describe('快照', () => {
  /** 各种状态都走一遍：✓ ⊘ ⏸ ○、一张过期、一张开着。 */
  function busyRun() {
    const run = PlanRun.start({
      id: 'R2',
      planId: 'PLAN-x',
      projectId: 'p',
      integrationBranch: 'auto/x',
      reviewer: 'claude',
      stopConditions: { unresolvedEscalations: 5, wallClockMs: 8 * 60 * MIN, escalationTimeoutMs: 20 * MIN },
      featureIds: ['F1', 'F2', 'F3', 'F4', 'F5'],
      startedAt: T0,
    });
    run.startFeature('F1', 'M-F1');
    run.markMerged('F1');
    run.startFeature('F2', 'M-F2');
    const e1 = run.openEscalation({ featureId: 'F2', missionId: 'M-F2', failure: '红', question: '跳不跳？' }, at(10));
    run.choose(e1.id, { action: 'rescope', reason: 'F4 依赖 F2', decidedBy: 'claude', dropFeatures: ['F4'] }, at(15));
    run.startFeature('F3', 'M-F3');
    const e2 = run.openEscalation({ featureId: 'F3', failure: '卡住', question: '重跑吗？' }, at(20));
    run.expire(e2.id, at(40));
    run.startFeature('F5', 'M-F5');
    run.openEscalation({ featureId: 'F5', missionId: 'M-F5', failure: '合并冲突', question: '停吗？' }, at(50));
    return run;
  }

  test('经 JSON 往返后原样恢复，规则照常生效', () => {
    const original = busyRun();
    const restored = PlanRun.restore(JSON.parse(JSON.stringify(original.toSnapshot())));
    assert.deepEqual(restored.toSnapshot(), original.toSnapshot());
    assert.equal(restored.unresolvedCount, 1);
    assert.equal(restored.currentEscalation?.featureId, 'F5');
    // 恢复出来的仍认得指定检视者和截止时间。
    assert.throws(
      () => restored.choose('E-3', { action: 'stop', reason: 'x', decidedBy: 'mallory' }, at(55)),
      rule('NOT_DESIGNATED_REVIEWER'),
    );
    assert.throws(
      () => restored.choose('E-3', { action: 'stop', reason: 'x', decidedBy: 'claude' }, at(70)),
      rule('ESCALATION_DEADLINE_PASSED'),
    );
    restored.choose('E-3', { action: 'stop', reason: '冲突要人看', decidedBy: 'claude' }, at(55));
    assert.equal(restored.stopped?.reason, 'reviewer_stop');
  });

  test('读不懂的记录拒绝恢复，不静默重置、不猜', () => {
    const good = busyRun().toSnapshot() as unknown as Record<string, unknown>;
    const corrupt = (patch: (s: Record<string, any>) => void) => {
      const copy = JSON.parse(JSON.stringify(good));
      patch(copy);
      return copy;
    };
    for (const snapshot of [
      null,
      corrupt((s) => { s.version = 2; }),
      corrupt((s) => { delete s.reviewer; }),
      corrupt((s) => { s.features[0].status = 'done'; }),
      corrupt((s) => { s.escalations[0].resolution.action = 'merge'; }),
      corrupt((s) => { s.escalations[1].resolution.kind = 'maybe'; }),
      corrupt((s) => { s.stopConditions.unresolvedEscalations = 0; }),
      corrupt((s) => { s.escalations[2].deadline = 'soon'; }),
    ]) {
      assert.throws(() => PlanRun.restore(snapshot), rule('PLAN_RUN_CORRUPT'));
    }
  });
});

describe('功能标题', () => {
  test('开跑时记下标题：早上看交接面不用回头翻方案文件（它到早上可能已经改了）', () => {
    const run = PlanRun.start({
      id: 'R3',
      planId: 'PLAN-x',
      projectId: 'p',
      integrationBranch: 'auto/x',
      reviewer: 'claude',
      stopConditions: { unresolvedEscalations: 5, wallClockMs: 1, escalationTimeoutMs: 1 },
      featureIds: ['F1', 'F2'],
      titles: { F1: 'run-plan.ts 驱动' },
      startedAt: T0,
    });
    assert.equal(run.feature('F1')?.title, 'run-plan.ts 驱动');
    assert.equal(run.feature('F2')?.title, undefined, '没给就没有，不编');
    const restored = PlanRun.restore(JSON.parse(JSON.stringify(run.toSnapshot())));
    assert.equal(restored.feature('F1')?.title, 'run-plan.ts 驱动');
  });

  test('没有标题的旧记录照样读；标题不是字符串就算读不懂', () => {
    const old = startRun().toSnapshot() as unknown as { features: Record<string, unknown>[] };
    assert.equal(PlanRun.restore(JSON.parse(JSON.stringify(old))).feature('F1')?.title, undefined);
    const bad = JSON.parse(JSON.stringify(old));
    bad.features[0].title = 42;
    assert.throws(() => PlanRun.restore(bad), rule('PLAN_RUN_CORRUPT'));
  });
});

function gatedRun(extra?: {
  maxEscalations?: number;
  maxRerunsPerFeature?: number;
  featureIds?: string[];
}) {
  return PlanRun.start({
    id: 'R1',
    planId: 'PLAN-x',
    projectId: 'p',
    integrationBranch: 'auto/x',
    reviewer: 'claude',
    stopConditions: {
      unresolvedEscalations: 9,
      wallClockMs: 8 * 60 * MIN,
      escalationTimeoutMs: 20 * MIN,
      ...(extra?.maxEscalations !== undefined ? { maxEscalations: extra.maxEscalations } : {}),
      ...(extra?.maxRerunsPerFeature !== undefined ? { maxRerunsPerFeature: extra.maxRerunsPerFeature } : {}),
    },
    featureIds: extra?.featureIds ?? ['F1', 'F2', 'F3'],
    startedAt: T0,
  });
}

function failOpen(
  run: PlanRun,
  featureId: string,
  missionId: string,
  minutes: number,
  failure = `${featureId} 红了`,
) {
  run.startFeature(featureId, missionId);
  return run.openEscalation(
    {
      featureId,
      missionId,
      failure,
      question: `${featureId} 选隔离重跑、跳过、重划还是停？`,
    },
    at(minutes),
  );
}

describe('升级单总数上限',
  () => {
    test('maxEscalations = 2：第 1、2 张照常开；已决定、已过期、开着都计入已开张数',
      () => {
        const run = gatedRun({ maxEscalations: 2 });
        const e1 = failOpen(run, 'F1', 'M-F1', 10);
        assert.ok(e1);
        assert.equal(run.escalationsOpened, 1, '开着的也算');
        run.choose(e1.id, { action: 'skip', reason: '今晚不跑', decidedBy: 'claude' }, at(12));
        assert.equal(run.escalationsOpened, 1, '已决定的仍算');

        const e2 = failOpen(run, 'F2', 'M-F2', 20);
        assert.ok(e2);
        assert.equal(run.escalationsOpened, 2);
        run.expire(e2.id, at(40));
        assert.equal(run.escalationsOpened, 2, '已过期的仍算');
        assert.equal(run.stopped, undefined, '未解决阈值是 9，过期一张不停');

        const third = failOpen(run, 'F3', 'M-F3', 50, '第三次失败');
        assert.equal(third, undefined, '第 3 次失败不开单');
        assert.equal(run.escalations.length, 2);
        const f3 = run.feature('F3');
        assert.equal(f3?.status, 'suspended');
        assert.match(f3?.needsDecision ?? '', /第三次失败/);
        assert.match(f3?.needsDecision ?? '', /M-F3/);
        assert.match(f3?.needsDecision ?? '', /要你定/);
        assert.equal(run.stopped?.reason, 'escalation_limit');
        assert.match(run.stopped?.detail ?? '', /已开 2/);
        assert.match(run.stopped?.detail ?? '', /F3/);
      });

    test('到上限停下之后任何动作都被拒；失败的功能保持挂起',
      () => {
        const run = gatedRun({ maxEscalations: 1, featureIds: ['F1', 'F2'] });
        assert.ok(failOpen(run, 'F1', 'M-F1', 10));
        run.choose('E-1', { action: 'skip', reason: '先过', decidedBy: 'claude' }, at(12));
        assert.equal(failOpen(run, 'F2', 'M-F2', 20), undefined);
        assert.throws(() => run.startFeature('F2', 'M-F2-x'), rule('PLAN_RUN_STOPPED'));
        assert.throws(
          () => run.openEscalation({ featureId: 'F2', failure: 'x', question: 'y' }, at(21)),
          rule('PLAN_RUN_STOPPED'),
        );
        assert.equal(run.feature('F2')?.status, 'suspended');
      });
  });

describe('每功能重跑上限',
  () => {
    test('上限 1：第一次 rerun 接受；再选被拒且记录不变；同单可改 skip；另一功能不受影响',
      () => {
        const run = gatedRun({ maxRerunsPerFeature: 1 });
        const e1 = failOpen(run, 'F1', 'M-F1', 10);
        assert.ok(e1);
        run.choose(e1.id, { action: 'rerun_isolated', reason: '像 flake', decidedBy: 'claude' }, at(12));
        assert.equal(run.rerunsUsed('F1'), 1);

        const e2 = failOpen(run, 'F1', 'M-F1-r2', 20);
        assert.ok(e2);
        const before = JSON.stringify(run.toSnapshot());
        assert.throws(
          () => run.choose(e2.id, { action: 'rerun_isolated', reason: '再试', decidedBy: 'claude' }, at(22)),
          (error: unknown) => {
            rule('RERUN_LIMIT_REACHED')(error);
            assert.match((error as Error).message, /F1/);
            assert.match((error as Error).message, /1/);
            return true;
          },
        );
        assert.equal(JSON.stringify(run.toSnapshot()), before);
        assert.equal(run.feature('F1')?.status, 'running');
        assert.equal(run.currentEscalation?.id, e2.id);

        run.choose(e2.id, { action: 'skip', reason: '改选跳过', decidedBy: 'claude' }, at(23));
        assert.equal(run.feature('F1')?.status, 'skipped');

        const e3 = failOpen(run, 'F2', 'M-F2', 30);
        assert.ok(e3);
        run.choose(e3.id, { action: 'rerun_isolated', reason: 'F2 第一次重跑', decidedBy: 'claude' }, at(32));
        assert.equal(run.feature('F2')?.status, 'pending');
        assert.equal(run.rerunsUsed('F2'), 1);
      });
  });

describe('两道闸的快照兼容',
  () => {
    test('缺新字段的旧快照按缺省恢复；toSnapshot 写出生效值',
      () => {
        const snap = startRun().toSnapshot() as unknown as Record<string, unknown>;
        const stop = { ...(snap.stopConditions as Record<string, unknown>) };
        delete stop.maxEscalations;
        delete stop.maxRerunsPerFeature;
        snap.stopConditions = stop;
        const restored = PlanRun.restore(snap);
        assert.equal(restored.stopConditions.maxEscalations, DEFAULT_MAX_ESCALATIONS);
        assert.equal(restored.stopConditions.maxRerunsPerFeature, DEFAULT_MAX_RERUNS_PER_FEATURE);
        assert.equal(restored.toSnapshot().stopConditions.maxEscalations, DEFAULT_MAX_ESCALATIONS);
        assert.equal(startRun().toSnapshot().stopConditions.maxRerunsPerFeature, DEFAULT_MAX_RERUNS_PER_FEATURE);
      });

    test('超额的旧快照照常恢复，不重审已发生的决定；之后新动作受生效上限约束', () => {
      const run = gatedRun({ maxEscalations: 20, maxRerunsPerFeature: 10, featureIds: ['F1', 'F2'] });
      for (let i = 0; i < 7; i += 1) {
        const opened = failOpen(run, 'F1', `M-F1-${i}`, 10 + i * 30, `红${i}`);
        assert.ok(opened);
        run.choose(
          opened.id,
          { action: 'rerun_isolated', reason: `第${i}次重跑`, decidedBy: 'claude' },
          at(11 + i * 30),
        );
      }
      assert.equal(run.escalationsOpened, 7);
      assert.equal(run.rerunsUsed('F1'), 7);
      const snap = run.toSnapshot() as unknown as Record<string, unknown>;
      const stop = { ...(snap.stopConditions as Record<string, unknown>) };
      delete stop.maxEscalations;
      delete stop.maxRerunsPerFeature;
      snap.stopConditions = stop;
      const restored = PlanRun.restore(JSON.parse(JSON.stringify(snap)));
      assert.equal(restored.escalationsOpened, 7);
      assert.equal(restored.rerunsUsed('F1'), 7);
      assert.equal(restored.stopConditions.maxEscalations, DEFAULT_MAX_ESCALATIONS);
      assert.equal(restored.escalations[0].resolution?.kind, 'decided');
      assert.equal(restored.stopped, undefined);

      const next = failOpen(restored, 'F2', 'M-F2', 400, 'F2 也红');
      assert.equal(next, undefined);
      assert.equal(restored.escalations.length, 7, '不再开第 8 张');
      assert.equal(restored.stopped?.reason, 'escalation_limit');
    });

    test('非法的新字段 → PLAN_RUN_CORRUPT；escalation_limit 能往返', () => {
      const good = startRun().toSnapshot() as unknown as Record<string, unknown>;
      for (const value of [0, -1, 1.5, '3', null]) {
        const copy = JSON.parse(JSON.stringify(good));
        copy.stopConditions.maxEscalations = value;
        assert.throws(() => PlanRun.restore(copy), rule('PLAN_RUN_CORRUPT'), String(value));
      }

      const hit = gatedRun({ maxEscalations: 1, featureIds: ['F1', 'F2'] });
      assert.ok(failOpen(hit, 'F1', 'M-F1', 10));
      hit.choose('E-1', { action: 'skip', reason: '过', decidedBy: 'claude' }, at(12));
      assert.equal(failOpen(hit, 'F2', 'M-F2', 20), undefined);
      assert.equal(hit.stopped?.reason, 'escalation_limit');
      const restored = PlanRun.restore(JSON.parse(JSON.stringify(hit.toSnapshot())));
      assert.deepEqual(restored.toSnapshot(), hit.toSnapshot());
      assert.equal(restored.stopped?.reason, 'escalation_limit');
    });
  });

function withAnswerable(question = '契约里的 missionId 是不是写错了？') {
  const run = startRun();
  run.startFeature('F1', 'M-F1');
  const escalation = run.openEscalation(
    {
      featureId: 'F1',
      missionId: 'M-F1',
      failure: '协调者提问',
      question,
      answerable: true,
    },
    at(10),
  );
  assert.ok(escalation);
  return { run, escalation };
}

describe('可答复升级单',
  () => {
    test('REVIEWER_ACTIONS 仍是原四个动作，不含 answer',
      () => {
        assert.deepEqual([...REVIEWER_ACTIONS], ['rerun_isolated', 'skip', 'rescope', 'stop']);
      });

    test('answerable 单记下 trim 后的原问；超长截断并在 4000 内注明；必须有合法 missionId',
      () => {
        const { run, escalation } = withAnswerable('  原问要 trim  ');
        assert.equal(escalation.answerable, true);
        assert.equal(escalation.question, '原问要 trim');
        assert.equal(escalation.missionId, 'M-F1');
        assert.equal(run.feature('F1')?.status, 'running');

        const long = startRun();
        long.startFeature('F1', 'M-F1');
        const huge = `前缀${'问'.repeat(ESCALATION_TEXT_LIMIT)}`;
        const clipped = long.openEscalation(
          {
            featureId: 'F1',
            missionId: 'M-F1',
            failure: '问太长',
            question: huge,
            answerable: true,
          },
          at(10),
        );
        assert.ok(clipped);
        assert.equal(clipped.question.length, ESCALATION_TEXT_LIMIT);
        assert.match(clipped.question, /已截断/);
        assert.equal(clipped.question.endsWith('…（已截断）'), true);

        const missing = startRun();
        missing.startFeature('F1', 'M-F1');
        assert.throws(
          () =>
            missing.openEscalation(
              { featureId: 'F1', failure: 'x', question: 'y', answerable: true },
              at(10),
            ),
          rule('ANSWERABLE_MISSION_REQUIRED'),
        );
        assert.throws(
          () =>
            missing.openEscalation(
              { featureId: 'F1', missionId: '  ', failure: 'x', question: 'y', answerable: true },
              at(10),
            ),
          rule('ANSWERABLE_MISSION_REQUIRED'),
        );
        assert.equal(missing.escalations.length, 0);
        assert.equal(missing.feature('F1')?.status, 'running');

        const blankQ = startRun();
        blankQ.startFeature('F1', 'M-F1');
        const beforeBlank = JSON.stringify(blankQ.toSnapshot());
        assert.throws(
          () =>
            blankQ.openEscalation(
              {
                featureId: 'F1',
                missionId: 'M-F1',
                failure: 'x',
                question: '   ',
                answerable: true,
              },
              at(10),
            ),
          rule('ANSWERABLE_QUESTION_REQUIRED'),
        );
        assert.throws(
          () =>
            blankQ.openEscalation(
              {
                featureId: 'F1',
                missionId: 'M-F1',
                failure: 'x',
                question: '',
                answerable: true,
              },
              at(10),
            ),
          rule('ANSWERABLE_QUESTION_REQUIRED'),
        );
        assert.equal(JSON.stringify(blankQ.toSnapshot()), beforeBlank);
        assert.equal(blankQ.escalations.length, 0);
        assert.equal(blankQ.feature('F1')?.status, 'running');
      });

    test('answer 决定逐字段往返：功能仍 running，重跑次数不增加，理由可省',
      () => {
        const { run, escalation } = withAnswerable();
        const beforeReruns = run.rerunsUsed('F1');
        const decided = run.choose(
          escalation.id,
          { action: 'answer', answer: '  用 M-F1，不要改 id  ', decidedBy: 'claude' },
          at(12),
        );
        assert.deepEqual(decided.resolution, {
          kind: 'decided',
          action: 'answer',
          answer: '用 M-F1，不要改 id',
          decidedBy: 'claude',
          decidedAt: at(12),
        });
        assert.equal(run.feature('F1')?.status, 'running');
        assert.equal(run.rerunsUsed('F1'), beforeReruns);
        assert.equal(run.currentEscalation, undefined);
        assert.equal(run.stopped, undefined);

        const restored = PlanRun.restore(JSON.parse(JSON.stringify(run.toSnapshot())));
        assert.deepEqual(restored.toSnapshot(), run.toSnapshot());
        assert.deepEqual(restored.escalations[0].resolution, decided.resolution);
        assert.equal(restored.escalations[0].answerable, true);
        assert.equal(restored.feature('F1')?.status, 'running');
        assert.equal(restored.rerunsUsed('F1'), 0);

        const withReason = startRun();
        withReason.startFeature('F2', 'M-F2');
        const e2 = withReason.openEscalation(
          {
            featureId: 'F2',
            missionId: 'M-F2',
            failure: '问',
            question: '继续吗？',
            answerable: true,
          },
          at(10),
        );
        assert.ok(e2);
        withReason.choose(
          e2.id,
          { action: 'answer', answer: '继续', reason: '现场还能跑', decidedBy: 'claude' },
          at(11),
        );
        assert.deepEqual(withReason.escalations[0].resolution, {
          kind: 'decided',
          action: 'answer',
          answer: '继续',
          reason: '现场还能跑',
          decidedBy: 'claude',
          decidedAt: at(11),
        });
        assert.equal(withReason.feature('F2')?.status, 'running');
      });

    test('非可答复单不能 answer；空白/超长答复、身份不符、到期、已决定都拒绝且快照不变',
      () => {
        const { run, escalation } = withEscalation();
        const before = JSON.stringify(run.toSnapshot());
        assert.throws(
          () =>
            run.choose(
              escalation.id,
              { action: 'answer', answer: '不行', decidedBy: 'claude' },
              at(12),
            ),
          rule('ESCALATION_NOT_ANSWERABLE'),
        );
        assert.equal(JSON.stringify(run.toSnapshot()), before);

        const { run: ans, escalation: open } = withAnswerable();
        const snap = () => JSON.stringify(ans.toSnapshot());

        const blank = snap();
        assert.throws(
          () => ans.choose(open.id, { action: 'answer', answer: '   ', decidedBy: 'claude' }, at(12)),
          rule('DECISION_ANSWER_INVALID'),
        );
        assert.throws(
          () => ans.choose(open.id, { action: 'answer', decidedBy: 'claude' }, at(12)),
          rule('DECISION_ANSWER_INVALID'),
        );
        assert.equal(snap(), blank);

        const tooLong = snap();
        assert.throws(
          () =>
            ans.choose(
              open.id,
              { action: 'answer', answer: 'x'.repeat(ESCALATION_TEXT_LIMIT + 1), decidedBy: 'claude' },
              at(12),
            ),
          rule('DECISION_ANSWER_INVALID'),
        );
        assert.equal(snap(), tooLong);

        const identity = snap();
        assert.throws(
          () =>
            ans.choose(
              open.id,
              { action: 'answer', answer: '可以', decidedBy: 'someone-else' },
              at(12),
            ),
          rule('NOT_DESIGNATED_REVIEWER'),
        );
        assert.equal(snap(), identity);

        const late = snap();
        assert.throws(
          () => ans.choose(open.id, { action: 'answer', answer: '可以', decidedBy: 'claude' }, at(30)),
          rule('ESCALATION_DEADLINE_PASSED'),
        );
        assert.equal(snap(), late);
        assert.equal(ans.feature('F1')?.status, 'running');
        assert.equal(ans.currentEscalation?.id, open.id);

        ans.choose(open.id, { action: 'answer', answer: '可以', decidedBy: 'claude' }, at(12));
        const decided = snap();
        assert.throws(
          () => ans.choose(open.id, { action: 'answer', answer: '改口', decidedBy: 'claude' }, at(13)),
          rule('ESCALATION_ALREADY_RESOLVED'),
        );
        assert.equal(snap(), decided);
      });

    test('旧四动作和理由要求未变：空白理由仍拒，skip 仍把功能标 skipped',
      () => {
        const { run, escalation } = withAnswerable();
        assert.throws(
          () => run.choose(escalation.id, { action: 'skip', reason: '  ', decidedBy: 'claude' }, at(12)),
          rule('DECISION_REASON_REQUIRED'),
        );
        assert.throws(
          () => run.choose(escalation.id, { action: 'skip', decidedBy: 'claude' }, at(12)),
          rule('DECISION_REASON_REQUIRED'),
        );
        run.choose(escalation.id, { action: 'skip', reason: '今晚不答了', decidedBy: 'claude' }, at(12));
        assert.equal(run.feature('F1')?.status, 'skipped');
        const resolution = run.escalations[0].resolution;
        assert.equal(resolution?.kind === 'decided' ? resolution.action : undefined, 'skip');
      });

    test('restore：旧无新字段可读；非法 answer 结论拒为 PLAN_RUN_CORRUPT',
      () => {
        const old = withEscalation().run.toSnapshot() as unknown as Record<string, any>;
        assert.equal(old.escalations[0].answerable, undefined);
        const restoredOld = PlanRun.restore(JSON.parse(JSON.stringify(old)));
        assert.equal(restoredOld.escalations[0].answerable, undefined);
        assert.equal(restoredOld.currentEscalation?.id, 'E-1');

        const good = JSON.parse(JSON.stringify(withAnswerable().run.toSnapshot())) as Record<string, any>;
        good.escalations[0].resolution = {
          kind: 'decided',
          action: 'answer',
          answer: '记下',
          decidedBy: 'claude',
          decidedAt: at(12),
        };
        const answered = PlanRun.restore(JSON.parse(JSON.stringify(good)));
        assert.equal(answered.escalations[0].resolution?.kind, 'decided');
        assert.equal(
          answered.escalations[0].resolution?.kind === 'decided'
            ? answered.escalations[0].resolution.action
            : undefined,
          'answer',
        );

        const missingAnswer = JSON.parse(JSON.stringify(good));
        missingAnswer.escalations[0].resolution = {
          kind: 'decided',
          action: 'answer',
          decidedBy: 'claude',
          decidedAt: at(12),
        };
        assert.throws(() => PlanRun.restore(missingAnswer), rule('PLAN_RUN_CORRUPT'));

        const blankAnswer = JSON.parse(JSON.stringify(good));
        blankAnswer.escalations[0].resolution = {
          kind: 'decided',
          action: 'answer',
          answer: '  ',
          decidedBy: 'claude',
          decidedAt: at(12),
        };
        assert.throws(() => PlanRun.restore(blankAnswer), rule('PLAN_RUN_CORRUPT'));

        const onOld = JSON.parse(JSON.stringify(old));
        onOld.escalations[0].resolution = {
          kind: 'decided',
          action: 'answer',
          answer: '不该出现',
          decidedBy: 'claude',
          decidedAt: at(12),
        };
        assert.throws(() => PlanRun.restore(onOld), rule('PLAN_RUN_CORRUPT'));

        const blankQuestion = JSON.parse(JSON.stringify(withAnswerable().run.toSnapshot()));
        blankQuestion.escalations[0].question = '   ';
        assert.throws(() => PlanRun.restore(blankQuestion), rule('PLAN_RUN_CORRUPT'));
        blankQuestion.escalations[0].question = '';
        assert.throws(() => PlanRun.restore(blankQuestion), rule('PLAN_RUN_CORRUPT'));
      });
  });
