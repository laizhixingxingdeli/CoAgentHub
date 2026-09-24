/**
 * Phase2 shadow exit evaluator —— **synthetic only**.
 *
 * 这些用例用合成 ActivityEvent 验证纯函数契约，**不是**生产 shadow 达标证据。
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluatePhase2ShadowExit,
  type DecisionCostModel,
  type Phase2AnswerLabel,
  type Phase2ExitCriteria,
  type Phase2ExitReport,
} from '../src/application/phase2-shadow-exit-evaluator.ts';
import type { ActivityEvent } from '../src/application/ports.ts';

function baseIds() {
  return {
    projectId: 'p1',
    missionId: 'm1',
    workItemIds: ['w1'],
  };
}

function dispatch(ids: readonly string[] = ['w1']) {
  return { kind: 'dispatch' as const, workItemIds: [...ids] };
}

function successData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: '1',
    hook: 'PRE_DISPATCH',
    providerKind: 'noop',
    ids: baseIds(),
    quality: 'success',
    mode: 'shadow',
    questionSetId: 'PRE_DISPATCH_V1',
    latencyMs: 10,
    baselineAction: dispatch(),
    effectiveAction: dispatch(),
    answers: { task_type: { kind: 'choice', option: 'bugfix' } },
    ...overrides,
  };
}

function providerErrorData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: '1',
    hook: 'PRE_DISPATCH',
    providerKind: 'noop',
    ids: baseIds(),
    quality: 'provider_error',
    mode: 'shadow',
    questionSetId: 'PRE_DISPATCH_V1',
    latencyMs: 10,
    baselineAction: dispatch(),
    effectiveAction: dispatch(),
    ...overrides,
  };
}

function shadowEvent(data: unknown, extra: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    at: '2020-01-01T00:00:00.000Z',
    projectId: 'p1',
    missionId: 'm1',
    kind: 'decision.shadow',
    data,
    ...extra,
  };
}

function otherEvent(): ActivityEvent {
  return {
    at: '2020-01-01T00:00:00.000Z',
    projectId: 'p1',
    missionId: 'm1',
    kind: 'work_item.dispatched',
    data: {},
  };
}

function byId(report: ReturnType<typeof evaluatePhase2ShadowExit>, id: string) {
  const c = report.criteria.find((x) => x.id === id);
  assert.ok(c, `missing criterion ${id}`);
  return c;
}

const fullPassCostModel: DecisionCostModel = {
  usdPerMillionInputTokens: 1,
  usdPerMillionOutputTokens: 2,
};

/** 七条齐全（用于 gate=pass 场景）。 */
function fullCriteria(overrides: Partial<Phase2ExitCriteria> = {}): Phase2ExitCriteria {
  return {
    minSamples: 1,
    minSuccessRate: 1,
    maxP95LatencyMs: 1000,
    requireDataIntegrity: true,
    requireNoBehaviorChange: true,
    maxEstimatedCostUsd: 1,
    answerQuality: { minLiftOverMajority: 0 },
    ...overrides,
  };
}

/** 与 successData 缺省回答一致的标注：答对，单一样本时与全猜多数类持平（提升 0）。 */
const PASS_LABELS: readonly Phase2AnswerLabel[] = [
  { missionId: 'm1', workItemIds: ['w1'], answers: { task_type: 'bugfix' } },
];

