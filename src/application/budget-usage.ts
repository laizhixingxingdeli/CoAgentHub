/**
 * Pure authoritative budget usage snapshot + evaluation (BUDGET-001-S1/S2).
 *
 * Application-layer only: consumes ExecutionBudget + attempt usage facts +
 * optional durable orchestration.round.started ActivityLog facts (S2).
 * No scheduler enforcement, wait-state coupling, thresholds, upgrade wiring,
 * or default policy numbers. Does not invent wall-clock/command usage.
 */

import type { ExecutionBudget, TokenUsage } from '../kernel/index.ts';

/** Stable budget dimensions evaluated in S1. */
export const BUDGET_DIMENSIONS = [
  'attempts',
  'rounds',
  'wallClockMs',
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cost',
  'changedFiles',
  'commands',
] as const;

export type BudgetDimension = (typeof BUDGET_DIMENSIONS)[number];

export type DimensionVerdictStatus = 'ok' | 'exceeded' | 'unknown' | 'not_in_force';

/**
 * Per-dimension verdict.
 *
 * - `not_in_force`: no applicable limit (missing budget, or optional limit absent)
 * - `unknown`: limit in force but trusted usage unavailable in S1
 * - `ok` / `exceeded`: trusted usage compared with `used >= limit` => exceeded
 */
export interface DimensionVerdict {
  readonly dimension: BudgetDimension;
  readonly status: DimensionVerdictStatus;
  /** Present when this dimension's limit is in force. */
  readonly limit?: number;
  /** Present when trusted usage is known for this dimension. */
  readonly used?: number;
}

export interface BudgetEvaluation {
  readonly dimensions: readonly DimensionVerdict[];
  /**
   * True iff any dimension status is `exceeded`.
   * `unknown` / `not_in_force` never contribute.
   */
  readonly anyAuthoritativeExceeded: boolean;
}

