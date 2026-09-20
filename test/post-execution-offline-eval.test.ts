import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DecisionAnswerSet } from '../src/application/ports.ts';
import {
  evaluatePostExecutionOffline,
  type GroundTruth,
  type OfflineEvalSample,
  type OfflineEvalThresholds,
} from '../src/application/post-execution-offline-eval.ts';

const THRESHOLDS: OfflineEvalThresholds = {
  objectiveSatisfiedMin: 0.8,
  evidenceSufficientMin: 0.8,
  scopeDeviationMax: 0.2,
  semanticRiskEscalateMin: 2,
};

function answers(partial: {
  objective_satisfied?: number;
  evidence_sufficient?: number;
  scope_deviation?: number;
  semantic_risk?: number;
  extra?: Record<string, unknown>;
}): DecisionAnswerSet {
  const base: Record<string, { kind: 'score'; value: number; scale: string }> = {
    objective_satisfied: {
      kind: 'score',
      value: partial.objective_satisfied ?? 0.9,
      scale: 'noul',
    },
    evidence_sufficient: {
      kind: 'score',
      value: partial.evidence_sufficient ?? 0.9,
      scale: 'noul',
    },
    scope_deviation: {
      kind: 'score',
      value: partial.scope_deviation ?? 0.1,
      scale: 'noul',
    },
    semantic_risk: {
      kind: 'score',
      value: partial.semantic_risk ?? 0.5,
      scale: 'ordinal4.v1',
    },
  };
  if (partial.extra) {
    Object.assign(base, partial.extra);
  }
  return { answers: base as DecisionAnswerSet['answers'] };
}

function sample(
  id: string,
  ans: DecisionAnswerSet,
  gt: Partial<GroundTruth> & Pick<GroundTruth, 'review'>,
): OfflineEvalSample {
  return {
    id,
    answers: ans,
    groundTruth: {
      objectiveSatisfied: gt.objectiveSatisfied ?? true,
      evidenceSufficient: gt.evidenceSufficient ?? true,
      scopeDeviation: gt.scopeDeviation ?? false,
      review: gt.review,
      ...(gt.semanticRiskOrdinal !== undefined
        ? { semanticRiskOrdinal: gt.semanticRiskOrdinal }
        : {}),
    },
  };
}

