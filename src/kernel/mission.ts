import { IllegalTransitionError, InvariantViolationError } from './errors.ts';
import { Attempt } from './attempt.ts';
import { WorkItem } from './work-item.ts';
import type { Project } from './project.ts';
import type { WorkItemInit } from './work-item.ts';
import { freezePayload } from './payloads.ts';
import type { AttemptSnapshot, MissionSnapshot, WorkItemSnapshot } from './snapshot.ts';
import type {
  EscalationBody,
  FinalReview,
  WaitReason,
  WorkspaceRef,
  MissionContract,
  MissionResultBody,
  OriginChannel,
  PlanBody,
  WorkOrder,
} from './payloads.ts';

export type MissionStatus =
  | 'investigating'
  | 'planning'
  | 'executing'
  /** 协调者交卷了，等 L3 最终检视。**这时改动还没落地。** */
  | 'awaiting_review'
  | 'completed'
  | 'blocked';

/**
 * Mission 流转表。`completed` / `blocked` 是终态，没有任何出边。
 * `executing -> planning` 表示协调者退回规划，同时也是释放不变量 C 占用的方式之一。
 *
 * **没有任何状态能直接跳到 completed**：只有 L3 检视过才算完成。协调者交卷
 * 只把 Mission 推到 awaiting_review。早先的版本让交卷直接 complete，
 * 于是改动还躺在未合并的分支上，名额就已经放了——下一条 Mission 会从
 * 看不见这些改动的基线上分叉，两边迟早撞车。
 *
 * `investigating -> awaiting_review` 与 `planning -> awaiting_review` 是刻意
 * 允许的：「查完发现不用改代码」是个正常结局，它同样该由 L3 过目。
 */
const MISSION_TRANSITIONS: Record<MissionStatus, readonly MissionStatus[]> = {
  investigating: ['planning', 'executing', 'awaiting_review', 'blocked'],
  planning: ['executing', 'awaiting_review', 'blocked'],
  executing: ['planning', 'awaiting_review', 'blocked'],
  // L3 检视的三种出口：放行落地 / 打回重来 / 放弃。
  awaiting_review: ['completed', 'planning', 'blocked'],
  completed: [],
  blocked: [],
};

export interface MissionInit {
  id: string;
  projectId: string;
  /** 不变量 C 的内存边界；由 `Project.createMission()` 注入。 */
  project: Project;
  /** L3 交下来的契约。缺省表示还没定契约。 */
  contract?: MissionContract;
  /** Mission 从哪个 Host/会话发起；结果最终回到这里。 */
  origin?: OriginChannel;
}

/**
 * 一个 Mission。只能通过 `Project.createMission()` 创建，初始状态 `investigating`。
 */
export class Mission {
  #id: string;
  #projectId: string;
  #project: Project;
  #status: MissionStatus = 'investigating';
  #workItems: WorkItem[] = [];
  #coordinatorAttempts: Attempt[] = [];
  #coordinatorSeq = 0;
  #contract: Readonly<MissionContract> | undefined;
  #contractRevision = 0;
  #plan: Readonly<PlanBody> | undefined;
  #planRevision = 0;
  #result: Readonly<MissionResultBody> | undefined;
  #escalations: Readonly<EscalationBody>[] = [];
  #origin: Readonly<OriginChannel> | undefined;
  #hasMutated = false;
  #workspaceRef: Readonly<WorkspaceRef> | undefined;
  #finalReview: Readonly<FinalReview> | undefined;
  #waitReason: WaitReason | undefined;
  #waitDetail: string | undefined;
  #paused = false;

  constructor(init: MissionInit) {
    this.#id = init.id;
    this.#projectId = init.projectId;
    this.#project = init.project;
    if (init.origin) {
      this.#origin = freezePayload({ ...init.origin });
    }
    if (init.contract) {
      this.#contract = freezePayload({ ...init.contract });
      this.#contractRevision = 1;
    }
  }

  get id(): string {
    return this.#id;
  }

  get projectId(): string {
    return this.#projectId;
  }

  get status(): MissionStatus {
    return this.#status;
  }

  /**
   * 是否正占用 Project 的改动名额。
   *
   * 判据是"**动过代码且还没走到终态**"，不是"此刻正在 executing"。
   * 一旦开始改代码，分支上就有了未合并的改动；在它落地或被放弃之前，
   * 别的 Mission 从旧基线分叉出去就是在制造冲突——哪怕本 Mission
   * 此刻退回了 planning、或正在等 L3 检视。
   */
  get isMutating(): boolean {
    return this.#hasMutated && !this.#isTerminal();
  }

