/**
 * Phase2 shadow exit evaluator —— 纯函数离线门禁。
 *
 * 只消费 ActivityEvent 流中的 decision.shadow（PRE_DISPATCH + PRE_DISPATCH_V1），
 * 不读 ActivityLog、不接 runner/platform。
 * 无默认阈值；缺 criterion 即为 not_evaluated。
 * Gate：六证全部 pass 才 pass；任一 fail => fail；无 fail 但有 not_evaluated => insufficient_evidence。
 */

import type { ActivityEvent } from './ports.ts';

/** Inline kind string — do not import runner symbols (source-constraint). */
const SHADOW_KIND = 'decision.shadow';
const PHASE2_HOOK = 'PRE_DISPATCH';
const PHASE2_QUESTION_SET_ID = 'PRE_DISPATCH_V1';

export interface DecisionCostModel {
  readonly usdPerMillionInputTokens: number;
  readonly usdPerMillionOutputTokens: number;
}

export interface Phase2ExitCriteria {
  readonly minSamples?: number;
  readonly minSuccessRate?: number;
  readonly maxP95LatencyMs?: number;
  readonly requireDataIntegrity?: true;
  readonly requireNoBehaviorChange?: true;
  readonly maxEstimatedCostUsd?: number;
}

export type Phase2CriterionStatus = 'pass' | 'fail' | 'not_evaluated';

export interface Phase2CriterionResult {
  readonly id: string;
  readonly status: Phase2CriterionStatus;
  readonly reason?: string;
}

export interface Phase2ExitCounts {
  readonly shadowEvents: number;
  readonly wellFormed: number;
  readonly malformed: number;
  readonly success: number;
  readonly providerError: number;
  readonly integrityFailures: number;
  readonly behaviorChangeCount: number;
}

export interface Phase2ExitMetrics {
  readonly successRate?: number;
  readonly p95LatencyMs?: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly estimatedCostUsd?: number;
  readonly missingUsageCount: number;
}

export type Phase2ExitGate = 'pass' | 'fail' | 'insufficient_evidence';

export interface Phase2ExitReport {
  readonly counts: Phase2ExitCounts;
  readonly metrics: Phase2ExitMetrics;
  readonly criteria: readonly Phase2CriterionResult[];
  readonly gate: Phase2ExitGate;
}

export interface EvaluatePhase2ShadowExitOptions {
  readonly costModel?: DecisionCostModel;
}

type IntegrityOk = {
  readonly ok: true;
  readonly quality: 'success' | 'provider_error';
  readonly latencyMs: number;
  readonly behaviorChanged: boolean;
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
  readonly hasUsage: boolean;
};

type IntegrityBad = {
  readonly ok: false;
  readonly quality: 'success' | 'provider_error' | 'unknown';
  readonly latencyMs?: number;
  readonly behaviorChanged: boolean;
};

type IntegrityResult = IntegrityOk | IntegrityBad;

function isFiniteNonNegNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

function isFiniteNonNegInt(v: unknown): v is number {
  return isFiniteNonNegNumber(v) && Number.isInteger(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

function isStringArray(v: unknown): v is readonly string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function parseDispatchAction(raw: unknown): { ok: true; workItemIds: readonly string[] } | { ok: false } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false };
  const o = raw as Record<string, unknown>;
  if (o.kind !== 'dispatch') return { ok: false };
  if (!isStringArray(o.workItemIds)) return { ok: false };
  return { ok: true, workItemIds: o.workItemIds };
}

function answersNonEmptyRecord(answers: unknown): answers is Record<string, unknown> {
  if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) return false;
  return Object.keys(answers as object).length > 0;
}

function validateSignal(signal: unknown): boolean {
  if (signal === null || typeof signal !== 'object' || Array.isArray(signal)) return false;
  const s = signal as Record<string, unknown>;
  if (s.kind === 'choice') {
    return typeof s.option === 'string';
  }
  if (s.kind === 'score') {
    if (typeof s.value !== 'number' || !Number.isFinite(s.value)) return false;
    if (s.scale !== undefined && typeof s.scale !== 'string') return false;
    return true;
  }
  if (s.kind === 'noop') {
    if (s.reason !== undefined && typeof s.reason !== 'string') return false;
    return true;
  }
  return false;
}

function validateAnswers(answers: Record<string, unknown>): boolean {
  for (const key of Object.keys(answers)) {
    if (!validateSignal(answers[key])) return false;
  }
  return true;
}