describe('post-execution-offline-eval', () => {
  test('all valid accept/fast -> zero errors', () => {
    const samples = [
      sample('a', answers({}), { review: 'accept', objectiveSatisfied: true, evidenceSufficient: true, scopeDeviation: false }),
      sample('b', answers({ objective_satisfied: 0.85, evidence_sufficient: 0.85, scope_deviation: 0.1, semantic_risk: 1 }), {
        review: 'accept',
      }),
    ];
    const report = evaluatePostExecutionOffline(samples, THRESHOLDS);
    assert.equal(report.counts.valid, 2);
    assert.equal(report.counts.invalid, 0);
    assert.equal(report.outcomeCounts.fast_review, 2);
    assert.equal(report.errorRates.falsePassCount, 0);
    assert.equal(report.errorRates.falsePassRate, 0);
    assert.equal(report.errorRates.falseEscalationCount, 0);
    assert.equal(report.errorRates.falseEscalationRate, 0);
    assert.equal(report.errorRates.falsePassRate, 0);
    assert.ok(!('passed' in report));
    assert.ok(!('gate' in report));
  });

  test('fast + reject => falsePass', () => {
    const report = evaluatePostExecutionOffline(
      [sample('fp', answers({ semantic_risk: 0 }), { review: 'reject' })],
      THRESHOLDS,
    );
    assert.equal(report.outcomeCounts.fast_review, 1);
    assert.equal(report.errorRates.falsePassCount, 1);
    assert.equal(report.errorRates.falsePassRate, 1);
    assert.equal(report.errorRates.falseEscalationCount, 0);
  });

  test('escalate + accept => falseEscalation', () => {
    const report = evaluatePostExecutionOffline(
      [sample('fe', answers({ semantic_risk: 2.5 }), { review: 'accept' })],
      THRESHOLDS,
    );
    assert.equal(report.outcomeCounts.escalate_attention, 1);
    assert.equal(report.errorRates.falseEscalationCount, 1);
    assert.equal(report.errorRates.falseEscalationRate, 1);
    assert.equal(report.errorRates.falsePassCount, 0);
  });

  test('full_review + accept is not falseEscalation', () => {
    // obj below min → full_review, risk below escalate
    const report = evaluatePostExecutionOffline(
      [
        sample(
          'fr',
          answers({ objective_satisfied: 0.5, evidence_sufficient: 0.9, scope_deviation: 0.1, semantic_risk: 0 }),
          { review: 'accept', objectiveSatisfied: false },
        ),
      ],
      THRESHOLDS,
    );
    assert.equal(report.outcomeCounts.full_review, 1);
    assert.equal(report.errorRates.falseEscalationCount, 0);
    assert.equal(report.errorRates.falsePassCount, 0);
  });

  test('Brier hand calc p=.7 y=1 => .09', () => {
    const report = evaluatePostExecutionOffline(
      [
        sample(
          'brier',
          answers({
            objective_satisfied: 0.7,
            evidence_sufficient: 0.7,
            scope_deviation: 0.7,
            semantic_risk: 0,
          }),
          {
            review: 'accept',
            objectiveSatisfied: true,
            evidenceSufficient: true,
            scopeDeviation: true,
          },
        ),
      ],
      THRESHOLDS,
    );
    assert.ok(Math.abs(report.noul.objective_satisfied.brier! - 0.09) < 1e-12);
    assert.ok(Math.abs(report.noul.evidence_sufficient.brier! - 0.09) < 1e-12);
    assert.ok(Math.abs(report.noul.scope_deviation.brier! - 0.09) < 1e-12);
  });

  test('ECE p=.05 y=0 => .05; p=1 enters last bin', () => {
    const eceLow = evaluatePostExecutionOffline(
      [
        sample(
          'ece-low',
          answers({
            objective_satisfied: 0.05,
            evidence_sufficient: 0.05,
            scope_deviation: 0.05,
            semantic_risk: 0,
          }),
          {
            review: 'reject',
            objectiveSatisfied: false,
            evidenceSufficient: false,
            scopeDeviation: false,
          },
        ),
      ],
      THRESHOLDS,
    );
    assert.equal(eceLow.noul.objective_satisfied.ece, 0.05);

    const eceOne = evaluatePostExecutionOffline(
      [
        sample(
          'ece-one',
          answers({
            objective_satisfied: 1,
            evidence_sufficient: 1,
            scope_deviation: 1,
            semantic_risk: 0,
          }),
          {
            review: 'accept',
            objectiveSatisfied: true,
            evidenceSufficient: true,
            scopeDeviation: true,
          },
        ),
      ],
      THRESHOLDS,
    );
    assert.equal(eceOne.noul.objective_satisfied.ece, 0);

    // p=1 must land in bin 9 with another point in same bin path
    // both in bin 9 (floor(1*10)=10→9, floor(0.95*10)=9)
    const mixed = evaluatePostExecutionOffline(
      [
        sample(
          'ece-1',
          answers({
            objective_satisfied: 1,
            evidence_sufficient: 1,
            scope_deviation: 1,
            semantic_risk: 0,
          }),
          {
            review: 'accept',
            objectiveSatisfied: true,
            evidenceSufficient: true,
            scopeDeviation: true,
          },
        ),
        sample(
          'ece-095',
          answers({
            objective_satisfied: 0.95,
            evidence_sufficient: 0.95,
            scope_deviation: 0.95,
            semantic_risk: 0,
          }),
          {
            review: 'accept',
            objectiveSatisfied: true,
            evidenceSufficient: true,
            scopeDeviation: true,
          },
        ),
      ],
      THRESHOLDS,
    );
    assert.ok(mixed.noul.objective_satisfied.ece !== null);
    assert.ok(mixed.noul.objective_satisfied.ece! < 0.1);
  });

  test('invalid samples: missing/wrong scale/noul>1/risk>3/extra key; excluded from denominators', () => {
    const missingKey: DecisionAnswerSet = {
      answers: {
        objective_satisfied: { kind: 'score', value: 0.9, scale: 'noul' },
        evidence_sufficient: { kind: 'score', value: 0.9, scale: 'noul' },
        // scope_deviation missing
        semantic_risk: { kind: 'score', value: 0, scale: 'ordinal4.v1' },
      },
    };
    const wrongScale = answers({});
    (wrongScale.answers as Record<string, unknown>).objective_satisfied = {
      kind: 'score',
      value: 0.9,
      scale: 'unit',
    };
    const noulHi = answers({ objective_satisfied: 1.5 });
    const riskHi = answers({ semantic_risk: 3.5 });
    const extra = answers({
      extra: { surprise: { kind: 'score', value: 0.1, scale: 'noul' } },
    });

    const validOne = sample('ok', answers({}), { review: 'accept' });
    const report = evaluatePostExecutionOffline(
      [
        sample('m', missingKey, { review: 'accept' }),
        sample('ws', wrongScale, { review: 'accept' }),
        sample('nh', noulHi, { review: 'accept' }),
        sample('rh', riskHi, { review: 'accept' }),
        sample('ex', extra, { review: 'accept' }),
        validOne,
      ],
      THRESHOLDS,
    );

    assert.equal(report.counts.total, 6);
    assert.equal(report.counts.valid, 1);
    assert.equal(report.counts.invalid, 5);
    assert.ok(report.counts.invalidReasons.missing_scope_deviation >= 1);
    assert.ok(report.counts.invalidReasons.wrong_scale_objective_satisfied >= 1);
    assert.ok(report.counts.invalidReasons.out_of_range_objective_satisfied >= 1);
    assert.ok(report.counts.invalidReasons.out_of_range_semantic_risk >= 1);
    assert.ok(report.counts.invalidReasons.unexpected_answer_key >= 1);
    assert.equal(report.errorRates.falsePassRate, 0);
    assert.equal(report.noul.objective_satisfied.n, 1);
  });

  test('missing threshold field / NaN / out-of-range => throw', () => {
    const s = [sample('t', answers({}), { review: 'accept' })];
    assert.throws(() =>
      evaluatePostExecutionOffline(s, {
        objectiveSatisfiedMin: 0.8,
        evidenceSufficientMin: 0.8,
        scopeDeviationMax: 0.2,
        // semanticRiskEscalateMin missing
      } as OfflineEvalThresholds),
    );
    assert.throws(() =>
      evaluatePostExecutionOffline(s, {
        ...THRESHOLDS,
        objectiveSatisfiedMin: Number.NaN,
      }),
    );
    assert.throws(() =>
      evaluatePostExecutionOffline(s, {
        ...THRESHOLDS,
        semanticRiskEscalateMin: 4,
      }),
    );
    assert.throws(() =>
      evaluatePostExecutionOffline(s, {
        ...THRESHOLDS,
        scopeDeviationMax: -0.1,
      }),
    );
  });

  test('risk == threshold triggers escalate', () => {
    const report = evaluatePostExecutionOffline(
      [sample('eq', answers({ semantic_risk: 2 }), { review: 'escalate' })],
      THRESHOLDS,
    );
    assert.equal(report.outcomeCounts.escalate_attention, 1);
  });

  test('semanticRisk MAE uses round; MAE only (no ECE)', () => {
    const report = evaluatePostExecutionOffline(
      [
        sample(
          'mae1',
          answers({ semantic_risk: 1.4 }),
          { review: 'accept', semanticRiskOrdinal: 1 },
        ),
        sample(
          'mae2',
          answers({ semantic_risk: 2.6 }),
          { review: 'escalate', semanticRiskOrdinal: 2 },
        ),
      ],
      THRESHOLDS,
    );
    // round(1.4)=1 abs 0; round(2.6)=3 abs 1 → mean 0.5
    assert.equal(report.semanticRiskMae.n, 2);
    assert.equal(report.semanticRiskMae.mae, 0.5);
    assert.equal(
      Object.keys(report.semanticRiskMae).sort().join(','),
      'mae,n',
    );

    const noLabel = evaluatePostExecutionOffline(
      [sample('nl', answers({}), { review: 'accept' })],
      THRESHOLDS,
    );
    assert.equal(noLabel.semanticRiskMae.n, 0);
    assert.equal(noLabel.semanticRiskMae.mae, null);
  });

  test('valid=0 => rates null', () => {
    const bad: DecisionAnswerSet = { answers: {} };
    const report = evaluatePostExecutionOffline(
      [sample('empty', bad, { review: 'accept' })],
      THRESHOLDS,
    );
    assert.equal(report.counts.valid, 0);
    assert.equal(report.errorRates.falsePassRate, null);
    assert.equal(report.errorRates.falseEscalationRate, null);
    assert.equal(report.noul.macroBrier, null);
    assert.equal(report.noul.macroEce, null);
  });

  test('source guard: no mapper/state/platform/runner/kernel; no DecisionRecord/PolicyAction; no production threshold defaults', () => {
    const path = fileURLToPath(
      new URL('../src/application/post-execution-offline-eval.ts', import.meta.url),
    );
    const src = readFileSync(path, 'utf8');
    const importLines = src
      .split('\n')
      .filter((line) => /^\s*import\b/.test(line))
      .join('\n');
    assert.doesNotMatch(importLines, /mapper/);
    assert.doesNotMatch(importLines, /post-execution-state/);
    assert.doesNotMatch(importLines, /platform/);
    assert.doesNotMatch(importLines, /runner/);
    assert.doesNotMatch(importLines, /kernel/);
    assert.doesNotMatch(src, /DecisionRecord|PolicyAction/);
    assert.doesNotMatch(src, /DEFAULT_.*THRESHOLD|PRODUCTION_THRESHOLD/);
    const fromApp = [...src.matchAll(/from\s+'(\.[^']+)'/g)].map((m) => m[1]);
    for (const spec of fromApp) {
      assert.ok(
        spec === './ports.ts' || spec.endsWith('/ports.ts'),
        `unexpected import ${spec}`,
      );
    }
  });
});
