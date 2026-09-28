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

