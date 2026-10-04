import type { Clock, IdGenerator, QueuedHopCapacityRepository, QueuedHopRepository } from './ports.ts';

export type HopRole = 'coordinator' | 'executor' | 'independent_reviewer';
export type HopPriority = number;

export interface QueuedHop {
  readonly id: string;
  readonly projectId: string;
  readonly missionId: string;
  readonly workItemId: string;
  readonly role: HopRole;
  readonly priority: HopPriority;
  readonly availableAt: string;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly idempotencyKey: string;
  readonly status: 'queued' | 'claimed' | 'completed' | 'retry_wait' | 'dead_letter';
  readonly owner?: string;
  readonly leaseUntil?: string;
  /** Missing on legacy queued rows; interpreted as zero before the first claim. */
  readonly claimGeneration?: number;
  /** Last accepted failure; missing on hops that have never failed. */
  readonly lastFailure?: HopLastFailure;
  /**
   * Candidate that actually holds this lease. Absent on legacy rows, which occupy
   * global/project/role only — otherwise old snapshots would be unreadable.
   */
  readonly runtimeKind?: string;
  readonly profileId?: string;
  /**
   * Marks the hop as one impact-analysis follow-up. Only meaningful together with
   * `changeId`, and only for the coordinator role: that pair is what separates two
   * concurrent changes of the same work item, so each change gets its own slot.
   */
  readonly purpose?: 'impact';
  readonly changeId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type EnqueueHopInput = Omit<QueuedHop, 'id' | 'status' | 'owner' | 'leaseUntil' | 'claimGeneration' | 'createdAt' | 'updatedAt' | 'runtimeKind' | 'profileId' | 'lastFailure'>;

export interface HopLastFailure {
  readonly attemptId: string;
  readonly claimGeneration: number;
  readonly at: string;
  readonly classification: string;
  readonly disposition: string;
  readonly retryable: boolean;
}

export interface ReportHopFailureInput {
  readonly id: string;
  readonly claimGeneration: number;
  readonly attemptId: string;
  readonly failedAt: string;
  readonly classification: string;
  readonly disposition: string;
  readonly retryable: boolean;
}

function identity(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${name} must be non-empty`);
}

function timestamp(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${name} must be a valid timestamp`);
  }
}

/**
 * Both fields or neither: an impact hop without a changeId would collapse every
 * change onto one slot, and a changeId on a normal hop would silently split the
 * ordinary scheduler slot away from its historical key.
 */
export type HopIdentity = {
  readonly missionId: string;
  readonly role: HopRole;
  readonly workItemId: string;
  readonly contractRevision: number;
  readonly purpose?: 'impact';
  readonly changeId?: string;
};

function isImpactIdentity(input: HopIdentity): boolean {
  return input.purpose !== undefined || input.changeId !== undefined;
}

function validateHopIdentity(input: HopIdentity): void {
  if (!isImpactIdentity(input)) return;
  if (input.purpose !== 'impact') throw new Error('purpose must be impact when changeId is set');
  if (typeof input.changeId !== 'string' || input.changeId.trim().length === 0) {
    throw new Error('changeId must be a non-empty string when purpose is impact');
  }
  if (input.role !== 'coordinator') throw new Error('impact hops must use the coordinator role');
}

export function validateEnqueueHop(input: EnqueueHopInput): void {
  const runtimeInput = input as EnqueueHopInput & Record<string, unknown>;
  for (const field of ['status', 'owner', 'leaseUntil', 'claimGeneration', 'runtimeKind', 'profileId', 'lastFailure']) {
    if (Object.hasOwn(runtimeInput, field)) throw new Error(`${field} cannot be set when enqueueing`);
  }
  validateHopIdentity(input);
  identity(input.projectId, 'projectId');
  identity(input.missionId, 'missionId');
  identity(input.workItemId, 'workItemId');
  identity(input.idempotencyKey, 'idempotencyKey');
  if (!['coordinator', 'executor', 'independent_reviewer'].includes(input.role)) throw new Error('role is invalid');
  if (!Number.isSafeInteger(input.priority) || input.priority < 0) throw new Error('priority is invalid');
  timestamp(input.availableAt, 'availableAt');
  if (!Number.isSafeInteger(input.attemptCount) || input.attemptCount < 0) throw new Error('attemptCount is invalid');
  if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1 || input.attemptCount > input.maxAttempts) {
    throw new Error('maxAttempts is invalid');
  }
}

