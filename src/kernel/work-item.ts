import { IllegalTransitionError, InvariantViolationError } from './errors.ts';
import { Attempt } from './attempt.ts';
import { freezePayload } from './payloads.ts';
import type { AttemptSnapshot, WorkItemSnapshot } from './snapshot.ts';
import type {
  BlockedRecord,
  ExecutionResultBody,
  ReviewRecord,
  WorkOrder,
} from './payloads.ts';

export type WorkItemStatus =
  | 'created'
  | 'dispatched'
  | 'submitted'
  | 'accepted'
  | 'rejected'
  | 'blocked';

/**
 * WorkItem 流转表。
 *
 * 注意 accepted 只能从 submitted 进来，而 submitted 只能由 `submit()` 产生
 * （不变量 A）。本模型没有「失败的 WorkItem」状态：Attempt 失败只是这一次
 * 尝试没成，WorkItem 停在 dispatched 可再试。
 */
const WORK_ITEM_TRANSITIONS: Record<WorkItemStatus, readonly WorkItemStatus[]> = {
  created: ['dispatched'],
  dispatched: ['submitted', 'blocked'],
  submitted: ['accepted', 'rejected'],
  // accepted -> dispatched：**L3 打回时重新打开**。
  //
  // 早先 accepted 是终态，于是协调者被打回后只能为同一条意见另开新工作项——
  // 实测一次滚出三个工作项、七跳、$2.31。L3 说"这份交付不行"时，
  // 组成它的那些验收本来就是暂时的。
  //
  // 不变量 A 不受影响：**到达** accepted 的路依然只有 review('accept') 一条。
  accepted: ['dispatched'],
  rejected: ['dispatched'],
  // 上游把工单修好之后可以重新派发。blocked 不是终态——它是"这张工单
  // 本身不成立，需要有人改它"。
  blocked: ['dispatched'],
};

export interface WorkItemInit {
  id: string;
  missionId: string;
  title: string;
  /** 工单正文。缺省表示只有标题（老测试走这条路）。 */
  order?: WorkOrder;
  /**
   * 拆出这个工作项时，规划是第几版（S05.2）。
   *
   * **必须冻在工作项上。** 规划会随证据变化；改到 r3 之后，没人能说出 r1 时
   * 拆的那个工单当初依据的是什么——读到的永远是当前那版。L3 检视时问
   * "这个工作项凭什么这么拆"，答案会是错的，而且看不出错。
   */
  planRevision?: number;
}

export type ReviewVerdict = 'accept' | 'reject';

/**
 * 一个工作项。只能由 `Mission.createWorkItem()` 创建，初始状态 `created`。
 */
export class WorkItem {
  #id: string;
  #missionId: string;
  #title: string;
  #status: WorkItemStatus = 'created';
  #attempts: Attempt[] = [];
  #executorSeq = 0;
  #result: unknown;
  #submitted = false;
  #order: Readonly<WorkOrder> | undefined;
  #reviews: Readonly<ReviewRecord>[] = [];
  #blocked: Readonly<BlockedRecord> | undefined;
  #planRevision: number | undefined;

  constructor(init: WorkItemInit) {
    this.#id = init.id;
    this.#missionId = init.missionId;
    this.#title = init.title;
    this.#planRevision = init.planRevision;
    if (init.order) {
      this.#order = freezePayload({ ...init.order });
    }
  }

  /** 拆出它时规划是第几版（S05.2）。冻住，之后规划怎么改都不动。 */
  get planRevision(): number | undefined {
    return this.#planRevision;
  }

  get id(): string {
    return this.#id;
  }

  get missionId(): string {
    return this.#missionId;
  }

  get title(): string {
    return this.#title;
  }

  get status(): WorkItemStatus {
    return this.#status;
  }

