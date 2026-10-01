import type { AttemptEndReason } from '../kernel/index.ts';

export type CandidateCircuitState = 'closed' | 'open' | 'half_open';

export interface ClosedCandidateCircuit {
  readonly profileId: string;
  readonly state: 'closed';
}

export interface OpenCandidateCircuit {
  readonly profileId: string;
  readonly state: 'open';
  readonly failureClass: string;
  readonly openUntil: string | null;
}

export interface HalfOpenCandidateCircuit {
  readonly profileId: string;
  readonly state: 'half_open';
  readonly failureClass: string;
  readonly openUntil: string;
  readonly probeClaimed: true;
}

export type CandidateCircuit = ClosedCandidateCircuit | OpenCandidateCircuit | HalfOpenCandidateCircuit;

export interface OpenCandidateCircuitInput {
  readonly profileId: string;
  readonly failureClass: string;
  readonly openUntil: string | null;
}

export interface ClaimCandidateProbeInput {
  readonly profileId: string;
  readonly now: string;
}

export interface ResolveCandidateProbeInput {
  readonly profileId: string;
  readonly succeeded: boolean;
  /** Required on failure; ignored on success. */
  readonly failureClass?: string;
  /** Required on failure; ignored on success. */
  readonly openUntil?: string | null;
}

function nonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${field} must be non-empty`);
}

export interface QuotaResetInput {
  readonly message?: string;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly now: string;
}

/** Returns only an explicitly supplied, valid future reset; absent information stays manual. */
export function resolveQuotaResetTime(input: QuotaResetInput): string | null {
  const now = Date.parse(input.now);
  if (!Number.isFinite(now)) return null;
  const future = (value: number): string | null => Number.isFinite(value) && value > now ? new Date(value).toISOString() : null;
  const headers = input.headers ?? {};
  const retry = Object.entries(headers).find(([key]) => key.toLowerCase() === 'retry-after')?.[1];
  if (retry !== undefined) {
    const seconds = Number(retry);
    const result = Number.isFinite(seconds) && /^\d+(?:\.\d+)?$/.test(retry.trim())
      ? future(now + seconds * 1000)
      : future(Date.parse(retry));
    if (result) return result;
  }
  const reset = Object.entries(headers).find(([key]) => key.toLowerCase() === 'x-ratelimit-reset')?.[1];
  if (reset !== undefined) {
    const value = Number(reset);
    const result = /^\d+(?:\.\d+)?$/.test(reset.trim())
      ? future(value > 1e12 ? value : value * 1000)
      : future(Date.parse(reset));
    if (result) return result;
  }
  const message = input.message ?? '';
  const relative = /try again in\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|秒|minutes?|mins?|分钟|分|hours?|hrs?|小时|时)/i.exec(message);
  if (relative) {
    const unit = relative[2].toLowerCase();
    const factor = /秒|sec/.test(unit) ? 1000 : /分|min/.test(unit) ? 60000 : 3600000;
    const result = future(now + Number(relative[1]) * factor);
    if (result) return result;
  }
  const candidates = [
    /\(\s*quota resets at\s+([^\)]+)\)/i,
    /(?:resets at|重置于)\s*([^\s,;\)]+)/i,
  ];
  for (const pattern of candidates) {
    const match = pattern.exec(message);
    if (match) {
      const result = future(Date.parse(match[1]));
      if (result) return result;
    }
  }
  return null;
}

export function validateCandidateCircuitTimestamp(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${field} must be an ISO timestamp`);
  }
}

export function validateOpenCandidateCircuit(input: OpenCandidateCircuitInput): void {
  nonEmpty(input.profileId, 'profileId');
  nonEmpty(input.failureClass, 'failureClass');
  if (input.openUntil === null) {
    if (input.failureClass !== 'quota') throw new Error('openUntil may be null only for quota');
  } else {
    validateCandidateCircuitTimestamp(input.openUntil, 'openUntil');
  }
}

export function closedCandidateCircuit(profileId: string): ClosedCandidateCircuit {
  nonEmpty(profileId, 'profileId');
  return { profileId, state: 'closed' };
}

/** Explicit non-probe failures may reopen any current state. */
export function openCandidateCircuit(input: OpenCandidateCircuitInput): OpenCandidateCircuit {
  validateOpenCandidateCircuit(input);
  return { profileId: input.profileId, state: 'open', failureClass: input.failureClass, openUntil: input.openUntil };
}

export function validateClaimCandidateProbe(input: ClaimCandidateProbeInput): void {
  nonEmpty(input.profileId, 'profileId');
  validateCandidateCircuitTimestamp(input.now, 'now');
}

export function validateResolveCandidateProbe(input: ResolveCandidateProbeInput): void {
  nonEmpty(input.profileId, 'profileId');
  if (typeof input.succeeded !== 'boolean') throw new Error('succeeded must be boolean');
  if (!input.succeeded) {
    nonEmpty(input.failureClass, 'failureClass');
    if (input.openUntil === null) {
      if (input.failureClass !== 'quota') throw new Error('openUntil may be null only for quota');
    } else {
      validateCandidateCircuitTimestamp(input.openUntil, 'openUntil');
    }
  }
}