export type ClaimableHop = QueuedHop & { readonly status: 'queued' | 'claimed' };

export function canClaimHop(hop: QueuedHop, now: string): boolean {
  if (hop.status === 'completed' || hop.status === 'dead_letter') return false;
  if (Date.parse(hop.availableAt) > Date.parse(now)) return false;
  if (hop.status === 'queued' || hop.status === 'retry_wait') return true;
  if (hop.status !== 'claimed') return false;
  return Date.parse(hop.leaseUntil!) <= Date.parse(now);
}

export function claimHop(hop: QueuedHop, owner: string, now: string, leaseUntil: string): QueuedHop | undefined {
  if (!owner.trim() || !canClaimHop(hop, now) || Date.parse(leaseUntil) <= Date.parse(now)) return undefined;
  const generation = hop.claimGeneration ?? 0;
  if (!Number.isSafeInteger(generation) || generation < 0 || generation >= Number.MAX_SAFE_INTEGER) return undefined;
  return { ...hop, status: 'claimed', owner, leaseUntil, claimGeneration: generation + 1, updatedAt: now };
}

export function renewHop(hop: QueuedHop, owner: string, generation: number, now: string, leaseUntil: string): QueuedHop | undefined {
  if (hop.status !== 'claimed' || hop.owner !== owner || hop.claimGeneration !== generation ||
      Date.parse(now) >= Date.parse(hop.leaseUntil!) || Date.parse(leaseUntil) <= Date.parse(now) ||
      Date.parse(leaseUntil) <= Date.parse(hop.leaseUntil!)) return undefined;
  return { ...hop, leaseUntil, updatedAt: now };
}

export function completeHop(hop: QueuedHop, owner: string, generation: number, now: string): QueuedHop | undefined {
  if (hop.status !== 'claimed' || hop.owner !== owner || hop.claimGeneration !== generation ||
      Date.parse(now) >= Date.parse(hop.leaseUntil!)) return undefined;
  return { ...hop, status: 'completed', updatedAt: now };
}

/** 1s · 2^{n-1}, capped at 10 minutes. Callers cannot pick the delay. */
export const HOP_FAILURE_BACKOFF_BASE_MS = 1_000;
export const HOP_FAILURE_BACKOFF_CAP_MS = 600_000;

export function hopFailureBackoffMs(attemptCount: number): number {
  if (!Number.isSafeInteger(attemptCount) || attemptCount < 1) {
    throw new Error('attemptCount must be a positive safe integer');
  }
  const exp = Math.min(attemptCount - 1, 16);
  return Math.min(HOP_FAILURE_BACKOFF_CAP_MS, HOP_FAILURE_BACKOFF_BASE_MS * (2 ** exp));
}

export function validateReportHopFailure(input: unknown): asserts input is ReportHopFailureInput {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('failure report must be an object');
  }
  const record = input as Record<string, unknown>;
  for (const field of ['attemptCount', 'availableAt', 'maxAttempts', 'status']) {
    if (Object.hasOwn(record, field)) throw new Error(`${field} cannot be set when reporting failure`);
  }
  identity(record.id, 'id');
  identity(record.attemptId, 'attemptId');
  identity(record.classification, 'classification');
  identity(record.disposition, 'disposition');
  timestamp(record.failedAt, 'failedAt');
  if (!Number.isSafeInteger(record.claimGeneration) || (record.claimGeneration as number) < 0) {
    throw new Error('claimGeneration is invalid');
  }
  if (typeof record.retryable !== 'boolean') throw new Error('retryable must be a boolean');
}

function sameFailureTriple(hop: QueuedHop, input: ReportHopFailureInput): boolean {
  const last = hop.lastFailure;
  return last !== undefined
    && last.claimGeneration === input.claimGeneration
    && last.attemptId === input.attemptId;
}

/**
 * Apply one fenced failure. Same (id, claimGeneration, attemptId) replay returns
 * the same object so storage can skip the write; stale generation / non-claim
 * returns undefined. Next count and availableAt are computed here, never taken
 * from the caller — otherwise a replay could inflate attemptCount.
 */
