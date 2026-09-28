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
  readonly openUntil: string;
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
  readonly openUntil: string;
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
  readonly openUntil?: string;
}

function nonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${field} must be non-empty`);
}

export function validateCandidateCircuitTimestamp(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`${field} must be an ISO timestamp`);
  }
}

export function validateOpenCandidateCircuit(input: OpenCandidateCircuitInput): void {
  nonEmpty(input.profileId, 'profileId');
  nonEmpty(input.failureClass, 'failureClass');
  validateCandidateCircuitTimestamp(input.openUntil, 'openUntil');
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
    validateCandidateCircuitTimestamp(input.openUntil, 'openUntil');
  }
}

export function claimCandidateProbe(record: OpenCandidateCircuit | HalfOpenCandidateCircuit, now: string): CandidateCircuit | undefined {
  validateCandidateCircuitTimestamp(now, 'now');
  if (record.state !== 'open' || Date.parse(now) < Date.parse(record.openUntil)) return undefined;
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
  if (/\b429\b|too many requests|rate.?limit|quota|需要充值|配额|额度/i.test(message)) {
    return { failureClass: 'quota', failover: true };
  }
  if (/\b401\b|unauthori[sz]ed|authentication|鉴权|认证/i.test(message)) {
    return { failureClass: 'auth', failover: true };
  }
  if (/\b5\d\d\b|internal server error|bad gateway|service unavailable|gateway timeout/i.test(message)) {
    return { failureClass: 'upstream_5xx', failover: true };
  }
  return { failureClass: 'unknown', failover: false };
}