describe('evaluatePhase2ShadowExit (synthetic)', () => {
  test('empty events + empty criteria => insufficient_evidence', () => {
    const report = evaluatePhase2ShadowExit([], {});
    assert.equal(report.gate, 'insufficient_evidence');
    assert.equal(report.counts.shadowEvents, 0);
    assert.equal(report.metrics.successRate, undefined);
    assert.equal(report.metrics.p95LatencyMs, undefined);
    for (const c of report.criteria) {
      assert.equal(c.status, 'not_evaluated');
    }
  });

  test('non-shadow events ignored', () => {
    const report = evaluatePhase2ShadowExit([otherEvent(), otherEvent()], {
      minSamples: 1,
    });
    assert.equal(report.counts.shadowEvents, 0);
    assert.equal(byId(report, 'minSamples').status, 'fail');
    assert.equal(report.gate, 'fail');
  });

  test('all success with full criteria pass', () => {
    const events = Array.from({ length: 5 }, (_, i) =>
      shadowEvent(
        successData({
          latencyMs: 10 + i,
          usage: { inputTokens: 100, outputTokens: 50 },
        }),
      ),
    );
    const criteria = fullCriteria({ minSamples: 5, maxP95LatencyMs: 100 });
    const report = evaluatePhase2ShadowExit(events, criteria, { costModel: fullPassCostModel, labels: PASS_LABELS });
    assert.equal(report.counts.success, 5);
    assert.equal(report.counts.wellFormed, 5);
    assert.equal(report.counts.malformed, 0);
    assert.equal(report.metrics.successRate, 1);
    assert.equal(report.metrics.totalInputTokens, 500);
    assert.equal(report.metrics.totalOutputTokens, 250);
    assert.equal(report.metrics.missingUsageCount, 0);
    assert.ok(report.metrics.estimatedCostUsd !== undefined);
    assert.equal(report.gate, 'pass');
    for (const c of report.criteria) {
      assert.equal(c.status, 'pass', c.id);
    }
  });

  test('all success but minSuccessRate fail when mixed with provider_error', () => {
    const events = [
      shadowEvent(successData()),
      shadowEvent(providerErrorData()),
    ];
    const report = evaluatePhase2ShadowExit(events, { minSuccessRate: 1 });
    assert.equal(report.metrics.successRate, 0.5);
    assert.equal(byId(report, 'minSuccessRate').status, 'fail');
    assert.equal(report.gate, 'fail');
  });

  test('provider_error + malformed in successRate denominator', () => {
    const events = [
      shadowEvent(successData()),
      shadowEvent(providerErrorData()),
      shadowEvent({ not: 'valid', hook: 'PRE_DISPATCH', questionSetId: 'PRE_DISPATCH_V1' }),
    ];
    const report = evaluatePhase2ShadowExit(events, {});
    assert.equal(report.counts.shadowEvents, 3);
    assert.equal(report.counts.success, 1);
    assert.equal(report.counts.providerError, 1);
    assert.equal(report.counts.malformed, 1);
    assert.equal(report.counts.wellFormed, 2);
    assert.equal(report.metrics.successRate, 1 / 3);
  });

  test('success missing answers => malformed integrity failure', () => {
    const data = successData();
    delete data.answers;
    const report = evaluatePhase2ShadowExit([shadowEvent(data)], {
      requireDataIntegrity: true,
    });
    assert.equal(report.counts.malformed, 1);
    assert.equal(report.counts.success, 0);
    assert.equal(report.counts.integrityFailures, 1);
    assert.equal(byId(report, 'requireDataIntegrity').status, 'fail');
  });

  test('provider_error with answers => integrity failure', () => {
    const report = evaluatePhase2ShadowExit(
      [shadowEvent(providerErrorData({ answers: { q: { kind: 'noop' } } }))],
      { requireDataIntegrity: true },
    );
    assert.equal(report.counts.malformed, 1);
    assert.equal(report.counts.providerError, 0);
  });

  test('negative token / NaN latency => integrity failure', () => {
    const badUsage = evaluatePhase2ShadowExit(
      [shadowEvent(successData({ usage: { inputTokens: -1, outputTokens: 1 } }))],
      {},
    );
    assert.equal(badUsage.counts.malformed, 1);

    const badLatency = evaluatePhase2ShadowExit(
      [shadowEvent(successData({ latencyMs: Number.NaN }))],
      {},
    );
    assert.equal(badLatency.counts.malformed, 1);
  });

  test('baseline !== effective => integrity failure + behaviorChangeCount', () => {
    const report = evaluatePhase2ShadowExit(
      [
        shadowEvent(
          successData({
            baselineAction: dispatch(['w1']),
            effectiveAction: dispatch(['w2']),
          }),
        ),
      ],
      { requireNoBehaviorChange: true, requireDataIntegrity: true },
    );
    assert.equal(report.counts.behaviorChangeCount, 1);
    assert.equal(report.counts.integrityFailures, 1);
    assert.equal(report.counts.malformed, 1);
    assert.equal(report.counts.success, 0);
    assert.equal(byId(report, 'requireNoBehaviorChange').status, 'fail');
    assert.equal(byId(report, 'requireDataIntegrity').status, 'fail');
  });

  test('P95 nearest-rank n=20 uses rank 19 (index 18)', () => {
    // latencies 1..20 => sorted same; ceil(0.95*20)=19 => value 19
    const events = Array.from({ length: 20 }, (_, i) =>
      shadowEvent(successData({ latencyMs: i + 1 })),
    );
    const report = evaluatePhase2ShadowExit(events, { maxP95LatencyMs: 19 });
    assert.equal(report.metrics.p95LatencyMs, 19);
    assert.equal(byId(report, 'maxP95LatencyMs').status, 'pass');

    const fail = evaluatePhase2ShadowExit(events, { maxP95LatencyMs: 18 });
    assert.equal(byId(fail, 'maxP95LatencyMs').status, 'fail');
  });

  test('P95 includes well-formed provider_error latency (success fast + error slow)', () => {
    // success 10ms + provider_error 1000ms => P95 must reflect error latency
    const events = [
      shadowEvent(successData({ latencyMs: 10 })),
      shadowEvent(providerErrorData({ latencyMs: 1000 })),
    ];
    const report = evaluatePhase2ShadowExit(events, { maxP95LatencyMs: 500 });
    // n=2, ceil(0.95*2)=2 => second sample = 1000
    assert.equal(report.metrics.p95LatencyMs, 1000);
    assert.equal(byId(report, 'maxP95LatencyMs').status, 'fail');
    assert.equal(byId(report, 'maxP95LatencyMs').reason, 'above_max_p95_latency');

    const pass = evaluatePhase2ShadowExit(events, { maxP95LatencyMs: 1000 });
    assert.equal(pass.metrics.p95LatencyMs, 1000);
    assert.equal(byId(pass, 'maxP95LatencyMs').status, 'pass');
  });

  test('malformed latency not included in P95', () => {
    const events = [
      shadowEvent(successData({ latencyMs: 10 })),
      shadowEvent(
        successData({
          latencyMs: 9999,
          baselineAction: { kind: 'not-dispatch' },
        }),
      ),
    ];
    const report = evaluatePhase2ShadowExit(events, {});
    assert.equal(report.counts.malformed, 1);
    assert.equal(report.counts.wellFormed, 1);
    assert.equal(report.metrics.p95LatencyMs, 10);
  });

  test('cost model four combinations', () => {
    const events = [
      shadowEvent(
        successData({ usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } }),
      ),
    ];
    const model: DecisionCostModel = {
      usdPerMillionInputTokens: 3,
      usdPerMillionOutputTokens: 4,
    };

    // no criterion, no model
    const a = evaluatePhase2ShadowExit(events, {});
    assert.equal(a.metrics.estimatedCostUsd, undefined);

    // criterion without model => cost_model_required
    const b = evaluatePhase2ShadowExit(events, { maxEstimatedCostUsd: 10 });
    assert.equal(byId(b, 'maxEstimatedCostUsd').status, 'fail');
    assert.equal(byId(b, 'maxEstimatedCostUsd').reason, 'cost_model_required');
    assert.equal(b.metrics.estimatedCostUsd, undefined);

    // model without criterion => cost computed, criterion not_evaluated
    const c = evaluatePhase2ShadowExit(events, {}, { costModel: model });
    assert.equal(c.metrics.estimatedCostUsd, 7);
    assert.equal(byId(c, 'maxEstimatedCostUsd').status, 'not_evaluated');

    // both: pass/fail by threshold
    const d = evaluatePhase2ShadowExit(events, { maxEstimatedCostUsd: 7 }, { costModel: model });
    assert.equal(byId(d, 'maxEstimatedCostUsd').status, 'pass');
    const e = evaluatePhase2ShadowExit(events, { maxEstimatedCostUsd: 6 }, { costModel: model });
    assert.equal(byId(e, 'maxEstimatedCostUsd').status, 'fail');
  });

  test('invalid criteria => fail invalid_criteria', () => {
    const events = [shadowEvent(successData())];
    const report = evaluatePhase2ShadowExit(events, {
      minSamples: -1,
      minSuccessRate: 1.5,
      maxP95LatencyMs: -5,
      maxEstimatedCostUsd: Number.NaN,
    } as Phase2ExitCriteria);
    assert.equal(byId(report, 'minSamples').reason, 'invalid_criteria');
    assert.equal(byId(report, 'minSuccessRate').reason, 'invalid_criteria');
    assert.equal(byId(report, 'maxP95LatencyMs').reason, 'invalid_criteria');
    assert.equal(byId(report, 'maxEstimatedCostUsd').reason, 'invalid_criteria');
    assert.equal(report.gate, 'fail');
  });

  test('minSamples=0 and minSuccessRate=0 => invalid_criteria + gate fail', () => {
    const events = [shadowEvent(successData())];
    const report = evaluatePhase2ShadowExit(events, {
      minSamples: 0,
      minSuccessRate: 0,
    });
    assert.equal(byId(report, 'minSamples').status, 'fail');
    assert.equal(byId(report, 'minSamples').reason, 'invalid_criteria');
    assert.equal(byId(report, 'minSuccessRate').status, 'fail');
    assert.equal(byId(report, 'minSuccessRate').reason, 'invalid_criteria');
    assert.equal(report.gate, 'fail');
  });

  test('minSuccessRate=1 with all success and full seven criteria => pass', () => {
    const events = [
      shadowEvent(successData({ usage: { inputTokens: 1, outputTokens: 1 } })),
    ];
    const report = evaluatePhase2ShadowExit(events, fullCriteria({ minSuccessRate: 1 }), {
      costModel: fullPassCostModel,
      labels: PASS_LABELS,
    });
    assert.equal(report.metrics.successRate, 1);
    assert.equal(byId(report, 'minSuccessRate').status, 'pass');
    assert.equal(report.gate, 'pass');
    for (const c of report.criteria) {
      assert.equal(c.status, 'pass', c.id);
    }
  });

  test('only minSamples=1 even with enough samples => insufficient_evidence', () => {
    const events = [shadowEvent(successData())];
    const report = evaluatePhase2ShadowExit(events, { minSamples: 1 });
    assert.equal(byId(report, 'minSamples').status, 'pass');
    assert.equal(byId(report, 'minSuccessRate').status, 'not_evaluated');
    assert.equal(report.gate, 'insufficient_evidence');
  });

  test('seven criteria all pass => pass; any fail => fail', () => {
    const events = [
      shadowEvent(successData({ usage: { inputTokens: 10, outputTokens: 10 } })),
    ];
    const pass = evaluatePhase2ShadowExit(events, fullCriteria(), { costModel: fullPassCostModel, labels: PASS_LABELS });
    assert.equal(pass.gate, 'pass');
    for (const c of pass.criteria) {
      assert.equal(c.status, 'pass', c.id);
    }

    const fail = evaluatePhase2ShadowExit(
      events,
      fullCriteria({ minSuccessRate: 1, minSamples: 99 }),
      { costModel: fullPassCostModel },
    );
    assert.equal(byId(fail, 'minSamples').status, 'fail');
    assert.equal(fail.gate, 'fail');
  });

  test('POST hook / other questionSet shadow ignored (not shadowEvents, not malformed)', () => {
    const events = [
      shadowEvent(successData({ hook: 'POST_DISPATCH' })),
      shadowEvent(successData({ questionSetId: 'OTHER_V1' })),
      shadowEvent(successData({ hook: 'POST_DISPATCH', questionSetId: 'OTHER_V1' })),
      shadowEvent(successData()), // one legal PRE
    ];
    const report = evaluatePhase2ShadowExit(events, {});
    assert.equal(report.counts.shadowEvents, 1);
    assert.equal(report.counts.wellFormed, 1);
    assert.equal(report.counts.malformed, 0);
    assert.equal(report.counts.success, 1);
  });

  test('legal PRE provider_error: wellFormed++, no integrity++, P95 counted, success denominator', () => {
    const events = [shadowEvent(providerErrorData({ latencyMs: 42 }))];
    const report = evaluatePhase2ShadowExit(events, {
      minSamples: 1,
      maxP95LatencyMs: 42,
      requireDataIntegrity: true,
    });
    assert.equal(report.counts.shadowEvents, 1);
    assert.equal(report.counts.wellFormed, 1);
    assert.equal(report.counts.malformed, 0);
    assert.equal(report.counts.providerError, 1);
    assert.equal(report.counts.success, 0);
    assert.equal(report.counts.integrityFailures, 0);
    assert.equal(report.metrics.p95LatencyMs, 42);
    assert.equal(report.metrics.successRate, 0);
    assert.equal(byId(report, 'minSamples').status, 'pass');
    assert.equal(byId(report, 'maxP95LatencyMs').status, 'pass');
    assert.equal(byId(report, 'requireDataIntegrity').status, 'pass');
  });

  test('success without usage increments missingUsageCount; tokens only from valid usage', () => {
    const events = [
      shadowEvent(successData()),
      shadowEvent(successData({ usage: { inputTokens: 10, outputTokens: 20 } })),
    ];
    const report = evaluatePhase2ShadowExit(events, {});
    assert.equal(report.metrics.missingUsageCount, 1);
    assert.equal(report.metrics.totalInputTokens, 10);
    assert.equal(report.metrics.totalOutputTokens, 20);
  });

  test('pure function does not mutate input events or criteria', () => {
    const events = Object.freeze([
      Object.freeze(
        shadowEvent(
          Object.freeze(
            successData({
              answers: Object.freeze({ q1: Object.freeze({ kind: 'noop' }) }),
              baselineAction: Object.freeze(dispatch()),
              effectiveAction: Object.freeze(dispatch()),
              ids: Object.freeze(baseIds()),
            }),
          ),
        ),
      ),
    ]);
    const criteria = Object.freeze({
      minSamples: 1,
      minSuccessRate: 1,
      requireDataIntegrity: true as const,
    });
    const beforeEvents = JSON.stringify(events);
    const beforeCriteria = JSON.stringify(criteria);
    evaluatePhase2ShadowExit(events, criteria);
    assert.equal(JSON.stringify(events), beforeEvents);
    assert.equal(JSON.stringify(criteria), beforeCriteria);
  });

  test('minSamples compares wellFormed not shadowEvents', () => {
    const events = [
      shadowEvent(successData()),
      shadowEvent({ broken: true, hook: 'PRE_DISPATCH', questionSetId: 'PRE_DISPATCH_V1' }),
      shadowEvent({ broken: true, hook: 'PRE_DISPATCH', questionSetId: 'PRE_DISPATCH_V1' }),
    ];
    const report = evaluatePhase2ShadowExit(events, { minSamples: 2 });
    assert.equal(report.counts.wellFormed, 1);
    assert.equal(byId(report, 'minSamples').status, 'fail');
    const pass = evaluatePhase2ShadowExit(events, { minSamples: 1 });
    assert.equal(byId(pass, 'minSamples').status, 'pass');
  });
});