export function reportHopFailure(hop: QueuedHop, input: ReportHopFailureInput): QueuedHop | undefined {
  validateReportHopFailure(input);
  if (hop.id !== input.id) return undefined;
  if (sameFailureTriple(hop, input)) return hop;
  if (hop.status !== 'claimed' || hop.claimGeneration !== input.claimGeneration) return undefined;
  const attemptCount = hop.attemptCount + 1;
  const lastFailure: HopLastFailure = {
    attemptId: input.attemptId,
    claimGeneration: input.claimGeneration,
    at: input.failedAt,
    classification: input.classification,
    disposition: input.disposition,
    retryable: input.retryable,
  };
  const { owner: _owner, leaseUntil: _lease, ...rest } = hop;
  if (!input.retryable || attemptCount >= hop.maxAttempts) {
    return {
      ...rest,
      status: 'dead_letter',
      attemptCount,
      lastFailure,
      updatedAt: input.failedAt,
    };
  }
  const availableAt = new Date(Date.parse(input.failedAt) + hopFailureBackoffMs(attemptCount)).toISOString();
  if (!(Date.parse(availableAt) > Date.parse(input.failedAt))) {
    throw new Error('backoff must be strictly later than the failure time');
  }
  return {
    ...rest,
    status: 'retry_wait',
    attemptCount,
    availableAt,
    lastFailure,
    updatedAt: input.failedAt,
  };
}

export function cloneQueuedHop(hop: QueuedHop): QueuedHop {
  return hop.lastFailure ? { ...hop, lastFailure: { ...hop.lastFailure } } : { ...hop };
}

/** Inputs for in-transaction claim fencing; PG reuses the same shape. */
export interface ClaimFence {
  readonly id: string;
  readonly owner: string;
  readonly claimGeneration: number;
  readonly now: string;
}

/**
 * Live claimed hop owned by this fence: matching owner and generation, now strictly before leaseUntil.
 * Missing, queued/completed, expired, or identity mismatch is false — callers must reject and roll back.
 */
export function holdsCurrentClaim(hop: QueuedHop | undefined, fence: ClaimFence): boolean {
  if (!hop || hop.id !== fence.id || hop.status !== 'claimed') return false;
  if (hop.owner !== fence.owner || hop.claimGeneration !== fence.claimGeneration) return false;
  if (typeof hop.leaseUntil !== 'string' || !Number.isFinite(Date.parse(hop.leaseUntil))) return false;
  if (!Number.isFinite(Date.parse(fence.now))) return false;
  return Date.parse(fence.now) < Date.parse(hop.leaseUntil);
}

function leaseDuration(leaseMs: number): void {
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error('leaseMs must be a positive safe integer');
}

/** Shared by Orchestrator and MissionRunner; matches attempt-lease tolerance. */
export const DEFAULT_HOP_LEASE_MS = 90_000;

const CAPACITY_DIMENSIONS = ['global', 'project', 'role', 'runtime', 'profile'] as const;
export type HopCapacityDimension = (typeof CAPACITY_DIMENSIONS)[number];

/** Positive safe-integer caps on concurrent *active* leases. */
export interface HopCapacityLimits {
  readonly global: number;
  readonly project: number;
  readonly role: number;
  readonly runtime: number;
  readonly profile: number;
}

/**
 * Explicit fail-closed defaults. Unlimited (MAX_SAFE_INTEGER) would make the
 * gate a no-op; zero is rejected as an invalid construct.
 */
export const DEFAULT_HOP_CAPACITY_LIMITS: HopCapacityLimits = Object.freeze({
  global: 8,
  project: 2,
  role: 4,
  runtime: 4,
  profile: 2,
});

/** Runtime/profile of the candidate that will actually start after this claim. */
export interface HopCapacityCandidate {
  readonly runtimeKind: string;
  readonly profileId: string;
}

/**
 * One hop this caller may start, bound to the runtime/profile that will occupy
 * capacity if that hop is claimed. Storage must not invent a hop, claim an id
 * missing from this list, or stamp another entry's identity onto this hopId.
 */
