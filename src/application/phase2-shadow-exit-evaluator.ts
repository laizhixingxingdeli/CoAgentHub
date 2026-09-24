/**
 * Phase2 shadow exit evaluator —— 纯函数离线门禁。
 *
 * 只消费 ActivityEvent 流中的 decision.shadow（PRE_DISPATCH + PRE_DISPATCH_V1），
 * 不读 ActivityLog、不接 runner/platform。
 * 无默认阈值；缺 criterion 即为 not_evaluated。
 * Gate：七条全部 pass 才 pass；任一 fail => fail；无 fail 但有 not_evaluated => insufficient_evidence。
 *
 * 第七条 answerQuality（J3）看答案对不对：前六条只看管线，E3 实测只给 ID 时三道题都比
 * 「全猜多数类」还差，照样能全过。标注由调用方离线给（options.labels），这里不读任何存储。
 */

import { PRE_DISPATCH_V1, PRE_DISPATCH_V1_QUESTION_IDS } from './decision-question-registry.ts';
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
  readonly answerQuality?: Phase2AnswerQualityCriteria;
}

/**
 * 答案质量阈值（J3）。minAccuracy 与 minLiftOverMajority 至少给一个，每道要评的题都得达到。
 */
export interface Phase2AnswerQualityCriteria {
  /** 要评的题（PRE_DISPATCH_V1 的题 id）；缺省 = 标注里出现过的全部题。 */
  readonly questions?: readonly string[];
  /** 每道题至少多少条对上了标注的成功样本才评；整数 ≥ 1，缺省 1。 */
  readonly minLabeledSamples?: number;
  /** 每道题对照标注的准确率下限，(0, 1]。 */
  readonly minAccuracy?: number;
  /** 每道题「准确率 − 全猜多数类的准确率」的下限，[-1, 1]。0 = 至少不比瞎猜差。 */
  readonly minLiftOverMajority?: number;
}

/**
 * 标注值。choice 题写选项；分档题（semantic_risk）写档位下标 0..3 或档名 LOW..CRITICAL；
 * noul 题（work_order_ambiguous）写 true / false。
 */
export type Phase2AnswerLabelValue = string | number | boolean;

/** 一条离线人工标注，对上一次 PRE 派发：同一 Mission、同一批工作项（顺序无关）。 */
export interface Phase2AnswerLabel {
  readonly missionId: string;
  readonly workItemIds: readonly string[];
  readonly answers: Readonly<Record<string, Phase2AnswerLabelValue>>;
}

export interface Phase2AnswerQualityQuestion {
  readonly questionId: string;
  /** 对上了标注、且标注里有这道题的成功样本数。 */
  readonly labeled: number;
  readonly correct: number;
  readonly accuracy: number;
  /** 标注里最多的那个答案（分档题写档名）。并列时取规范形式排序最前的。 */
  readonly majorityLabel: string;
  /** 全猜 majorityLabel 的准确率。 */
  readonly majorityBaseline: number;
  readonly lift: number;
}

export interface Phase2AnswerQualityMetrics {
  /** 对上了标注的成功 shadow 样本数。 */
  readonly labeledSamples: number;
  readonly questions: readonly Phase2AnswerQualityQuestion[];
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
  readonly answerQuality?: Phase2AnswerQualityMetrics;
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
  /** 离线人工标注：answerQuality 判据的依据。 */
  readonly labels?: readonly Phase2AnswerLabel[];
}

