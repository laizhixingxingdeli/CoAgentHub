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
  type Phase2ExitCriteria,
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
    answers: { q1: { kind: 'noop' } },
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

/** 六证齐全（用于 gate=pass 场景） */
function fullCriteria(overrides: Partial<Phase2ExitCriteria> = {}): Phase2ExitCriteria {
  return {
    minSamples: 1,
    minSuccessRate: 1,
    maxP95LatencyMs: 1000,
    requireDataIntegrity: true,
    requireNoBehaviorChange: true,
    maxEstimatedCostUsd: 1,
    ...overrides,
  };
}

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
    const report = evaluatePhase2ShadowExit(events, criteria, { costModel: fullPassCostModel });
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

  test('minSuccessRate=1 with all success and full six criteria => pass', () => {
    const events = [
      shadowEvent(successData({ usage: { inputTokens: 1, outputTokens: 1 } })),
    ];
    const report = evaluatePhase2ShadowExit(events, fullCriteria({ minSuccessRate: 1 }), {
      costModel: fullPassCostModel,
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

  test('six criteria all pass => pass; any fail => fail', () => {
    const events = [
      shadowEvent(successData({ usage: { inputTokens: 10, outputTokens: 10 } })),
    ];
    const pass = evaluatePhase2ShadowExit(events, fullCriteria(), { costModel: fullPassCostModel });
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