  /** 只读副本：外部 push/splice 影响不到聚合内部。 */
  get attempts(): readonly Attempt[] {
    return [...this.#attempts];
  }

  /** `submit()` 带来的产物，未提交时为 undefined。 */
  get result(): unknown {
    return this.#result;
  }

  get hasResult(): boolean {
    return this.#submitted;
  }

  /** `created` / `rejected` / `blocked` / `accepted`（被 L3 打回后重开）都可以再派发。 */
  dispatch(): void {
    this.#goto('dispatched');
  }

  /**
   * 开一次执行者尝试。仅允许在 `dispatched` 上调用；
   * 已有 in_progress attempt 时抛 CONCURRENT_EXECUTOR_ATTEMPT（不变量 B 的
   * WorkItem 侧对应物）。调用后 WorkItem 状态不变——开尝试不是流转。
   */
  startAttempt(): Attempt {
    if (this.#status !== 'dispatched') {
      throw new IllegalTransitionError('WorkItem', this.#status, 'startAttempt');
    }
    if (this.#hasInProgressAttempt()) {
      throw new InvariantViolationError(
        'CONCURRENT_EXECUTOR_ATTEMPT',
        `WorkItem ${this.#id} already has an in_progress attempt`,
      );
    }
    this.#executorSeq += 1;
    // id 必须在 **Mission 内**唯一，不只是在本 WorkItem 内。
    // 早先是裸 `exec-${n}`，于是两个工作项各有一个 exec-1；平台按
    // (missionId, attemptId) 查 attempt 时只会找到第一个，第二个工作项的
    // 工具调用就被悄悄记到了第一个工作项的尝试上。
    // 分隔符用 `.` 不用 `/`：attempt id 要进 URL 路径，带斜杠会把路由切碎。
    const attempt = new Attempt({
      id: `${this.#id}.exec-${this.#executorSeq}`,
      kind: 'executor',
      missionId: this.#missionId,
      workItemId: this.#id,
    });
    this.#attempts.push(attempt);
    return attempt;
  }

  /**
   * 执行者交付产物。仅 `dispatched` -> `submitted`。
   * 这里绝不进入 accepted（不变量 A），也不要求 Attempt 已经 succeed——
   * 交付判定与尝试判定是解耦的两件事。
   */
  submit(result?: unknown): void {
    this.#goto('submitted');
    this.#result = result;
    this.#submitted = true;
  }

  /** 验收。仅 `submitted` -> `accepted` / `rejected`；在 dispatched 上调用必须抛错。 */
  review(verdict: ReviewVerdict, record?: Omit<ReviewRecord, 'verdict'>): void {
    if (verdict !== 'accept' && verdict !== 'reject') {
      throw new IllegalTransitionError('WorkItem', this.#status, String(verdict));
    }
    this.#goto(verdict === 'accept' ? 'accepted' : 'rejected');
    if (record) {
      this.#reviews.push(freezePayload({ ...record, verdict }));
    }
  }

  /* --------------------------- 载荷（非状态） --------------------------- */

  get order(): Readonly<WorkOrder> | undefined {
    return this.#order;
  }

  /** 每次验收留一条；被打回重做的工作项会有多条。 */
  get reviews(): readonly Readonly<ReviewRecord>[] {
    return [...this.#reviews];
  }

  get blocked(): Readonly<BlockedRecord> | undefined {
    return this.#blocked;
  }

  /** 已提交时返回结构化执行结果。 */
  get executionResult(): Readonly<ExecutionResultBody> | undefined {
    return this.#submitted
      ? (this.#result as Readonly<ExecutionResultBody> | undefined)
      : undefined;
  }

  /**
   * 执行者报告工单不成立。
   *
   * **这是一次真流转**：`dispatched -> blocked`。早先的版本只记载荷、
   * 让工作项留在 dispatched，结果调度器看到它还"在途"，立刻又派一个执行者
   * 去做同一张不成立的工单——换个人做不会产生任何新信息，只会把候选池烧完。
   * 离开 dispatched，控制权才回得到上游。
   */
  recordBlocked(record: BlockedRecord): void {
    this.#goto('blocked');
    this.#blocked = freezePayload({ ...record });
  }

  /* --------------------------- 快照 --------------------------- */

  toSnapshot(): WorkItemSnapshot {
    return {
      id: this.#id,
      missionId: this.#missionId,
      title: this.#title,
      status: this.#status,
      order: this.#order,
      planRevision: this.#planRevision,
      result: this.#result,
      submitted: this.#submitted,
      reviews: [...this.#reviews],
      blocked: this.#blocked,
      attempts: this.#attempts.map((attempt) => attempt.toSnapshot()),
      executorSeq: this.#executorSeq,
    };
  }

  /** 直接装配历史状态，不重放动作、不重新校验流转。 */
  static restore(snapshot: WorkItemSnapshot): WorkItem {
    const item = new WorkItem({
      id: snapshot.id,
      missionId: snapshot.missionId,
      title: snapshot.title,
    });
    item.#status = snapshot.status as WorkItemStatus;
    item.#order = snapshot.order as Readonly<WorkOrder> | undefined;
    item.#planRevision = snapshot.planRevision;
    item.#result = snapshot.result;
    item.#submitted = snapshot.submitted;
    item.#reviews = (snapshot.reviews ?? []) as Readonly<ReviewRecord>[];
    item.#blocked = snapshot.blocked as Readonly<BlockedRecord> | undefined;
    item.#attempts = (snapshot.attempts ?? []).map((a: AttemptSnapshot) => Attempt.restore(a));
    item.#executorSeq = snapshot.executorSeq ?? 0;
    return item;
  }

  #hasInProgressAttempt(): boolean {
    return this.#attempts.some((attempt) => attempt.status === 'in_progress');
  }

  #goto(to: WorkItemStatus): void {
    if (!WORK_ITEM_TRANSITIONS[this.#status].includes(to)) {
      throw new IllegalTransitionError('WorkItem', this.#status, to);
    }
    this.#status = to;
  }
}