export interface EligibleHopClaim extends HopCapacityCandidate {
  readonly hopId: string;
}

export type QueuedHopWait = 'available_at' | 'lease' | 'capacity' | 'dead_letter';

/** Snapshot decision; `select` is not yet written — storage claims that row. */
export type CapacityClaimDecision =
  | { readonly kind: 'select'; readonly hop: QueuedHop; readonly candidate: HopCapacityCandidate }
  | { readonly kind: 'waiting'; readonly hop: QueuedHop; readonly wait: QueuedHopWait }
  | { readonly kind: 'empty' };

export type CapacityClaimResult =
  | { readonly kind: 'claimed'; readonly hop: QueuedHop }
  | { readonly kind: 'waiting'; readonly hop: QueuedHop; readonly wait: QueuedHopWait }
  | { readonly kind: 'empty' };

/** Inputs for the atomic cross-row capacity claim implemented by storage. */
export interface ClaimAvailableHopInput {
  readonly owner: string;
  readonly now: string;
  readonly leaseUntil: string;
  readonly limits: HopCapacityLimits;
  readonly eligible: readonly EligibleHopClaim[];
}

function positiveSafeInteger(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

export function validateHopCapacityLimits(limits: unknown): asserts limits is HopCapacityLimits {
  if (limits === null || typeof limits !== 'object' || Array.isArray(limits)) {
    throw new Error('capacity limits must be an object');
  }
  const record = limits as Record<string, unknown>;
  for (const dim of CAPACITY_DIMENSIONS) {
    positiveSafeInteger(record[dim], `capacity.${dim}`);
  }
}

export function hopCapacityLimits(limits: unknown = DEFAULT_HOP_CAPACITY_LIMITS): HopCapacityLimits {
  validateHopCapacityLimits(limits);
  return {
    global: limits.global,
    project: limits.project,
    role: limits.role,
    runtime: limits.runtime,
    profile: limits.profile,
  };
}

export function validateHopCapacityCandidate(candidate: unknown): asserts candidate is HopCapacityCandidate {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('capacity candidate must be an object');
  }
  const record = candidate as Record<string, unknown>;
  identity(record.runtimeKind, 'runtimeKind');
  identity(record.profileId, 'profileId');
}

export function validateEligibleHopClaims(eligible: unknown): asserts eligible is readonly EligibleHopClaim[] {
  if (!Array.isArray(eligible)) throw new Error('eligible hops must be an array');
  const seen = new Set<string>();
  for (const item of eligible) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('eligible hop must be an object');
    }
    const record = item as Record<string, unknown>;
    identity(record.hopId, 'hopId');
    identity(record.runtimeKind, 'runtimeKind');
    identity(record.profileId, 'profileId');
    const hopId = record.hopId;
    if (seen.has(hopId)) throw new Error(`eligible hop ${hopId} is duplicated`);
    seen.add(hopId);
  }
}

function eligibleIdentities(eligible: readonly EligibleHopClaim[]): Map<string, HopCapacityCandidate> {
  validateEligibleHopClaims(eligible);
  const identities = new Map<string, HopCapacityCandidate>();
  for (const row of eligible) {
    identities.set(row.hopId, { runtimeKind: row.runtimeKind, profileId: row.profileId });
  }
  return identities;
}

/**
 * Occupying lease: claimed and leaseUntil strictly later than `now`.
 * Equality does not occupy — same boundary as reclaim (`canClaimHop`).
 */
export function isActiveHopLease(hop: QueuedHop, now: string): boolean {
  if (hop.status !== 'claimed') return false;
  if (typeof hop.leaseUntil !== 'string' || !Number.isFinite(Date.parse(hop.leaseUntil))) return false;
  if (!Number.isFinite(Date.parse(now))) return false;
  return Date.parse(hop.leaseUntil) > Date.parse(now);
}

export const QUEUED_HOP_STATUSES = ['queued', 'claimed', 'completed', 'retry_wait', 'dead_letter'] as const;

export type QueuedHopStatusCounts = Record<(typeof QUEUED_HOP_STATUSES)[number], number>;