type IntegrityOk = {
  readonly ok: true;
  readonly quality: 'success' | 'provider_error';
  readonly latencyMs: number;
  readonly behaviorChanged: boolean;
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
  readonly hasUsage: boolean;
  /** 成功样本才有：对标注用的键与答案。 */
  readonly sample?: AnswerSample;
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
      sample: {
        key: dispatchKey(ids.missionId as string, ids.workItemIds as readonly string[]),
        answers: d.answers,
      },
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

/* ------------------------------ 答案质量（J3） ------------------------------ */

interface AnswerSample {
  readonly key: string;
  readonly answers: Readonly<Record<string, unknown>>;
}

type QuestionScale =
  | { readonly kind: 'choice' }
  | { readonly kind: 'ordinal'; readonly levels: readonly string[] }
  | { readonly kind: 'noul' };

/** PRE_DISPATCH_V1 每道题怎么判对（题型取自 PRE_DISPATCH_V1，不从回答里猜——没答的题也要知道怎么数标注）。 */
const QUESTION_SCALES: ReadonlyMap<string, QuestionScale> = new Map(
  PRE_DISPATCH_V1.questions.map((q): [string, QuestionScale] => {
    if (q.kind === 'choice') return [q.id, { kind: 'choice' }];
    if (q.kind === 'noul') return [q.id, { kind: 'noul' }];
    return [q.id, { kind: 'ordinal', levels: q.orderedLevels.map((level) => level.label) }];
  }),
);

/** 浮点比较留一点余量：0.7 − 0.6 算出来是 0.0999…，不能因此判「提升不到 0.1」。 */
const EPSILON = 1e-9;

function dispatchKey(missionId: string, workItemIds: readonly string[]): string {
  return JSON.stringify([missionId, [...workItemIds].sort()]);
}

/** 标注规范成可比较、可数众数的形式；与题型不符 → undefined。分档题统一成下标。 */
function normalizeLabel(scale: QuestionScale, value: unknown): string | undefined {
  if (scale.kind === 'choice') return typeof value === 'string' && value.length > 0 ? value : undefined;
  if (scale.kind === 'noul') return typeof value === 'boolean' ? String(value) : undefined;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < scale.levels.length) {
    return String(value);
  }
  if (typeof value === 'string') {
    const index = scale.levels.indexOf(value.trim().toUpperCase());
    return index >= 0 ? String(index) : undefined;
  }
  return undefined;
}

/**
 * 回答规范成同一形式；没答、noop、题型对不上 → undefined（算错）。
 * 分档题四舍五入到最近的档，noul 以 0.5 为界——与 E3 的量法一致。
 */
function normalizeAnswer(scale: QuestionScale, signal: unknown): string | undefined {
  if (signal === null || typeof signal !== 'object') return undefined;
  const s = signal as { kind?: unknown; option?: unknown; value?: unknown };
  if (scale.kind === 'choice') return s.kind === 'choice' && typeof s.option === 'string' ? s.option : undefined;
  if (s.kind !== 'score' || typeof s.value !== 'number' || !Number.isFinite(s.value)) return undefined;
  if (scale.kind === 'noul') return String(s.value >= 0.5);
  return String(Math.min(scale.levels.length - 1, Math.max(0, Math.round(s.value))));
}

function displayLabel(scale: QuestionScale, normalized: string): string {
  return scale.kind === 'ordinal' ? (scale.levels[Number(normalized)] ?? normalized) : normalized;
}

/** 标注整体校验：任一条不合法、或同一次派发标了两份（不知道信哪份），整批不用。 */
function parseLabels(
  labels: readonly unknown[],
): { ok: true; byKey: ReadonlyMap<string, Readonly<Record<string, unknown>>> } | { ok: false } {
  const byKey = new Map<string, Readonly<Record<string, unknown>>>();
  for (const raw of labels) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false };
    const label = raw as Record<string, unknown>;
    if (!isNonEmptyString(label.missionId) || !isStringArray(label.workItemIds) || label.workItemIds.length === 0) {
      return { ok: false };
    }
    const answers = label.answers;
    if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) return { ok: false };
    const entries = Object.entries(answers as Record<string, unknown>);
    if (entries.length === 0) return { ok: false };
    for (const [questionId, value] of entries) {
      const scale = QUESTION_SCALES.get(questionId);
      if (!scale || normalizeLabel(scale, value) === undefined) return { ok: false };
    }
    const key = dispatchKey(label.missionId, label.workItemIds);
    if (byKey.has(key)) return { ok: false };
    byKey.set(key, answers as Record<string, unknown>);
  }
  return { ok: true, byKey };
}

function validAnswerQualityCriteria(c: Phase2AnswerQualityCriteria): boolean {
  if (c === null || typeof c !== 'object' || Array.isArray(c)) return false;
  // 一个阈值都没有的质量判据等于没有判据。
  if (c.minAccuracy === undefined && c.minLiftOverMajority === undefined) return false;
  if (
    c.minAccuracy !== undefined &&
    !(typeof c.minAccuracy === 'number' && Number.isFinite(c.minAccuracy) && c.minAccuracy > 0 && c.minAccuracy <= 1)
  ) {
    return false;
  }
  if (
    c.minLiftOverMajority !== undefined &&
    !(
      typeof c.minLiftOverMajority === 'number' &&
      Number.isFinite(c.minLiftOverMajority) &&
      c.minLiftOverMajority >= -1 &&
      c.minLiftOverMajority <= 1
    )
  ) {
    return false;
  }
  if (c.minLabeledSamples !== undefined && !(isFiniteNonNegInt(c.minLabeledSamples) && c.minLabeledSamples >= 1)) {
    return false;
  }
  if (
    c.questions !== undefined &&
    !(isStringArray(c.questions) && c.questions.length > 0 && c.questions.every((q) => QUESTION_SCALES.has(q)))
  ) {
    return false;
  }
  return true;
}

