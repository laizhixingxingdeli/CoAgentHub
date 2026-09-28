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
  readonly status: 'queued';
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type EnqueueHopInput = Omit<QueuedHop, 'id' | 'status' | 'createdAt' | 'updatedAt'>;

function identity(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${name} must be non-empty`);
}

function timestamp(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${name} must be a valid timestamp`);
  }
}

export function validateEnqueueHop(input: EnqueueHopInput): void {
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

export class DurableScheduler {
  readonly #repository: QueuedHopRepository;
  readonly #clock: Clock;
  readonly #ids: IdGenerator;

  constructor(repository: QueuedHopRepository, clock: Clock, ids: IdGenerator) {
    this.#repository = repository;
    this.#clock = clock;
    this.#ids = ids;
  }

  async enqueue(input: EnqueueHopInput): Promise<QueuedHop> {
    validateEnqueueHop(input);
    const now = this.#clock.now().toISOString();
    return this.#repository.enqueue({ ...input, id: this.#ids.next('HOP'), status: 'queued', createdAt: now, updatedAt: now });
  }
}

