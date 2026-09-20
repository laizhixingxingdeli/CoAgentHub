/**
 * POST_EXECUTION offline evaluator — pure functions only.
 *
 * No production wiring, no gate, no default thresholds.
 * Imports only DecisionAnswerSet/DecisionSignal shapes from ports.
 */

import type { DecisionAnswerSet, DecisionSignal } from './ports.ts';

// Keep this module free of application side-effect modules (import path guard in tests).

export type HypotheticalOutcome = 'fast_review' | 'full_review' | 'escalate_attention';

export type GroundTruthReview = 'accept' | 'reject' | 'escalate';

export interface GroundTruth {
  readonly objectiveSatisfied: boolean;
  readonly evidenceSufficient: boolean;
  readonly scopeDeviation: boolean;
  readonly review: GroundTruthReview;
  readonly semanticRiskOrdinal?: 0 | 1 | 2 | 3;
}

export interface OfflineEvalSample {
  readonly id: string;
  readonly answers: DecisionAnswerSet;
  readonly groundTruth: GroundTruth;
}

export interface OfflineEvalThresholds {
  readonly objectiveSatisfiedMin: number;
  readonly evidenceSufficientMin: number;
  readonly scopeDeviationMax: number;
  readonly semanticRiskEscalateMin: number;
}

export interface NoulCalibration {
  readonly n: number;
  readonly brier: number | null;
  readonly ece: number | null;
}

export interface SemanticRiskMae {
  readonly n: number;
  readonly mae: number | null;
}

export interface OfflineEvalReport {
  readonly counts: {
    readonly total: number;
    readonly valid: number;
    readonly invalid: number;
    readonly invalidReasons: Readonly<Record<string, number>>;
  };
  readonly thresholds: OfflineEvalThresholds;
  readonly outcomeCounts: Readonly<Record<HypotheticalOutcome, number>>;
  readonly errorRates: {
    readonly falsePassCount: number;
    readonly falsePassRate: number | null;
    readonly falseEscalationCount: number;
    readonly falseEscalationRate: number | null;
  };
  readonly noul: {
    readonly objective_satisfied: NoulCalibration;
    readonly evidence_sufficient: NoulCalibration;
    readonly scope_deviation: NoulCalibration;
    readonly macroBrier: number | null;
    readonly macroEce: number | null;
  };
  readonly semanticRiskMae: SemanticRiskMae;
}

const REQUIRED_NOUL_KEYS = [
  'objective_satisfied',
  'evidence_sufficient',
  'scope_deviation',
] as const;

const REQUIRED_KEYS = [...REQUIRED_NOUL_KEYS, 'semantic_risk'] as const;

const ECE_BINS = 10;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function assertThresholds(thresholds: OfflineEvalThresholds): void {
  const checks: ReadonlyArray<{ readonly key: keyof OfflineEvalThresholds; readonly min: number; readonly max: number }> = [
    { key: 'objectiveSatisfiedMin', min: 0, max: 1 },
    { key: 'evidenceSufficientMin', min: 0, max: 1 },
    { key: 'scopeDeviationMax', min: 0, max: 1 },
    { key: 'semanticRiskEscalateMin', min: 0, max: 3 },
  ];
  for (const { key, min, max } of checks) {
    if (!Object.prototype.hasOwnProperty.call(thresholds, key)) {
      throw new Error(`missing threshold field: ${key}`);
    }
    const v = thresholds[key];
    if (!isFiniteNumber(v) || v < min || v > max) {
      throw new Error(`invalid threshold ${key}: ${String(v)}`);
    }
  }
}

function validateNoulScore(signal: DecisionSignal | undefined, key: string): string | null {
  if (signal === undefined) return `missing_${key}`;
  if (signal.kind !== 'score') return `wrong_kind_${key}`;
  if (signal.scale !== 'noul') return `wrong_scale_${key}`;
  if (!isFiniteNumber(signal.value) || signal.value < 0 || signal.value > 1) {
    return `out_of_range_${key}`;
  }
  return null;
}