function validateUsage(usage: unknown): { ok: true; inputTokens: number; outputTokens: number } | { ok: false } {
  if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return { ok: false };
  const u = usage as Record<string, unknown>;
  if (!isFiniteNonNegInt(u.inputTokens) || !isFiniteNonNegInt(u.outputTokens)) return { ok: false };
  return { ok: true, inputTokens: u.inputTokens, outputTokens: u.outputTokens };
}

/** Phase2 只统计 PRE_DISPATCH + PRE_DISPATCH_V1；其它 shadow 直接忽略。 */
function isPhase2ShadowData(data: unknown): boolean {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return false;
  const d = data as Record<string, unknown>;
  return d.hook === PHASE2_HOOK && d.questionSetId === PHASE2_QUESTION_SET_ID;
}

function inspectShadowData(data: unknown): IntegrityResult {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, quality: 'unknown', behaviorChanged: false };
  }
  const d = data as Record<string, unknown>;

  const requiredPresent =
    d.schemaVersion !== undefined &&
    d.hook !== undefined &&
    d.providerKind !== undefined &&
    d.ids !== undefined &&
    d.quality !== undefined &&
    d.mode === 'shadow' &&
    d.questionSetId !== undefined &&
    d.baselineAction !== undefined &&
    d.effectiveAction !== undefined;

  if (!requiredPresent) {
    return { ok: false, quality: typeof d.quality === 'string' ? (d.quality as 'success' | 'provider_error' | 'unknown') : 'unknown', behaviorChanged: false };
  }

  if (typeof d.schemaVersion !== 'string' || d.schemaVersion.length === 0) {
    return { ok: false, quality: 'unknown', behaviorChanged: false };
  }
  if (typeof d.hook !== 'string' || d.hook.length === 0) {
    return { ok: false, quality: 'unknown', behaviorChanged: false };
  }
  if (typeof d.providerKind !== 'string' || d.providerKind.length === 0) {
    return { ok: false, quality: 'unknown', behaviorChanged: false };
  }
  if (typeof d.questionSetId !== 'string' || d.questionSetId.length === 0) {
    return { ok: false, quality: 'unknown', behaviorChanged: false };
  }
  if (d.ids === null || typeof d.ids !== 'object' || Array.isArray(d.ids)) {
    return { ok: false, quality: 'unknown', behaviorChanged: false };
  }
  const ids = d.ids as Record<string, unknown>;
  if (
    typeof ids.projectId !== 'string' ||
    typeof ids.missionId !== 'string' ||
    !isStringArray(ids.workItemIds)
  ) {
    return { ok: false, quality: 'unknown', behaviorChanged: false };
  }

  if (!isFiniteNonNegNumber(d.latencyMs)) {
    const q = d.quality === 'success' || d.quality === 'provider_error' ? d.quality : 'unknown';
    return { ok: false, quality: q, behaviorChanged: false };
  }
  const latencyMs = d.latencyMs;

  const baseline = parseDispatchAction(d.baselineAction);
  const effective = parseDispatchAction(d.effectiveAction);
  let behaviorChanged = false;
  if (baseline.ok && effective.ok) {
    behaviorChanged = !sameStringArray(baseline.workItemIds, effective.workItemIds);
  }

  const actionsStructurallyOk = baseline.ok && effective.ok;
  // baseline/effective 结构合法但内容不等 => integrity failure + behavior change
  if (!actionsStructurallyOk) {
    const q = d.quality === 'success' || d.quality === 'provider_error' ? d.quality : 'unknown';
    return { ok: false, quality: q, latencyMs, behaviorChanged: false };
  }
  if (behaviorChanged) {
    const q = d.quality === 'success' || d.quality === 'provider_error' ? d.quality : 'unknown';
    return { ok: false, quality: q, latencyMs, behaviorChanged: true };
  }

  if (d.quality === 'success') {
    if (!answersNonEmptyRecord(d.answers) || !validateAnswers(d.answers)) {
      return { ok: false, quality: 'success', latencyMs, behaviorChanged: false };
    }
    if (d.resolvedModel !== undefined && !isNonEmptyString(d.resolvedModel)) {
      return { ok: false, quality: 'success', latencyMs, behaviorChanged: false };
    }
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    let hasUsage = false;
    if (d.usage !== undefined) {
      const vu = validateUsage(d.usage);
      if (!vu.ok) {
        return { ok: false, quality: 'success', latencyMs, behaviorChanged: false };
      }
      usage = { inputTokens: vu.inputTokens, outputTokens: vu.outputTokens };
      hasUsage = true;
    }
    return {
      ok: true,
      quality: 'success',
      latencyMs,
      behaviorChanged: false,
      usage,
      hasUsage,
    };
  }

  if (d.quality === 'provider_error') {
    if (d.answers !== undefined || d.resolvedModel !== undefined || d.usage !== undefined) {
      return { ok: false, quality: 'provider_error', latencyMs, behaviorChanged: false };
    }
    return {
      ok: true,
      quality: 'provider_error',
      latencyMs,
      behaviorChanged: false,
      hasUsage: false,
    };
  }

  return { ok: false, quality: 'unknown', latencyMs, behaviorChanged: false };
}

