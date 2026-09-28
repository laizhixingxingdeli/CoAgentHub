import type { Clock, IdGenerator, QueuedHopRepository } from './ports.ts';

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
  readonly status: 'queued' | 'claimed' | 'completed';
  readonly owner?: string;
  readonly leaseUntil?: string;
  /** Missing on legacy queued rows; interpreted as zero before the first claim. */
  readonly claimGeneration?: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type EnqueueHopInput = Omit<QueuedHop, 'id' | 'status' | 'owner' | 'leaseUntil' | 'claimGeneration' | 'createdAt' | 'updatedAt'>;

function identity(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${name} must be non-empty`);
}

function timestamp(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${name} must be a valid timestamp`);
  }
}

export function validateEnqueueHop(input: EnqueueHopInput): void {
  const runtimeInput = input as EnqueueHopInput & Record<string, unknown>;
  for (const field of ['status', 'owner', 'leaseUntil', 'claimGeneration']) {
    if (Object.hasOwn(runtimeInput, field)) throw new Error(`${field} cannot be set when enqueueing`);
  }
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
  if (Date.parse(hop.availableAt) > Date.parse(now) || hop.status === 'completed') return false;
  return hop.status === 'queued' || Date.parse(hop.leaseUntil!) <= Date.parse(now);
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

function leaseDuration(leaseMs: number): void {
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error('leaseMs must be a positive safe integer');
}

/** Shared by Orchestrator and MissionRunner; matches attempt-lease tolerance. */
export const DEFAULT_HOP_LEASE_MS = 90_000;

export function hopIdempotencyKey(input: {
  readonly missionId: string;
  readonly role: HopRole;
  readonly workItemId: string;
  readonly contractRevision: number;
  readonly attemptCycle: number;
}): string {
  return `${input.missionId}:${input.role}:${input.workItemId}:r${input.contractRevision}:n${input.attemptCycle}`;
}

function hopKeyPrefix(input: {
  readonly missionId: string;
  readonly role: HopRole;
  readonly workItemId: string;
  readonly contractRevision: number;
}): string {
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
  input: {
    readonly missionId: string;
    readonly role: HopRole;
    readonly workItemId: string;
    readonly contractRevision: number;
  },
): number {
  const prefix = hopKeyPrefix(input);
  const cycleOf = (key: string): number | undefined => {
    if (!key.startsWith(prefix)) return undefined;
    const n = Number(key.slice(prefix.length));
    return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
  };
  for (const row of rows) {
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
  | { readonly kind: 'waiting'; readonly hop: QueuedHop; readonly wait: 'available_at' | 'lease' };

/**
 * Enqueue then claim the hop that is about to run.
 *
 * Done before issuing a run token / opening an Attempt: otherwise a crash leaves
 * an in_progress Attempt with no hop lease, and a second runner can neither take
 * over this hop nor start a new Attempt (invariant B).
 */
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
  const claimed = await params.scheduler.claim(hop.id, params.owner, params.leaseMs);
  if (claimed) return { kind: 'claimed', hop: claimed };
  const latest = (await params.repository.get(hop.id)) ?? hop;
  if (latest.status === 'completed') return { kind: 'completed', hop: latest };
  if (Date.parse(latest.availableAt) > Date.parse(params.nowIso)) {
    return { kind: 'waiting', hop: latest, wait: 'available_at' };
  }
  return { kind: 'waiting', hop: latest, wait: 'lease' };
}

export function queuedHopWaitDetail(result: Extract<QueuedHopAcquireResult, { kind: 'waiting' }>): string {
  if (result.wait === 'available_at') {
    return `队列 Hop ${result.hop.id} 尚未到达 availableAt=${result.hop.availableAt}，不能启动 Agent`;
  }
  const owner = result.hop.owner ?? '(unknown)';
  const until = result.hop.leaseUntil ?? '(none)';
  return `队列 Hop ${result.hop.id} 仍有有效租约（持有者 ${owner}，到期 ${until}），等待接管，不能启动 Agent`;
}

export class DurableScheduler {
  readonly #repository: QueuedHopRepository;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;

  constructor(repository: QueuedHopRepository, clock: Clock, ids: IdGenerator) {
    this.#repository = repository;
    this.#clock = clock;
    this.#ids = ids;
  }

  async claim(id: string, owner: string, leaseMs: number): Promise<QueuedHop | undefined> {
    leaseDuration(leaseMs);
    const now = this.#clock.now();
    return this.#repository.claim(id, owner, now.toISOString(), new Date(now.getTime() + leaseMs).toISOString());
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

  async enqueue(input: EnqueueHopInput): Promise<QueuedHop> {
    validateEnqueueHop(input);
    const now = this.#clock.now().toISOString();
    return this.#repository.enqueue({ ...input, id: this.#ids.next('HOP'), status: 'queued', createdAt: now, updatedAt: now });
  }
}