export function claimCandidateProbe(record: OpenCandidateCircuit | HalfOpenCandidateCircuit, now: string): CandidateCircuit | undefined {
  validateCandidateCircuitTimestamp(now, 'now');
  if (record.state !== 'open' || record.openUntil === null || Date.parse(now) < Date.parse(record.openUntil)) return undefined;
  return { profileId: record.profileId, state: 'half_open', failureClass: record.failureClass, openUntil: record.openUntil, probeClaimed: true };
}

export function resolveCandidateProbe(record: CandidateCircuit | undefined, input: ResolveCandidateProbeInput): CandidateCircuit {
  validateResolveCandidateProbe(input);
  if (!record || record.profileId !== input.profileId || record.state !== 'half_open' || record.probeClaimed !== true) {
    throw new Error('candidate probe is not claimed');
  }
  if (input.succeeded) return { profileId: input.profileId, state: 'closed' };
  return { profileId: input.profileId, state: 'open', failureClass: input.failureClass!, openUntil: input.openUntil! };
}

export type CandidateFailureClassification = {
  failureClass: 'quota' | 'auth' | 'upstream_5xx' | 'killed_idle' | 'local_adapter_error' | 'unknown';
  failover: boolean;
};

export function classifyCandidateFailure(
  endedBy: AttemptEndReason,
  failureMessage?: string,
  fromRuntimeException = false,
): CandidateFailureClassification | undefined {
  if (endedBy === 'killed_idle') return { failureClass: 'killed_idle', failover: true };
  if (endedBy !== 'upstream_failure') return undefined;

  const message = failureMessage ?? '';
  const localAdapterSignal = /adapter|econnrefused|enotfound|eai_again|fetch failed|socket|connection reset/i.test(message);
  if (fromRuntimeException && localAdapterSignal) {
    return { failureClass: 'local_adapter_error', failover: false };
  }
  // 403 / forbidden alone is not quota; only these billing/credit phrases (plus existing 429/rate-limit/quota/配额) failover.
  if (/\b429\b|too many requests|rate.?limit|quota|需要充值|配额|额度|credits|subscription|billing|spending limit|usage[ _]limit|insufficient balance|insufficient_quota|余额不足|欠费/i.test(message)) {
    return { failureClass: 'quota', failover: true };
  }
  if (/\b401\b|unauthori[sz]ed|authentication|鉴权|认证/i.test(message)) {
    return { failureClass: 'auth', failover: true };
  }
  // xai 会给 "Error Code null: Internal error during token generation"：没有 5xx 数字，
  // 旧正则判 unknown / failover=false，同次运行不退避、不换候选，Mission 停在 project_busy。
  if (/\b5\d\d\b|internal server error|internal error|bad gateway|service unavailable|gateway timeout|overloaded|temporarily unavailable/i.test(message)) {
    return { failureClass: 'upstream_5xx', failover: true };
  }
  return { failureClass: 'unknown', failover: false };
}

export type CandidateFailureSource = 'circuit' | 'queue' | 'attempt.ended' | 'unknown';

export interface CandidateFailureHint {
  readonly failureClass: string;
  readonly at: string;
  readonly source: 'queue' | 'attempt.ended';
}

export interface CandidateLastFailureObservation {
  readonly failureClass: string;
  readonly at: string | null;
  readonly source: CandidateFailureSource;
  readonly unknownReason?: string;
}

function newestFailureHint(hints: readonly CandidateFailureHint[]): CandidateFailureHint | undefined {
  const dated = hints.filter((hint) => Number.isFinite(Date.parse(hint.at)));
  dated.sort((a, b) => {
    const delta = Date.parse(b.at) - Date.parse(a.at);
    if (delta !== 0) return delta;
    return a.source < b.source ? -1 : a.source > b.source ? 1 : 0;
  });
  return dated[0];
}

/**
 * Last failure class/time for a candidate. Open circuits have a class but no
 * stored time — look at queue lastFailure / attempt.ended. Closed circuits
 * with no hints are unknown, never a fabricated class or timestamp.
 */
export function resolveCandidateLastFailure(
  circuit: CandidateCircuit,
  hints: readonly CandidateFailureHint[],
): CandidateLastFailureObservation {
  const latest = newestFailureHint(hints);
  if (circuit.state !== 'closed') {
    const matching = newestFailureHint(hints.filter((hint) => hint.failureClass === circuit.failureClass));
    const timed = matching ?? latest;
    if (timed) {
      return { failureClass: circuit.failureClass, at: timed.at, source: timed.source };
    }
    return {
      failureClass: circuit.failureClass,
      at: null,
      source: 'circuit',
      unknownReason: 'circuit_open_without_failure_time',
    };
  }
  if (latest) {
    return { failureClass: latest.failureClass, at: latest.at, source: latest.source };
  }
  return {
    failureClass: 'unknown',
    at: null,
    source: 'unknown',
    unknownReason: 'no_circuit_or_attempt_failure',
  };
}