  /** 这条 Mission 是否动过代码（进过 executing）。 */
  get hasMutated(): boolean {
    return this.#hasMutated;
  }

  get workItems(): readonly WorkItem[] {
    return [...this.#workItems];
  }

  get coordinatorAttempts(): readonly Attempt[] {
    return [...this.#coordinatorAttempts];
  }

  startPlanning(): void {
    this.#goto('planning');
  }

  /**
   * 进入 executing。先校验流转（终态 / 已在 executing 抛 IllegalTransitionError），
   * 再校验不变量 C（同 Project 内已有别的 executing Mission 时抛
   * CONCURRENT_MUTATING_MISSION），两步都在改动自身状态之前完成——
   * 被拒绝的调用不会留下半个流转。
   */
  startExecuting(): void {
    this.#assertCanGoTo('executing');
    if (this.#project.hasOtherMutatingMission(this.#id)) {
      throw new InvariantViolationError(
        'CONCURRENT_MUTATING_MISSION',
        `Project ${this.#projectId} already has a mission in executing state`,
      );
    }
    this.#status = 'executing';
    this.#hasMutated = true;
  }

  /** 协调者交卷，转入 L3 最终检视。改动尚未落地，名额仍然握着。 */
  submitForReview(): void {
    this.#goto('awaiting_review');
  }

  /**
   * L3 放行：改动已落地，Mission 完成，名额释放。
   * 只能从 awaiting_review 来——没经过检视的东西不算完成。
   */
  complete(review?: FinalReview): void {
    this.#goto('completed');
    if (review) this.#finalReview = freezePayload({ ...review });
  }

  /** L3 打回：交回协调者重做。名额不放——分支上的改动还在。 */
  sendBackToPlanning(review: FinalReview): void {
    this.#goto('planning');
    this.#finalReview = freezePayload({ ...review });
  }

  /**
   * 被人叫停。
   *
   * 和 block 的区别只在语义上：blocked 是"做不下去了"，cancelled 是
   * "不做了"。两者都是终态、都释放名额，所以共用同一个状态，靠
   * waitReason 区分——S06.1 说的就是别为每种原因都新造一个状态。
   */
  cancel(): void {
    this.#goto('blocked');
    this.#waitReason = 'cancelled_by_user';
    this.#waitDetail = undefined;
  }

  /**
   * 暂停 / 继续。
   *
   * **不是状态流转**：暂停的 Mission 还在它原来的阶段，只是调度器不碰它。
   * 做成流转的话，"暂停时它在 executing 还是 planning"这个信息就没了，
   * 恢复时无从下手。
   */
  get isPaused(): boolean {
    return this.#paused;
  }

  pause(): void {
    if (this.#isTerminal()) {
      throw new IllegalTransitionError('Mission', this.#status, 'pause');
    }
    this.#paused = true;
  }

  resume(): void {
    this.#paused = false;
  }

  block(review?: FinalReview): void {
    this.#goto('blocked');
    if (review) this.#finalReview = freezePayload({ ...review });
  }

  /* --------------------------- 停机原因 --------------------------- */

  /**
   * 为什么停着。
   *
   * S06.1：**不要把"在哪一阶段"和"为什么不动"揉成几十个互斥状态**。
   * 阶段是 status 那一条轴；这里是第二条轴——同样是 executing，
   * "正在跑"和"候选全都限流了"是完全不同的两回事，而界面上分不出来的话，
   * 人只能去翻日志。
   */
  get waitReason(): WaitReason | undefined {
    return this.#waitReason;
  }

  /**
   * 停机原因的**具体一句**：卡在谁身上、最近一次失败是什么、该怎么办。
   *
   * 上面那个枚举不够用。`no_available_agent` 只说明"停了"，说不出停在
   * 哪个候选、也说不出要等多久——那句话必须跟着状态一起存下来，否则
   * 只有算出它的那个进程知道，常驻界面上永远看不到。
   */
  get waitDetail(): string | undefined {
    return this.#waitDetail;
  }

  /** 记下停机原因。传 undefined 表示又动起来了。 */
  setWaitReason(reason: WaitReason | undefined, detail?: string): void {
    this.#waitReason = reason;
    // 原因清掉时详情必须一起清，不然界面上会挂着一句过期的解释。
    this.#waitDetail = reason ? detail : undefined;
  }

  get finalReview(): Readonly<FinalReview> | undefined {
    return this.#finalReview;
  }

  /** 本 Mission 的分支与分叉基线。落地时要用它核对目标有没有动过。 */
  get workspaceRef(): Readonly<WorkspaceRef> | undefined {
    return this.#workspaceRef;
  }

  recordWorkspace(ref: WorkspaceRef): void {
    this.#workspaceRef = freezePayload({ ...ref });
  }

  /**
   * 开一次协调者尝试（不变量 B：同一 Mission 同一时刻只能有一个 in_progress）。
   * 不改变 Mission 状态；终态上直接抛 IllegalTransitionError。
   */
  startCoordinatorAttempt(): Attempt {
    if (this.#isTerminal()) {
      throw new IllegalTransitionError('Mission', this.#status, 'startCoordinatorAttempt');
    }
    if (this.#hasInProgressCoordinatorAttempt()) {
      throw new InvariantViolationError(
        'CONCURRENT_COORDINATOR_ATTEMPT',
        `Mission ${this.#id} already has an in_progress coordinator attempt`,
      );
    }
    this.#coordinatorSeq += 1;
    const attempt = new Attempt({
      id: `coord-${this.#coordinatorSeq}`,
      kind: 'coordinator',
      missionId: this.#id,
    });
    this.#coordinatorAttempts.push(attempt);
    return attempt;
  }

  /** 在本 Mission 下建 WorkItem；终态上拒绝，id 在本 Mission 内必须唯一。 */
  createWorkItem(
    init: Pick<WorkItemInit, 'id' | 'title'> & { order?: WorkOrder },
  ): WorkItem {
    if (this.#isTerminal()) {
      throw new IllegalTransitionError('Mission', this.#status, 'createWorkItem');
    }
    if (this.#workItems.some((item) => item.id === init.id)) {
      throw new InvariantViolationError(
        'DUPLICATE_ID',
        `WorkItem id ${init.id} already exists in mission ${this.#id}`,
      );
    }
    const item = new WorkItem({
      id: init.id,
      missionId: this.#id,
      title: init.title,
      order: init.order,
      // 冻住"拆它时规划是第几版"（S05.2）。规划之后怎么改，这个都不动。
      planRevision: this.#planRevision,
    });
    this.#workItems.push(item);
    return item;
  }

  /* --------------------------- 载荷（非状态） --------------------------- */

  get origin(): Readonly<OriginChannel> | undefined {
    return this.#origin;
  }

  get contract(): Readonly<MissionContract> | undefined {
    return this.#contract;
  }

  get contractRevision(): number {
    return this.#contractRevision;
  }

  get plan(): Readonly<PlanBody> | undefined {
    return this.#plan;
  }

  get planRevision(): number {
    return this.#planRevision;
  }

  get result(): Readonly<MissionResultBody> | undefined {
    return this.#result;
  }

  get escalations(): readonly Readonly<EscalationBody>[] {
    return [...this.#escalations];
  }

  /** L3 发布新契约。终态上拒绝。每次调用都产生新的 contractRevision。 */
  reviseContract(contract: MissionContract): number {
    if (this.#isTerminal()) {
      throw new IllegalTransitionError('Mission', this.#status, 'reviseContract');
    }
    this.#contract = freezePayload({ ...contract });
    this.#contractRevision += 1;
    return this.#contractRevision;
  }

  /** 协调者把调查结论写回。终态上拒绝。每次调用都产生新的 planRevision。 */
  updatePlan(plan: PlanBody): number {
    if (this.#isTerminal()) {
      throw new IllegalTransitionError('Mission', this.#status, 'updatePlan');
    }
    this.#plan = freezePayload({ ...plan });
    this.#planRevision += 1;
    return this.#planRevision;
  }

  /**
   * 记录 Mission 结果。这不改变 Mission 状态——落地与否由 L3 决定，
   * 协调者只是交卷。
   */
  recordResult(result: MissionResultBody): void {
    if (this.#isTerminal()) {
      throw new IllegalTransitionError('Mission', this.#status, 'recordResult');
    }
    this.#result = freezePayload({ ...result });
  }

  recordEscalation(escalation: EscalationBody): void {
    this.#escalations.push(freezePayload({ ...escalation }));
  }

  /** 还没被 L3 答复的升级。有就说明不该再把协调者叫起来。 */
  get openEscalations(): readonly Readonly<EscalationBody>[] {
    return this.#escalations.filter((item) => !item.answer);
  }

  /** L3 答复最早那条未答复的升级。 */
  answerEscalation(answer: string, at: string): Readonly<EscalationBody> {
    const index = this.#escalations.findIndex((item) => !item.answer);
    if (index < 0) {
      throw new IllegalTransitionError('Mission', this.#status, 'answerEscalation');
    }
    const answered = freezePayload({ ...this.#escalations[index], answer, answeredAt: at });
    this.#escalations[index] = answered;
    return answered;
  }

  /** 最近一次留下了续跑句柄的协调者尝试。 */
  latestCoordinatorResumeRef(): string | undefined {
    for (let i = this.#coordinatorAttempts.length - 1; i >= 0; i -= 1) {
      const ref = this.#coordinatorAttempts[i].resumeRef;
      if (ref) return ref;
    }
    return undefined;
  }

  /** 找 WorkItem；找不到返回 undefined，由上层决定怎么报错。 */
  workItem(id: string): WorkItem | undefined {
    return this.#workItems.find((item) => item.id === id);
  }

  /** 找 Attempt（协调者的或任一 WorkItem 下执行者的）。 */
  attempt(id: string): Attempt | undefined {
    const own = this.#coordinatorAttempts.find((a) => a.id === id);
    if (own) return own;
    for (const item of this.#workItems) {
      const found = item.attempts.find((a) => a.id === id);
      if (found) return found;
    }
    return undefined;
  }

  /* --------------------------- 快照 --------------------------- */

  toSnapshot(): MissionSnapshot {
    return {
      id: this.#id,
      projectId: this.#projectId,
      status: this.#status,
      contract: this.#contract,
      contractRevision: this.#contractRevision,
      plan: this.#plan,
      planRevision: this.#planRevision,
      result: this.#result,
      escalations: [...this.#escalations],
      origin: this.#origin,
      hasMutated: this.#hasMutated,
      workspaceRef: this.#workspaceRef,
      finalReview: this.#finalReview,
      waitReason: this.#waitReason,
      waitDetail: this.#waitDetail,
      paused: this.#paused,
      workItems: this.#workItems.map((item) => item.toSnapshot()),
      coordinatorAttempts: this.#coordinatorAttempts.map((attempt) => attempt.toSnapshot()),
      coordinatorSeq: this.#coordinatorSeq,
    };
  }

  /** 直接装配历史状态，不重放动作、不重新校验流转。 */
  static restore(snapshot: MissionSnapshot, project: Project): Mission {
    const mission = new Mission({ id: snapshot.id, projectId: snapshot.projectId, project });
    mission.#status = snapshot.status as MissionStatus;
    mission.#contract = snapshot.contract as Readonly<MissionContract> | undefined;
    mission.#contractRevision = snapshot.contractRevision ?? 0;
    mission.#plan = snapshot.plan as Readonly<PlanBody> | undefined;
    mission.#planRevision = snapshot.planRevision ?? 0;
    mission.#result = snapshot.result as Readonly<MissionResultBody> | undefined;
    mission.#escalations = (snapshot.escalations ?? []) as Readonly<EscalationBody>[];
    mission.#origin = snapshot.origin as Readonly<OriginChannel> | undefined;
    mission.#hasMutated = snapshot.hasMutated ?? snapshot.status === 'executing';
    mission.#finalReview = snapshot.finalReview as Readonly<FinalReview> | undefined;
    mission.#workspaceRef = snapshot.workspaceRef as Readonly<WorkspaceRef> | undefined;
    mission.#waitReason = snapshot.waitReason as WaitReason | undefined;
    mission.#waitDetail = snapshot.waitDetail;
    mission.#paused = snapshot.paused ?? false;
    mission.#workItems = (snapshot.workItems ?? []).map((item: WorkItemSnapshot) =>
      WorkItem.restore(item),
    );
    mission.#coordinatorAttempts = (snapshot.coordinatorAttempts ?? []).map(
      (attempt: AttemptSnapshot) => Attempt.restore(attempt),
    );
    mission.#coordinatorSeq = snapshot.coordinatorSeq ?? 0;
    return mission;
  }

  #isTerminal(): boolean {
    return MISSION_TRANSITIONS[this.#status].length === 0;
  }

  #hasInProgressCoordinatorAttempt(): boolean {
    return this.#coordinatorAttempts.some(
      (attempt) => attempt.status === 'in_progress',
    );
  }

  #assertCanGoTo(to: MissionStatus): void {
    if (!MISSION_TRANSITIONS[this.#status].includes(to)) {
      throw new IllegalTransitionError('Mission', this.#status, to);
    }
  }

  #goto(to: MissionStatus): void {
    this.#assertCanGoTo(to);
    this.#status = to;
  }
}
