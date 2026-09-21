/**
 * kernel 层的错误类型。
 *
 * 约定：调用方用 `instanceof` + `code` 判别，不依赖 message 全文。
 * - ILLEGAL_TRANSITION：状态机流转表之外的调用（见各聚合文件里的 *TRANSITIONS 表）。
 * - InvariantViolationError 的 code 取值集合：
 *   CONCURRENT_EXECUTOR_ATTEMPT | CONCURRENT_COORDINATOR_ATTEMPT |
 *   CONCURRENT_MUTATING_MISSION | DUPLICATE_ID |
 *   INVALID_WORK_ORDER_VALIDATION | INVALID_REVIEW_RECORD
 */

export class KernelError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/**
 * 非法状态流转。
 *
 * `entity`：'Mission' | 'WorkItem' | 'Attempt'。
 * `from`：调用时的当前状态。
 * `to`：本次调用想要的目标状态。当某个操作本身不改变状态、但要求前置状态时
 * （`startAttempt` / `startCoordinatorAttempt` / `createWorkItem` 在非法状态下调用），
 * `to` 记为该操作名。
 */
export class IllegalTransitionError extends KernelError {
  readonly entity: string;
  readonly from: string;
  readonly to: string;

  constructor(entity: string, from: string, to: string) {
    super('ILLEGAL_TRANSITION', `${entity}: ${from} -> ${to} is not allowed`);
    this.entity = entity;
    this.from = from;
    this.to = to;
  }
}

/** 跨对象不变量被破坏（不变量 B / C、并发 Attempt、重复 id）。 */
export class InvariantViolationError extends KernelError {
  constructor(code: string, message: string) {
    super(code, message);
  }
}