/** Trusted token totals — only when every counted attempt is fully reported. */
export interface BudgetTokenAggregate {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

/**
 * Authoritative usage facts at a point in time.
 *
 * wallClockMs / commandCount remain omitted — no trusted sources yet.
 * roundCount is optional (S2): only when caller supplies a known projection
 * from countAuthoritativeRounds; never invent a zero when history is unknown.
 */
export interface BudgetUsageSnapshot {
  readonly missionId: string;
  readonly capturedAt: string;
  /** Exact number of supplied durable attempts (coordinator + executor). */
  readonly attemptCount: number;
  /**
   * Known authoritative orchestration round count (S2).
   * Absent when projection is unknown (legacy/mixed history) or not supplied.
   */
  readonly roundCount?: number;
  /** Only when caller provided a trusted changedFiles list. */
  readonly changedFileCount?: number;
  /** Only when every counted attempt is reported with finite nonnegative tokens. */
  readonly tokenAggregate?: BudgetTokenAggregate;
  /** Only when every counted attempt is reported with finite nonnegative cost. */
  readonly costAggregate?: number;
}

/**
 * Minimal attempt fact for snapshotting. Kind is ignored for counting —
 * coordinator and executor shapes both count when supplied.
 */
export interface BudgetAttemptFact {
  readonly usage?: unknown;
  readonly kind?: unknown;
}

export interface BuildBudgetUsageSnapshotInput {
  readonly missionId: string;
  readonly capturedAt: string;
  readonly attempts: readonly BudgetAttemptFact[];
  /**
   * Known authoritative round count from countAuthoritativeRounds.
   * When provided (including 0), `roundCount` is set on the snapshot.
   * Omitted => no round fact (evaluator keeps rounds unknown).
   */
  readonly roundCount?: number;
  /**
   * Trusted changed-files list from an authoritative source.
   * When provided (including empty), `changedFileCount` is set to its length.
   * Omitted => no changed-file fact.
   */
  readonly changedFiles?: readonly string[];
}

/** Minimal activity-log shape for pure round projection (S2). */
export interface BudgetActivityEventFact {
  readonly kind: string;
  readonly data?: unknown;
}

/**
 * Result of projecting durable orchestration.round.started facts.
 *
 * - known: trusted count (may be 0 when no rounds and no attempt trace)
 * - unknown: legacy/pre-S2 or mixed history — do not invent a number
 */
export type AuthoritativeRoundCount =
  | { readonly status: 'known'; readonly count: number }
  | { readonly status: 'unknown' };

const ROUND_STARTED_KIND = 'orchestration.round.started';
const ATTEMPT_TRACE_KINDS = new Set(['attempt.started', 'attempt.ended']);

function isAuthoritativeRoundStarted(event: BudgetActivityEventFact): boolean {
  if (event.kind !== ROUND_STARTED_KIND) return false;
  const data = event.data;
  if (data == null || typeof data !== 'object' || Array.isArray(data)) return false;
  return (data as { schemaVersion?: unknown }).schemaVersion === 1;
}

/**
 * Pure projection of authoritative orchestration rounds from ActivityLog events.
 *
 * Recognizes only orchestration.round.started with data.schemaVersion === 1.
 * Never infers rounds from timestamps, work items, maxRounds, or attempt counts.
 */
export function countAuthoritativeRounds(
  events: readonly BudgetActivityEventFact[],
): AuthoritativeRoundCount {
  let authoritativeCount = 0;
  let firstAuthoritativeIndex = -1;
  let firstAttemptTraceIndex = -1;

  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]!;
    if (isAuthoritativeRoundStarted(event)) {
      if (firstAuthoritativeIndex < 0) firstAuthoritativeIndex = i;
      authoritativeCount += 1;
      continue;
    }
    if (ATTEMPT_TRACE_KINDS.has(event.kind) && firstAttemptTraceIndex < 0) {
      firstAttemptTraceIndex = i;
    }
  }

  // No authoritative round-start facts.
  if (firstAuthoritativeIndex < 0) {
    // Honest zero: empty / pre-work history with no attempt trace.
    if (firstAttemptTraceIndex < 0) {
      return Object.freeze({ status: 'known', count: 0 });
    }
    // Legacy / pre-S2 history: attempts without round-start facts.
    return Object.freeze({ status: 'unknown' });
  }

  // Mixed history: attempt trace appears before the first trusted round-start.
  if (firstAttemptTraceIndex >= 0 && firstAttemptTraceIndex < firstAuthoritativeIndex) {
    return Object.freeze({ status: 'unknown' });
  }

  return Object.freeze({ status: 'known', count: authoritativeCount });
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isReportedTokenUsage(value: unknown): value is TokenUsage {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false;
  const u = value as Record<string, unknown>;
  if (u.quality !== 'reported') return false;
  return (
    isFiniteNonNegative(u.input) &&
    isFiniteNonNegative(u.output) &&
    isFiniteNonNegative(u.cacheRead) &&
    isFiniteNonNegative(u.cacheWrite) &&
    isFiniteNonNegative(u.total)
  );
}

function hasReportedCost(value: unknown): boolean {
  if (!isReportedTokenUsage(value)) return false;
  return isFiniteNonNegative((value as TokenUsage).cost);
}

/**
 * Build a pure usage snapshot from durable attempt facts (+ optional trusted files).
 *
 * Does not mutate `attempts` or `changedFiles`. Does not read Mission aggregates.
 */
export function buildBudgetUsageSnapshot(
  input: BuildBudgetUsageSnapshotInput,
): BudgetUsageSnapshot {
  const attempts = input.attempts;
  const attemptCount = attempts.length;

  const out: {
    missionId: string;
    capturedAt: string;
    attemptCount: number;
    roundCount?: number;
    changedFileCount?: number;
    tokenAggregate?: BudgetTokenAggregate;
    costAggregate?: number;
  } = {
    missionId: input.missionId,
    capturedAt: input.capturedAt,
    attemptCount,
  };

  if (Object.prototype.hasOwnProperty.call(input, 'roundCount') && input.roundCount !== undefined) {
    out.roundCount = input.roundCount;
  }

  if (Object.prototype.hasOwnProperty.call(input, 'changedFiles') && input.changedFiles !== undefined) {
    out.changedFileCount = input.changedFiles.length;
  }

  let tokensOk = true;
  let costOk = true;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let costSum = 0;

  for (const attempt of attempts) {
    const usage = attempt.usage;
    if (!isReportedTokenUsage(usage)) {
      tokensOk = false;
      costOk = false;
      // Keep scanning so a single pass classifies both aggregates.
      continue;
    }
    inputTokens += usage.input;
    outputTokens += usage.output;
    totalTokens += usage.total;
    if (!hasReportedCost(usage)) {
      costOk = false;
    } else {
      costSum += usage.cost as number;
    }
  }

  if (tokensOk) {
    out.tokenAggregate = Object.freeze({
      inputTokens,
      outputTokens,
      totalTokens,
    });
  }

  if (costOk) {
    out.costAggregate = costSum;
  }

  return Object.freeze(out);
}