/** Count by persisted status. Expired claimed rows still count as claimed. */
export function countQueuedHopStatuses(hops: readonly QueuedHop[]): QueuedHopStatusCounts {
  const counts: QueuedHopStatusCounts = {
    queued: 0,
    claimed: 0,
    completed: 0,
    retry_wait: 0,
    dead_letter: 0,
  };
  for (const hop of hops) {
    if (hop.status in counts) counts[hop.status] += 1;
  }
  return counts;
}

export interface DeadLetterSummary {
  readonly hopId: string;
  readonly missionId: string;
  readonly workItemId: string;
  readonly role: HopRole;
  readonly at: string;
  readonly classification: string;
  readonly disposition?: string;
  readonly attemptId?: string;
}

/**
 * Newest-first dead-letter reasons. Missing lastFailure is classified unknown
 * rather than guessed from hop fields.
 */
export function summarizeDeadLetters(hops: readonly QueuedHop[]): DeadLetterSummary[] {
  const rows: DeadLetterSummary[] = [];
  for (const hop of hops) {
    if (hop.status !== 'dead_letter') continue;
    const last = hop.lastFailure;
    const at = last?.at ?? hop.updatedAt;
    rows.push({
      hopId: hop.id,
      missionId: hop.missionId,
      workItemId: hop.workItemId,
      role: hop.role,
      at,
      classification: last?.classification ?? 'unknown',
      ...(last?.disposition !== undefined ? { disposition: last.disposition } : {}),
      ...(last?.attemptId !== undefined ? { attemptId: last.attemptId } : {}),
    });
  }
  rows.sort((a, b) => {
    const delta = Date.parse(b.at) - Date.parse(a.at);
    if (Number.isFinite(delta) && delta !== 0) return delta;
    return a.hopId < b.hopId ? -1 : a.hopId > b.hopId ? 1 : 0;
  });
  return rows;
}

export interface HopOccupancySnapshot {
  readonly now: string;
  readonly limits: HopCapacityLimits;
  readonly activeLeases: number;
  readonly global: number;
  readonly project: Readonly<Record<string, number>>;
  readonly role: Readonly<Record<string, number>>;
  readonly runtime: Readonly<Record<string, number>>;
  readonly profile: Readonly<Record<string, number>>;
  /** Active leases that omit runtimeKind — not invented as a runtime bucket. */
  readonly runtimeUnattributed: number;
  /** Active leases that omit profileId — not invented as a profile bucket. */
  readonly profileUnattributed: number;
}