function validateSemanticRisk(signal: DecisionSignal | undefined): string | null {
  if (signal === undefined) return 'missing_semantic_risk';
  if (signal.kind !== 'score') return 'wrong_kind_semantic_risk';
  if (signal.scale !== 'ordinal4.v1') return 'wrong_scale_semantic_risk';
  if (!isFiniteNumber(signal.value) || signal.value < 0 || signal.value > 3) {
    return 'out_of_range_semantic_risk';
  }
  return null;
}

interface ValidatedAnswers {
  readonly objective_satisfied: number;
  readonly evidence_sufficient: number;
  readonly scope_deviation: number;
  readonly semantic_risk: number;
}

/** Returns invalid reason codes; empty => valid. */
function validateOfflineSample(sample: OfflineEvalSample): readonly string[] {
  const reasons: string[] = [];
  const answers = sample.answers?.answers;
  if (answers === undefined || typeof answers !== 'object' || answers === null) {
    return ['missing_answers'];
  }

  for (const key of Object.keys(answers)) {
    if (!(REQUIRED_KEYS as readonly string[]).includes(key)) {
      reasons.push('unexpected_answer_key');
    }
  }

  for (const key of REQUIRED_NOUL_KEYS) {
    const r = validateNoulScore(answers[key], key);
    if (r) reasons.push(r);
  }
  const riskR = validateSemanticRisk(answers.semantic_risk);
  if (riskR) reasons.push(riskR);

  return reasons;
}

function extractValidatedAnswers(sample: OfflineEvalSample): ValidatedAnswers {
  const a = sample.answers.answers;
  return {
    objective_satisfied: (a.objective_satisfied as Extract<DecisionSignal, { kind: 'score' }>).value,
    evidence_sufficient: (a.evidence_sufficient as Extract<DecisionSignal, { kind: 'score' }>).value,
    scope_deviation: (a.scope_deviation as Extract<DecisionSignal, { kind: 'score' }>).value,
    semantic_risk: (a.semantic_risk as Extract<DecisionSignal, { kind: 'score' }>).value,
  };
}

function hypotheticalOutcome(
  answers: ValidatedAnswers,
  thresholds: OfflineEvalThresholds,
): HypotheticalOutcome {
  // Do not round risk before compare.
  if (answers.semantic_risk >= thresholds.semanticRiskEscalateMin) {
    return 'escalate_attention';
  }
  if (
    answers.objective_satisfied >= thresholds.objectiveSatisfiedMin &&
    answers.evidence_sufficient >= thresholds.evidenceSufficientMin &&
    answers.scope_deviation <= thresholds.scopeDeviationMax
  ) {
    return 'fast_review';
  }
  return 'full_review';
}

function emptyNoul(): NoulCalibration {
  return { n: 0, brier: null, ece: null };
}

