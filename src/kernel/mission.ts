import { IllegalTransitionError, InvariantViolationError } from './errors.ts';
import { Attempt } from './attempt.ts';
import { WorkItem } from './work-item.ts';
import type { Project } from './project.ts';
import type { WorkItemInit } from './work-item.ts';
import { freezeDeep, freezePayload, isPromotionTriggerCode } from './payloads.ts';
import type { AttemptSnapshot, MissionSnapshot, WorkItemSnapshot } from './snapshot.ts';
import type {
  ComplexityAssessment,
  EscalationBody,
  ExecutionBudget,
  FinalReview,
  WaitReason,
  WorkspaceRef,
  MissionContract,
  MissionExecutionMode,
  MissionResultBody,
  OriginChannel,
  PlanBody,
  PromotionRecord,
  PromotionStatus,
  PromotionTokenUsageSnapshot,
  PromotionUnknownDimension,
  PromotionUsageSnapshot,
  PromotionWorkspaceRevision,
  RunKind,
  WorkOrder,
  IndependentReviewBlockReason,
  IndependentReviewL2Ref,
  IndependentReviewOpen,
  IndependentReviewRecord,
  IndependentReviewVerdict,
} from './payloads.ts';

const PROMOTION_STATUSES: readonly PromotionStatus[] = [
  'investigating',
  'planning',
  'executing',
];

const PROMOTION_UNKNOWN_DIMENSIONS: readonly PromotionUnknownDimension[] = [
  'tokens',
  'cost',
  'wallClockMs',
  'rounds',
  'changedFiles',
  'commands',
  'budgetRemaining',
];

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
  /** 执行保障档位；缺省/非法 -> standard。 */
  executionMode?: MissionExecutionMode;
  /** 运行种类；缺省/非法 -> mutation。与 executionMode 正交。 */
  runKind?: RunKind;
  /** 可选六维复杂度评估；缺省/非法 -> undefined。无 setter。 */
  complexityAssessment?: ComplexityAssessment;
  /** 可选执行预算上限；缺省/非法 -> undefined。无 setter、不填默认预算。 */
  executionBudget?: ExecutionBudget;
  /** 票级费用上限（美元）。Standard 新 Mission 默认 10；其余默认 undefined；恢复快照时以快照为准。 */
  costCap?: number;
}