function verdict(
  dimension: BudgetDimension,
  status: DimensionVerdictStatus,
  limit?: number,
  used?: number,
): DimensionVerdict {
  const v: {
    dimension: BudgetDimension;
    status: DimensionVerdictStatus;
    limit?: number;
    used?: number;
  } = { dimension, status };
  if (limit !== undefined) v.limit = limit;
  if (used !== undefined) v.used = used;
  return Object.freeze(v);
}

function compareUsage(dimension: BudgetDimension, limit: number, used: number): DimensionVerdict {
  const status: DimensionVerdictStatus = used >= limit ? 'exceeded' : 'ok';
  return verdict(dimension, status, limit, used);
}

function optionalLimitVerdict(
  dimension: BudgetDimension,
  limit: number | undefined,
  used: number | undefined,
): DimensionVerdict {
  if (limit === undefined) return verdict(dimension, 'not_in_force');
  if (used === undefined) return verdict(dimension, 'unknown', limit);
  return compareUsage(dimension, limit, used);
}

/**
 * Evaluate an ExecutionBudget against a usage snapshot.
 *
 * `budget === undefined` => every dimension `not_in_force`, no exceedances.
 * Required fields (attempts/rounds/wallClockMs) are always in force when budget exists;
 * rounds use snapshot.roundCount when present (S2), else `unknown`;
 * wallClockMs remain `unknown` (no trusted usage yet).
 * `commands` with a limit is always `unknown` until a trusted counter exists.
 */
export function evaluateExecutionBudget(
  budget: ExecutionBudget | undefined,
  snapshot: BudgetUsageSnapshot,
): BudgetEvaluation {
  if (budget === undefined) {
    const dimensions = BUDGET_DIMENSIONS.map((dimension) => verdict(dimension, 'not_in_force'));
    return Object.freeze({
      dimensions: Object.freeze(dimensions),
      anyAuthoritativeExceeded: false,
    });
  }

  const token = snapshot.tokenAggregate;
  const dimensions: DimensionVerdict[] = [
    compareUsage('attempts', budget.maxAttempts, snapshot.attemptCount),
    optionalLimitVerdict('rounds', budget.maxRounds, snapshot.roundCount),
    verdict('wallClockMs', 'unknown', budget.maxWallClockMs),
    optionalLimitVerdict('inputTokens', budget.maxInputTokens, token?.inputTokens),
    optionalLimitVerdict('outputTokens', budget.maxOutputTokens, token?.outputTokens),
    optionalLimitVerdict('totalTokens', budget.maxTotalTokens, token?.totalTokens),
    optionalLimitVerdict('cost', budget.maxCost, snapshot.costAggregate),
    optionalLimitVerdict('changedFiles', budget.maxChangedFiles, snapshot.changedFileCount),
    // S1: no trusted command counter — limit in force still yields unknown.
    budget.maxCommands === undefined
      ? verdict('commands', 'not_in_force')
      : verdict('commands', 'unknown', budget.maxCommands),
  ];

  const anyAuthoritativeExceeded = dimensions.some((d) => d.status === 'exceeded');

  return Object.freeze({
    dimensions: Object.freeze(dimensions),
    anyAuthoritativeExceeded,
  });
}

/** Lookup helper for tests and callers. */
export function verdictFor(
  evaluation: BudgetEvaluation,
  dimension: BudgetDimension,
): DimensionVerdict {
  const found = evaluation.dimensions.find((d) => d.dimension === dimension);
  if (!found) {
    throw new Error(`missing dimension verdict: ${dimension}`);
  }
  return found;
}