function evaluateAnswerQuality(
  samples: readonly AnswerSample[],
  config: Phase2AnswerQualityCriteria | undefined,
  labels: readonly Phase2AnswerLabel[] | undefined,
): { result: Phase2CriterionResult; metrics?: Phase2AnswerQualityMetrics } {
  const id = 'answerQuality';
  if (config === undefined) return { result: criterion(id, 'not_evaluated') };
  if (!validAnswerQualityCriteria(config)) return { result: criterion(id, 'fail', 'invalid_criteria') };
  // 没有标注判不满足、不跳过：不看答案对错的 Phase 2 说明不了 Jev 有用（E3）。
  if (!Array.isArray(labels) || labels.length === 0) return { result: criterion(id, 'fail', 'no_labels') };
  const parsed = parseLabels(labels);
  if (!parsed.ok) return { result: criterion(id, 'fail', 'invalid_labels') };

  const labeledQuestions = new Set<string>();
  for (const answers of parsed.byKey.values()) for (const q of Object.keys(answers)) labeledQuestions.add(q);
  const questionIds = config.questions ?? PRE_DISPATCH_V1_QUESTION_IDS.filter((q) => labeledQuestions.has(q));

  const tallies = new Map<string, { labeled: number; correct: number; labelCounts: Map<string, number> }>();
  for (const q of questionIds) tallies.set(q, { labeled: 0, correct: 0, labelCounts: new Map() });
  let labeledSamples = 0;
  for (const sample of samples) {
    const label = parsed.byKey.get(sample.key);
    if (!label) continue;
    labeledSamples += 1;
    for (const q of questionIds) {
      if (!(q in label)) continue;
      const scale = QUESTION_SCALES.get(q)!;
      const expected = normalizeLabel(scale, label[q])!;
      const tally = tallies.get(q)!;
      tally.labeled += 1;
      tally.labelCounts.set(expected, (tally.labelCounts.get(expected) ?? 0) + 1);
      if (normalizeAnswer(scale, sample.answers[q]) === expected) tally.correct += 1;
    }
  }
  if (labeledSamples === 0) return { result: criterion(id, 'fail', 'no_labeled_samples') };

  const questions: Phase2AnswerQualityQuestion[] = questionIds.map((q) => {
    const scale = QUESTION_SCALES.get(q)!;
    const tally = tallies.get(q)!;
    let majority = '';
    let majorityCount = 0;
    for (const [value, count] of [...tally.labelCounts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (count > majorityCount) {
        majority = value;
        majorityCount = count;
      }
    }
    const accuracy = tally.labeled > 0 ? tally.correct / tally.labeled : 0;
    const majorityBaseline = tally.labeled > 0 ? majorityCount / tally.labeled : 0;
    return {
      questionId: q,
      labeled: tally.labeled,
      correct: tally.correct,
      accuracy,
      majorityLabel: majority === '' ? '' : displayLabel(scale, majority),
      majorityBaseline,
      lift: accuracy - majorityBaseline,
    };
  });
  const metrics: Phase2AnswerQualityMetrics = { labeledSamples, questions };

  const minLabeled = config.minLabeledSamples ?? 1;
  if (questions.some((q) => q.labeled < minLabeled)) {
    return { result: criterion(id, 'fail', 'insufficient_labeled_samples'), metrics };
  }
  const minAccuracy = config.minAccuracy;
  if (minAccuracy !== undefined && questions.some((q) => q.accuracy + EPSILON < minAccuracy)) {
    return { result: criterion(id, 'fail', 'below_min_accuracy'), metrics };
  }
  const minLift = config.minLiftOverMajority;
  if (minLift !== undefined && questions.some((q) => q.lift + EPSILON < minLift)) {
    return { result: criterion(id, 'fail', 'below_min_lift'), metrics };
  }
  return { result: criterion(id, 'pass'), metrics };
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
  const answerSamples: AnswerSample[] = [];

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
      if (inspected.sample) answerSamples.push(inspected.sample);
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

  // answerQuality（J3）：对照标注的准确率 / 相对全猜多数类的提升
  const quality = evaluateAnswerQuality(answerSamples, criteria.answerQuality, options?.labels);
  results.push(quality.result);

  // Gate：七个固定 criteria 任一 fail => fail；无 fail 但任一 not_evaluated => insufficient_evidence；七者全部 pass 才 pass
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
      ...(quality.metrics ? { answerQuality: quality.metrics } : {}),
    },
    criteria: results,
    gate,
  };
}