/** toSnapshot/restore 在不改动 snapshot.ts 的前提下附带票级费用上限。 */
type MissionSnapshotWithCostCap = MissionSnapshot & { readonly costCap?: number };

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
  #independentReviewerAttempts: Attempt[] = [];
  #independentReviewerSeq = 0;
  #independentReviews: Readonly<IndependentReviewRecord>[] = [];
  #independentReviewBlockReason: IndependentReviewBlockReason | undefined;
  #independentReviewBlockDetail: string | undefined;
  #independentReviewOpen: Readonly<IndependentReviewOpen> | undefined;
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
  #updatedAt: string | undefined;
  #paused = false;
  #parked = false;
  #parkReason: string | undefined;
  #executionMode: MissionExecutionMode;
  #runKind: RunKind;
  #complexityAssessment: Readonly<ComplexityAssessment> | undefined;
  #executionBudget: Readonly<ExecutionBudget> | undefined;
  #costCap: number | undefined;
  #promotions: Readonly<PromotionRecord>[] = [];

  constructor(init: MissionInit) {
    this.#id = init.id;
    this.#projectId = init.projectId;
    this.#project = init.project;
    this.#executionMode = Mission.#normalizeExecutionMode(init.executionMode);
    this.#runKind = Mission.#normalizeRunKind(init.runKind);
    this.#complexityAssessment = Mission.#normalizeComplexityAssessment(
      init.complexityAssessment,
    );
    this.#executionBudget = Mission.#normalizeExecutionBudget(init.executionBudget);
    // Standard 新 Mission 默认 $10 票级费用上限；其余模式不设。恢复快照时此处结果会被 restore 覆盖。
    this.#costCap =
      this.#executionMode === 'standard'
        ? Mission.#normalizeCostCapValue(init.costCap) ?? 10
        : undefined;
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

  /** 创建时选定的执行保障档位；只读。 */
  get executionMode(): MissionExecutionMode {
    return this.#executionMode;
  }

  /** 创建时选定的运行种类；只读。与 executionMode 正交。 */
  get runKind(): RunKind {
    return this.#runKind;
  }

  /** 可选六维复杂度评估；只读。未评估为 undefined，禁止默认全 0。 */
  get complexityAssessment(): Readonly<ComplexityAssessment> | undefined {
    return this.#complexityAssessment;
  }

  /** 可选执行预算上限；只读。缺省/非法为 undefined，禁止填默认预算。 */
  get executionBudget(): Readonly<ExecutionBudget> | undefined {
    return this.#executionBudget;
  }

  /** 票级费用上限（美元）；Standard 新 Mission 默认 10，其余默认 undefined。只读。 */
  get costCap(): number | undefined {
    return this.#costCap;
  }

  /**
   * 提升本 Mission 的票级费用上限，返回新上限。
   * `by` 必须是有限正数；当前未设上限时以 10 为起点（与新建 Standard 一致）。
   */
  raiseCostCap(by: number): number {
    if (!Number.isFinite(by) || by <= 0) {
      throw new InvariantViolationError(
        'INVALID_COST_CAP_DELTA',
        `raiseCostCap 收到非有限正数增量: ${by}`,
      );
    }
    const base = this.#costCap ?? 10;
    this.#costCap = base + by;
    return this.#costCap;
  }

  /** Lightweight→Standard 升级历史；只读副本。本阶段最多一条。 */
  get promotions(): readonly Readonly<PromotionRecord>[] {
    return [...this.#promotions];
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
    return this.#hasMutated && !this.#isTerminal() && !this.#parked;
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

  get independentReviewerAttempts(): readonly Attempt[] {
    return [...this.#independentReviewerAttempts];
  }

  get independentReviews(): readonly Readonly<IndependentReviewRecord>[] {
    return [...this.#independentReviews];
  }

  get independentReviewBlockReason(): IndependentReviewBlockReason | undefined {
    return this.#independentReviewBlockReason;
  }

  get independentReviewBlockDetail(): string | undefined {
    return this.#independentReviewBlockDetail;
  }

  get independentReviewOpen(): Readonly<IndependentReviewOpen> | undefined {
    return this.#independentReviewOpen;
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

  get isParked(): boolean {
    return this.#parked;
  }

  get parkReason(): string | undefined {
    return this.#parkReason;
  }

  /** 暂存已提交成果；调用方须先确保成果处于安全检查点。 */
  park(reason: string): void {
    if (this.#isTerminal()) {
      throw new IllegalTransitionError('Mission', this.#status, 'park');
    }
    this.#parked = true;
    this.#parkReason = reason;
  }

  /** 重新领取名额后恢复调度；拒绝时保持 parked 原状。 */
  unpark(): void {
    if (this.#parked && this.#project.hasOtherMutatingMission(this.#id)) {
      throw new InvariantViolationError(
        'CONCURRENT_MUTATING_MISSION',
        `Project ${this.#projectId} already has a mission in executing state`,
      );
    }
    this.#parked = false;
    this.#parkReason = undefined;
  }

  pause(): void {
    if (this.#isTerminal()) {
      throw new IllegalTransitionError('Mission', this.#status, 'pause');
    }
    this.#paused = true;
  }

  resume(): void {
    if (this.#parked) this.unpark();
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

  /**
   * 最后一次状态变化的时间。
   *
   * 列表页要按"最近动过"排序、也要显示"多久没动了"。从活动日志里现算的话，
   * 每渲染一次列表就要把每条 Mission 的全部事件读一遍——那是 O(事件总数)，
   * 而这只是一列。记在这里是一次写、一次读。
   */
  get updatedAt(): string | undefined {
    return this.#updatedAt;
  }

  /** 由用例层在每次记事件时调用。时间从外面传，kernel 里不读时钟。 */
  touch(at: string): void {
    this.#updatedAt = at;
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
   * Lightweight → Standard 可信升级（PROMO-001）。
   *
   * 所有 guard 在 mutation 前完成；成功时 deep-copy/freeze 一条 promotion。
   * 不清 waitReason，不 retire/reject/reset WorkItem，不清 result/evidence/workspace。
   * executing 升级会 status→planning，但 hasMutated 保留，isMutating 仍为 true。
   */
  promoteToStandard(
    record: PromotionRecord,
  ): { changed: boolean; promotion: Readonly<PromotionRecord> } {
    // 幂等：已 standard 且恰好 1 条，身份字段相等 => changed:false。
    if (
      this.#executionMode === 'standard' &&
      this.#promotions.length === 1
    ) {
      const existing = this.#promotions[0]!;
      if (Mission.#promotionIdentityEqual(existing, record)) {
        return { changed: false, promotion: existing };
      }
      throw new InvariantViolationError(
        'PROMOTION_ALREADY_APPLIED',
        `Mission ${this.#id} 已从 lightweight 升级为 standard，拒绝不同的 promotion 记录`,
      );
    }

    if (this.#executionMode !== 'lightweight') {
      throw new InvariantViolationError(
        'PROMOTION_MODE_REQUIRED',
        `promoteToStandard 要求 executionMode=lightweight，当前是 ${this.#executionMode}`,
      );
    }
    if (this.#runKind !== 'mutation') {
      throw new InvariantViolationError(
        'PROMOTION_RUN_KIND_REQUIRED',
        `promoteToStandard 要求 runKind=mutation，当前是 ${this.#runKind}`,
      );
    }
    if (this.#isTerminal() || this.#status === 'awaiting_review') {
      throw new IllegalTransitionError('Mission', this.#status, 'promoteToStandard');
    }
    if (
      this.#status !== 'investigating' &&
      this.#status !== 'planning' &&
      this.#status !== 'executing'
    ) {
      throw new IllegalTransitionError('Mission', this.#status, 'promoteToStandard');
    }
    if (this.#promotions.length !== 0) {
      throw new InvariantViolationError(
        'PROMOTION_ALREADY_APPLIED',
        `Mission ${this.#id} 已有 promotion 记录，本阶段最多一次 L→S`,
      );
    }

    const normalized = Mission.#normalizePromotionRecordStrict(record, this.#status);
    if (!normalized) {
      throw new InvariantViolationError(
        'INVALID_PROMOTION_RECORD',
        `Mission ${this.#id} 拒绝非法 PromotionRecord`,
      );
    }

    // mutation：executing → planning；executionMode → standard；append 1 条。
    if (this.#status === 'executing') {
      this.#status = 'planning';
    }
    this.#executionMode = 'standard';
    this.#promotions.push(normalized);
    return { changed: true, promotion: normalized };
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

  /**
   * 开一次独立检视 Attempt。
   *
   * 只在 awaiting_review 且交卷 delivered 时允许：更早开等于在审一份还不存在的交卷，
   * 更晚会变成给终态补章。同一时刻只能有一个 in_progress——并发两张牌会写出两份
   * 互相覆盖的结论，而读取方无法证明哪份是权威。
   */
  startIndependentReviewerAttempt(open: Omit<IndependentReviewOpen, 'attemptId'>): Attempt {
    if (this.#status !== 'awaiting_review') {
      throw new IllegalTransitionError('Mission', this.#status, 'startIndependentReviewerAttempt');
    }
    if (this.#result?.outcome !== 'delivered') {
      throw new InvariantViolationError(
        'INDEPENDENT_REVIEW_NOT_DELIVERED',
        `Mission ${this.#id} 交卷不是 delivered，不能开独立检视`,
      );
    }
    if (this.#hasInProgressIndependentReviewerAttempt()) {
      throw new InvariantViolationError(
        'CONCURRENT_INDEPENDENT_REVIEWER_ATTEMPT',
        `Mission ${this.#id} already has an in_progress independent_reviewer attempt`,
      );
    }
    this.#independentReviewerSeq += 1;
    const attempt = new Attempt({
      id: `indrev-${this.#independentReviewerSeq}`,
      kind: 'independent_reviewer',
      missionId: this.#id,
    });
    this.#independentReviewerAttempts.push(attempt);
    this.#independentReviewOpen = freezePayload({
      attemptId: attempt.id,
      contractRevision: open.contractRevision,
      reviewedCommit: open.reviewedCommit,
      l2Fingerprint: open.l2Fingerprint,
      l2ReviewRefs: open.l2ReviewRefs.map((ref) => ({ ...ref })),
      ...(open.validationReportId !== undefined
        ? { validationReportId: open.validationReportId }
        : {}),
    });
    this.#independentReviewBlockReason = undefined;
    this.#independentReviewBlockDetail = undefined;
    return attempt;
  }

  /**
   * 记下为什么没开出独立检视。Mission 停在 awaiting_review，绝不回落协调者自审。
   * 原因必须跟着状态走，否则只有算出它的那个进程知道。
   */
  recordIndependentReviewBlock(reason: IndependentReviewBlockReason, detail: string): void {
    this.#independentReviewBlockReason = reason;
    this.#independentReviewBlockDetail = detail;
  }

  /**
   * 收一份独立检视结论。每个 Attempt 只收一次，追加不覆盖。
   * 不改 WorkItem.reviews，也不流转 Mission——打回不是 E2 的编排职责。
   */
  recordIndependentReview(
    attemptId: string,
    input: {
      reviewerProfileId: string;
      contractRevision: number;
      reviewedCommit: string;
      l2ReviewRefs: readonly IndependentReviewL2Ref[];
      l2Fingerprint: string;
      validationReportId?: string;
      verdict: IndependentReviewVerdict;
      reasons: readonly string[];
      recordedAt: string;
    },
  ): Readonly<IndependentReviewRecord> {
    if (this.#status !== 'awaiting_review') {
      throw new IllegalTransitionError('Mission', this.#status, 'recordIndependentReview');
    }
    const attempt = this.#independentReviewerAttempts.find((a) => a.id === attemptId);
    if (!attempt || attempt.kind !== 'independent_reviewer') {
      throw new InvariantViolationError(
        'UNKNOWN_INDEPENDENT_REVIEWER_ATTEMPT',
        `Mission ${this.#id} 没有 independent_reviewer attempt ${attemptId}`,
      );
    }
    if (attempt.status !== 'in_progress') {
      throw new InvariantViolationError(
        'INDEPENDENT_REVIEW_ATTEMPT_NOT_ACTIVE',
        `attempt ${attemptId} 已经是 ${attempt.status}，不能再交检视结论`,
      );
    }
    if (this.#independentReviews.some((row) => row.reviewerAttemptId === attemptId)) {
      throw new InvariantViolationError(
        'INDEPENDENT_REVIEW_ALREADY_RECORDED',
        `attempt ${attemptId} 已经交过独立检视结论，拒绝覆盖`,
      );
    }
    if (input.verdict !== 'pass' && input.verdict !== 'send_back') {
      throw new InvariantViolationError(
        'INVALID_INDEPENDENT_REVIEW',
        `独立检视结论只能是 pass 或 send_back，收到 ${String(input.verdict)}`,
      );
    }
    if (!Array.isArray(input.reasons) || input.reasons.length === 0 || input.reasons.some((r) => typeof r !== 'string' || r.trim() === '')) {
      throw new InvariantViolationError(
        'INVALID_INDEPENDENT_REVIEW',
        '独立检视必须给出非空理由',
      );
    }
    const record = freezePayload({
      missionId: this.#id,
      reviewerAttemptId: attemptId,
      reviewerProfileId: input.reviewerProfileId,
      contractRevision: input.contractRevision,
      reviewedCommit: input.reviewedCommit,
      l2ReviewRefs: input.l2ReviewRefs.map((ref) => ({ ...ref })),
      l2Fingerprint: input.l2Fingerprint,
      verdict: input.verdict,
      reasons: [...input.reasons],
      recordedAt: input.recordedAt,
      ...(input.validationReportId !== undefined
        ? { validationReportId: input.validationReportId }
        : {}),
    }) as IndependentReviewRecord;
    this.#independentReviews.push(record);
    return record;
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

  /** 找 Attempt（协调者、独立检视者、或任一 WorkItem 下执行者的）。 */
  attempt(id: string): Attempt | undefined {
    const own = this.#coordinatorAttempts.find((a) => a.id === id);
    if (own) return own;
    const review = this.#independentReviewerAttempts.find((a) => a.id === id);
    if (review) return review;
    for (const item of this.#workItems) {
      const found = item.attempts.find((a) => a.id === id);
      if (found) return found;
    }
    return undefined;
  }

  /* --------------------------- 快照 --------------------------- */

  toSnapshot(): MissionSnapshot {
    const snapshot: MissionSnapshot & { readonly costCap?: number } = {
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
      updatedAt: this.#updatedAt,
      paused: this.#paused,
      parked: this.#parked,
      parkReason: this.#parkReason,
      executionMode: this.#executionMode,
      runKind: this.#runKind,
      complexityAssessment: this.#complexityAssessment,
      executionBudget: this.#executionBudget,
      costCap: this.#costCap,
      // fail-closed：只序列化 normalize 后的可信 promotion；禁止 raw fallback 第二写路径。
      promotions: this.#promotions.flatMap((p) => {
        const copied = Mission.#normalizePromotionRecord(p, undefined);
        return copied ? [copied] : [];
      }),
      workItems: this.#workItems.map((item) => item.toSnapshot()),
      coordinatorAttempts: this.#coordinatorAttempts.map((attempt) => attempt.toSnapshot()),
      coordinatorSeq: this.#coordinatorSeq,
      independentReviewerAttempts: this.#independentReviewerAttempts.map((attempt) =>
        attempt.toSnapshot(),
      ),
      independentReviewerSeq: this.#independentReviewerSeq,
      independentReviews: this.#independentReviews.map((row) => ({ ...row, l2ReviewRefs: [...row.l2ReviewRefs], reasons: [...row.reasons] })),
      independentReviewBlockReason: this.#independentReviewBlockReason,
      independentReviewBlockDetail: this.#independentReviewBlockDetail,
      independentReviewOpen: this.#independentReviewOpen
        ? {
            ...this.#independentReviewOpen,
            l2ReviewRefs: [...this.#independentReviewOpen.l2ReviewRefs],
          }
        : undefined,
      costCap: this.#costCap,
    };
    return snapshot;
  }

  /** 直接装配历史状态，不重放动作、不重新校验流转。 */
  static restore(snapshot: MissionSnapshot, project: Project): Mission {
    const mission = new Mission({
      id: snapshot.id,
      projectId: snapshot.projectId,
      project,
      executionMode: Mission.#normalizeExecutionMode(snapshot.executionMode),
      runKind: Mission.#normalizeRunKind(snapshot.runKind),
      complexityAssessment: Mission.#normalizeComplexityAssessment(
        snapshot.complexityAssessment,
      ),
      executionBudget: Mission.#normalizeExecutionBudget(snapshot.executionBudget),
    });
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
    mission.#updatedAt = snapshot.updatedAt;
    mission.#paused = snapshot.paused ?? false;
    mission.#parked = snapshot.parked ?? false;
    mission.#parkReason = mission.#parked && typeof snapshot.parkReason === 'string'
      ? snapshot.parkReason
      : undefined;
    mission.#workItems = (snapshot.workItems ?? []).map((item: WorkItemSnapshot) =>
      WorkItem.restore(item),
    );
    mission.#coordinatorAttempts = (snapshot.coordinatorAttempts ?? []).map(
      (attempt: AttemptSnapshot) => Attempt.restore(attempt),
    );
    mission.#coordinatorSeq = snapshot.coordinatorSeq ?? 0;
    mission.#independentReviewerAttempts = (snapshot.independentReviewerAttempts ?? [])
      .filter((attempt: AttemptSnapshot) => attempt.kind === 'independent_reviewer')
      .map((attempt: AttemptSnapshot) => Attempt.restore(attempt));
    mission.#independentReviewerSeq = snapshot.independentReviewerSeq ?? 0;
    mission.#independentReviews = Mission.#normalizeIndependentReviews(
      snapshot.independentReviews,
      snapshot.id,
    );
    mission.#independentReviewBlockReason = Mission.#normalizeIndependentReviewBlockReason(
      snapshot.independentReviewBlockReason,
    );
    mission.#independentReviewBlockDetail =
      typeof snapshot.independentReviewBlockDetail === 'string'
        ? snapshot.independentReviewBlockDetail
        : undefined;
    mission.#independentReviewOpen = Mission.#normalizeIndependentReviewOpen(
      snapshot.independentReviewOpen,
    );
    mission.#promotions = Mission.#normalizePromotionsList(
      snapshot.promotions,
      mission.#executionMode,
    );
    // 旧快照没有 costCap 字段 -> undefined（不迁移）；新快照带值则校验恢复。
    mission.#costCap = Mission.#normalizeCostCapValue(
      (snapshot as MissionSnapshotWithCostCap).costCap,
    );
    return mission;
  }

  static #normalizeExecutionMode(value: unknown): MissionExecutionMode {
    if (value === 'lightweight' || value === 'standard' || value === 'high_assurance') {
      return value;
    }
    return 'standard';
  }

  /** 仅接受有限正数费用上限；其余（undefined/0/负/NaN/非数）一律归为 undefined。 */
  static #normalizeCostCapValue(value: unknown): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return value;
    }
    return undefined;
  }

  static #normalizeRunKind(value: unknown): RunKind {
    if (value === 'mutation' || value === 'query') {
      return value;
    }
    return 'mutation';
  }

  /**
   * fail-closed：缺/undefined -> undefined；任一字段非法 -> 整段 undefined。
   * 禁止逐维 clamp、默认 0 或抛错。合法时复制 reasons 再 freeze。
   */
  static #normalizeComplexityAssessment(
    value: unknown,
  ): Readonly<ComplexityAssessment> | undefined {
    if (value == null) return undefined;
    if (typeof value !== 'object' || Array.isArray(value)) return undefined;
    const raw = value as Record<string, unknown>;
    const dims = [
      'goalUncertainty',
      'changeScope',
      'operationalRisk',
      'verificationDifficulty',
      'coordinationNeed',
      'recoveryDifficulty',
    ] as const;
    const scores: Partial<Record<(typeof dims)[number], 0 | 1 | 2>> = {};
    for (const key of dims) {
      const score = raw[key];
      if (score !== 0 && score !== 1 && score !== 2) return undefined;
      scores[key] = score;
    }
    if (!Array.isArray(raw.reasons) || !raw.reasons.every((r) => typeof r === 'string')) {
      return undefined;
    }
    if (
      raw.decidedBy !== 'rule' &&
      raw.decidedBy !== 'user' &&
      raw.decidedBy !== 'coordinator'
    ) {
      return undefined;
    }
    if (typeof raw.assessedAt !== 'string') return undefined;
    return freezePayload({
      goalUncertainty: scores.goalUncertainty!,
      changeScope: scores.changeScope!,
      operationalRisk: scores.operationalRisk!,
      verificationDifficulty: scores.verificationDifficulty!,
      coordinationNeed: scores.coordinationNeed!,
      recoveryDifficulty: scores.recoveryDifficulty!,
      reasons: [...raw.reasons] as string[],
      decidedBy: raw.decidedBy,
      assessedAt: raw.assessedAt,
    });
  }

  /**
   * fail-closed：缺/null/undefined -> undefined；任一已知字段非法或缺 required -> 整段 undefined。
   * 不 clamp、不 partial、不填默认预算。仅重构 known fields；未知 key 丢弃。
   */
  static #normalizeExecutionBudget(value: unknown): Readonly<ExecutionBudget> | undefined {
    if (value == null) return undefined;
    if (typeof value !== 'object' || Array.isArray(value)) return undefined;
    const raw = value as Record<string, unknown>;

    const maxAttempts = Mission.#asNonNegativeInt(raw.maxAttempts);
    const maxRounds = Mission.#asNonNegativeInt(raw.maxRounds);
    const maxWallClockMs = Mission.#asNonNegativeInt(raw.maxWallClockMs);
    if (maxAttempts === undefined || maxRounds === undefined || maxWallClockMs === undefined) {
      return undefined;
    }

    const budget: {
      maxAttempts: number;
      maxRounds: number;
      maxWallClockMs: number;
      maxInputTokens?: number;
      maxOutputTokens?: number;
      maxTotalTokens?: number;
      maxCost?: number;
      maxChangedFiles?: number;
      maxCommands?: number;
    } = {
      maxAttempts,
      maxRounds,
      maxWallClockMs,
    };

    const optionalInts = [
      'maxInputTokens',
      'maxOutputTokens',
      'maxTotalTokens',
      'maxChangedFiles',
      'maxCommands',
    ] as const;
    for (const key of optionalInts) {
      if (!Object.prototype.hasOwnProperty.call(raw, key) || raw[key] === undefined) continue;
      const n = Mission.#asNonNegativeInt(raw[key]);
      if (n === undefined) return undefined;
      budget[key] = n;
    }

    if (Object.prototype.hasOwnProperty.call(raw, 'maxCost') && raw.maxCost !== undefined) {
      const cost = Mission.#asNonNegativeNumber(raw.maxCost);
      if (cost === undefined) return undefined;
      budget.maxCost = cost;
    }

    return freezePayload(budget);
  }

  /** finite nonnegative integer（含 0）；否则 undefined。拒绝 boxed Number。 */
  static #asNonNegativeInt(value: unknown): number | undefined {
    if (typeof value !== 'number') return undefined;
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) return undefined;
    return value;
  }

  /** finite nonnegative number（含 0、允许小数）；否则 undefined。拒绝 boxed Number。 */
  static #asNonNegativeNumber(value: unknown): number | undefined {
    if (typeof value !== 'number') return undefined;
    if (!Number.isFinite(value) || value < 0) return undefined;
    return value;
  }

  static #isPromotionStatus(value: unknown): value is PromotionStatus {
    return typeof value === 'string' && (PROMOTION_STATUSES as readonly string[]).includes(value);
  }

  static #isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
  }

  /** 幂等身份：Platform 生成的 id + 触发意图，不做递归深比较。 */
  static #promotionIdentityEqual(
    a: Readonly<PromotionRecord>,
    b: Readonly<PromotionRecord>,
  ): boolean {
    return (
      a.id === b.id &&
      a.triggerCode === b.triggerCode &&
      a.triggerRule === b.triggerRule
    );
  }

  /**
   * 调用瞬间严格校验 + deep freeze。失败返回 undefined（由 caller 抛 INVALID_PROMOTION_RECORD）。
   * toStatus 必须等于计算结果：executing→planning，其余保持 fromStatus。
   */
  static #normalizePromotionRecordStrict(
    value: unknown,
    currentStatus: MissionStatus,
  ): Readonly<PromotionRecord> | undefined {
    const expectedToStatus: 'investigating' | 'planning' =
      currentStatus === 'executing' ? 'planning' : (currentStatus as 'investigating' | 'planning');
    return Mission.#normalizePromotionRecord(value, {
      requireFromStatus: currentStatus as PromotionStatus,
      requireToStatus: expectedToStatus,
    });
  }

  /**
   * restore fail-closed：
   * - 单条 malformed（含缺/空 id）丢弃
   * - >1 条合法 => 整表不可信，返回 []
   * - executionMode !== standard 却带 promotions => 丢 promotions（不改 mode）
   */
  static #normalizePromotionsList(
    value: unknown,
    executionMode: MissionExecutionMode,
  ): Readonly<PromotionRecord>[] {
    if (!Array.isArray(value)) return [];
    const out: Readonly<PromotionRecord>[] = [];
    for (const item of value) {
      const normalized = Mission.#normalizePromotionRecord(item, undefined);
      if (normalized) out.push(normalized);
    }
    if (out.length > 1) return [];
    if (executionMode !== 'standard' && out.length > 0) return [];
    return out;
  }

  static #normalizePromotionRecord(
    value: unknown,
    bound:
      | {
          readonly requireFromStatus: PromotionStatus;
          readonly requireToStatus: 'investigating' | 'planning';
        }
      | undefined,
  ): Readonly<PromotionRecord> | undefined {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const raw = value as Record<string, unknown>;

    if (typeof raw.id !== 'string' || raw.id.length === 0) return undefined;
    if (raw.fromMode !== 'lightweight' || raw.toMode !== 'standard') return undefined;
    if (!isPromotionTriggerCode(raw.triggerCode)) return undefined;
    if (typeof raw.triggerRule !== 'string' || raw.triggerRule.length === 0) return undefined;
    if (typeof raw.at !== 'string' || raw.at.length === 0) return undefined;
    if (!Mission.#isPromotionStatus(raw.fromStatus)) return undefined;
    if (raw.toStatus !== 'investigating' && raw.toStatus !== 'planning') return undefined;

    if (bound) {
      if (raw.fromStatus !== bound.requireFromStatus) return undefined;
      if (raw.toStatus !== bound.requireToStatus) return undefined;
    } else {
      // restore：toStatus 仍须与 fromStatus 规则一致（executing→planning，否则保持）。
      const expected =
        raw.fromStatus === 'executing' ? 'planning' : raw.fromStatus;
      if (raw.toStatus !== expected) return undefined;
    }

    const consumedUsage = Mission.#normalizePromotionUsageSnapshot(raw.consumedUsage);
    if (!consumedUsage) return undefined;
    if (!Mission.#isStringArray(raw.evidenceIds)) return undefined;
    if (!Mission.#isStringArray(raw.validationReportIds)) return undefined;
    if (!Mission.#isStringArray(raw.workItemIdsSnapshot)) return undefined;

    const workspaceRevision = Mission.#normalizePromotionWorkspaceRevision(raw.workspaceRevision);
    if (!workspaceRevision) return undefined;

    return freezeDeep({
      id: raw.id,
      fromMode: 'lightweight' as const,
      toMode: 'standard' as const,
      triggerCode: raw.triggerCode,
      triggerRule: raw.triggerRule,
      at: raw.at,
      fromStatus: raw.fromStatus,
      toStatus: raw.toStatus,
      consumedUsage,
      evidenceIds: [...raw.evidenceIds],
      validationReportIds: [...raw.validationReportIds],
      workspaceRevision,
      workItemIdsSnapshot: [...raw.workItemIdsSnapshot],
    } satisfies PromotionRecord);
  }

  static #normalizePromotionUsageSnapshot(
    value: unknown,
  ): PromotionUsageSnapshot | undefined {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const raw = value as Record<string, unknown>;
    const attemptCount = Mission.#asNonNegativeInt(raw.attemptCount);
    if (attemptCount === undefined) return undefined;
    if (raw.budgetAuthoritative !== false) return undefined;
    if (!Array.isArray(raw.dimensionsUnknown)) return undefined;

    const dimensionsUnknown: PromotionUnknownDimension[] = [];
    for (const dim of raw.dimensionsUnknown) {
      if (
        typeof dim !== 'string' ||
        !(PROMOTION_UNKNOWN_DIMENSIONS as readonly string[]).includes(dim)
      ) {
        return undefined;
      }
      dimensionsUnknown.push(dim as PromotionUnknownDimension);
    }

    const out: PromotionUsageSnapshot = {
      attemptCount,
      dimensionsUnknown: [...dimensionsUnknown],
      budgetAuthoritative: false,
    };

    if (Object.prototype.hasOwnProperty.call(raw, 'tokenUsage') && raw.tokenUsage !== undefined) {
      const tokenUsage = Mission.#normalizePromotionTokenUsage(raw.tokenUsage);
      if (!tokenUsage) return undefined;
      (out as { tokenUsage?: PromotionTokenUsageSnapshot }).tokenUsage = tokenUsage;
    }

    return out;
  }

  static #normalizePromotionTokenUsage(
    value: unknown,
  ): PromotionTokenUsageSnapshot | undefined {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const raw = value as Record<string, unknown>;
    const input = Mission.#asNonNegativeNumber(raw.input);
    const output = Mission.#asNonNegativeNumber(raw.output);
    const cacheRead = Mission.#asNonNegativeNumber(raw.cacheRead);
    const cacheWrite = Mission.#asNonNegativeNumber(raw.cacheWrite);
    const total = Mission.#asNonNegativeNumber(raw.total);
    if (
      input === undefined ||
      output === undefined ||
      cacheRead === undefined ||
      cacheWrite === undefined ||
      total === undefined
    ) {
      return undefined;
    }
    if (raw.quality !== 'reported' && raw.quality !== 'estimated' && raw.quality !== 'unknown') {
      return undefined;
    }
    // 禁止夹带 cost 等伪精确字段进 promotion token 快照。
    return {
      input,
      output,
      cacheRead,
      cacheWrite,
      total,
      quality: raw.quality,
    };
  }

  static #normalizePromotionWorkspaceRevision(
    value: unknown,
  ): PromotionWorkspaceRevision | undefined {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const raw = value as Record<string, unknown>;
    if (raw.kind === 'unknown') {
      return { kind: 'unknown' };
    }
    if (raw.kind === 'head') {
      if (typeof raw.revision !== 'string' || raw.revision.length === 0) return undefined;
      return { kind: 'head', revision: raw.revision };
    }
    return undefined;
  }

  #isTerminal(): boolean {
    return MISSION_TRANSITIONS[this.#status].length === 0;
  }

  #hasInProgressCoordinatorAttempt(): boolean {
    return this.#coordinatorAttempts.some(
      (attempt) => attempt.status === 'in_progress',
    );
  }

  #hasInProgressIndependentReviewerAttempt(): boolean {
    return this.#independentReviewerAttempts.some(
      (attempt) => attempt.status === 'in_progress',
    );
  }

  static #normalizeIndependentReviewBlockReason(
    value: unknown,
  ): IndependentReviewBlockReason | undefined {
    if (
      value === 'no_candidates' ||
      value === 'all_candidates_conflict' ||
      value === 'history_missing_profile' ||
      value === 'not_awaiting_review' ||
      value === 'not_delivered' ||
      value === 'concurrent_attempt' ||
      value === 'reviewed_commit_unavailable' ||
      value === 'work_items_unfinished'
    ) {
      return value;
    }
    return undefined;
  }

  static #normalizeIndependentReviewOpen(value: unknown): Readonly<IndependentReviewOpen> | undefined {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const raw = value as Record<string, unknown>;
    if (typeof raw.attemptId !== 'string' || raw.attemptId.trim() === '') return undefined;
    if (typeof raw.contractRevision !== 'number' || !Number.isFinite(raw.contractRevision)) {
      return undefined;
    }
    if (typeof raw.reviewedCommit !== 'string' || raw.reviewedCommit.trim() === '') return undefined;
    if (typeof raw.l2Fingerprint !== 'string') return undefined;
    const refs = Mission.#normalizeL2Refs(raw.l2ReviewRefs);
    if (!refs) return undefined;
    return freezePayload({
      attemptId: raw.attemptId,
      contractRevision: raw.contractRevision,
      reviewedCommit: raw.reviewedCommit,
      l2Fingerprint: raw.l2Fingerprint,
      l2ReviewRefs: refs,
      ...(typeof raw.validationReportId === 'string' && raw.validationReportId.trim() !== ''
        ? { validationReportId: raw.validationReportId }
        : {}),
    });
  }

  static #normalizeIndependentReviews(
    value: unknown,
    missionId: string,
  ): Readonly<IndependentReviewRecord>[] {
    if (!Array.isArray(value)) return [];
    const out: Readonly<IndependentReviewRecord>[] = [];
    for (const row of value) {
      const normalized = Mission.#normalizeIndependentReviewRecord(row, missionId);
      if (normalized) out.push(normalized);
    }
    return out;
  }

  static #normalizeIndependentReviewRecord(
    value: unknown,
    missionId: string,
  ): Readonly<IndependentReviewRecord> | undefined {
    if (value == null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const raw = value as Record<string, unknown>;
    if (raw.missionId !== missionId) return undefined;
    if (typeof raw.reviewerAttemptId !== 'string' || raw.reviewerAttemptId.trim() === '') {
      return undefined;
    }
    if (typeof raw.reviewerProfileId !== 'string' || raw.reviewerProfileId.trim() === '') {
      return undefined;
    }
    if (typeof raw.contractRevision !== 'number' || !Number.isFinite(raw.contractRevision)) {
      return undefined;
    }
    if (typeof raw.reviewedCommit !== 'string' || raw.reviewedCommit.trim() === '') return undefined;
    if (typeof raw.l2Fingerprint !== 'string') return undefined;
    if (raw.verdict !== 'pass' && raw.verdict !== 'send_back') return undefined;
    if (!Array.isArray(raw.reasons) || raw.reasons.length === 0 || raw.reasons.some((r) => typeof r !== 'string' || r.trim() === '')) {
      return undefined;
    }
    if (typeof raw.recordedAt !== 'string') return undefined;
    const refs = Mission.#normalizeL2Refs(raw.l2ReviewRefs);
    if (!refs) return undefined;
    return freezePayload({
      missionId,
      reviewerAttemptId: raw.reviewerAttemptId,
      reviewerProfileId: raw.reviewerProfileId,
      contractRevision: raw.contractRevision,
      reviewedCommit: raw.reviewedCommit,
      l2ReviewRefs: refs,
      l2Fingerprint: raw.l2Fingerprint,
      verdict: raw.verdict,
      reasons: [...raw.reasons] as string[],
      recordedAt: raw.recordedAt,
      ...(typeof raw.validationReportId === 'string' && raw.validationReportId.trim() !== ''
        ? { validationReportId: raw.validationReportId }
        : {}),
    });
  }

  static #normalizeL2Refs(value: unknown): IndependentReviewL2Ref[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const out: IndependentReviewL2Ref[] = [];
    for (const row of value) {
      if (row == null || typeof row !== 'object' || Array.isArray(row)) return undefined;
      const raw = row as Record<string, unknown>;
      if (typeof raw.workItemId !== 'string' || raw.workItemId.trim() === '') return undefined;
      out.push({
        workItemId: raw.workItemId,
        ...(typeof raw.submittedAttemptId === 'string'
          ? { submittedAttemptId: raw.submittedAttemptId }
          : {}),
        ...(typeof raw.reviewAttemptId === 'string' ? { reviewAttemptId: raw.reviewAttemptId } : {}),
      });
    }
    return out;
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