/* ------------------------------ answerQuality（J3） ------------------------------ */

/** 一次派发 = 一个 Mission 一个工作项；答案按题给。 */
function answered(missionId: string, answers: Record<string, unknown>): ActivityEvent {
  return shadowEvent(
    successData({
      ids: { projectId: 'p1', missionId, workItemIds: ['w1'] },
      answers,
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
    { missionId },
  );
}

function label(missionId: string, answers: Phase2AnswerLabel['answers']): Phase2AnswerLabel {
  return { missionId, workItemIds: ['w1'], answers };
}

const choice = (option: string) => ({ kind: 'choice', option });
const ordinal = (value: number) => ({ kind: 'score', value, scale: 'ordinal4.v1' });
const noul = (value: number) => ({ kind: 'score', value, scale: 'noul' });

function quality(report: Phase2ExitReport) {
  return byId(report, 'answerQuality');
}

function question(report: Phase2ExitReport, id: string) {
  const q = report.metrics.answerQuality?.questions.find((x) => x.questionId === id);
  assert.ok(q, `missing question ${id}`);
  return q;
}

/** 六个 Mission 的标注：task_type 多数类 feature（4/6），风险多数类 LOW（4/6），歧义多数类 false（4/6）。 */
const SIX_LABELS: readonly Phase2AnswerLabel[] = [
  label('m-1', { task_type: 'feature', semantic_risk: 'LOW', work_order_ambiguous: false }),
  label('m-2', { task_type: 'feature', semantic_risk: 'LOW', work_order_ambiguous: false }),
  label('m-3', { task_type: 'feature', semantic_risk: 0, work_order_ambiguous: false }),
  label('m-4', { task_type: 'feature', semantic_risk: 'low', work_order_ambiguous: false }),
  label('m-5', { task_type: 'bugfix', semantic_risk: 'HIGH', work_order_ambiguous: true }),
  label('m-6', { task_type: 'refactor', semantic_risk: 3, work_order_ambiguous: true }),
];

describe('answerQuality（J3）：对照标注的准确率 / 相对全猜多数类的提升', () => {
  test('不配阈值 → not_evaluated：其余六条全过，gate 也只是 insufficient_evidence', () => {
    const report = evaluatePhase2ShadowExit(
      [shadowEvent(successData({ usage: { inputTokens: 1, outputTokens: 1 } }))],
      fullCriteria({ answerQuality: undefined }),
      { costModel: fullPassCostModel, labels: PASS_LABELS },
    );
    assert.equal(quality(report).status, 'not_evaluated');
    assert.equal(report.criteria.filter((c) => c.status === 'pass').length, 6);
    assert.equal(report.gate, 'insufficient_evidence');
  });

  test('配了阈值却没有标注 → fail（no_labels），不跳过；gate fail', () => {
    const events = [shadowEvent(successData({ usage: { inputTokens: 1, outputTokens: 1 } }))];
    for (const labels of [undefined, []]) {
      const report = evaluatePhase2ShadowExit(events, fullCriteria(), {
        costModel: fullPassCostModel,
        ...(labels ? { labels } : {}),
      });
      assert.equal(quality(report).status, 'fail', String(labels));
      assert.equal(quality(report).reason, 'no_labels');
      assert.equal(report.gate, 'fail');
      assert.equal(report.metrics.answerQuality, undefined);
    }
  });

  test('E3 A 臂的形状：常数答案比全猜多数类差 → below_min_lift，逐题明细给出', () => {
    // 只给 ID 时：风险全答 MEDIUM、歧义全在 0.6 上下、任务类型照 ID 字面猜 config。
    const events = SIX_LABELS.map((l) =>
      answered(l.missionId, { task_type: choice('config'), semantic_risk: ordinal(1.1), work_order_ambiguous: noul(0.62) }),
    );
    const report = evaluatePhase2ShadowExit(events, { answerQuality: { minLiftOverMajority: 0 } }, { labels: SIX_LABELS });
    assert.equal(quality(report).status, 'fail');
    assert.equal(quality(report).reason, 'below_min_lift');
    assert.equal(report.metrics.answerQuality?.labeledSamples, 6);
    const task = question(report, 'task_type');
    assert.deepEqual(
      { labeled: task.labeled, correct: task.correct, majorityLabel: task.majorityLabel },
      { labeled: 6, correct: 0, majorityLabel: 'feature' },
    );
    assert.equal(task.accuracy, 0);
    assert.ok(Math.abs(task.majorityBaseline - 4 / 6) < 1e-12);
    assert.ok(Math.abs(task.lift + 4 / 6) < 1e-12);
    const risk = question(report, 'semantic_risk');
    assert.equal(risk.correct, 0, 'MEDIUM 一条都不对');
    assert.equal(risk.majorityLabel, 'LOW', '档名与下标、大小写都规范成同一档');
    const amb = question(report, 'work_order_ambiguous');
    assert.equal(amb.correct, 2, '0.62 ≥ 0.5 判「有歧义」：只对上两条 true');
    assert.equal(amb.majorityLabel, 'false');
  });

  test('B 臂的形状：答对多数、比全猜多数类高 → pass', () => {
    const answers: Record<string, Record<string, unknown>> = {
      'm-1': { task_type: choice('feature'), semantic_risk: ordinal(0.2), work_order_ambiguous: noul(0.1) },
      'm-2': { task_type: choice('feature'), semantic_risk: ordinal(0.4), work_order_ambiguous: noul(0.3) },
      'm-3': { task_type: choice('feature'), semantic_risk: ordinal(0), work_order_ambiguous: noul(0.2) },
      'm-4': { task_type: choice('feature'), semantic_risk: ordinal(1.2), work_order_ambiguous: noul(0.4) },
      'm-5': { task_type: choice('bugfix'), semantic_risk: ordinal(1.6), work_order_ambiguous: noul(0.9) },
      'm-6': { task_type: choice('refactor'), semantic_risk: ordinal(2.7), work_order_ambiguous: noul(0.5) },
    };
    const events = SIX_LABELS.map((l) => answered(l.missionId, answers[l.missionId]!));
    const report = evaluatePhase2ShadowExit(
      events,
      { answerQuality: { minAccuracy: 0.8, minLiftOverMajority: 0.1 } },
      { labels: SIX_LABELS },
    );
    assert.equal(quality(report).status, 'pass', JSON.stringify(report.metrics.answerQuality));
    assert.equal(question(report, 'task_type').correct, 6);
    // 1.2 → MEDIUM 答错；1.6 → HIGH、2.7 → CRITICAL 四舍五入到档
    assert.equal(question(report, 'semantic_risk').correct, 5);
    // 0.5 算「有歧义」
    assert.equal(question(report, 'work_order_ambiguous').correct, 6);
  });

  test('阈值边界：恰好等于算过（0.7 − 0.6 的浮点误差不误判）；低一点就不过', () => {
    // 10 条：标注 6 条 feature（多数类 0.6），答对 7 条 → 准确率 0.7、提升 0.1
    const labels: Phase2AnswerLabel[] = [];
    const events: ActivityEvent[] = [];
    for (let i = 0; i < 10; i++) {
      const truth = i < 6 ? 'feature' : 'bugfix';
      labels.push(label(`m-${i}`, { task_type: truth }));
      const right = i < 6 || i === 6;
      events.push(answered(`m-${i}`, { task_type: choice(right ? truth : 'other') }));
    }
    const exact = evaluatePhase2ShadowExit(events, { answerQuality: { minAccuracy: 0.7, minLiftOverMajority: 0.1 } }, { labels });
    assert.equal(quality(exact).status, 'pass', JSON.stringify(exact.metrics.answerQuality));
    const accuracy = evaluatePhase2ShadowExit(events, { answerQuality: { minAccuracy: 0.71 } }, { labels });
    assert.equal(quality(accuracy).reason, 'below_min_accuracy');
    const lift = evaluatePhase2ShadowExit(events, { answerQuality: { minLiftOverMajority: 0.11 } }, { labels });
    assert.equal(quality(lift).reason, 'below_min_lift');
  });

  test('判对规则：没答 / noop 算错；题型对不上算错', () => {
    const labels = [
      label('m-a', { task_type: 'feature', semantic_risk: 'LOW' }),
      label('m-b', { task_type: 'feature', semantic_risk: 'LOW' }),
      label('m-c', { task_type: 'feature', semantic_risk: 'LOW' }),
    ];
    const events = [
      answered('m-a', { task_type: choice('feature'), semantic_risk: ordinal(0) }),
      answered('m-b', { task_type: { kind: 'noop', reason: 'declined' }, semantic_risk: ordinal(0) }),
      answered('m-c', { semantic_risk: choice('LOW') }),
    ];
    const report = evaluatePhase2ShadowExit(events, { answerQuality: { minAccuracy: 1 } }, { labels });
    assert.equal(question(report, 'task_type').correct, 1);
    assert.equal(question(report, 'semantic_risk').correct, 2, 'choice 形状的风险答案不算对');
    assert.equal(quality(report).reason, 'below_min_accuracy');
  });

  test('questions 只评指定题；指定题样本不够（或压根没标）→ insufficient_labeled_samples', () => {
    const events = SIX_LABELS.map((l) =>
      answered(l.missionId, { task_type: choice('feature'), semantic_risk: ordinal(1), work_order_ambiguous: noul(0.9) }),
    );
    // 只评 task_type：4/6 对、与多数类持平 → 过；风险、歧义答得再差也不看。
    const onlyTask = evaluatePhase2ShadowExit(
      events,
      { answerQuality: { questions: ['task_type'], minLiftOverMajority: 0 } },
      { labels: SIX_LABELS },
    );
    assert.equal(quality(onlyTask).status, 'pass');
    assert.deepEqual(onlyTask.metrics.answerQuality?.questions.map((q) => q.questionId), ['task_type']);

    const tooFew = evaluatePhase2ShadowExit(
      events,
      { answerQuality: { minLiftOverMajority: 0, minLabeledSamples: 7 } },
      { labels: SIX_LABELS },
    );
    assert.equal(quality(tooFew).reason, 'insufficient_labeled_samples');

    const unlabeled = evaluatePhase2ShadowExit(
      events,
      { answerQuality: { questions: ['preferred_executor'], minLiftOverMajority: 0 } },
      { labels: SIX_LABELS },
    );
    assert.equal(quality(unlabeled).reason, 'insufficient_labeled_samples');
  });

  test('标注一条都对不上成功样本 → no_labeled_samples；provider_error 样本不参与；workItemIds 顺序无关', () => {
    const noMatch = evaluatePhase2ShadowExit(
      [answered('m-x', { task_type: choice('feature') })],
      { answerQuality: { minLiftOverMajority: 0 } },
      { labels: [label('m-y', { task_type: 'feature' })] },
    );
    assert.equal(quality(noMatch).reason, 'no_labeled_samples');

    const errorOnly = evaluatePhase2ShadowExit(
      [shadowEvent(providerErrorData())],
      { answerQuality: { minLiftOverMajority: 0 } },
      { labels: PASS_LABELS },
    );
    assert.equal(quality(errorOnly).reason, 'no_labeled_samples');

    const batch = shadowEvent(
      successData({ ids: { projectId: 'p1', missionId: 'm1', workItemIds: ['w1', 'w2'] } }),
    );
    const reordered = evaluatePhase2ShadowExit(
      [batch],
      { answerQuality: { minAccuracy: 1 } },
      { labels: [{ missionId: 'm1', workItemIds: ['w2', 'w1'], answers: { task_type: 'bugfix' } }] },
    );
    assert.equal(quality(reordered).status, 'pass');
  });

  test('阈值不合法 → invalid_criteria', () => {
    const events = [shadowEvent(successData())];
    for (const answerQuality of [
      {},
      { questions: ['task_type'] },
      { minAccuracy: 0 },
      { minAccuracy: 1.2 },
      { minLiftOverMajority: 1.5 },
      { minLiftOverMajority: Number.NaN },
      { minAccuracy: 0.5, minLabeledSamples: 0 },
      { minAccuracy: 0.5, minLabeledSamples: 1.5 },
      { minAccuracy: 0.5, questions: [] },
      { minAccuracy: 0.5, questions: ['nope'] },
    ]) {
      const report = evaluatePhase2ShadowExit(events, { answerQuality }, { labels: PASS_LABELS });
      assert.equal(quality(report).reason, 'invalid_criteria', JSON.stringify(answerQuality));
    }
  });

  test('标注不合法 → invalid_labels（整批不用，不悄悄丢掉坏的那条）', () => {
    const events = [shadowEvent(successData())];
    const bad: unknown[][] = [
      [{ missionId: 'm1', workItemIds: ['w1'], answers: { nope: 'x' } }],
      [{ missionId: 'm1', workItemIds: ['w1'], answers: { task_type: true } }],
      [{ missionId: 'm1', workItemIds: ['w1'], answers: { semantic_risk: 'SEVERE' } }],
      [{ missionId: 'm1', workItemIds: ['w1'], answers: { semantic_risk: 4 } }],
      [{ missionId: 'm1', workItemIds: ['w1'], answers: { work_order_ambiguous: 1 } }],
      [{ missionId: 'm1', workItemIds: ['w1'], answers: {} }],
      [{ missionId: '', workItemIds: ['w1'], answers: { task_type: 'bugfix' } }],
      [{ missionId: 'm1', workItemIds: [], answers: { task_type: 'bugfix' } }],
      [...PASS_LABELS, { missionId: 'm1', workItemIds: ['w1'], answers: { task_type: 'feature' } }],
      [...PASS_LABELS, null],
    ];
    for (const labels of bad) {
      const report = evaluatePhase2ShadowExit(events, { answerQuality: { minAccuracy: 0.5 } }, {
        labels: labels as Phase2AnswerLabel[],
      });
      assert.equal(quality(report).reason, 'invalid_labels', JSON.stringify(labels));
    }
  });

  test('纯函数：不改标注', () => {
    const labels = JSON.parse(JSON.stringify(SIX_LABELS)) as Phase2AnswerLabel[];
    const before = JSON.stringify(labels);
    evaluatePhase2ShadowExit(
      SIX_LABELS.map((l) => answered(l.missionId, { task_type: choice('feature') })),
      { answerQuality: { minLiftOverMajority: 0 } },
      { labels },
    );
    assert.equal(JSON.stringify(labels), before);
  });
});