function bumpCount(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

/**
 * Five-dimension occupancy of durable active leases. Expired claimed rows do
 * not occupy. Legacy rows without runtime/profile only fill global/project/role.
 */
export function activeHopOccupancy(
  hops: readonly QueuedHop[],
  now: string,
  limits: HopCapacityLimits = DEFAULT_HOP_CAPACITY_LIMITS,
): HopOccupancySnapshot {
  validateHopCapacityLimits(limits);
  const project: Record<string, number> = {};
  const role: Record<string, number> = {};
  const runtime: Record<string, number> = {};
  const profile: Record<string, number> = {};
  let global = 0;
  let runtimeUnattributed = 0;
  let profileUnattributed = 0;
  for (const hop of hops) {
    if (!isActiveHopLease(hop, now)) continue;
    global += 1;
    bumpCount(project, hop.projectId);
    bumpCount(role, hop.role);
    if (typeof hop.runtimeKind === 'string' && hop.runtimeKind.length > 0) bumpCount(runtime, hop.runtimeKind);
    else runtimeUnattributed += 1;
    if (typeof hop.profileId === 'string' && hop.profileId.length > 0) bumpCount(profile, hop.profileId);
    else profileUnattributed += 1;
  }
  return {
    now,
    limits: hopCapacityLimits(limits),
    activeLeases: global,
    global,
    project,
    role,
    runtime,
    profile,
    runtimeUnattributed,
    profileUnattributed,
  };
}

export function activeLeaseForProfile(
  hops: readonly QueuedHop[],
  profileId: string,
  now: string,
): QueuedHop | undefined {
  return hops.find((hop) => hop.profileId === profileId && isActiveHopLease(hop, now));
}

/**
 * Higher numeric priority first; same priority is createdAt FIFO; id is a stable
 * tie-break so two stores cannot pick different heads from the same snapshot.
 */
export function compareHopFairness(a: QueuedHop, b: QueuedHop): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  const created = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (created !== 0) return created;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

function occupancyWouldExceed(
  hops: readonly QueuedHop[],
  hop: QueuedHop,
  now: string,
  limits: HopCapacityLimits,
  candidate: HopCapacityCandidate,
): boolean {
  let global = 0;
  let project = 0;
  let role = 0;
  let runtime = 0;
  let profile = 0;
  for (const row of hops) {
    if (row.id === hop.id || !isActiveHopLease(row, now)) continue;
    global += 1;
    if (row.projectId === hop.projectId) project += 1;
    if (row.role === hop.role) role += 1;
    if (row.runtimeKind === candidate.runtimeKind) runtime += 1;
    if (row.profileId === candidate.profileId) profile += 1;
  }
  return global >= limits.global
    || project >= limits.project
    || role >= limits.role
    || runtime >= limits.runtime
    || profile >= limits.profile;
}

export function hopFitsCapacity(
  hops: readonly QueuedHop[],
  hop: QueuedHop,
  now: string,
  limits: HopCapacityLimits,
  candidate: HopCapacityCandidate,
): boolean {
  validateHopCapacityLimits(limits);
  validateHopCapacityCandidate(candidate);
  return !occupancyWouldExceed(hops, hop, now, limits, candidate);
}

/**
 * Pure fair selection over a snapshot. Storage must run this inside the same
 * transaction that writes the claim — occupancy is only durable leases, never
 * an in-process counter.
 */
export function decideCapacityClaim(
  hops: readonly QueuedHop[],
  now: string,
  limits: HopCapacityLimits,
  eligible: readonly EligibleHopClaim[],
): CapacityClaimDecision {
  validateHopCapacityLimits(limits);
  const identities = eligibleIdentities(eligible);
  const claimable = hops.filter((hop) => identities.has(hop.id) && canClaimHop(hop, now)).sort(compareHopFairness);
  let blocked: QueuedHop | undefined;
  for (const hop of claimable) {
    const candidate = identities.get(hop.id)!;
    if (occupancyWouldExceed(hops, hop, now, limits, candidate)) {
      blocked ??= hop;
      continue;
    }
    return { kind: 'select', hop, candidate };
  }
  if (blocked) return { kind: 'waiting', hop: blocked, wait: 'capacity' };
  const considered = hops.filter((hop) => identities.has(hop.id));
  const leased = considered.filter((hop) => isActiveHopLease(hop, now)).sort(compareHopFairness)[0];
  if (leased) return { kind: 'waiting', hop: leased, wait: 'lease' };
  const delayed = considered
    .filter((hop) => hop.status !== 'completed' && hop.status !== 'dead_letter'
      && Date.parse(hop.availableAt) > Date.parse(now))
    .sort(compareHopFairness)[0];
  if (delayed) return { kind: 'waiting', hop: delayed, wait: 'available_at' };
  return { kind: 'empty' };
}

/** Stamp the starting candidate so later occupancy can count runtime/profile. */
export function claimHopWithCandidate(
  hop: QueuedHop,
  owner: string,
  now: string,
  leaseUntil: string,
  candidate: HopCapacityCandidate,
): QueuedHop | undefined {
  validateHopCapacityCandidate(candidate);
  const claimed = claimHop(hop, owner, now, leaseUntil);
  if (!claimed) return undefined;
  return { ...claimed, runtimeKind: candidate.runtimeKind, profileId: candidate.profileId };
}

export function hopIdempotencyKey(input: HopIdentity & {
  readonly attemptCycle: number;
}): string {
  validateHopIdentity(input);
  // JSON.stringify, not bare `:`-joining: a changeId carrying the separator would
  // otherwise forge another change's key (e.g. 'a:b' vs 'a' + ':b').
  if (isImpactIdentity(input)) {
    return `impact:${JSON.stringify([input.missionId, input.role, input.workItemId, input.contractRevision, input.changeId])}:n${input.attemptCycle}`;
  }
  return `${input.missionId}:${input.role}:${input.workItemId}:r${input.contractRevision}:n${input.attemptCycle}`;
}

function hopKeyPrefix(input: HopIdentity): string {
  if (isImpactIdentity(input)) {
    return `impact:${JSON.stringify([input.missionId, input.role, input.workItemId, input.contractRevision, input.changeId])}:n`;
  }
  return `${input.missionId}:${input.role}:${input.workItemId}:r${input.contractRevision}:n`;
}

/**
 * Slot for the hop that is about to run.
 *
 * Must NOT track Attempt count: a crash after startAttempt leaves an extra
 * in_progress (or later interrupted) Attempt, and bumping the key would enqueue
 * a sibling instead of finding the live claimed/queued row. Unfinished logical
 * hops reuse the open row; only completed rows free the next slot so a later
 * independent hop is not blocked by the old key.
 */
export function nextLogicalHopCycle(
  rows: readonly QueuedHop[],
  input: HopIdentity,
): number {
  validateHopIdentity(input);
  const prefix = hopKeyPrefix(input);
  const cycleOf = (key: string): number | undefined => {
    if (!key.startsWith(prefix)) return undefined;
    const n = Number(key.slice(prefix.length));
    return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
  };
  for (const row of rows) {
    // retry_wait / dead_letter keep the slot so a sibling hop cannot sneak in.
    if (row.status === 'completed') continue;
    const cycle = cycleOf(row.idempotencyKey);
    if (cycle !== undefined) return cycle;
  }
  let next = 0;
  for (const row of rows) {
    if (row.status !== 'completed') continue;
    const cycle = cycleOf(row.idempotencyKey);
    if (cycle !== undefined && cycle + 1 > next) next = cycle + 1;
  }
  return next;
}

export type QueuedHopAcquireResult =
  | { readonly kind: 'claimed'; readonly hop: QueuedHop }
  | { readonly kind: 'completed'; readonly hop: QueuedHop }
  | { readonly kind: 'waiting'; readonly hop: QueuedHop; readonly wait: QueuedHopWait };

/**
 * Enqueue then claim the hop that is about to run.
 *
 * Done before issuing a run token / opening an Attempt: otherwise a crash leaves
 * an in_progress Attempt with no hop lease, and a second runner can neither take
 * over this hop nor start a new Attempt (invariant B).
 */
/**
 * Dead-letter and not-yet-due backoff must surface as waits, never as a live
 * lease. Mislabeling them `lease` lets capacity/single-id callers retry or skip
 * the slot as if someone still held it.
 */
export function parkedQueuedHopWait(
  hop: QueuedHop,
  nowIso: string,
): Extract<QueuedHopAcquireResult, { kind: 'waiting' }> | undefined {
  if (hop.status === 'dead_letter') return { kind: 'waiting', hop, wait: 'dead_letter' };
  if (hop.status === 'completed') return undefined;
  if (Date.parse(hop.availableAt) > Date.parse(nowIso)) {
    return { kind: 'waiting', hop, wait: 'available_at' };
  }
  return undefined;
}

export async function acquireQueuedHop(params: {
  readonly scheduler: DurableScheduler;
  readonly repository: QueuedHopRepository;
  readonly input: EnqueueHopInput;
  readonly owner: string;
  readonly leaseMs: number;
  readonly nowIso: string;
}): Promise<QueuedHopAcquireResult> {
  const hop = await params.scheduler.enqueue(params.input);
  if (hop.status === 'completed') return { kind: 'completed', hop };
  const parked = parkedQueuedHopWait(hop, params.nowIso);
  if (parked) return parked;
  const claimed = await params.scheduler.claim(hop.id, params.owner, params.leaseMs);
  if (claimed) return { kind: 'claimed', hop: claimed };
  const latest = (await params.repository.get(hop.id)) ?? hop;
  if (latest.status === 'completed') return { kind: 'completed', hop: latest };
  const parkedLatest = parkedQueuedHopWait(latest, params.nowIso);
  if (parkedLatest) return parkedLatest;
  return { kind: 'waiting', hop: latest, wait: 'lease' };
}

export function queuedHopWaitDetail(result: Extract<QueuedHopAcquireResult, { kind: 'waiting' }>): string {
  if (result.wait === 'dead_letter') {
    const last = result.hop.lastFailure;
    const why = last
      ? `分类 ${last.classification}，处置 ${last.disposition}，尝试 ${last.attemptId}`
      : '无失败记录';
    return `队列 Hop ${result.hop.id} 已死信（${why}，count=${result.hop.attemptCount}/${result.hop.maxAttempts}），不能启动 Agent`;
  }
  if (result.wait === 'available_at') {
    if (result.hop.status === 'retry_wait') {
      return `队列 Hop ${result.hop.id} 失败后退避中，availableAt=${result.hop.availableAt}，count=${result.hop.attemptCount}/${result.hop.maxAttempts}，不能启动 Agent`;
    }
    return `队列 Hop ${result.hop.id} 尚未到达 availableAt=${result.hop.availableAt}，不能启动 Agent`;
  }
  if (result.wait === 'capacity') {
    return `队列 Hop ${result.hop.id} 受并发容量限制，不能启动 Agent`;
  }
  const owner = result.hop.owner ?? '(unknown)';
  const until = result.hop.leaseUntil ?? '(none)';
  return `队列 Hop ${result.hop.id} 仍有有效租约（持有者 ${owner}，到期 ${until}），等待接管，不能启动 Agent`;
}

export class DurableScheduler {
  readonly #repository: QueuedHopRepository;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;
  readonly #limits: HopCapacityLimits;

  constructor(
    repository: QueuedHopRepository,
    clock: Clock,
    ids: IdGenerator,
    limits: HopCapacityLimits = DEFAULT_HOP_CAPACITY_LIMITS,
  ) {
    this.#repository = repository;
    this.#clock = clock;
    this.#ids = ids;
    // Reject bad caps before enqueue/claim can touch storage.
    this.#limits = hopCapacityLimits(limits);
  }

  async claim(id: string, owner: string, leaseMs: number): Promise<QueuedHop | undefined> {
    leaseDuration(leaseMs);
    const now = this.#clock.now();
    return this.#repository.claim(id, owner, now.toISOString(), new Date(now.getTime() + leaseMs).toISOString());
  }

  /**
   * Fair capacity claim. Storage must evaluate occupancy and skip inside one
   * transaction; this entry only supplies clock, lease, and already-validated limits.
   */
  async claimAvailable(owner: string, leaseMs: number, eligible: readonly EligibleHopClaim[]): Promise<CapacityClaimResult> {
    leaseDuration(leaseMs);
    validateEligibleHopClaims(eligible);
    const repo = this.#repository as QueuedHopCapacityRepository;
    if (typeof repo.claimAvailable !== 'function') {
      throw new Error('queued hop repository does not support capacity claim');
    }
    const now = this.#clock.now();
    return repo.claimAvailable({
      owner,
      now: now.toISOString(),
      leaseUntil: new Date(now.getTime() + leaseMs).toISOString(),
      limits: this.#limits,
      eligible,
    });
  }

  async renew(id: string, owner: string, claimGeneration: number, leaseMs: number): Promise<QueuedHop> {
    leaseDuration(leaseMs);
    const now = this.#clock.now();
    const result = await this.#repository.renew(id, owner, claimGeneration, now.toISOString(), new Date(now.getTime() + leaseMs).toISOString());
    if (!result) throw new Error('claim cannot be renewed');
    return result;
  }

  async complete(id: string, owner: string, claimGeneration: number): Promise<QueuedHop> {
    const result = await this.#repository.complete(id, owner, claimGeneration, this.#clock.now().toISOString());
    if (!result) throw new Error('claim cannot be completed');
    return result;
  }

  async reportFailure(input: ReportHopFailureInput): Promise<QueuedHop> {
    validateReportHopFailure(input);
    const repo = this.#repository;
    if (typeof repo.reportFailure !== 'function') {
      throw new Error('queued hop repository does not support failure reporting');
    }
    const result = await repo.reportFailure(input);
    if (!result) throw new Error('failure cannot be reported');
    return result;
  }

  async enqueue(input: EnqueueHopInput): Promise<QueuedHop> {
    validateEnqueueHop(input);
    const now = this.#clock.now().toISOString();
    return this.#repository.enqueue({ ...input, id: this.#ids.next('HOP'), status: 'queued', createdAt: now, updatedAt: now });
  }
}