function mean(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function brierMean(pairs: readonly { p: number; y: number }[]): number | null {
  if (pairs.length === 0) return null;
  let s = 0;
  for (const { p, y } of pairs) {
    const d = p - y;
    s += d * d;
  }
  return s / pairs.length;
}

/** Fixed 10-bin ECE: bin = floor(p*10), p=1 → bin 9. */
function expectedCalibrationError(pairs: readonly { p: number; y: number }[]): number | null {
  const n = pairs.length;
  if (n === 0) return null;
  const binP: number[][] = Array.from({ length: ECE_BINS }, () => []);
  const binY: number[][] = Array.from({ length: ECE_BINS }, () => []);
  for (const { p, y } of pairs) {
    let b = Math.floor(p * ECE_BINS);
    if (b >= ECE_BINS) b = ECE_BINS - 1;
    if (b < 0) b = 0;
    binP[b]!.push(p);
    binY[b]!.push(y);
  }
  let ece = 0;
  for (let i = 0; i < ECE_BINS; i++) {
    const ps = binP[i]!;
    const ys = binY[i]!;
    const nk = ps.length;
    if (nk === 0) continue;
    const meanP = mean(ps)!;
    const meanY = mean(ys)!;
    ece += (nk / n) * Math.abs(meanP - meanY);
  }
  return ece;
}

function boolToY(b: boolean): number {
  return b ? 1 : 0;
}

function macroAverage(values: readonly (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null);
  if (present.length === 0) return null;
  return mean(present);
}

export function evaluatePostExecutionOffline(
  samples: readonly OfflineEvalSample[],
  thresholds: OfflineEvalThresholds,
): OfflineEvalReport {
  assertThresholds(thresholds);

  const invalidReasons: Record<string, number> = {};
  const outcomeCounts: Record<HypotheticalOutcome, number> = {
    fast_review: 0,
    full_review: 0,
    escalate_attention: 0,
  };

  let valid = 0;
  let invalid = 0;
  let falsePassCount = 0;
  let falseEscalationCount = 0;

  const noulPairs: Record<(typeof REQUIRED_NOUL_KEYS)[number], { p: number; y: number }[]> = {
    objective_satisfied: [],
    evidence_sufficient: [],
    scope_deviation: [],
  };
  const riskAbs: number[] = [];

  for (const sample of samples) {
    const reasons = validateOfflineSample(sample);
    if (reasons.length > 0) {
      invalid += 1;
      for (const r of reasons) {
        invalidReasons[r] = (invalidReasons[r] ?? 0) + 1;
      }
      continue;
    }

    valid += 1;
    const ans = extractValidatedAnswers(sample);
    const outcome = hypotheticalOutcome(ans, thresholds);
    outcomeCounts[outcome] += 1;

    const review = sample.groundTruth.review;
    if (outcome === 'fast_review' && (review === 'reject' || review === 'escalate')) {
      falsePassCount += 1;
    }
    if (outcome === 'escalate_attention' && review === 'accept') {
      falseEscalationCount += 1;
    }
    // full_review + accept is not falseEscalation

    noulPairs.objective_satisfied.push({
      p: ans.objective_satisfied,
      y: boolToY(sample.groundTruth.objectiveSatisfied),
    });
    noulPairs.evidence_sufficient.push({
      p: ans.evidence_sufficient,
      y: boolToY(sample.groundTruth.evidenceSufficient),
    });
    noulPairs.scope_deviation.push({
      p: ans.scope_deviation,
      y: boolToY(sample.groundTruth.scopeDeviation),
    });

    if (sample.groundTruth.semanticRiskOrdinal !== undefined) {
      const label = sample.groundTruth.semanticRiskOrdinal;
      riskAbs.push(Math.abs(Math.round(ans.semantic_risk) - label));
    }
  }

  const rateOrNull = (count: number): number | null => (valid === 0 ? null : count / valid);

  function calFor(key: (typeof REQUIRED_NOUL_KEYS)[number]): NoulCalibration {
    const pairs = noulPairs[key];
    if (pairs.length === 0) return emptyNoul();
    return {
      n: pairs.length,
      brier: brierMean(pairs),
      ece: expectedCalibrationError(pairs),
    };
  }

  const objCal = calFor('objective_satisfied');
  const evCal = calFor('evidence_sufficient');
  const scCal = calFor('scope_deviation');

  const semanticRiskMae: SemanticRiskMae =
    riskAbs.length === 0
      ? { n: 0, mae: null }
      : { n: riskAbs.length, mae: mean(riskAbs) };

  return {
    counts: {
      total: samples.length,
      valid,
      invalid,
      invalidReasons,
    },
    thresholds: {
      objectiveSatisfiedMin: thresholds.objectiveSatisfiedMin,
      evidenceSufficientMin: thresholds.evidenceSufficientMin,
      scopeDeviationMax: thresholds.scopeDeviationMax,
      semanticRiskEscalateMin: thresholds.semanticRiskEscalateMin,
    },
    outcomeCounts,
    errorRates: {
      falsePassCount,
      falsePassRate: rateOrNull(falsePassCount),
      falseEscalationCount,
      falseEscalationRate: rateOrNull(falseEscalationCount),
    },
    noul: {
      objective_satisfied: objCal,
      evidence_sufficient: evCal,
      scope_deviation: scCal,
      macroBrier: macroAverage([objCal.brier, evCal.brier, scCal.brier]),
      macroEce: macroAverage([objCal.ece, evCal.ece, scCal.ece]),
    },
    semanticRiskMae,
  };
}