function nearestRankP95(latencies: readonly number[]): number | undefined {
  if (latencies.length === 0) return undefined;
  const sorted = [...latencies].sort((a, b) => a - b);
  const rank = Math.ceil(0.95 * sorted.length);
  return sorted[rank - 1];
}

function isValidCostModel(m: DecisionCostModel | undefined): m is DecisionCostModel {
  if (m === undefined) return false;
  return (
    isFiniteNonNegNumber(m.usdPerMillionInputTokens) &&
    isFiniteNonNegNumber(m.usdPerMillionOutputTokens)
  );
}

function criterion(
  id: string,
  status: Phase2CriterionStatus,
  reason?: string,
): Phase2CriterionResult {
  return reason === undefined ? { id, status } : { id, status, reason };
}

/**
 * 纯函数：根据 shadow 事件与退出准则生成 Phase2ExitReport。
 * 不修改 events / criteria。
 */
export function evaluatePhase2ShadowExit(
  events: readonly ActivityEvent[],
  criteria: Phase2ExitCriteria,
  options?: EvaluatePhase2ShadowExitOptions,
): Phase2ExitReport {
  let shadowEvents = 0;
  let wellFormed = 0;
  let malformed = 0;
  let success = 0;
  let providerError = 0;
  let integrityFailures = 0;
  let behaviorChangeCount = 0;

  /** P95：所有 well-formed（success + provider_error）的 latencyMs */
  const wellFormedLatencies: number[] = [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let missingUsageCount = 0;

  for (const ev of events) {
    if (ev.kind !== SHADOW_KIND) continue;
    if (!isPhase2ShadowData(ev.data)) continue;

    shadowEvents += 1;
    const inspected = inspectShadowData(ev.data);

    if (inspected.behaviorChanged) {
      behaviorChangeCount += 1;
    }

    if (!inspected.ok) {
      integrityFailures += 1;
      malformed += 1;
      continue;
    }

    wellFormed += 1;
    wellFormedLatencies.push(inspected.latencyMs);
    if (inspected.quality === 'success') {
      success += 1;
      if (inspected.hasUsage && inspected.usage) {
        totalInputTokens += inspected.usage.inputTokens;
        totalOutputTokens += inspected.usage.outputTokens;
      } else {
        missingUsageCount += 1;
      }
    } else {
      providerError += 1;
    }
  }

  const successRate = shadowEvents > 0 ? success / shadowEvents : undefined;
  const p95LatencyMs = nearestRankP95(wellFormedLatencies);

  const costModel = options?.costModel;
  let estimatedCostUsd: number | undefined;
  if (isValidCostModel(costModel)) {
    estimatedCostUsd =
      (totalInputTokens / 1e6) * costModel.usdPerMillionInputTokens +
      (totalOutputTokens / 1e6) * costModel.usdPerMillionOutputTokens;
  }

  const results: Phase2CriterionResult[] = [];

  // minSamples：合法必须 integer >= 1；0 => invalid_criteria
  if (criteria.minSamples === undefined) {
    results.push(criterion('minSamples', 'not_evaluated'));
  } else if (
    typeof criteria.minSamples !== 'number' ||
    !Number.isFinite(criteria.minSamples) ||
    !Number.isInteger(criteria.minSamples) ||
    criteria.minSamples < 1
  ) {
    results.push(criterion('minSamples', 'fail', 'invalid_criteria'));
  } else if (wellFormed >= criteria.minSamples) {
    results.push(criterion('minSamples', 'pass'));
  } else {
    results.push(criterion('minSamples', 'fail', 'below_min_samples'));
  }

  // minSuccessRate：合法必须 >0 && <=1；0 => invalid_criteria；1 合法
  if (criteria.minSuccessRate === undefined) {
    results.push(criterion('minSuccessRate', 'not_evaluated'));
  } else if (
    typeof criteria.minSuccessRate !== 'number' ||
    !Number.isFinite(criteria.minSuccessRate) ||
    !(criteria.minSuccessRate > 0 && criteria.minSuccessRate <= 1)
  ) {
    results.push(criterion('minSuccessRate', 'fail', 'invalid_criteria'));
  } else if (successRate === undefined) {
    results.push(criterion('minSuccessRate', 'fail', 'no_samples'));
  } else if (successRate >= criteria.minSuccessRate) {
    results.push(criterion('minSuccessRate', 'pass'));
  } else {
    results.push(criterion('minSuccessRate', 'fail', 'below_min_success_rate'));
  }

  // maxP95LatencyMs
  if (criteria.maxP95LatencyMs === undefined) {
    results.push(criterion('maxP95LatencyMs', 'not_evaluated'));
  } else if (
    typeof criteria.maxP95LatencyMs !== 'number' ||
    !Number.isFinite(criteria.maxP95LatencyMs) ||
    criteria.maxP95LatencyMs < 0
  ) {
    results.push(criterion('maxP95LatencyMs', 'fail', 'invalid_criteria'));
  } else if (p95LatencyMs === undefined) {
    results.push(criterion('maxP95LatencyMs', 'fail', 'no_latency_samples'));
  } else if (p95LatencyMs <= criteria.maxP95LatencyMs) {
    results.push(criterion('maxP95LatencyMs', 'pass'));
  } else {
    results.push(criterion('maxP95LatencyMs', 'fail', 'above_max_p95_latency'));
  }

  // requireDataIntegrity
  if (criteria.requireDataIntegrity === undefined) {
    results.push(criterion('requireDataIntegrity', 'not_evaluated'));
  } else if (criteria.requireDataIntegrity !== true) {
    results.push(criterion('requireDataIntegrity', 'fail', 'invalid_criteria'));
  } else if (shadowEvents === 0) {
    results.push(criterion('requireDataIntegrity', 'fail', 'no_samples'));
  } else if (integrityFailures === 0) {
    results.push(criterion('requireDataIntegrity', 'pass'));
  } else {
    results.push(criterion('requireDataIntegrity', 'fail', 'integrity_failures'));
  }

  // requireNoBehaviorChange
  if (criteria.requireNoBehaviorChange === undefined) {
    results.push(criterion('requireNoBehaviorChange', 'not_evaluated'));
  } else if (criteria.requireNoBehaviorChange !== true) {
    results.push(criterion('requireNoBehaviorChange', 'fail', 'invalid_criteria'));
  } else if (shadowEvents === 0) {
    results.push(criterion('requireNoBehaviorChange', 'fail', 'no_samples'));
  } else if (behaviorChangeCount === 0) {
    results.push(criterion('requireNoBehaviorChange', 'pass'));
  } else {
    results.push(criterion('requireNoBehaviorChange', 'fail', 'behavior_changed'));
  }

  // maxEstimatedCostUsd
  if (criteria.maxEstimatedCostUsd === undefined) {
    results.push(criterion('maxEstimatedCostUsd', 'not_evaluated'));
  } else if (
    typeof criteria.maxEstimatedCostUsd !== 'number' ||
    !Number.isFinite(criteria.maxEstimatedCostUsd) ||
    criteria.maxEstimatedCostUsd < 0
  ) {
    results.push(criterion('maxEstimatedCostUsd', 'fail', 'invalid_criteria'));
  } else if (!isValidCostModel(costModel)) {
    results.push(criterion('maxEstimatedCostUsd', 'fail', 'cost_model_required'));
  } else if (estimatedCostUsd === undefined) {
    results.push(criterion('maxEstimatedCostUsd', 'fail', 'cost_model_required'));
  } else if (estimatedCostUsd <= criteria.maxEstimatedCostUsd) {
    results.push(criterion('maxEstimatedCostUsd', 'pass'));
  } else {
    results.push(criterion('maxEstimatedCostUsd', 'fail', 'above_max_estimated_cost'));
  }

  // Gate：六个固定 criteria 任一 fail => fail；无 fail 但任一 not_evaluated => insufficient_evidence；六者全部 pass 才 pass
  const anyFail = results.some((r) => r.status === 'fail');
  const anyNotEvaluated = results.some((r) => r.status === 'not_evaluated');
  let gate: Phase2ExitGate;
  if (anyFail) {
    gate = 'fail';
  } else if (anyNotEvaluated) {
    gate = 'insufficient_evidence';
  } else {
    gate = 'pass';
  }

  return {
    counts: {
      shadowEvents,
      wellFormed,
      malformed,
      success,
      providerError,
      integrityFailures,
      behaviorChangeCount,
    },
    metrics: {
      ...(successRate !== undefined ? { successRate } : {}),
      ...(p95LatencyMs !== undefined ? { p95LatencyMs } : {}),
      totalInputTokens,
      totalOutputTokens,
      ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
      missingUsageCount,
    },
    criteria: results,
    gate,
  };
}
