import * as haValidation from './platform/ha-validation.ts';
import * as promotion from './platform/promotion.ts';
import * as postExecution from './platform/post-execution.ts';
import * as commandTracking from './platform/command-tracking.ts';
import * as validationReportViews from './platform/validation-report-views.ts';
import * as standardRedispatch from './platform/standard-redispatch.ts';
import * as standardValidation from './platform/standard-validation.ts';
import * as budgetUsage from './platform/budget-usage.ts';
import * as missionControl from './platform/mission-control.ts';
import * as planning from './platform/planning.ts';
import * as escalations from './platform/escalations.ts';
import * as lightweightSubmission from './platform/lightweight-submission.ts';
import * as lightweightValidation from './platform/lightweight-validation.ts';
import * as lightweightDispatch from './platform/lightweight-dispatch.ts';
import * as executorSubmissions from './platform/executor-submissions.ts';
import * as workItemDispatch from './platform/work-item-dispatch.ts';
import * as workItemReview from './platform/work-item-review.ts';
import * as workOrders from './platform/work-orders.ts';
import * as startupBrief from './platform/startup-brief.ts';
import * as views from './platform/views.ts';
import * as independentReview from './platform/independent-review.ts';
import * as attempts from './platform/attempts.ts';
import { queuedAttemptStartedData } from './platform/attempts.ts';
import * as missionIntake from './platform/mission-intake.ts';
import * as missionLifecycle from './platform/mission-lifecycle.ts';
import { STANDARD_AUTO_REDISPATCH_EVENT_KIND, STANDARD_AUTO_REDISPATCH_LIMIT, autoRedispatchEventsFor, submissionPrecedesPromotion, autoRedispatchSummary, failedValidationSummary, standardAutoRedispatchHandoff } from './platform/redispatch-helpers.ts';
export { STANDARD_AUTO_REDISPATCH_EVENT_KIND, STANDARD_AUTO_REDISPATCH_LIMIT } from './platform/redispatch-helpers.ts';
export type { StandardAutoRedispatchReason, StandardAutoRedispatchSkipReason } from './platform/redispatch-helpers.ts';
import type { StandardAutoRedispatchReason } from './platform/redispatch-helpers.ts';
import { elapsedMs, sumUsage, buildPromotionUsageSnapshot, push, combine } from './platform/usage-helpers.ts';
import { criteriaFailureStopFor, priorGuidanceForWorkItem, coordinatorStartupSources, boundWorkItemForExecutor, validationReportKey, validationReportView, criteriaList, criteriaFailureQuestion, criteriaFailureWhy, hasOpenDiagnosticEscalation, readDiagnosticCriteria, agentWorkItemIndex, agentEscalationAnswers, buildAgentWorkItemView } from './platform/agent-view-helpers.ts';
export { criteriaFailureStopFor } from './platform/agent-view-helpers.ts';
import { REVISE_BLOCKED_HINT, orderChangedFields, checkWorkOrderCriteria, checkWorkOrderStandard, checkAcceptanceResults } from './platform/work-order-helpers.ts';
import { sanitizeAttemptContextMetrics, activityDataHasContextMetrics, keepTrueOrUnknownLeaves } from './platform/context-metrics.ts';
import type { PlatformValidationDeps, QueueClaimIdentity, StandardAutoRedispatchHandoff, StandardAutoRedispatchResult, PlatformDeps, CreateMissionInput, CreateClassifiedMissionInput, CreateClassifiedMissionResult, MissionView, MissionSummary, WorkOrderView, RunSummary, WorkOrderStandardWarning, ValidationReportCommandView, ValidationReportView, AgentWorkItemIndexEntry, CriteriaFailureDiagnostic, AgentEscalationAnswer, AgentMissionView, AgentWorkItemEvidenceSummary, AgentWorkItemSubmissionSummary, AgentWorkItemView, UsageBucket, UsageReport } from './platform/types.ts';
export type { PlatformValidationDeps, QueueClaimIdentity, StandardAutoRedispatchHandoff, StandardAutoRedispatchResult, PlatformDeps, CreateMissionInput, CreateClassifiedMissionInput, CreateClassifiedMissionResult, MissionView, MissionSummary, WorkOrderView, RunSummary, WorkOrderStandardWarning, ValidationReportCommandView, ValidationReportView, AgentWorkItemIndexEntry, CriteriaFailureDiagnostic, AgentEscalationAnswer, AgentMissionView, AgentWorkItemEvidenceSummary, AgentWorkItemSubmissionSummary, AgentWorkItemView, UsageBucket, UsageReport } from './platform/types.ts';
import { PlatformContext, PlatformRuleError, PROTOCOL_VERSION, ATTEMPT_STARTED_KIND } from './platform/context.ts';
/**
 * 平台用例层 —— coagent_* 工具背后的真实实现。
 *
 * 工具的 handler（住在各个 runtime 适配包里）只负责把结构化参数转发到这里。
 * 规则写在这一层而不是 prompt 里：**能用工具层挡住的，就不要指望模型记得住。**
 */

import {
  InvariantViolationError,
  isPromotionTriggerCode,
} from '../kernel/index.ts';
import type {
  AcceptanceResult,
  ComplexityAssessment,
  Attempt,
  AttemptEndReason,
  AttemptKind,
  BlockedRecord,
  EscalationBody,
  EvidenceKind,
  EvidenceRecord,
  ExecutionResultBody,
  FinalReview,
  FinalReviewAuthority,
  IndependentReviewBlockReason,
  IndependentReviewL2Ref,
  IndependentReviewRecord,
  IndependentReviewVerdict,
  Mission,
  MissionContract,
  MissionExecutionMode,
  MissionResultBody,
  OriginChannel,
  PlanBody,
  Project,
  PromotionRecord,
  PromotionStatus,
  PromotionTokenUsageSnapshot,
  PromotionTriggerCode,
  PromotionUnknownDimension,
  PromotionUsageSnapshot,
  PromotionWorkspaceRevision,
  ReviewAuthority,
  ReviewRecord,
  RunKind,
  TokenUsage,
  UsedProfile,
  ValidationReport,
  ValidationCheckResult,
  WaitReason,
  WorkItem,
  WorkOrder,
  WorkspaceRef,
} from '../kernel/index.ts';
import type {
  ActivityEvent,
  ActivityLog,
  Clock,
  CommandTransaction,
  ContextMetricsV1,
  DecisionHook,
  DecisionProvider,
  FencedCommandTransaction,
  IdGenerator,
  PostExecutionEvaluator,
  ProjectRepository,
} from './ports.ts';
import type { ClaimFence } from './durable-scheduler.ts';
import {
  POST_EXECUTION_SHADOW_EVENT_KIND,
  postExecutionInputFrom,
  recordPostExecutionShadow,
} from './post-execution-shadow.ts';
import type { DeliveryRepository } from './delivery.ts';
import { escalationDeliveryKey, resultDeliveryKey } from './delivery.ts';
import type { WorkspaceManager } from './workspace.ts';
import type { ArtifactStore } from './artifact-store.ts';
import type { CommandRunner } from './validation/ports.ts';
import { VALIDATION_POLICY_REVISION } from './validation/engine.ts';
import { lightweightGateTrigger } from './promotion/lightweight-gate.ts';
import { redactSecrets, redactSecretsDeep } from './redact.ts';
import { collectAttemptLiveTail, mergeAttemptOutput, type LiveOutput } from './live.ts';
import { evaluatePolicy, POLICY_ACTION, POLICY_REASON } from './policy-engine.ts';
import {
  HA_AUTHORITY_CODE,
  HA_AUTHORITY_ENV,
  HaAuthorityError,
  loadHaAuthorityConfig,
  matchHaRelease,
  type HaAuthorityConfig,
} from './ha-authority-config.ts';
import {
  applyMemoryDelta,
  plannedMemoryFiles,
  readProjectMemory,
  writeVibe,
} from './project-memory.ts';
import { runDecisionShadow } from './decision-shadow-runner.ts';
import {
  assertNoCallerRouteOverride,
  ClassifiedMissionInputError,
  parseComplexityAssessmentStrict,
  parseTaskFactsStrict,
} from './classified-mission-intake.ts';
import { classifyTask, type ClassificationResult } from './task-classifier.ts';
import {
  buildContextBundle,
  projectStartupBriefFields,
  type BoundWorkItem,
  type ContractCheck,
  type ContextBundle,
  type WorkItemIndexEntry,
} from './context-builder.ts';
import {
  anyHardAuthoritativeExceeded,
  budgetThresholdCrossings,
  buildBudgetUsageSnapshot,
  countAuthoritativeCommands,
  countAuthoritativeRounds,
  evaluateExecutionBudget,
  formatHardBudgetExceededDetail,
  hardExceededVerdicts,
  projectAuthoritativeWallClockMs,
  type BudgetEvaluation,
  type BudgetUsageSnapshot,
} from './budget-usage.ts';




/** 平台规则被违反（区别于领域流转错误）。 */
export { PlatformRuleError } from './platform/context.ts';
















/**
 * 终审入口求一次策略。结论必须与现网相同：HA 机器终审仍是
 * HIGH_ASSURANCE_NEEDS_HUMAN，其它允许路径不改对外错误码。
 */
function assertFinalizePolicy(
  input: Parameters<typeof evaluatePolicy>[0],
  haHumanMessage: string,
): void {
  const verdict = evaluatePolicy(input);
  if (verdict.decision === 'allow') return;
  if (verdict.reason.code === POLICY_REASON.HA_MACHINE_FINALIZE_DENIED) {
    throw new PlatformRuleError('HIGH_ASSURANCE_NEEDS_HUMAN', haHumanMessage);
  }
  throw new PlatformRuleError('POLICY_DENIED', verdict.reason.detail);
}










export class Platform {
  #context: PlatformContext;
  get #projects(): ProjectRepository { return this.#context.projects; }
  get #activity(): ActivityLog { return this.#context.activity; }
  get #ids(): IdGenerator { return this.#context.ids; }
  get #deliveries(): DeliveryRepository { return this.#context.deliveries; }
  get #workspace(): WorkspaceManager | undefined { return this.#context.workspace; }
  get #artifacts(): ArtifactStore { return this.#context.artifacts; }
  get #clock(): Clock { return this.#context.clock; }
  get #decisionProvider(): DecisionProvider | undefined { return this.#context.decisionProvider; }
  get #decisionHooks(): ReadonlySet<DecisionHook> { return this.#context.decisionHooks; }
  get #postExecutionEvaluator(): PostExecutionEvaluator | undefined { return this.#context.postExecutionEvaluator; }
  get #transaction(): CommandTransaction | undefined { return this.#context.transaction; }
  get #validation(): PlatformValidationDeps | undefined { return this.#context.validation; }
  get #haAuthorityFile(): string | undefined { return this.#context.haAuthorityFile; }
  get #live(): LiveOutput | undefined { return this.#context.live; }

  constructor(deps: PlatformDeps) {
    this.#context = new PlatformContext(deps);
  }

  /* =============================== L3 面 =============================== */

  async createMission(input: CreateMissionInput): Promise<{ missionId: string }> {
    // 单事务命令（C4）：状态改动与事件一起提交，或者一个都不落。
    return this.#tx(() => this.#createMission(input));
  }

  async recordStandardFallbackRoute(
    missionId: string,
    input: {
      classification: ClassificationResult;
      fallbackReason: string;
      assessment?: ComplexityAssessment;
    },
  ): Promise<void> {
    return missionIntake.recordStandardFallbackRoute(this.#context, { createMission: (input) => this.createMission(input), recordWorkspace: (id, ref) => this.recordWorkspace(id, ref) }, missionId, input);
  }

  async #createMission(input: CreateMissionInput): Promise<{ missionId: string }> {
    return missionIntake.createMission(this.#context, { createMission: (input) => this.createMission(input), recordWorkspace: (id, ref) => this.recordWorkspace(id, ref) }, input);
  }

  /**
   * Fast Lane / Standard classified 入口。
   *
   * 顺序：assert override → strict parse → classify → route guards
   * （**先于** ensureProject / id 分配，拒绝路径不留空 Project）→ 创建 → 单次 save → 审计。
   * executionMode / runKind **只**取 classifier.recommended。
   */
  async createClassifiedMission(
    input: CreateClassifiedMissionInput,
  ): Promise<CreateClassifiedMissionResult> {
    // 单事务命令（C4）：状态改动与事件一起提交，或者一个都不落。
    return this.#tx(() => this.#createClassifiedMission(input));
  }

  async #createClassifiedMission(
    input: CreateClassifiedMissionInput,
  ): Promise<CreateClassifiedMissionResult> {
    return missionIntake.createClassifiedMission(this.#context, { createMission: (input) => this.createMission(input), recordWorkspace: (id, ref) => this.recordWorkspace(id, ref) }, input);
  }

  /**
   * 再跑一遍同一个任务。
   *
   * **另起一条 Mission，契约一字不改地抄过来**，而不是把原来那条洗干净重用。
   * 理由是"能比较"：每次运行要有自己那份 attempt、用量、耗时、结束原因，
   * 横着摆才看得出"换了协调者模型之后便宜了没有"。洗掉重用会把上一次的
   * 记录抹了，而那正是要比的东西。
   *
   * 抄的是**当前生效的契约**（可能已经改到 r2/r3），不是 r1：重跑的意思是
   * "照现在的要求再来一次"。
   *
   * 不碰任何不变量：它就是一次普通的 createMission。同 Project 的改动名额
   * 仍然一次只给一条——想并行跑多个配置的话，那条限制要单独拆（它现在把
   * "正在改代码"和"会把改动合回去"混成了一件事），不在这里顺手改。
   */
  async rerunMission(
    missionId: string,
    options?: { newMissionId?: string; baseRevision?: string },
  ): Promise<{
    missionId: string;
    rerunOf: string;
    contractRevision: number;
    /** 钉住的分叉基线。源头没记过工作区时为 undefined。 */
    baseRevision: string | undefined;
    /**
     * 源头那次的产出**已经落地进项目了**。
     *
     * 这时候这次重跑不是干净的对照：答案就摆在项目的工作区里，agent 读一眼
     * 就有。实测 P1-single 正是这么干的——它 read 了主仓库的 profile-audit.ts
     * 和 .test.ts，还 git show 了那次交付的提交。**它不是在解题，是在抄**，
     * 而两份记录看上去都完整自洽。
     *
     * 隔离做不到（agent 用绝对路径就能越出 worktree），所以至少要**说出来**：
     * 拿这样一次运行去和源头比成本，比出来的数是假的。
     */
    sourceAlreadyLanded: boolean;
  }> {
    // 单事务命令（C4）：状态改动与事件一起提交，或者一个都不落。
    return this.#tx(() => this.#rerunMission(missionId, options));
  }

  async #rerunMission(
    missionId: string,
    options?: { newMissionId?: string; baseRevision?: string },
  ): Promise<{
    missionId: string;
    rerunOf: string;
    contractRevision: number;
    /** 钉住的分叉基线。源头没记过工作区时为 undefined。 */
    baseRevision: string | undefined;
    /**
     * 源头那次的产出**已经落地进项目了**。
     *
     * 这时候这次重跑不是干净的对照：答案就摆在项目的工作区里，agent 读一眼
     * 就有。实测 P1-single 正是这么干的——它 read 了主仓库的 profile-audit.ts
     * 和 .test.ts，还 git show 了那次交付的提交。**它不是在解题，是在抄**，
     * 而两份记录看上去都完整自洽。
     *
     * 隔离做不到（agent 用绝对路径就能越出 worktree），所以至少要**说出来**：
     * 拿这样一次运行去和源头比成本，比出来的数是假的。
     */
    sourceAlreadyLanded: boolean;
  }> {
    return missionIntake.rerunMission(this.#context, { createMission: (input) => this.createMission(input), recordWorkspace: (id, ref) => this.recordWorkspace(id, ref) }, missionId, options);
  }

  async listRuns(missionId: string): Promise<RunSummary[]> {
    return views.listRuns(this.#context, missionId);
  }

  async reviseContract(
    missionId: string,
    contract: MissionContract,
  ): Promise<{ contractRevision: number }> {
    // 单事务命令（C4）：状态改动与事件一起提交，或者一个都不落。
    return this.#tx(() => this.#reviseContract(missionId, contract));
  }

  async #reviseContract(
    missionId: string,
    contract: MissionContract,
  ): Promise<{ contractRevision: number }> {
    return missionLifecycle.reviseContract(this.#context, (id, answer) => this.#answerEscalation(id, answer), missionId, contract);
  }
  /* ========================= Attempt 生命周期 ========================= */

  async startCoordinatorAttempt(
    missionId: string,
    profile?: UsedProfile,
    claim?: QueueClaimIdentity,
  ): Promise<{ attemptId: string }> {
    // 队列领取与 attempt.started 必须同事务：标记按 attemptId 可查，重启后仍能认出队列 Attempt。
    return this.#txFenced(claim, () => this.#startCoordinatorAttempt(missionId, profile, claim));
  }

  async #startCoordinatorAttempt(
    missionId: string,
    profile?: UsedProfile,
    claim?: QueueClaimIdentity,
  ): Promise<{ attemptId: string }> {
    return attempts.startCoordinatorAttempt(this.#context, missionId, profile, claim);
  }

  async startExecutorAttempt(
    missionId: string,
    workItemId: string,
    profile?: UsedProfile,
    claim?: QueueClaimIdentity,
  ): Promise<{ attemptId: string }> {
    // 队列领取与 attempt.started 必须同事务：标记按 attemptId 可查，重启后仍能认出队列 Attempt。
    return this.#txFenced(claim, () => this.#startExecutorAttempt(missionId, workItemId, profile, claim));
  }

  async #startExecutorAttempt(
    missionId: string,
    workItemId: string,
    profile?: UsedProfile,
    claim?: QueueClaimIdentity,
  ): Promise<{ attemptId: string }> {
    return attempts.startExecutorAttempt(this.#context, missionId, workItemId, profile, claim);
  }

  /**
   * 从独立检视候选里开一张 independent_reviewer Attempt。
   *
   * 不开时 Mission 停在 awaiting_review，并把原因写进可查询字段；
   * 绝不拿协调者自己的 profile 顶上。E2 不从 runMission 自动调用。
   */
  async startIndependentReviewerAttempt(
    missionId: string,
    candidates: readonly UsedProfile[],
    claim?: QueueClaimIdentity,
  ): Promise<{ attemptId: string; profileId: string }> {
    // 挡下来的原因必须先作为一次成功提交落库，再把拒绝抛给调用方。
    // 若在同一事务里抛错，文件/PG 都会回滚，待检视原因查询不到。
    const result = await this.#txFenced(claim, () =>
      this.#startIndependentReviewerAttempt(missionId, candidates, claim),
    );
    if (!result.ok) {
      throw new PlatformRuleError(result.code, result.detail);
    }
    return { attemptId: result.attemptId, profileId: result.profileId };
  }

  async #startIndependentReviewerAttempt(
    missionId: string,
    candidates: readonly UsedProfile[],
    claim?: QueueClaimIdentity,
  ): Promise<
    | { ok: true; attemptId: string; profileId: string }
    | { ok: false; code: string; detail: string }
  > {
    return independentReview.startIndependentReviewerAttempt(this.#context, missionId, candidates, claim);
  }

  async getMissionReviewBundle(
    missionId: string,
    attemptId: string,
  ): Promise<{
    missionId: string;
    contractRevision: number;
    reviewedCommit: string;
    l2ItemResults: readonly {
      workItemId: string;
      submittedAttemptId?: string;
      reviewAttemptId?: string;
      verdict?: string;
      acceptanceResults?: unknown;
    }[];
    validationReportRefs: readonly { id: string }[];
  }> {
    return independentReview.getMissionReviewBundle(this.#context, missionId, attemptId);
  }

  /**
   * 该 Attempt 是否在 attempt.started 上带有持久队列标记。
   * HTTP finish 必须据此区分：队列不得在丢牌后走无 claim 旧路径。
   */
  async attemptRequiresQueueClaim(missionId: string, attemptId: string): Promise<boolean> {
    return this.#attemptHasQueueMark(missionId, attemptId);
  }

  async submitIndependentReview(
    missionId: string,
    attemptId: string,
    input: { readonly verdict: unknown; readonly reasons: unknown },
    claim?: QueueClaimIdentity,
  ): Promise<{ recorded: IndependentReviewRecord }> {
    return this.#attemptWrite(missionId, attemptId, claim, () => this.#submitIndependentReview(missionId, attemptId, input));
  }

  async #submitIndependentReview(
    missionId: string,
    attemptId: string,
    input: { readonly verdict: unknown; readonly reasons: unknown },
  ): Promise<{ recorded: IndependentReviewRecord }> {
    return independentReview.submitIndependentReview(this.#context, missionId, attemptId, input);
  }

  /**
   * 读取方判断「当前有效的 pass」：revision / HEAD / L2 / 报告任一变化即失效。
   * 同一证据下最新若是 send_back，不得回退到更早的 pass。HA 受控放行在合并前核对这一份。
   */
  async effectiveIndependentReviewPass(
    missionId: string,
  ): Promise<IndependentReviewRecord | undefined> {
    return independentReview.effectiveIndependentReviewPass(this.#context, missionId);
  }

  async #currentHaValidationReport(
    missionId: string,
    head: string,
    fingerprint: string,
    contractRevision: number,
  ): Promise<
    | {
        id: string;
        passed: boolean;
        workItemIds?: readonly string[];
        commands?: readonly { argv: readonly string[]; timeoutMs: number }[];
      }
    | undefined
  > {
    return independentReview.currentHaValidationReport(this.#context, missionId, head, fingerprint, contractRevision);
  }

  #parseHaWorkItemIds(value: unknown): readonly string[] | undefined {
    return independentReview.parseHaWorkItemIds(this.#context, value);
  }

  #parseHaCommands(
    value: unknown,
  ): readonly { argv: readonly string[]; timeoutMs: number }[] | undefined {
    return independentReview.parseHaCommands(this.#context, value);
  }

  #frozenHaCommands(mission: Mission): { argv: string[]; timeoutMs: number }[] {
    return independentReview.frozenHaCommands(this.#context, mission);
  }

  #sameHaCommands(
    left: readonly { argv: readonly string[]; timeoutMs: number }[],
    right: readonly { argv: readonly string[]; timeoutMs: number }[],
  ): boolean {
    return independentReview.sameHaCommands(this.#context, left, right);
  }

  #haReuseMatches(
    meta: {
      workItemIds?: readonly string[];
      commands?: readonly { argv: readonly string[]; timeoutMs: number }[];
    },
    report: ValidationReport,
    activeIds: readonly string[],
    frozen: readonly { argv: readonly string[]; timeoutMs: number }[],
  ): boolean {
    return independentReview.haReuseMatches(this.#context, meta, report, activeIds, frozen);
  }

  #independentReviewOpenBlock(
    mission: Mission,
    _candidates: readonly UsedProfile[],
  ): { reason: IndependentReviewBlockReason; code: string; detail: string } | undefined {
    return independentReview.independentReviewOpenBlock(this.#context, mission, _candidates);
  }

  /**
   * 历史参与者的 profileId 集合。任一缺 profile 则无法证明独立，返回 undefined。
   */
  #participantProfileIds(mission: Mission): Set<string> | undefined {
    return independentReview.participantProfileIds(this.#context, mission);
  }

  #missionWorkspaceCwd(mission: Mission): string | undefined {
    return independentReview.missionWorkspaceCwd(this.#context, mission);
  }

  async #missionReviewedCommit(mission: Mission): Promise<string> {
    return independentReview.missionReviewedCommit(this.#context, mission);
  }

  #l2ReviewSnapshot(mission: Mission): {
    fingerprint: string;
    refs: IndependentReviewL2Ref[];
    validationReportId?: string;
    items: {
      workItemId: string;
      submittedAttemptId?: string;
      reviewAttemptId?: string;
      verdict?: string;
      acceptanceResults?: unknown;
    }[];
  } {
    return independentReview.l2ReviewSnapshot(this.#context, mission);
  }

  #l2RefsBelongToMission(mission: Mission, refs: readonly IndependentReviewL2Ref[]): boolean {
    return independentReview.l2RefsBelongToMission(this.#context, mission, refs);
  }

  /**
   * 结束一次尝试。
   *
   * `no_structured_result` 与 `upstream_failure` 都记为失败，但**分别记原因**：
   * 上游失败允许换候选重试，"跑完却没提交"不允许——换一个再赌一次只会
   * 烧配额，不产生新信息。调度器据此分流。
   */
  async finishAttempt(
    missionId: string,
    attemptId: string,
    outcome: {
      endedBy: AttemptEndReason;
      usage?: TokenUsage;
      failureMessage?: string;
      /** 运行时留下的续跑句柄。落库才能跨进程续上。 */
      resumeRef?: string;
      /** 这一跳的原始输出（尾部）。Timeline 第三层用。 */
      output?: string;
      /** 这一跳调过的工具名序列。Timeline 第二层用。 */
      toolCalls?: readonly string[];
      /** 运行时实际解析到的身份（S13.3）。 */
      resolvedProfile?: {
        readonly revision: string;
        readonly resolved: readonly { readonly key: string; readonly value: string }[];
      };
      /** 不可信采集摘要。校验失败则忽略，不挡旧收尾。 */
      contextMetrics?: unknown;
    },
    claim?: QueueClaimIdentity,
  ): Promise<void> {
    // 单事务命令（C4）：状态改动与事件一起提交，或者一个都不落。
    return this.#attemptWrite(missionId, attemptId, claim, () => this.#finishAttempt(missionId, attemptId, outcome));
  }

  async #finishAttempt(
    missionId: string,
    attemptId: string,
    outcome: {
      endedBy: AttemptEndReason;
      usage?: TokenUsage;
      failureMessage?: string;
      /** 运行时留下的续跑句柄。落库才能跨进程续上。 */
      resumeRef?: string;
      /** 这一跳的原始输出（尾部）。Timeline 第三层用。 */
      output?: string;
      /** 这一跳调过的工具名序列。Timeline 第二层用。 */
      toolCalls?: readonly string[];
      /** 运行时实际解析到的身份（S13.3）。 */
      resolvedProfile?: {
        readonly revision: string;
        readonly resolved: readonly { readonly key: string; readonly value: string }[];
      };
      contextMetrics?: unknown;
    },
  ): Promise<void> {
    return attempts.finishAttempt(this.#context, missionId, attemptId, outcome);
  }

  /**
   * 给一次在途尝试续租。
   *
   * 调度器按固定间隔打。心跳落到状态里，别的进程才看得见"这条还有人在跑"——
   * 没有它，启动收敛只能靠"我刚起来"来猜，而那个前提在多进程下是错的。
   *
   * 找不到 attempt 或它已经收过尾就静默返回：心跳是尽力而为的旁路信号，
   * 不该让一次收尾竞态把整跳搞失败。
   */
  async beatAttempt(missionId: string, attemptId: string, owner?: string): Promise<void> {
    // 单事务命令（C4）：状态改动与事件一起提交，或者一个都不落。
    return this.#tx(() => this.#beatAttempt(missionId, attemptId, owner));
  }

  async #beatAttempt(missionId: string, attemptId: string, owner?: string): Promise<void> {
    return attempts.beatAttempt(this.#context, missionId, attemptId, owner);
  }

  /**
   * L3 作废一个工作项（S14.6 里的 cancel-replace）。
   *
   * 场景：契约改了，协调者照新契约另拆了一批工单，旧的那些还挂在 dispatched 上。
   * 不作废的话调度器会把它们也跑一遍——做的是明确不要的那件事，还要花一次
   * 执行者的钱。实测撞到过。
   *
   * 复用 blocked 而不是新造状态：它的含义本来就是"这张工单不成立，需要有人
   * 处理"，与这里完全吻合。**不为每种原因新造互斥状态**是 S06.1 的要求，
   * 区分靠 blocked 记录里写的是谁作废的。
   */
  async retireWorkItem(
    missionId: string,
    workItemId: string,
    reason: string,
  ): Promise<{ status: string }> {
    // 单事务命令（C4）：状态改动与事件一起提交，或者一个都不落。
    return this.#tx(() => this.#retireWorkItem(missionId, workItemId, reason));
  }

  async #retireWorkItem(
    missionId: string,
    workItemId: string,
    reason: string,
  ): Promise<{ status: string }> {
    return missionControl.retireWorkItem(this.#context, (mission, item) => this.#criteriaFailureStop(mission, item), missionId, workItemId, reason);
  }

  /**
   * 记下 Mission 为什么停着（S06.1 的第二条轴）。
   *
   * 同样是 executing，"正在跑"和"候选全在冷却"是两回事；界面上分不出来，
   * 人就只能去翻日志。清掉传 undefined。
   */
  async setWaitReason(
    missionId: string,
    reason: WaitReason | undefined,
    detail?: string,
  ): Promise<void> {
    // 单事务命令（C4）：状态改动与事件一起提交，或者一个都不落。
    return this.#tx(() => this.#setWaitReason(missionId, reason, detail));
  }

  async #setWaitReason(
    missionId: string,
    reason: WaitReason | undefined,
    detail?: string,
  ): Promise<void> {
    return missionLifecycle.setWaitReason(this.#context, (id, answer) => this.#answerEscalation(id, answer), missionId, reason, detail);
  }
  /* =========================== 取消 / 暂停 =========================== */

  /**
   * 叫停一条 Mission（S12.2 / S14.5）。
   *
   * v1 只做"停止后续调度"：在途的 attempt 由调度器的 finally 正常收尾。
   * **不处理取消与 failover 之间那个微秒级的竞态**——那需要 fencing token，
   * 文档已经明确推迟。真撞上了的后果是多跑完一跳，不会破坏状态。
   */
  async cancelMission(missionId: string, reason?: string): Promise<{ status: string }> {
    // 单事务命令（C4）：状态改动与事件一起提交，或者一个都不落。
    return this.#tx(() => this.#cancelMission(missionId, reason));
  }

  async #cancelMission(missionId: string, reason?: string): Promise<{ status: string }> {
    return missionLifecycle.cancelMission(this.#context, (id, answer) => this.#answerEscalation(id, answer), missionId, reason);
  }
  /** 暂停：调度器不再碰它，但阶段保持原样。 */
  async pauseMission(missionId: string): Promise<{ paused: boolean }> {
    // 单事务命令（C4）：状态改动与事件一起提交，或者一个都不落。
    return this.#tx(() => this.#pauseMission(missionId));
  }

  async #pauseMission(missionId: string): Promise<{ paused: boolean }> {
    return missionLifecycle.pauseMission(this.#context, (id, answer) => this.#answerEscalation(id, answer), missionId);
  }
  async parkMission(
    missionId: string,
    input: { reason: string; reviewer: string },
  ): Promise<{ parked: boolean; reason: string }> {
    return missionLifecycle.parkMission(this.#context, (id, answer) => this.#answerEscalation(id, answer), missionId, input);
  }
  async resumeParkedMission(
    missionId: string,
    input: { reason: string; reviewer: string; answer?: string },
  ): Promise<{ parked: boolean; conflictFiles: string[]; targetHead: string }> {
    return missionLifecycle.resumeParkedMission(this.#context, (id, answer) => this.#answerEscalation(id, answer), missionId, input);
  }
  async resumeMission(missionId: string): Promise<{ paused: boolean }> {
    // 单事务命令（C4）：状态改动与事件一起提交，或者一个都不落。
    return this.#tx(() => this.#resumeMission(missionId));
  }

  async #resumeMission(missionId: string): Promise<{ paused: boolean }> {
    return missionLifecycle.resumeMission(this.#context, (id, answer) => this.#answerEscalation(id, answer), missionId);
  }
  async getProjectContext(missionId: string, slug?: string) {
    return views.getProjectContext(this.#context, missionId, slug);
  }

  /* ============================== 读模型 ============================== */

  async listProjects() {
    return views.listProjects(this.#context);
  }

  /**
   * 用量聚合（S11.5）。
   *
   * 四个维度：Project / Mission / Role / 运行时身份。最后一个是按 attempt 上
   * 冻结的**事实键**分组的——适配层填的是 provider / model，所以"按 Provider
   * 聚合""按 Model 聚合"都落在这里，而这一层不用认识这两个词，接第二个
   * agent 时也不用改。
   *
   * 只统计**冻结过身份**的 attempt：没冻的（老数据、或运行时没报）归进
   * `unattributed`，而不是摊到某个身份上——摊给谁都是编的。
   */
  async getUsage(filter?: { projectId?: string; missionId?: string }): Promise<UsageReport> {
    return budgetUsage.getUsage(this.#context, filter);
  }

  async listMissions(): Promise<MissionSummary[]> {
    return views.listMissions(this.#context);
  }

  async getAttemptDetail(missionId: string, attemptId: string) {
    return views.getAttemptDetail(this.#context, missionId, attemptId);
  }

  async getActivity(missionId: string) {
    return views.getActivity(this.#context, missionId);
  }

  /** Persist the dispatched work-item snapshot associated with an observed Git conflict. */
  async recordConflictDispatchBarrier(
    missionId: string,
    conflictFiles: readonly string[],
  ): Promise<readonly string[]> {
    return this.#tx(async () => {
      const { mission } = await this.#locate(missionId);
      const events = await this.#activity.list(missionId);
      let barrier: readonly string[] | undefined;
      for (const event of events) {
        if (event.kind === 'mission.conflict_dispatch_barrier') {
          const data = event.data as { workItemIds?: unknown };
          barrier = Array.isArray(data.workItemIds) ? data.workItemIds as string[] : [];
        } else if (event.kind === 'mission.conflict_dispatch_cleared') {
          barrier = undefined;
        }
      }
      if (conflictFiles.length === 0) {
        if (barrier !== undefined) await this.#event(mission, 'mission.conflict_dispatch_cleared', {});
        return [];
      }
      if (barrier !== undefined) return [...barrier];
      const workItemIds = mission.workItems.filter((item) => item.status === 'dispatched').map((item) => item.id);
      await this.#event(mission, 'mission.conflict_dispatch_barrier', {
        conflictFiles: [...conflictFiles],
        workItemIds,
      });
      return workItemIds;
    });
  }

  /* ============================ L2 协调者面 ============================ */

  async getMissionView(missionId: string): Promise<MissionView> {
    return views.getMissionView(this.#context, { workItemValidationReportViews: (m, e) => this.#workItemValidationReportViews(m, e), haReviewHold: (m) => this.#haReviewHold(m) }, missionId);
  }

  async getAgentMissionView(missionId: string): Promise<AgentMissionView> {
    return views.getAgentMissionView(this.#context, { workItemValidationReportViews: (m, e) => this.#workItemValidationReportViews(m, e), haReviewHold: (m) => this.#haReviewHold(m) }, missionId);
  }

  async #haReviewHold(
    mission: Mission,
  ): Promise<'pending_dispatch' | 'in_review' | 'pending_release' | 'fault'> {
    return haValidation.haReviewHold(this.#context, mission);
  }

  /**
   * HA：在当前 HEAD 上用冻结工单跑确定性验证，覆盖全部非 retired 工作项。
   * 已有匹配当前证据且落盘的报告则复用，避免重跑清掉有效证据。
   */
  async runHaDeterministicValidation(
    missionId: string,
    _cwd: string,
  ): Promise<{ reportId: string; passed: boolean; reviewedCommit: string }> {
    return haValidation.runHaDeterministicValidation(this.#context, (id, reason, detail) => this.setWaitReason(id, reason, detail), missionId, _cwd);
  }

  /**
   * 开跑简报（S09.1 [MUST]）。
   *
   * 文档要求托管 agent **启动时直接获得** Role / Project / Contract 或 Work Order /
   * cwd / Project Rules / ContextRefs / 工具表 / ExecutionProfile。先前只有
   * 角色 prompt 是启动就给的，其余全靠 agent 自己调工具取——代价是实的：
   *
   *   - 每一跳都白花一轮工具调用去取本来就该给它的东西；
   *   - **执行者可能从头到尾没见过架构红线**。它的工具表里没有
   *     coagent_get_project_context，红线只有在协调者把它抄进工单时才到得了它手上，
   *     而红线是"项目不可协商的东西"。
   *
   * 按角色给不同的东西：协调者要契约与规划，执行者要工单。两边都要红线。
   */
  async getStartupBrief(
    missionId: string,
    attemptId: string,
    budget?: number,
    claim?: QueueClaimIdentity,
  ): Promise<{
    role: AttemptKind;
    projectId: string;
    missionId: string;
    status: string;
    /** 架构红线。两个角色都要——它是项目层面不可协商的东西。 */
    projectRules?: string;
    /**
     * 这台机器上会咬人的地方。**平台知道自己跑在什么系统上，agent 不知道。**
     *
     * 实测 P1：协调者写探针用了 `cat > /tmp/probe.mjs`，没成，接着 `pwd && ls`
     * 自己诊断、改用工作区相对路径——处理得很好，但那一个来回是白花的。
     * Windows 上 Git Bash 的 `/tmp` 和 Node 的 `/tmp` 不是同一个目录。
     *
     * 只说**会静默出错**的那几条。环境里的常识不用讲，讲多了就没人读了。
     */
    environmentNotes?: readonly string[];
    contract?: Readonly<MissionContract>;
    contractRevision?: number;
    plan?: Readonly<PlanBody>;
    planRevision?: number;
    workItem?: BoundWorkItem;
    /** L3 打回的理由。被打回之后重跑时，这是最该先看到的东西。 */
    finalReview?: Readonly<FinalReview>;
    /** 当前契约修订的核对结论；无当前修订核对时缺省，旧简报形状不变。 */
    contractCheck?: Readonly<ContractCheck>;
    /** 可追溯的角色视图；旧字段从这里投影，缺省语义保持不变。 */
    contextBundle: ContextBundle;
  }> {
    return startupBrief.getStartupBrief(this.#context, { workItemValidationReportViews: (m, e) => this.#workItemValidationReportViews(m, e) }, missionId, attemptId, budget, claim);
  }

  /**
   * 裁剪审计必须走队列写门禁：不经 #attemptWrite 的话，队列 Attempt 在丢牌后
   * 仍能记一条「已审计」，而控制面其它写已经被 fence 挡住。
   * 落盘失败要抛出去——调用方拿到裁剪简报却没有事件，等于声称已审计。
   */
  async #recordContextTruncated(
    missionId: string,
    attemptId: string,
    claim: QueueClaimIdentity | undefined,
    data: {
      readonly role: string;
      readonly budget: number;
      readonly estimatedBefore: number;
      readonly estimatedAfter: number;
      readonly omittedSources: readonly string[];
      readonly overflow: boolean;
      readonly remainingOverBudget: number;
    },
  ): Promise<void> {
    return startupBrief.recordContextTruncated(this.#context, missionId, attemptId, claim, data);
  }

  async getContract(missionId: string): Promise<{
    contract: Readonly<MissionContract> | undefined;
    contractRevision: number;
  }> {
    return views.getContract(this.#context, missionId);
  }

  /**
   * 协调者开工前的契约核对（Standard）。
   *
   * 为什么要这个口：第 33 波返工的三处源头都在检视者的票上（范围漏文件、
   * 没写输入位置、诊断错误），协调者本可以开工时就发现，却直接派工，
   * 执行者卡住后又原样重派。核对结论必须落成事件，会话被压缩或换人接手后
   * 才恢复得出「核过没有、核出什么」；判为 issues 时不能只记一条——只记不投，
   * 协调者被唤醒后只会再升级一次，所以走既有的可答复升级通道。
   */
  async submitContractCheck(
    missionId: string,
    attemptId: string,
    input: { verdict: 'ok' | 'issues'; summary: string; issues?: readonly string[] },
    claim?: QueueClaimIdentity,
  ): Promise<{ contractRevision: number; verdict: 'ok' | 'issues' }> {
    return escalations.submitContractCheck(this.#context, missionId, attemptId, input, claim);
  }

  /**
   * 只更新调查发现（S09.2 的 coagent_update_findings）。
   *
   * 落到同一份 Plan 上，但**不要求协调者把整份规划重写一遍**：调查途中它
   * 往往只是多知道了一件事，方向和决策都还没定。逼它连带重填 direction /
   * decisions，要么它编一个，要么它干脆不记——两种都比没有这个口更糟。
   */
  async updateFindings(
    missionId: string,
    attemptId: string,
    findings: string,
    rejectedHypotheses?: readonly string[],
    claim?: QueueClaimIdentity,
  ): Promise<{ planRevision: number }> {
    // 单事务命令（C4）：状态改动与事件一起提交，或者一个都不落。
    return this.#attemptWrite(missionId, attemptId, claim, () => this.#updateFindings(missionId, attemptId, findings, rejectedHypotheses));
  }

  async #updateFindings(
    missionId: string,
    attemptId: string,
    findings: string,
    rejectedHypotheses?: readonly string[],
  ): Promise<{ planRevision: number }> {
    return planning.updateFindings(this.#context, missionId, attemptId, findings, rejectedHypotheses);
  }

  async updatePlan(
    missionId: string,
    attemptId: string,
    plan: PlanBody,
    claim?: QueueClaimIdentity,
  ): Promise<{ planRevision: number }> {
    // 单事务命令（C4）：状态改动与事件一起提交，或者一个都不落。
    return this.#attemptWrite(missionId, attemptId, claim, () => this.#updatePlan(missionId, attemptId, plan));
  }

  async #updatePlan(
    missionId: string,
    attemptId: string,
    plan: PlanBody,
  ): Promise<{ planRevision: number }> {
    return planning.updatePlan(this.#context, missionId, attemptId, plan);
  }

  /**
   * 创建工作项。**没有 Plan 就拒绝** —— 会话可能被压缩或换人接手，
   * 只有写回平台的结论才是权威。这条用工具层强制，不靠提示。
   */
  async createWorkItem(
    missionId: string,
    attemptId: string,
    input: { title: string; order: WorkOrder; workItemId?: string },
    claim?: QueueClaimIdentity,
    options?: { viaCoordinatorTool?: boolean },
  ): Promise<{ workItemId: string; warnings: readonly WorkOrderStandardWarning[] }> {
    // 单事务命令（C4）：状态改动与事件一起提交，或者一个都不落。
    return this.#attemptWrite(missionId, attemptId, claim, () =>
      this.#createWorkItem(missionId, attemptId, input, options),
    );
  }

  async #createWorkItem(
    missionId: string,
    attemptId: string,
    input: { title: string; order: WorkOrder; workItemId?: string },
    options?: { viaCoordinatorTool?: boolean },
  ): Promise<{ workItemId: string; warnings: readonly WorkOrderStandardWarning[] }> {
    return workOrders.createWorkItem(this.#context, missionId, attemptId, input, options);
  }

  /**
   * 修订一张还没定稿的工单。
   *
   * 工单冻结后原本只能作废重建（实测 PLAT3 作废 9 个，其中 7 个曾卡住），
   * 但唤醒说明又要求「把工单改对再重新派发」——两者对不上。这里补上入口：
   * 只要工单**没在跑**（created / rejected / blocked），协调者可以整份替换。
   *
   * 身份只来自 Run Token 的 claim，body 里自述的角色一律不采信（#requireAttempt）。
   * 修订号在 kernel 里递增（r1 -> r2 …），平台只负责发事件、对比字段差异。
   */
  async reviseWorkOrder(
    missionId: string,
    attemptId: string,
    workItemId: string,
    order: WorkOrder,
    claim?: QueueClaimIdentity,
    options?: { viaCoordinatorTool?: boolean },
  ): Promise<{
    workItemId: string;
    revision: string;
    changedFields: readonly string[];
    warnings: readonly WorkOrderStandardWarning[];
  }> {
    // 单事务命令（C4）：状态改动与事件一起提交，或者一个都不落。
    return this.#attemptWrite(missionId, attemptId, claim, () =>
      this.#reviseWorkOrder(missionId, attemptId, workItemId, order, options),
    );
  }

  async #reviseWorkOrder(
    missionId: string,
    attemptId: string,
    workItemId: string,
    order: WorkOrder,
    options?: { viaCoordinatorTool?: boolean },
  ): Promise<{
    workItemId: string;
    revision: string;
    changedFields: readonly string[];
    warnings: readonly WorkOrderStandardWarning[];
  }> {
    return workOrders.reviseWorkOrder(this.#context, missionId, attemptId, workItemId, order, options);
  }

  /**
   * Lightweight 进程内：无 Coordinator/Plan 创建恰好一个 frozen WorkItem。
   * 不 startExecuting、不占 mutation slot、不建 Plan/Coordinator Attempt。
   * 仅供进程内 Orchestrator 调用；不进 HTTP/tools。
   * order.validation 可缺省/commands 可空（表示只跑 changed-paths）；规范化交给 WorkItem 构造器。
   */
  async createLightweightWorkItem(
    missionId: string,
    input: { readonly order: WorkOrder; readonly title?: string; readonly workItemId?: string },
  ): Promise<{ workItemId: string }> {
    // 单事务命令（C4）：状态改动与事件一起提交，或者一个都不落。
    return this.#tx(() => this.#createLightweightWorkItem(missionId, input));
  }

  async #createLightweightWorkItem(
    missionId: string,
    input: { readonly order: WorkOrder; readonly title?: string; readonly workItemId?: string },
  ): Promise<{ workItemId: string }> {
    return lightweightDispatch.createLightweightWorkItem(this.#context, (mission) => this.#requireLightweightMutationLane(mission), (mission) => this.#requireNoOpenDiagnosticEscalation(mission), (mission, project) => this.#acquireMutationSlotForDispatch(mission, project), missionId, input);
  }

  /**
   * Lightweight 进程内：占用 Project mutation slot 并 dispatch 唯一 WorkItem。
   * 复用 Standard 的 slot 规则；slot 后、dispatch 前 observational PRE_DISPATCH shadow
   *（无 attemptId，失败不阻断）。
   */
  async dispatchLightweightWorkItem(
    missionId: string,
    workItemId: string,
  ): Promise<{ dispatched: string }> {
    // 单事务命令（C4）：占名额、PRE shadow、派发一起提交。PRE shadow 缺省不开；开了事务最多多占一个超时。
    return this.#tx(() => this.#dispatchLightweightWorkItem(missionId, workItemId));
  }

  async #dispatchLightweightWorkItem(
    missionId: string,
    workItemId: string,
  ): Promise<{ dispatched: string }> {
    return lightweightDispatch.dispatchLightweightWorkItem(this.#context, (mission) => this.#requireLightweightMutationLane(mission), (mission) => this.#requireNoOpenDiagnosticEscalation(mission), (mission, project) => this.#acquireMutationSlotForDispatch(mission, project), missionId, workItemId);
  }

  /**
   * Lightweight 进程内：对 submitted WorkItem 跑注入的 validation.engine，
   * **先持久化 ValidationReport**，通过且 authority/linkage 一致后再 accept。
   * cwd 由 trusted WorkspaceManager.prepare() 注入；调用方不得传 report/authority/linkage。
   * order 必须存在；commands 缺省视为 []（仍跑 changed-paths）。
   */
  async validateAndAcceptLightweightWorkItem(input: {
    readonly missionId: string;
    readonly workItemId: string;
    readonly cwd: string;
  }): Promise<{ reportId: string; passed: boolean; status: string; held?: PromotionTriggerCode }> {
    return lightweightValidation.validateAndAcceptLightweightWorkItem(this.#context, (mission) => this.#requireLightweightMutationLane(mission), input);
  }

  /**
   * Lightweight 进程内：唯一 accepted WorkItem + durable validator report
   * 通过后，derive MissionResult 并 submitForReview（不 complete）。
   * 仅供进程内 Orchestrator；不绑 HTTP/tools。
   */
  async submitLightweightMissionForReview(
    missionId: string,
  ): Promise<{ status: 'awaiting_review'; reportId: string }> {
    // 单事务命令（C2）：改状态、记 mission_result.submitted、建投递、记 delivery.created 一起提交。
    return this.#tx(() => this.#submitLightweightMissionForReview(missionId));
  }

  async #submitLightweightMissionForReview(
    missionId: string,
  ): Promise<{ status: 'awaiting_review'; reportId: string }> {
    return lightweightSubmission.submitLightweightMissionForReview(this.#context, (mission) => this.#requireLightweightMutationLane(mission), missionId);
  }

  async dispatchWorkItems(
    missionId: string,
    attemptId: string,
    workItemIds: readonly string[],
    claim?: QueueClaimIdentity,
  ): Promise<{ dispatched: readonly string[] }> {
    // 单事务命令（C4）：占名额、PRE shadow、派发一起提交。PRE shadow 缺省不开；开了事务最多多占一个超时。
    return this.#attemptWrite(missionId, attemptId, claim, () => this.#dispatchWorkItems(missionId, attemptId, workItemIds));
  }

  async #dispatchWorkItems(
    missionId: string,
    attemptId: string,
    workItemIds: readonly string[],
  ): Promise<{ dispatched: readonly string[] }> {
    return workItemDispatch.dispatchWorkItems(this.#context, (mission) => this.#requireNoOpenDiagnosticEscalation(mission), (mission, project) => this.#acquireMutationSlotForDispatch(mission, project), missionId, attemptId, workItemIds);
  }

  async reviewExecutionResult(
    missionId: string,
    attemptId: string,
    input: {
      workItemId: string;
      verdict: 'accept' | 'reject';
      reasons: readonly string[];
      requiredChanges: readonly string[];
      /** 工单 acceptance 逐条的结论（方案 §11）；工单有验收标准时必填。 */
      acceptanceResults?: readonly AcceptanceResult[];
    },
    claim?: QueueClaimIdentity,
  ): Promise<{ status: string }> {
    // 单事务命令（C4）：状态改动与事件一起提交，或者一个都不落。
    return this.#attemptWrite(missionId, attemptId, claim, () => this.#reviewExecutionResult(missionId, attemptId, input));
  }

  async #reviewExecutionResult(
    missionId: string,
    attemptId: string,
    input: {
      workItemId: string;
      verdict: 'accept' | 'reject';
      reasons: readonly string[];
      requiredChanges: readonly string[];
      /** 工单 acceptance 逐条的结论（方案 §11）；工单有验收标准时必填。 */
      acceptanceResults?: readonly AcceptanceResult[];
    },
  ): Promise<{ status: string }> {
    return workItemReview.reviewExecutionResult(this.#context, (mission, item) => this.#criteriaFailureStop(mission, item), missionId, attemptId, input);
  }

  async escalateToL3(
    missionId: string,
    attemptId: string,
    body: Omit<EscalationBody, 'attemptId'>,
    claim?: QueueClaimIdentity,
  ): Promise<void> {
    // 单事务命令（C2）：记下升级、记 escalated、建投递、记 delivery.created 一起提交。
    return this.#attemptWrite(missionId, attemptId, claim, () => this.#escalateToL3(missionId, attemptId, body));
  }

  async #escalateToL3(
    missionId: string,
    attemptId: string,
    body: Omit<EscalationBody, 'attemptId'>,
  ): Promise<void> {
    return escalations.escalateToL3(this.#context, missionId, attemptId, body);
  }

  /**
   * 记一条 Mission 升级并投递一次。协调者 escalateToL3 与轻量 reportBlocked 共用：
   * 分开写会变成两次升级/两封信，L3 对同一提问会看到两张单。
   */
  async #recordEscalationAndDeliver(
    mission: Mission,
    body: EscalationBody,
    diagnostic?: CriteriaFailureDiagnostic,
  ): Promise<void> {
    return escalations.recordEscalationAndDeliver(this.#context, mission, body, diagnostic);
  }

  /** 停派门禁。只读无副作用，故可放在抢名额之前——否则「停了」变成「停了一半」。 */
  async #requireNoOpenDiagnosticEscalation(mission: Mission): Promise<void> {
    return escalations.requireNoOpenDiagnosticEscalation(this.#context, mission);
  }
  /**
   * 一次失败之后：这条工作项关联的标准上是不是已连续三个不同工作项没过？是就开一张
   * 可答复的诊断卡（同一事务里提交）。失败入口必须在**自己那条事件之后**调。
   */
  async #criteriaFailureStop(mission: Mission, item: WorkItem): Promise<void> {
    return escalations.criteriaFailureStop(this.#context, mission, item);
  }

  /**
   * 交卷。**还有没验收的工作项就拒绝** —— 这是 dry-run 里暴露的缺口：
   * 只有一个工作项时不会出事，多个时协调者可能在还没验完就交卷。
   */
  async submitMissionResult(
    missionId: string,
    attemptId: string,
    body: MissionResultBody,
    claim?: QueueClaimIdentity,
  ): Promise<void> {
    // 单事务命令（C2）：改状态、记 mission_result.submitted、建投递、记 delivery.created 一起提交。
    return this.#attemptWrite(missionId, attemptId, claim, () => this.#submitMissionResult(missionId, attemptId, body));
  }

  async #submitMissionResult(
    missionId: string,
    attemptId: string,
    body: MissionResultBody,
  ): Promise<void> {
    return missionControl.submitMissionResult(this.#context, missionId, attemptId, body);
  }

  /** 记录本 Mission 的分支与基线。调度器开好工作区之后调一次。 */
  async recordWorkspace(
    missionId: string,
    ref: {
      projectRoot?: string;
      branch: string;
      baseRevision: string;
      targetBranch?: string;
    },
  ): Promise<void> {
    // 单事务命令（C4）：状态改动与事件一起提交，或者一个都不落。
    return this.#tx(() => this.#recordWorkspace(missionId, ref));
  }

  async #recordWorkspace(
    missionId: string,
    ref: {
      projectRoot?: string;
      branch: string;
      baseRevision: string;
      targetBranch?: string;
    },
  ): Promise<void> {
    const { mission } = await this.#locate(missionId);
    mission.recordWorkspace(ref);
  }

  /**
   * Trusted orchestration round-start fact (BUDGET-001-S2).
   *
   * Append-only ActivityLog event via the private trusted path. No Mission
   * snapshot counter, no caller-authored ActivityEvent payload, no HTTP/tool surface.
   * Orchestrator records this once per runMission loop iteration after preflight
   * gates and before any Lightweight / Executor / Coordinator hop.
   */
  async recordOrchestrationRoundStarted(missionId: string): Promise<void> {
    // 单事务命令（C4）：状态改动与事件一起提交，或者一个都不落。
    return this.#tx(() => this.#recordOrchestrationRoundStarted(missionId));
  }

  async #recordOrchestrationRoundStarted(missionId: string): Promise<void> {
    const { mission } = await this.#locate(missionId);
    await this.#event(mission, 'orchestration.round.started', { schemaVersion: 1 });
  }

  /**
   * Authoritative Mission budget evaluation (BUDGET-001-S5).
   *
   * Assembles usage from durable attempts + activity projections only.
   * Does not invent zeros for unknown rounds/wall/commands; does not supply
   * changedFiles unless a trusted diff list is passed (Orchestrator leaves it
   * omitted when Workspace.diff is not wired into the loop).
   */
  async evaluateMissionBudget(
    missionId: string,
    opts?: { readonly changedFiles?: readonly string[] },
  ): Promise<{
    readonly budgetPresent: boolean;
    readonly snapshot: BudgetUsageSnapshot;
    readonly evaluation: BudgetEvaluation;
  }> {
    return budgetUsage.evaluateMissionBudget(this.#context, missionId, opts);
  }

  /**
   * Durable once-per-dimension/threshold budget warnings (BUDGET-001-S5).
   *
   * Scans activity for existing `mission.budget.threshold` v1 rows so reruns
   * do not re-emit. unknown / not_in_force dimensions never emit.
   */
  async recordBudgetThresholdEvents(
    missionId: string,
    evaluation: BudgetEvaluation,
  ): Promise<void> {
    // 单事务命令（C4）：状态改动与事件一起提交，或者一个都不落。
    return this.#tx(() => this.#recordBudgetThresholdEvents(missionId, evaluation));
  }

  async #recordBudgetThresholdEvents(
    missionId: string,
    evaluation: BudgetEvaluation,
  ): Promise<void> {
    return budgetUsage.recordBudgetThresholdEvents(this.#context, missionId, evaluation);
  }

  /**
   * Platform-internal LW→Standard promotion after *this* process re-evaluates
   * authoritative hard budget exceedance (BUDGET-001-S5).
   *
   * Not a public caller-authored `budget_exceeded` path — see
   * {@link promoteMissionToStandard}, which still rejects that code.
   */
  async promoteLightweightForBudgetExceeded(
    missionId: string,
  ): Promise<{ changed: boolean; promotion: Readonly<PromotionRecord> }> {
    // 单事务命令（C4）：状态改动与事件一起提交，或者一个都不落。
    return this.#tx(() => this.#promoteLightweightForBudgetExceeded(missionId));
  }

  async #promoteLightweightForBudgetExceeded(
    missionId: string,
  ): Promise<{ changed: boolean; promotion: Readonly<PromotionRecord> }> {
    return promotion.promoteLightweightForBudgetExceeded(this.#context, missionId);
  }

  /** Detail string for Standard hard-budget wait (hard exceeded dims only). */
  formatExecutionBudgetExceededDetail(evaluation: BudgetEvaluation): string {
    return formatHardBudgetExceededDetail(evaluation);
  }

  /**
   * Trusted command-tracking cover (BUDGET-001-S4).
   *
   * Recorded when a Mission attempt receives runtime.capabilities v1 before any
   * tool.started. Envelope carries attemptId. No caller-authored payload.
   */
  async recordCommandTrackingEnabled(missionId: string, attemptId: string): Promise<void> {
    // 单事务命令（C4）：状态改动与事件一起提交，或者一个都不落。
    return this.#tx(() => this.#recordCommandTrackingEnabled(missionId, attemptId));
  }

  async #recordCommandTrackingEnabled(missionId: string, attemptId: string): Promise<void> {
    return commandTracking.recordCommandTrackingEnabled(this.#context, missionId, attemptId);
  }

  /**
   * Trusted command-start fact (BUDGET-001-S4).
   *
   * Adapter-classified activityClass === 'command' with a stable callId.
   * Hub never classifies by tool name. Envelope carries attemptId.
   */
  async recordCommandStarted(missionId: string, attemptId: string, callId: string): Promise<void> {
    // 单事务命令（C4）：状态改动与事件一起提交，或者一个都不落。
    return this.#tx(() => this.#recordCommandStarted(missionId, attemptId, callId));
  }

  async #recordCommandStarted(missionId: string, attemptId: string, callId: string): Promise<void> {
    return commandTracking.recordCommandStarted(this.#context, missionId, attemptId, callId);
  }

  /**
   * Trusted command-tracking breach (BUDGET-001-S4).
   *
   * Written when an attempt already covered by v1 later sees a missing/illegal
   * activityClass or an empty command callId — so projection fails closed to
   * unknown instead of undercounting.
   */
  async recordCommandTrackingInvalid(missionId: string, attemptId: string): Promise<void> {
    // 单事务命令（C4）：状态改动与事件一起提交，或者一个都不落。
    return this.#tx(() => this.#recordCommandTrackingInvalid(missionId, attemptId));
  }

  async #recordCommandTrackingInvalid(missionId: string, attemptId: string): Promise<void> {
    return commandTracking.recordCommandTrackingInvalid(this.#context, missionId, attemptId);
  }

  /**
   * L3 答复一条升级。
   *
   * 升级之后调度器是停着的（再叫协调者只会让它再升级一次）。答复落库之后
   * 协调者下一轮就能在 coagent_get_mission 里看到它，据此继续。
   */
  async answerEscalation(
    missionId: string,
    answer: string,
  ): Promise<{ question: string; answer: string }> {
    // 单事务命令（C4）：状态改动与事件一起提交，或者一个都不落。
    return this.#tx(() => this.#answerEscalation(missionId, answer));
  }

  async #answerEscalation(
    missionId: string,
    answer: string,
  ): Promise<{ question: string; answer: string }> {
    return escalations.answerEscalation(this.#context, missionId, answer);
  }

  /**
   * 轻量没有协调者可重派：只能在本事务里把「这条升级对应的」blocked 工单 dispatch。
   * 不能走 dispatchWorkItems（会要 coordinator attempt），也不能走 dispatchLightweightWorkItem
   * （只接受 created）。Standard 或对不上 attemptId 的项一律不动，避免误派。
   */
  async #redispatchLightweightBlockedAfterAnswer(
    mission: Mission,
    answered: Readonly<EscalationBody>,
  ): Promise<void> {
    return escalations.redispatchLightweightBlockedAfterAnswer(this.#context, mission, answered);
  }

  async getMissionDiff(
    missionId: string,
  ): Promise<{ stat: string; files: string[]; pendingMemory: string[] }> {
    return views.getMissionDiff(this.#context, missionId);
  }

  /**
   * L3 最终检视。
   *
   *   merge      —— 核对目标 HEAD 没变过之后落地，Mission 完成，名额释放
   *   send_back  —— 交回协调者重做，名额不放（分支上的改动还在）
   *   abandon    —— 放弃，名额释放
   *
   * 目标 HEAD 变过就**不合**：那意味着底下的代码动了，直接合进去等于拿一份
   * 过时的基线覆盖别人。这时候 Mission 转 blocked，交回协调者重新同步。
   */
  /**
   * 公开最终检视入口。**只发人类权威。**
   *
   * 机器权威必须来自跑过合并后验证的可信内部路径——同 `promoteMissionToStandard`
   * 拒绝 `budget_exceeded` 的纪律：能从外面写一个 kind 上去，权威就等于没有。
   */
  async finalizeMission(
    missionId: string,
    input: {
      verdict: 'merge' | 'send_back' | 'abandon';
      reasons: readonly string[];
      projectRoot?: string;
      /** 只接受 human；principalId 有就记，没有就记「人，不知道是谁」。 */
      authority?: { kind: 'human'; principalId?: string };
    },
  ): Promise<{ status: string; mergedInto?: string; reason?: string }> {
    assertFinalizePolicy(
      {
        principal: {
          status: 'ok',
          kind: 'user',
          id: input.authority?.principalId ?? 'human',
          role: 'operator',
        },
        action: POLICY_ACTION.finalizeHuman,
        context: { missionId },
      },
      `Mission ${missionId} 是 high_assurance：合并永远要人放行，机器 L3 不碰。`,
    );
    // L3（C4）：send_back / abandon 是短命令，状态与事件一起提交。merge 带 git 合并这一外部副作用，不包：
    // 合并成功后提交丢了，重放会因为目标分支已前移判合并失败——要可重入的合并检测（见规格）。
    if (input.verdict === 'merge') return this.#finalizeMission(missionId, input);
    return this.#tx(() => this.#finalizeMission(missionId, input));
  }

  /**
   * 检视者终审：用户确认之后签检视者的名字。只给命令行进程内调用，不挂公开入口。
   *
   * confirmedAt 取平台时钟，不接受调用方传入的时间——否则记录可以回拨。
   * 两个身份都 trim，trim 后各 1..128 字符。平台没有身份名册，这里记下的是
   * 调用方声明，不宣称已经核对过那一次点击。
   */
  async finalizeMissionByReviewer(
    missionId: string,
    input: {
      verdict: 'merge' | 'send_back' | 'abandon';
      reasons: readonly string[];
      projectRoot?: string;
      reviewerId: string;
      confirmedBy: string;
    },
  ): Promise<{ status: string; mergedInto?: string; reason?: string }> {
    const authority = this.#reviewerAuthority(input.reviewerId, input.confirmedBy);
    assertFinalizePolicy(
      {
        principal: { status: 'ok', kind: 'reviewer', id: authority.reviewerId },
        action: POLICY_ACTION.finalizeReviewer,
        context: { missionId },
      },
      `Mission ${missionId} 是 high_assurance：合并永远要人放行，机器 L3 不碰。`,
    );
    const body = {
      verdict: input.verdict,
      reasons: input.reasons,
      projectRoot: input.projectRoot,
      authority,
    };
    if (input.verdict === 'merge') return this.#applyFinalReview(missionId, body);
    return this.#tx(() => this.#applyFinalReview(missionId, body));
  }

  #reviewerAuthority(
    reviewerId: unknown,
    confirmedBy: unknown,
  ): Extract<FinalReviewAuthority, { kind: 'reviewer' }> {
    return Object.freeze({
      kind: 'reviewer' as const,
      reviewerId: this.#requireReviewerIdentity(reviewerId, 'reviewerId'),
      confirmedBy: this.#requireReviewerIdentity(confirmedBy, 'confirmedBy'),
      confirmedAt: this.#clock.now().toISOString(),
    });
  }

  #requireReviewerIdentity(value: unknown, field: string): string {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed.length < 1 || trimmed.length > 128) {
      throw new PlatformRuleError(
        'REVIEWER_IDENTITY_INVALID',
        `${field} 经 trim 后必须是 1 到 128 个字符。`,
      );
    }
    return trimmed;
  }

  async #finalizeMission(
    missionId: string,
    input: {
      verdict: 'merge' | 'send_back' | 'abandon';
      reasons: readonly string[];
      projectRoot?: string;
      /** 只接受 human；principalId 有就记，没有就记「人，不知道是谁」。 */
      authority?: { kind: 'human'; principalId?: string };
    },
  ): Promise<{ status: string; mergedInto?: string; reason?: string }> {
    const rawKind = (input as { authority?: { kind?: unknown } }).authority?.kind;
    if (rawKind !== undefined && rawKind !== 'human') {
      throw new PlatformRuleError(
        'FINAL_REVIEW_AUTHORITY_FORBIDDEN',
        `公开 finalizeMission 只能发 human 权威，收到 ${String(rawKind)}。` +
          '机器放行必须走跑过合并后验证的内部路径。',
      );
    }
    const authority: FinalReviewAuthority = Object.freeze(
      input.authority?.principalId !== undefined
        ? { kind: 'human' as const, principalId: input.authority.principalId }
        : { kind: 'human' as const },
    );
    return this.#applyFinalReview(missionId, {
      verdict: input.verdict,
      reasons: input.reasons,
      projectRoot: input.projectRoot,
      authority,
    });
  }

  /**
   * 人类入口与检视者入口共用的终审流转。三种 verdict、合并闸、失败行为必须一致。
   * 权威已在入口处定好：这里不再改 kind。
   */
  async #applyFinalReview(
    missionId: string,
    input: {
      verdict: 'merge' | 'send_back' | 'abandon';
      reasons: readonly string[];
      projectRoot?: string;
      authority: FinalReviewAuthority;
    },
  ): Promise<{ status: string; mergedInto?: string; reason?: string }> {
    const authority = input.authority;
    const tag = (data: Record<string, unknown>) =>
      authority.kind === 'reviewer' ? { ...data, authority: 'reviewer' as const } : data;
    const { mission } = await this.#locate(missionId);
    if (mission.status !== 'awaiting_review') {
      throw new PlatformRuleError(
        'NOT_AWAITING_REVIEW',
        `Mission ${missionId} 现在是 ${mission.status}，没有在等最终检视。`,
      );
    }
    if (input.verdict === 'merge' && mission.executionMode === 'high_assurance') {
      throw new PlatformRuleError(
        'HIGH_ASSURANCE_MERGE_NOT_AVAILABLE',
        `Mission ${missionId} 是 high_assurance：本项不开放合并。`,
      );
    }
    if (input.verdict === 'send_back' && input.reasons.length === 0) {
      throw new PlatformRuleError(
        'SEND_BACK_NEEDS_REASONS',
        '打回必须写清楚为什么，否则协调者只会原样再交一次。',
      );
    }

    if (input.verdict === 'send_back') {
      mission.sendBackToPlanning({ verdict: 'send_back', reasons: [...input.reasons], authority });
      await this.#event(mission, 'final_review.send_back', tag({ reasons: input.reasons }));
      return { status: mission.status };
    }

    if (input.verdict === 'abandon') {
      mission.block({ verdict: 'abandon', reasons: [...input.reasons], authority });
      await this.#event(mission, 'final_review.abandoned', tag({ reasons: input.reasons }));
      await this.#releaseWorkspace(missionId, mission.workspaceRef?.projectRoot ?? input.projectRoot);
      return { status: mission.status };
    }

    // merge
    let mergedInto: string | undefined;
    if (mission.hasMutated) {
      const ref = mission.workspaceRef;
      if (!ref) {
        throw new PlatformRuleError(
          'NO_WORKSPACE_REF',
          `Mission ${missionId} 动过代码但没记下分支信息，无法落地。`,
        );
      }
      // projectRoot 优先用调用方给的，其次用 Mission 自己记下的那个。
      const projectRoot = input.projectRoot ?? ref.projectRoot;
      if (!this.#workspace || !projectRoot) {
        throw new PlatformRuleError(
          'NO_WORKSPACE_MANAGER',
          '要落地改动必须知道项目仓库在哪，且平台要配了工作区管理。',
        );
      }
      await this.#landMemory(mission);

      const outcome = await this.#workspace.mergeToTarget({
        missionId,
        projectRoot,
        branch: ref.branch,
        expectedBaseRevision: ref.baseRevision,
      });
      if (!outcome.ok) {
        // 落不了地不算完成，也不该假装完成。转 blocked，原因说清楚。
        mission.block({ verdict: 'merge', reasons: [outcome.reason ?? '合并失败'], authority });
        await this.#event(mission, 'final_review.merge_failed', tag({ reason: outcome.reason }));
        return { status: mission.status, reason: outcome.reason };
      }
      mergedInto = outcome.mergedInto;
    }

    mission.complete({
      verdict: 'merge',
      reasons: [...input.reasons],
      mergedInto,
      mergedAt: new Date().toISOString(),
      authority,
    });
    await this.#event(mission, 'final_review.merged', tag({ mergedInto, reasons: input.reasons }));
    await this.#releaseWorkspace(missionId, mission.workspaceRef?.projectRoot ?? input.projectRoot);
    return { status: mission.status, mergedInto };
  }

  /**
   * HA 受控放行：外置常设授权 + 当前有效独立检视 pass + 方案级命令，
   * 再走与机器终审共用的锚点→合并→验证→条件回滚。不接 HTTP、不进 agent tools。
   */
  async finalizeMissionByHaAuthority(
    missionId: string,
    input: {
      readonly reviewerId: string;
      readonly confirmedBy: string;
      readonly projectRoot?: string;
      readonly reasons?: readonly string[];
      readonly verification?: readonly { readonly argv: readonly string[]; readonly timeoutMs: number }[];
    },
  ): Promise<{
    status: string;
    mergedInto?: string;
    reportId?: string;
    reason?: string;
    rolledBackTo?: string;
  }> {
    const { mission } = await this.#locate(missionId);
    if (mission.executionMode !== 'high_assurance') {
      throw new PlatformRuleError(
        'HA_RELEASE_MODE_REQUIRED',
        `Mission ${missionId} 不是 high_assurance，不能走受控放行。`,
      );
    }
    if (mission.status === 'completed') {
      // 已完成的重复调用不得再验、再写报告，也不二次合并。
      return {
        status: mission.status,
        mergedInto: mission.finalReview?.mergedInto,
      };
    }
    if (mission.status !== 'awaiting_review') {
      throw new PlatformRuleError(
        'NOT_AWAITING_REVIEW',
        `Mission ${missionId} 现在是 ${mission.status}，没有在等最终检视。`,
      );
    }

    const authority = this.#reviewerAuthority(input.reviewerId, input.confirmedBy);
    assertFinalizePolicy(
      {
        principal: { status: 'ok', kind: 'reviewer', id: authority.reviewerId },
        action: POLICY_ACTION.finalizeHaReviewer,
        context: { missionId },
        state: { executionMode: mission.executionMode },
      },
      `Mission ${missionId} 是 high_assurance：合并永远要人放行，机器 L3 不碰。`,
    );

    const projectRoot = input.projectRoot ?? mission.workspaceRef?.projectRoot;
    if (!this.#workspace || !projectRoot) {
      throw new PlatformRuleError('NO_WORKSPACE_MANAGER', 'HA 放行要知道项目仓库在哪。');
    }
    const workspace = this.#workspace;
    if (!workspace.currentBranch || !workspace.resetTarget || !workspace.listWorktreePaths) {
      throw new PlatformRuleError(
        'HA_RELEASE_UNAVAILABLE',
        '工作区管理不支持 currentBranch / resetTarget / listWorktreePaths，HA 放行不可用。',
      );
    }

    const worktreePaths = await this.#haWorktreePaths(workspace, projectRoot);
    const config = await this.#loadHaAuthority(projectRoot, worktreePaths);
    const registered = config.reviewers.find((row) => row.reviewerId === authority.reviewerId);
    if (!registered) {
      throw new PlatformRuleError(
        HA_AUTHORITY_CODE.REVIEWER_UNREGISTERED,
        'HA 放行拒绝（HA_AUTHORITY_REVIEWER_UNREGISTERED）：检视者未登记。',
      );
    }
    if (registered.confirmedBy !== authority.confirmedBy) {
      throw new PlatformRuleError(
        HA_AUTHORITY_CODE.CONFIRMED_BY_MISMATCH,
        'HA 放行拒绝（HA_AUTHORITY_CONFIRMED_BY_MISMATCH）：确认主体与登记值不一致。',
      );
    }

    const checkout = await workspace.currentBranch(projectRoot);
    if (!checkout) {
      throw new PlatformRuleError(
        'HA_DETACHED_HEAD',
        `Mission ${missionId} 项目仓是 detached HEAD，拒绝合并。`,
      );
    }
    const persistedTarget = mission.workspaceRef?.targetBranch;
    if (typeof persistedTarget !== 'string' || persistedTarget.trim() === '') {
      throw new PlatformRuleError(
        'HA_TARGET_MISSING',
        `Mission ${missionId} 没有可信的历史目标分支，拒绝用当前 checkout 倒填。`,
      );
    }
    if (this.#isForbiddenMaster(checkout) || this.#isForbiddenMaster(persistedTarget)) {
      throw new PlatformRuleError(
        HA_AUTHORITY_CODE.MASTER_FORBIDDEN,
        'HA 放行拒绝（HA_AUTHORITY_MASTER_FORBIDDEN）：master 不能作为常设代行目标。',
      );
    }
    if (checkout !== persistedTarget) {
      throw new PlatformRuleError(
        'HA_TARGET_MISMATCH',
        `当前 checkout（${checkout}）与 Mission 目标（${persistedTarget}）不一致，拒绝合并。`,
      );
    }
    try {
      matchHaRelease(config, {
        reviewerId: authority.reviewerId,
        confirmedBy: authority.confirmedBy,
        branch: persistedTarget,
      });
    } catch (error) {
      throw this.#wrapHaAuthorityError(error);
    }

    const unsafe = await this.#haUnsafe(missionId);
    if (unsafe) {
      return {
        status: mission.status,
        reason: this.#haUnsafeHint(unsafe.reason),
      };
    }

    const ref = mission.workspaceRef;
    if (!ref) {
      throw new PlatformRuleError('NO_WORKSPACE_REF', `Mission ${missionId} 没记下分支信息。`);
    }
    const headNow = await workspace.targetHead(projectRoot);
    if (headNow !== ref.baseRevision) {
      // revisionIsAncestor(ancestor, descendant) ↔ git merge-base --is-ancestor，
      // 不能把参数反了。「已合未记」要求 Mission 分支尖已在目标 HEAD 里，
      // 且那个尖不能还停在分叉基线——执行者改动常常还在 worktree
      // 未提交，分支仍等于基线；目标独自前进时基线仍是 HEAD 的祖先，
      // 那是旧基线，不是已合。git 失败时函数返 false，走旧基线拒绝（fail-closed），
      // 不会进合并。
      const alreadyMerged = await this.#haMissionAlreadyInHead(
        workspace,
        projectRoot,
        ref.branch,
        ref.baseRevision,
        headNow,
      );
      if (alreadyMerged) {
        await this.#markHaUnsafe(mission, 'merged_unrecorded', {
          head: headNow,
          anchor: ref.baseRevision,
        });
        return {
          status: mission.status,
          reason: this.#haUnsafeHint('merged_unrecorded'),
        };
      }
      throw new PlatformRuleError(
        'HA_STALE_BASELINE',
        `Mission ${missionId} 的分叉基线已过期，拒绝在任何 Git 合并前放行。`,
      );
    }

    const pass = await this.effectiveIndependentReviewPass(missionId);
    if (!pass) {
      throw new PlatformRuleError(
        'HA_NO_EFFECTIVE_PASS',
        `Mission ${missionId} 没有当前有效的独立检视 pass，拒绝合并。`,
      );
    }

    const verification = input.verification === undefined
      ? this.#planLevelCommands(mission)
      : this.#explicitHaCommands(mission.id, input.verification);
    const runner = this.#validation?.commandRunner;
    const reports = this.#validation?.reports;
    if (!runner || !reports) {
      throw new PlatformRuleError(
        'MACHINE_FINALIZE_UNAVAILABLE',
        '没注入 commandRunner / reports，HA 放行不可用。不退化成不验直接合。',
      );
    }

    const outcome = await this.#runIntegrationMergeVerify({
      mission,
      projectRoot,
      integrationBranch: persistedTarget,
      verification,
    });
    if (outcome.kind === 'merge_failed') {
      mission.setWaitReason(
        'waiting_l3',
        `HA 合并失败：${outcome.reason ?? '（没给原因）'} 集成分支没动，等人处置。`,
      );
      await this.#event(mission, 'final_review.merge_failed', {
        reason: outcome.reason,
        authority: 'reviewer',
      });
      await this.#event(mission, 'mission.waiting', { reason: 'waiting_l3' });
      return { status: mission.status, reason: outcome.reason };
    }
    if (outcome.kind === 'verify_failed') {
      if (!outcome.reset.ok) {
        const thirdParty = outcome.reset.reason?.includes('期间有别的提交');
        await this.#markHaUnsafe(mission, thirdParty ? 'third_party_advanced' : 'rollback_failed', {
          head: outcome.mergedInto,
          anchor: outcome.anchor,
          reportId: outcome.report.id,
        });
      }
      mission.setWaitReason(
        'waiting_l3',
        `集成验证未通过（报告 ${outcome.report.id}）；` +
          (outcome.reset.ok
            ? `已退回 ${outcome.anchor.slice(0, 12)}，等人处置。`
            : `**退回失败**：${outcome.reset.reason} 集成分支上留着一个没验过的合并。`),
      );
      await this.#event(mission, 'mission.waiting', {
        reason: 'waiting_l3',
        reportId: outcome.report.id,
        rolledBack: outcome.reset.ok,
      });
      return {
        status: mission.status,
        reportId: outcome.report.id,
        reason: outcome.reset.ok
          ? '集成验证未通过，已回滚'
          : this.#haUnsafeHint(outcome.reset.reason?.includes('期间有别的提交')
              ? 'third_party_advanced'
              : 'rollback_failed'),
        ...(outcome.reset.ok ? { rolledBackTo: outcome.anchor } : {}),
      };
    }
    if (outcome.kind === 'advanced_during_verify') {
      await this.#markHaUnsafe(mission, 'advanced_during_verify', {
        head: outcome.head,
        anchor: outcome.anchor,
        reportId: outcome.report.id,
      });
      mission.setWaitReason(
        'waiting_l3',
        `集成验证期间目标被推进或 checkout 被切换（报告 ${outcome.report.id}）；未签字。请人工核对锚点、当前 HEAD 与集成报告。`,
      );
      await this.#event(mission, 'mission.waiting', {
        reason: 'waiting_l3',
        reportId: outcome.report.id,
        advancedDuringVerify: true,
      });
      return {
        status: mission.status,
        reportId: outcome.report.id,
        reason: this.#haUnsafeHint('advanced_during_verify'),
      };
    }

    const reasons =
      input.reasons && input.reasons.length > 0
        ? [...input.reasons]
        : [`HA 受控放行验证通过（报告 ${outcome.report.id}）`];
    mission.complete({
      verdict: 'merge',
      reasons,
      mergedInto: outcome.mergedInto,
      mergedAt: this.#clock.now().toISOString(),
      authority,
    });
    await this.#event(mission, 'final_review.merged', {
      mergedInto: outcome.mergedInto,
      authority: 'reviewer',
      reportId: outcome.report.id,
    });
    await this.#event(mission, 'final_review.ha_authorized', {
      source: config.source,
      integrationReportId: outcome.report.id,
      reviewerId: registered.reviewerId,
      confirmedBy: registered.confirmedBy,
      integrationBranch: persistedTarget,
      mergedInto: outcome.mergedInto,
    });
    await this.#releaseWorkspace(missionId, projectRoot);
    return {
      status: mission.status,
      mergedInto: outcome.mergedInto,
      reportId: outcome.report.id,
    };
  }

  /**
   * 机器 L3：合进集成分支，**在合并结果上**跑方案级验证，绿才放行。
   *
   * 顺序是这一票的全部要害，不能改：
   *
   * 1. **钉分支**——核对项目仓现在确实在集成分支上。合并目标取自「当时 checkout
   *    的分支」，无人值守连跑时要是有别的东西 checkout 回了 master，后续功能会
   *    静默合进 master。
   * 2. **先落锚点事件再合**——进程死在「已合并、未验证」之间时，得有东西知道该
   *    退回哪。握在内存里等于没有。
   * 3. **验证插在 merge 与 complete 之间**——`completed` 在流转表里没有出边
   *    （`MISSION_TRANSITIONS.completed = []`）。先 complete 再验，红了就只能退
   *    git、退不了状态，两边当场分叉。
   * 4. 红 → 退回锚点，Mission **留在 `awaiting_review`** 等人：机器判不了不等于
   *    这条完了。
   *
   * 不接 HTTP、不进 agent tools：机器权威只能从这里发。
   */
  async finalizeMissionByMachine(
    missionId: string,
    input: {
      readonly integrationBranch: string;
      readonly verification: readonly {
        readonly argv: readonly string[];
        readonly timeoutMs: number;
      }[];
      readonly projectRoot?: string;
    },
  ): Promise<{
    status: string;
    mergedInto?: string;
    reportId?: string;
    reason?: string;
    rolledBackTo?: string;
  }> {
    const { mission } = await this.#locate(missionId);
    if (mission.status !== 'awaiting_review') {
      throw new PlatformRuleError(
        'NOT_AWAITING_REVIEW',
        `Mission ${missionId} 现在是 ${mission.status}，没有在等最终检视。`,
      );
    }
    // 自动合的范围只有 lightweight + standard。高保证路径的合并必须由人放行——
    // 今天建不出这种 Mission，但门口的规则不能靠「上游恰好建不出来」来守。
    // 判定收拢到 PolicyEngine，错误码仍是 HIGH_ASSURANCE_NEEDS_HUMAN。
    assertFinalizePolicy(
      {
        principal: { status: 'ok', kind: 'runner', id: 'platform' },
        action: POLICY_ACTION.finalizeMachine,
        context: { missionId },
        state: { executionMode: mission.executionMode },
      },
      `Mission ${missionId} 是 high_assurance：合并永远要人放行，机器 L3 不碰。`,
    );
    if (input.verification.length === 0) {
      throw new PlatformRuleError(
        'MACHINE_FINALIZE_NEEDS_VERIFICATION',
        '机器放行必须有方案级集成命令。空命令表 = 没有新证据，那就只是把 ' +
          'validator 那份报告又数了一遍。',
      );
    }
    const runner = this.#validation?.commandRunner;
    const reports = this.#validation?.reports;
    if (!runner || !reports) {
      throw new PlatformRuleError(
        'MACHINE_FINALIZE_UNAVAILABLE',
        '没注入 commandRunner / reports，机器放行不可用。不退化成不验直接合。',
      );
    }
    const projectRoot = input.projectRoot ?? mission.workspaceRef?.projectRoot;
    if (!this.#workspace || !projectRoot) {
      throw new PlatformRuleError('NO_WORKSPACE_MANAGER', '机器放行要知道项目仓库在哪。');
    }
    const workspace = this.#workspace;
    if (!workspace.currentBranch || !workspace.resetTarget) {
      throw new PlatformRuleError(
        'MACHINE_FINALIZE_UNAVAILABLE',
        '工作区管理不支持 currentBranch / resetTarget，机器放行不可用。',
      );
    }

    // 1. 钉分支
    const branch = await workspace.currentBranch(projectRoot);
    if (branch !== input.integrationBranch) {
      throw new PlatformRuleError(
        'INTEGRATION_BRANCH_MISMATCH',
        `项目仓现在在 ${branch ?? '(detached)'}，不是方案声明的 ${input.integrationBranch}。` +
          '拒绝合并——合错分支比不合更糟。',
      );
    }

    const outcome = await this.#runIntegrationMergeVerify({
      mission,
      projectRoot,
      integrationBranch: input.integrationBranch,
      verification: input.verification,
    });
    if (outcome.kind === 'merge_failed') {
      // 合不进去和验证红了是一回事：机器判不了，不等于这条完了。留在
      // awaiting_review 等人（或方案的检视者）处置。原先这里转 blocked 并记
      // { kind: 'human' }——一条机器路径冒签了人的权威，而且 blocked 是终态，
      // 人第二天想看一眼再合都没门。
      mission.setWaitReason(
        'waiting_l3',
        `机器合并失败：${outcome.reason ?? '（没给原因）'} 集成分支没动，等人处置。`,
      );
      await this.#event(mission, 'final_review.merge_failed', {
        reason: outcome.reason,
        authority: 'machine',
      });
      await this.#event(mission, 'mission.waiting', { reason: 'waiting_l3' });
      return { status: mission.status, reason: outcome.reason };
    }
    if (outcome.kind === 'verify_failed') {
      mission.setWaitReason(
        'waiting_l3',
        `集成验证未通过（报告 ${outcome.report.id}）；` +
          (outcome.reset.ok
            ? `已退回 ${outcome.anchor.slice(0, 12)}，等人处置。`
            : `**退回失败**：${outcome.reset.reason} 集成分支上留着一个没验过的合并。`),
      );
      await this.#event(mission, 'mission.waiting', {
        reason: 'waiting_l3',
        reportId: outcome.report.id,
        rolledBack: outcome.reset.ok,
      });
      return {
        status: mission.status,
        reportId: outcome.report.id,
        reason: outcome.reset.ok ? '集成验证未通过，已回滚' : '集成验证未通过，且回滚失败',
        ...(outcome.reset.ok ? { rolledBackTo: outcome.anchor } : {}),
      };
    }
    if (outcome.kind === 'advanced_during_verify') {
      // 与 HA 共用复核：绿之后 checkout / HEAD 已不是本次合并结果时，不能记 completed。
      mission.setWaitReason(
        'waiting_l3',
        `集成验证期间目标被推进或 checkout 被切换（报告 ${outcome.report.id}）；未签字。` +
          '不能把这次验证当成仍对着受授权的合并结果。',
      );
      await this.#event(mission, 'mission.waiting', {
        reason: 'waiting_l3',
        reportId: outcome.report.id,
        advancedDuringVerify: true,
      });
      return {
        status: mission.status,
        reportId: outcome.report.id,
        reason: '集成验证期间目标被推进或 checkout 被切换，未放行',
      };
    }

    mission.complete({
      verdict: 'merge',
      reasons: [`集成验证通过（报告 ${outcome.report.id}）`],
      mergedInto: outcome.mergedInto,
      mergedAt: this.#clock.now().toISOString(),
      authority: Object.freeze({
        kind: 'machine' as const,
        integrationReportId: outcome.report.id,
        policyRevision: outcome.report.policyRevision,
      }),
    });
    await this.#event(mission, 'final_review.merged', {
      mergedInto: outcome.mergedInto,
      authority: 'machine',
      reportId: outcome.report.id,
    });
    await this.#releaseWorkspace(missionId, projectRoot);
    return { status: mission.status, mergedInto: outcome.mergedInto, reportId: outcome.report.id };
  }

  /**
   * 无人值守的方案运行放弃一条失败的 Mission：放掉改动名额，分支留给人看。
   *
   * **为什么非放不可。** 名额的判据是「动过代码且没到终态」。验证红了、合并失败
   * 了、协调者卡住了——这些 Mission 都停在非终态，于是一直占着名额，方案里后面
   * 的功能一个都派发不了：一次失败就钉死整晚。
   *
   * 只发 abandon，永远不放行；权威记 `plan` 并指向那张升级单——是检视者选的
   * 动作还是等过了期，记在升级单上。不接 HTTP、不进 agent tools。
   */
  async abandonMissionForPlan(
    missionId: string,
    input: {
      readonly planRunId: string;
      readonly escalationId: string;
      readonly reasons: readonly string[];
      readonly projectRoot?: string;
    },
  ): Promise<{ status: string }> {
    assertFinalizePolicy(
      {
        principal: { status: 'ok', kind: 'runner', id: 'platform' },
        action: POLICY_ACTION.finalizePlan,
        context: { missionId },
      },
      `Mission ${missionId} 是 high_assurance：合并永远要人放行，机器 L3 不碰。`,
    );
    // 单事务命令（C4）：状态改动与事件一起提交，或者一个都不落。
    return this.#tx(() => this.#abandonMissionForPlan(missionId, input));
  }

  async #abandonMissionForPlan(
    missionId: string,
    input: {
      readonly planRunId: string;
      readonly escalationId: string;
      readonly reasons: readonly string[];
      readonly projectRoot?: string;
    },
  ): Promise<{ status: string }> {
    return missionControl.abandonMissionForPlan(this.#context, missionId, input);
  }

  /* ============================ L1 执行者面 ============================ */

  async getWorkOrder(missionId: string, workItemId: string): Promise<WorkOrderView> {
    return views.getWorkOrder(this.#context, missionId, workItemId);
  }

  async getAgentWorkItem(missionId: string, workItemId: string): Promise<AgentWorkItemView> {
    return views.getAgentWorkItem(this.#context, { workItemValidationReportViews: (m, e) => this.#workItemValidationReportViews(m, e), haReviewHold: (m) => this.#haReviewHold(m) }, missionId, workItemId);
  }

  async getContext(
    missionId: string,
    attemptId: string,
    ref: string,
  ): Promise<{ found: boolean; kind?: string; body?: string; note?: string }> {
    return views.getContext(this.#context, missionId, attemptId, ref);
  }

  async submitEvidence(
    missionId: string,
    attemptId: string,
    evidence: Omit<EvidenceRecord, 'id' | 'attemptId'>,
    claim?: QueueClaimIdentity,
  ): Promise<{ evidenceId: string }> {
    // 单事务命令（C4）：状态改动与事件一起提交，或者一个都不落。
    return this.#attemptWrite(missionId, attemptId, claim, () => this.#submitEvidence(missionId, attemptId, evidence));
  }

  async #submitEvidence(
    missionId: string,
    attemptId: string,
    evidence: Omit<EvidenceRecord, 'id' | 'attemptId'>,
  ): Promise<{ evidenceId: string }> {
    return executorSubmissions.submitEvidence(this.#context, (mission, item) => this.#criteriaFailureStop(mission, item), (mission, body) => this.#recordEscalationAndDeliver(mission, body), missionId, attemptId, evidence);
  }

  async submitExecutionResult(
    missionId: string,
    attemptId: string,
    body: ExecutionResultBody,
    claim?: QueueClaimIdentity,
  ): Promise<{ status: string }> {
    // 单事务命令（C4）：状态改动与事件一起提交，或者一个都不落。
    return this.#attemptWrite(missionId, attemptId, claim, () => this.#submitExecutionResult(missionId, attemptId, body));
  }

  async #submitExecutionResult(
    missionId: string,
    attemptId: string,
    body: ExecutionResultBody,
  ): Promise<{ status: string }> {
    return executorSubmissions.submitExecutionResult(this.#context, (mission, item) => this.#criteriaFailureStop(mission, item), (mission, body) => this.#recordEscalationAndDeliver(mission, body), missionId, attemptId, body);
  }

  async reportBlocked(
    missionId: string,
    attemptId: string,
    body: Omit<BlockedRecord, 'attemptId'>,
    claim?: QueueClaimIdentity,
  ): Promise<void> {
    // 单事务命令（C4）：状态改动与事件一起提交，或者一个都不落。
    return this.#attemptWrite(missionId, attemptId, claim, () => this.#reportBlocked(missionId, attemptId, body));
  }

  async #reportBlocked(
    missionId: string,
    attemptId: string,
    body: Omit<BlockedRecord, 'attemptId'>,
  ): Promise<void> {
    return executorSubmissions.reportBlocked(this.#context, (mission, item) => this.#criteriaFailureStop(mission, item), (mission, body) => this.#recordEscalationAndDeliver(mission, body), missionId, attemptId, body);
  }

  /* ================== Standard 机器验收（进程内，不动 L2 评审权） ================== */

  /**
   * Standard：把 trusted workspace HEAD 记成该 WorkItem 的验证基线。
   *
   * 基线必须由 orchestrator 从 trusted workspace 读出来，**不是执行者自报**，也
   * **不是 Mission 的初始 baseRevision**：Standard 一个 Mission 里有多条工作项各自
   * 开工，拿 Mission base 算 diff 会把别的工单、甚至同一条工单前面几跳的改动一起
   * 算进这一条，allowedScope / diffSize 的判断于是全错——而它看起来和判对了一模一样。
   *
   * 同一条工作项多次尝试时以最近一次为准（读取方从事件流倒序取）。
   * 仅进程内 Orchestrator 调用；不进 HTTP/tools——执行者能写基线等于自己给自己划线。
   */
  async recordStandardValidationBaseline(input: {
    readonly missionId: string;
    readonly workItemId: string;
    readonly head: string;
  }): Promise<{ recorded: true }> {
    return standardValidation.recordStandardValidationBaseline(this.#context, input);
  }

  /**
   * 读该 WorkItem 最近一次记下的验证基线。没有就是没有——不回退到 Mission base，
   * 调用方据此 fail-closed，而不是拿累计 diff 凑一份看起来正常的报告。
   */
  async #workItemValidationBaseline(
    missionId: string,
    workItemId: string,
  ): Promise<string | undefined> {
    return standardValidation.workItemValidationBaseline(this.#context, missionId, workItemId);
  }

  /** 同一次 submitted attempt 已经存过报告就返回它的 reportId（事件流倒序取最近一条）。 */
  async #submittedAttemptReportId(
    missionId: string,
    workItemId: string,
    submittedAttemptId: string,
  ): Promise<string | undefined> {
    return standardValidation.submittedAttemptReportId(this.#context, missionId, workItemId, submittedAttemptId);
  }

  /**
   * Standard：对 submitted WorkItem 跑冻结 validation.commands，并存 ValidationReport。
   *
   * 与 Lightweight 的 validateAndAccept 只差一处，但那处是关键：**这里不 review**。
   * 机器报告在 Standard 只是证据，accept/reject 仍归 L2——机器跑绿了不等于工单
   * 可以放行，所以工单保持 submitted。
   *
   * cwd 由 trusted WorkspaceManager 注入并强制覆盖每个命令；allowedScope /
   * forbiddenPaths / diffSize 只从 frozen order 拷贝，绝不在这里补默认值。
   * `order.validation.commands` 缺失或为空 = 什么都不做（不存报告、不记事件），
   * 免得调用方以为跑过验收。
   */
  async validateStandardWorkItem(input: {
    readonly missionId: string;
    readonly workItemId: string;
    readonly cwd: string;
  }): Promise<{ reportId: string; passed: boolean; status: string } | undefined> {
    return standardValidation.validateStandardWorkItem(this.#context, input);
  }

/**
   * Standard：一次 partial / 验证失败之后，机器直接把工单退回执行者（最多两次），不叫协调者。
   *
   * 只由进程内 Orchestrator 调用，**不进 HTTP/tools**：执行者能调它等于自己给自己续命、
   * 绕开 L2 的验收权。协调者的正式入口（dispatchWorkItems / reviewExecutionResult）
   * 一概不走这里，HO2 的未修订门禁原样生效。
   *
   * 借内核 review('reject') 的既有转移回到可派发态，但**不带 ReviewRecord**：这不是 L2 的
   * 验收结论，写进 reviews 就等于伪造一次评审——web、简报、L3 都会把它当成"有人验收过"。
   * 因此本方法不发 review.recorded。
   */
  async autoRedispatchStandardWorkItem(input: {
    readonly missionId: string;
    readonly workItemId: string;
  }): Promise<StandardAutoRedispatchResult> {
    // 命令事务（C4）：review('reject') / dispatch 的状态改动与 auto 事件一起提交，
    // 或者一个都不落——半套流转会让工单停在 rejected 而没人知道为什么。
    return this.#tx(() => this.#autoRedispatchStandardWorkItem(input));
  }

  async #autoRedispatchStandardWorkItem(input: {
    readonly missionId: string;
    readonly workItemId: string;
  }): Promise<StandardAutoRedispatchResult> {
    return standardRedispatch.autoRedispatchStandardWorkItem(this.#context, input);
  }

  /**
   * 这一次提交有没有可自动续派的依据。
   *
   * 返回 undefined = 没有，交给 L2：非 partial、缺报告、报告不属于这次提交、报告跑绿，
   * 都不是"执行者还能再试"。**缺报告绝不当失败**——验证没跑成或没落盘是平台侧的事，
   * 把它算成执行者的失败，会退回一次其实没人验过的交付。
   */
  async #standardAutoRedispatchReason(
    mission: Mission,
    item: WorkItem,
    submittedAttemptId: string,
  ): Promise<
    { reason: StandardAutoRedispatchReason; summary: string; reportId?: string } | undefined
  > {
    return standardRedispatch.standardAutoRedispatchReason(this.#context, mission, item, submittedAttemptId);
  }

  /**
   * 编排器读「这一跳为什么接着做」：最近一次自动续派的交接。
   *
   * 从事件流读，所以断线重启后照样读得回来；只放在内存里的交接，恰好会在最需要
   * 它的那一刻消失。partial 的 resumeRef 从原提交 Attempt 上取——它随状态一起落盘。
   */
  async getStandardAutoRedispatchHandoff(
    missionId: string,
    workItemId: string,
  ): Promise<StandardAutoRedispatchHandoff | undefined> {
    return standardRedispatch.getStandardAutoRedispatchHandoff(this.#context, missionId, workItemId);
  }

  /**
   * Standard 只读取报告：报告必须确实属于该 Mission 才返回。
   * 不校验归属就返回，等于让任何一个 Mission 拿别人的机器证据去放行——
   * 报告是 append-only 的，串了一份就永远串着。
   */
  async getValidationReport(
    missionId: string,
    reportId: string,
  ): Promise<ValidationReport | undefined> {
    return validationReportViews.getValidationReport(this.#context, missionId, reportId);
  }

  /**
   * 已交卷工作项 → 机器验证简版（视图共用同一份只读投影）。
   *
   * 一个 Mission 一条活动流：正序扫一遍得到「每个 (workItemId, submittedAttemptId)
   * 最近一条 validation.reported」，再按工作项**当前**的 submittedAttemptId 精确取。
   * 旧提交的报告因此挂不到新交卷头上；报告自己记的 workItem/attempt 也要对得上，
   * 对不上就当没有——串了一份 append-only 报告比没有更糟。
   *
   * 没报告的工作项不进 map，视图就不带这个字段（不臆造）。没注入 validation 依赖
   * （内存 / 轻量测试）或整条 Mission 没人交卷过时不读活动流。
   */
  async #workItemValidationReportViews(
    mission: Mission,
    events?: readonly ActivityEvent[],
  ): Promise<Map<string, ValidationReportView>> {
    return validationReportViews.workItemValidationReportViews(this.#context, mission, events);
  }

  /* ================================ 内部 ================================ */

  /**
   * 派发前占用 Project mutation slot（不变量 C）。
   * Standard 与 Lightweight 共用；调用方负责其后的 shadow / item.dispatch 顺序。
   */
  async #acquireMutationSlotForDispatch(mission: Mission, project: Project): Promise<void> {
    // 派发 = 这个 Mission 要开始改代码了，此刻占用 Project 的改动名额。
    // 不变量 C 在这里才真正生效：同 Project 的第二个 Mission 走到这一步会被
    // 挡下，而不是等到两边都改完才发现冲突。放在改 WorkItem 状态之前，
    // 被拒绝的派发不留下半套流转。
    if (!mission.isMutating) {
      try {
        mission.startExecuting();
      } catch (error) {
        if (error instanceof InvariantViolationError && error.code === 'CONCURRENT_MUTATING_MISSION') {
          // 记下停机原因：这不是"失败"，是排队。调度器据此让这条 Mission
          // 先歇着去跑别的，而不是当成出错。
          // 点名占着名额的是谁。只说"忙"的话，人下一步只能挨个 Mission 去翻。
          const holder = project.missions.find((m) => m.id !== mission.id && m.isMutating);
          mission.setWaitReason(
            'project_busy',
            holder
              ? `${holder.id} 正占着 ${mission.projectId} 的改动名额（${holder.status}）。` +
                '它落地或被放弃之后，这条会自动接上。'
              : undefined,
          );
          await this.#event(mission, 'mission.waiting', { reason: 'project_busy' });
          throw new PlatformRuleError(
            'PROJECT_BUSY',
            `本 Project 已经有别的 Mission 在改代码了。可以继续调查和规划，` +
              `但要等它结束才能派发实现任务。`,
          );
        }
        throw error;
      }
    } else if (mission.status !== 'executing') {
      // 已经占着改动名额、但阶段被退回过（L3 改契约、或 L2 自己退回规划）。
      //
      // 名额不用重新占，**阶段却必须重新推到 executing**：调度器只在这个
      // 阶段跑执行者。少了这一步，重新派发出去的工单永远不会被执行——
      // 而界面上看它就是"已派发"，看不出为什么不动。实测踩到过一次死锁。
      mission.startExecuting();
    }
  }

  /** Lightweight mutation lane 共用前置：mode + runKind。 */
  #requireLightweightMutationLane(mission: Mission): void {
    if (mission.executionMode !== 'lightweight') {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_MODE_REQUIRED',
        `需要 executionMode=lightweight，当前是 ${mission.executionMode}。`,
      );
    }
    if (mission.runKind !== 'mutation') {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_RUN_KIND_REQUIRED',
        `需要 runKind=mutation，当前是 ${mission.runKind}。`,
      );
    }
  }

  /** 命令事务（C2）：注入了就让 fn 里的写一起提交；缺省直接跑。 */
  #tx<T>(fn: () => Promise<T>): Promise<T> {
    return this.#context.tx(fn);
  }

  /**
   * 队列身份写：核对与状态/事件/投递必须在同一 runFenced 事务里。
   * 事务外 get 预检会在核对和提交之间被接管，旧 Runner 仍能迟到落盘。
   * 没注入 FencedCommandTransaction 时 fail-closed，避免内存平台把领取身份当成已授权。
   * 无领取身份走既有 #tx，原调用方不用改。
   */
  #txFenced<T>(claim: QueueClaimIdentity | undefined, fn: () => Promise<T>): Promise<T> {
    return this.#context.txFenced(claim, fn);
  }

  async #attemptHasQueueMark(missionId: string, attemptId: string): Promise<boolean> {
    return this.#context.attemptHasQueueMark(missionId, attemptId);
  }

  /**
   * 队列 Attempt 即使调用方没带内存 claim 也不得走无 fence 写入。
   * 只靠 HTTP 记得传 claim 的话，重启丢牌后控制面 finish 会把队列误判成非队列。
   */
  #attemptWrite<T>(
    missionId: string,
    attemptId: string,
    claim: QueueClaimIdentity | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.#context.attemptWrite(missionId, attemptId, claim, fn);
  }

  /**
   * POST_EXECUTION shadow（Jev 设计 §9，J2）：编排器在「执行者交卷 + 确定性验收」之后调用。
   *
   * 非权威、从不抛：评估器没注入、钩子没开、工作项不在交卷状态，都直接返回；取数或调用出任何错也只进事件。
   * 输入只取平台自己存的：工单、当前那次提交、那个 attempt 的证据，改动清单优先用平台算的 diff。
   */
  async runPostExecutionShadow(missionId: string, workItemId: string): Promise<void> {
    return postExecution.runPostExecutionShadow(this.#context, missionId, workItemId);
  }

  /**
   * 平台自己算的改动清单。只在真有隔离工作区时可信：原地模式的 diff 永远是空的，
   * 分不清「没改」和「没隔离」，这时返回 undefined，让调用方照实退回执行者自报。
   */
  async #trustedChangedFiles(mission: Mission): Promise<readonly string[] | undefined> {
    return postExecution.trustedChangedFiles(this.#context, mission);
  }

  /**
   * Lightweight 交卷后的自动升级（§4.3 接线）：验收没过、或实际改动超出轻量规模时，交给 Standard。
   *
   * 触发只从平台自己保存的那份 ValidationReport 复算（{@link lightweightGateTrigger}），
   * 调用方只能指名是哪份报告，不能自带理由——和 budget_exceeded 只能由平台自检发放是同一条纪律。
   * 报告必须属于这条 Mission、且正是当前这次提交的那一份：拿一份旧报告来升级，
   * 等于用上一次的失败给这一次定罪。
   *
   * 为什么不停下等人：E1 实测，执行者改对了、机器验收因一条配置判失败，Lightweight 没有出口，
   * Mission 停了 870 秒直到有人叫停。升级后协调者接手，已有产出、证据、报告全部复用。
   */
  async promoteLightweightAfterValidation(
    missionId: string,
    reportId: string,
  ): Promise<{ changed: boolean; promotion: Readonly<PromotionRecord> }> {
    // 单事务命令（C4）：状态改动与事件一起提交，或者一个都不落。
    return this.#tx(() => this.#promoteLightweightAfterValidation(missionId, reportId));
  }

  async #promoteLightweightAfterValidation(
    missionId: string,
    reportId: string,
  ): Promise<{ changed: boolean; promotion: Readonly<PromotionRecord> }> {
    return promotion.promoteLightweightAfterValidation(this.#context, (mission) => this.#requireLightweightMutationLane(mission), missionId, reportId);
  }

  /**
   * Lightweight → Standard 可信升级入口（PROMO-001）。
   *
   * **仅进程内**：不接受完整 PromotionRecord / evidence / usage / HEAD 等 caller audit JSON；
   * 全部从 trusted state 构造。产品/API/agent tools 本单不新增 route。
   *
   * `budget_exceeded` 仍拒绝 caller 手填——权威硬耗尽只能走
   * {@link promoteLightweightForBudgetExceeded}（Platform 自检求值后发放）。
   */
  async promoteMissionToStandard(
    missionId: string,
    trigger: { readonly code: PromotionTriggerCode; readonly rule: string },
  ): Promise<{ changed: boolean; promotion: Readonly<PromotionRecord> }> {
    // 单事务命令（C4）：状态改动与事件一起提交，或者一个都不落。
    return this.#tx(() => this.#promoteMissionToStandard(missionId, trigger));
  }

  async #promoteMissionToStandard(
    missionId: string,
    trigger: { readonly code: PromotionTriggerCode; readonly rule: string },
  ): Promise<{ changed: boolean; promotion: Readonly<PromotionRecord> }> {
    return promotion.promoteMissionToStandard(this.#context, missionId, trigger);
  }

  /**
   * Shared LW→Standard commit after trigger validation.
   * Used by public non-budget triggers and internal budget hard-exceed path.
   */
  async #commitPromotionToStandard(
    missionId: string,
    trigger: { readonly code: PromotionTriggerCode; readonly rule: string },
  ): Promise<{ changed: boolean; promotion: Readonly<PromotionRecord> }> {
    return promotion.commitPromotionToStandard(this.#context, missionId, trigger);
  }

  /**
   * 升级瞬间 workspace HEAD 的可信推导。
   * 禁止用 workspaceRef.baseRevision 冒充 current HEAD。
   */
  async #derivePromotionWorkspaceRevision(
    mission: Mission,
  ): Promise<PromotionWorkspaceRevision> {
    return promotion.derivePromotionWorkspaceRevision(this.#context, mission);
  }

  /**
   * 回收 worktree 目录。**只摘目录，不删分支** —— 改动是 Mission 的产出，
   * 分支留着才查得到。失败不致命：留个目录比中断收尾好。
   */
  /**
   * 共用：锚点 → 合并 → 在合并结果上验证 → 条件回滚。入口自己决定门禁与权威。
   */
  async #runIntegrationMergeVerify(input: {
    readonly mission: Mission;
    readonly projectRoot: string;
    readonly integrationBranch: string;
    readonly verification: readonly { readonly argv: readonly string[]; readonly timeoutMs: number }[];
  }): Promise<
    | { kind: 'merge_failed'; reason?: string; anchor: string }
    | {
        kind: 'verify_failed';
        mergedInto: string;
        report: ValidationReport;
        anchor: string;
        reset: { ok: boolean; reason?: string };
      }
    | { kind: 'verified'; mergedInto: string; report: ValidationReport; anchor: string }
    | {
        kind: 'advanced_during_verify';
        mergedInto: string;
        report: ValidationReport;
        anchor: string;
        checkout?: string;
        head: string;
      }
  > {
    const workspace = this.#workspace;
    const runner = this.#validation?.commandRunner;
    const reports = this.#validation?.reports;
    if (!workspace?.resetTarget || !runner || !reports) {
      throw new PlatformRuleError(
        'MACHINE_FINALIZE_UNAVAILABLE',
        '没注入 commandRunner / reports / resetTarget，不能做合并结果验证。',
      );
    }
    const { mission, projectRoot, integrationBranch, verification } = input;
    const anchor = await workspace.targetHead(projectRoot);
    await this.#event(mission, 'final_review.integration_anchor', {
      integrationBranch,
      anchor,
    });
    const ref = mission.workspaceRef;
    if (!ref) {
      throw new PlatformRuleError('NO_WORKSPACE_REF', `Mission ${mission.id} 没记下分支信息。`);
    }
    // 与人工放行同一步：协调者提议的长期知识跟代码同一次合进去。
    await this.#landMemory(mission);
    const merged = await workspace.mergeToTarget({
      missionId: mission.id,
      projectRoot,
      branch: ref.branch,
      expectedBaseRevision: ref.baseRevision,
    });
    if (!merged.ok) {
      return { kind: 'merge_failed', reason: merged.reason, anchor };
    }
    const mergedInto = merged.mergedInto ?? (await workspace.targetHead(projectRoot));
    await this.#event(mission, 'final_review.merge_applied', {
      integrationBranch,
      mergedInto,
      anchor,
    });

    const startedAt = this.#clock.now().toISOString();
    const checks: ValidationCheckResult[] = [];
    for (const command of verification) {
      const at = this.#clock.now().toISOString();
      const result = await runner.run({
        argv: command.argv,
        cwd: projectRoot,
        timeoutMs: command.timeoutMs,
      });
      checks.push(
        Object.freeze({
          kind: 'command' as const,
          passed: result.exitCode === 0 && !result.timedOut,
          startedAt: at,
          endedAt: this.#clock.now().toISOString(),
          summary: `${command.argv.join(' ')} → ${result.timedOut ? 'timeout' : String(result.exitCode)}`,
          command: Object.freeze({
            argv: Object.freeze([...command.argv]),
            cwd: projectRoot,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            durationMs: result.durationMs,
            outputTail: redactSecrets(result.output).slice(-2000),
          }),
        }),
      );
    }
    const passed = checks.every((check) => check.passed);
    const report: ValidationReport = Object.freeze({
      id: this.#ids.next('IVAL'),
      policyRevision: VALIDATION_POLICY_REVISION,
      missionId: mission.id,
      startedAt,
      endedAt: this.#clock.now().toISOString(),
      passed,
      checks: Object.freeze(checks),
    });
    await reports.save(report);
    await this.#event(mission, 'final_review.integration_verified', {
      reportId: report.id,
      passed,
      mergedInto,
    });
    if (!passed) {
      let reset: { ok: boolean; reason?: string };
      try {
        reset = await workspace.resetTarget({
          projectRoot,
          toRevision: anchor,
          expectedHead: mergedInto,
        });
      } catch (error) {
        // git reset 抛错不能当未处理异常溜走：当次必须留下可持久识别的
        // rollback_failed，重建平台后再放行才能继续拦住。
        reset = {
          ok: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      return { kind: 'verify_failed', mergedInto, report, anchor, reset };
    }
    // 验证绿了还不能签字：runner 期间第三方可能已推进目标或切走 checkout。
    // checkout 仍是目标分支、HEAD 仍是本次合并提交（合并结果未被替换），缺一不签 FinalReview。
    const checkoutNow =
      typeof workspace.currentBranch === 'function'
        ? await workspace.currentBranch(projectRoot)
        : undefined;
    const headNow = await workspace.targetHead(projectRoot);
    if (checkoutNow !== integrationBranch || headNow !== mergedInto) {
      return {
        kind: 'advanced_during_verify',
        mergedInto,
        report,
        anchor,
        checkout: checkoutNow,
        head: headNow,
      };
    }
    return { kind: 'verified', mergedInto, report, anchor };
  }

  async #loadHaAuthority(
    repoRoot: string,
    worktreePaths: readonly string[],
  ): Promise<HaAuthorityConfig> {
    try {
      return await loadHaAuthorityConfig({
        filePath: this.#haAuthorityFile ?? process.env[HA_AUTHORITY_ENV],
        repoRoot,
        worktreePaths,
      });
    } catch (error) {
      throw this.#wrapHaAuthorityError(error);
    }
  }

  /**
   * 目标 HEAD 是否已经包含 Mission 分支上的提交（已合未记）。
   * 分支仍等于分叉基线时不算：那只说明目标自己前进了。
   */
  async #haMissionAlreadyInHead(
    workspace: WorkspaceManager,
    projectRoot: string,
    missionBranch: string,
    baseRevision: string,
    headNow: string,
  ): Promise<boolean> {
    if (typeof workspace.revisionIsAncestor !== 'function') return false;
    const isAncestor = workspace.revisionIsAncestor.bind(workspace);
    const contained = await isAncestor(projectRoot, missionBranch, headNow);
    if (!contained) return false;
    const stillAtBaseline =
      (await isAncestor(projectRoot, missionBranch, baseRevision)) &&
      (await isAncestor(projectRoot, baseRevision, missionBranch));
    return !stillAtBaseline;
  }

  async #haWorktreePaths(
    workspace: WorkspaceManager,
    projectRoot: string,
  ): Promise<readonly string[]> {
    if (typeof workspace.listWorktreePaths !== 'function') {
      throw new PlatformRuleError(
        HA_AUTHORITY_CODE.WORKTREE_UNRESOLVABLE,
        'HA 放行拒绝（HA_AUTHORITY_WORKTREE_UNRESOLVABLE）：无法枚举 worktree。',
      );
    }
    try {
      const listed = await workspace.listWorktreePaths(projectRoot);
      if (!listed || listed.length === 0) {
        throw new Error('empty');
      }
      return listed;
    } catch {
      throw new PlatformRuleError(
        HA_AUTHORITY_CODE.WORKTREE_UNRESOLVABLE,
        'HA 放行拒绝（HA_AUTHORITY_WORKTREE_UNRESOLVABLE）：无法可靠枚举 worktree。',
      );
    }
  }

  #wrapHaAuthorityError(error: unknown): PlatformRuleError {
    if (error instanceof HaAuthorityError) {
      return new PlatformRuleError(error.code, error.message);
    }
    if (error instanceof PlatformRuleError) return error;
    return new PlatformRuleError(
      HA_AUTHORITY_CODE.INVALID_FIELDS,
      'HA 放行拒绝（HA_AUTHORITY_INVALID_FIELDS）：授权配置不可用。',
    );
  }

  async #haUnsafe(
    missionId: string,
  ): Promise<{ reason: string } | undefined> {
    const events = await this.#activity.list(missionId);
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]!;
      if (event.kind !== 'final_review.ha_unsafe') continue;
      const data = event.data;
      if (data == null || typeof data !== 'object' || Array.isArray(data)) continue;
      const reason = (data as { reason?: unknown }).reason;
      if (typeof reason === 'string' && reason.trim() !== '') return { reason };
      return { reason: 'unsafe' };
    }
    return undefined;
  }

  async #markHaUnsafe(
    mission: Mission,
    reason: 'merged_unrecorded' | 'rollback_failed' | 'third_party_advanced' | 'advanced_during_verify',
    extra: { head?: string; anchor?: string; reportId?: string },
  ): Promise<void> {
    await this.#event(mission, 'final_review.ha_unsafe', {
      reason,
      ...extra,
      hint: this.#haUnsafeHint(reason),
    });
  }

  #haUnsafeHint(reason: string): string {
    if (reason === 'merged_unrecorded') {
      return (
        'HA 合并已落到目标分支但 Mission 未记完成。' +
        '请人工核对锚点、当前 HEAD 与集成报告后再处置；禁止自动重合。'
      );
    }
    if (reason === 'third_party_advanced') {
      return (
        '集成分支在验证期间被第三方推进，未回滚。' +
        '请人工核对锚点、当前 HEAD 与集成报告后再处置；禁止自动重合。'
      );
    }
    if (reason === 'advanced_during_verify') {
      return (
        '集成验证期间目标分支被推进或 checkout 被切换，未签字。' +
        '请人工核对锚点、当前 HEAD 与集成报告后再处置；禁止自动重合。'
      );
    }
    return (
      'HA 验证未通过且回滚失败，集成分支可能不安全。' +
      '请人工核对锚点、当前 HEAD 与集成报告后再处置；禁止自动重合。'
    );
  }

  #explicitHaCommands(
    missionId: string,
    commands: readonly { readonly argv: readonly string[]; readonly timeoutMs: number }[],
  ): { argv: string[]; timeoutMs: number }[] {
    const invalid = (): never => {
      throw new PlatformRuleError(
        'HA_VERIFICATION_REQUIRED',
        `Mission ${missionId} 的显式验证命令非法，拒绝合并。`,
      );
    };
    if (!Array.isArray(commands) || commands.length === 0) invalid();
    return commands.map((command) => {
      if (!command || !Array.isArray(command.argv) || command.argv.length === 0 ||
          command.argv.some((part) => typeof part !== 'string' || part.trim() === '') ||
          !Number.isInteger(command.timeoutMs) || command.timeoutMs <= 0) invalid();
      return { argv: [...command.argv], timeoutMs: command.timeoutMs };
    });
  }

  #planLevelCommands(mission: Mission): { argv: string[]; timeoutMs: number }[] {
    const out: { argv: string[]; timeoutMs: number }[] = [];
    const seen = new Set<string>();
    for (const item of mission.workItems) {
      if (item.status === 'retired') continue;
      for (const command of item.order?.validation?.commands ?? []) {
        if (
          !Array.isArray(command.argv) ||
          command.argv.length === 0 ||
          command.argv.some((part) => typeof part !== 'string' || part.trim() === '')
        ) {
          throw new PlatformRuleError(
            'HA_VERIFICATION_REQUIRED',
            `Mission ${mission.id} 的冻结验证命令非法，拒绝合并。`,
          );
        }
        if (typeof command.timeoutMs !== 'number' || !Number.isFinite(command.timeoutMs) || command.timeoutMs <= 0) {
          throw new PlatformRuleError(
            'HA_VERIFICATION_REQUIRED',
            `Mission ${mission.id} 的冻结验证命令 timeoutMs 非法，拒绝合并。`,
          );
        }
        const argv = [...command.argv];
        const key = JSON.stringify([argv, command.timeoutMs]);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ argv, timeoutMs: command.timeoutMs });
      }
    }
    if (out.length === 0) {
      throw new PlatformRuleError(
        'HA_VERIFICATION_REQUIRED',
        `Mission ${mission.id} 没有非空方案级验证命令，拒绝合并。`,
      );
    }
    return out;
  }

  #isForbiddenMaster(branch: string): boolean {
    const trimmed = branch.trim();
    return trimmed === 'master' || trimmed === 'refs/heads/master';
  }

  /**
   * 批准的长期知识写进 **Mission 自己的 worktree**，跟代码同一次 merge 落地。
   * 分两次提交的话，"代码进去了文档没进去"就会发生——而且没人会发现。
   * 人工放行与机器放行共用这一步。
   */
  async #landMemory(mission: Mission): Promise<void> {
    const ref = mission.workspaceRef;
    const proposals = mission.result?.memoryDelta ?? [];
    if (!ref || proposals.length === 0 || ref.branch === '(in-place)') return;
    const worktreeRoot = this.#workspace?.worktreePath?.(mission.id, ref.projectRoot);
    if (!worktreeRoot) return;
    const written = applyMemoryDelta(worktreeRoot, proposals);
    // 传 projectId：worktree 的目录名是 Mission ID，
    // 靠它兜底会让 VIBE.md 的标题变成 Mission 名。
    const vibe = writeVibe(worktreeRoot, mission.projectId);
    await this.#event(mission, 'memory.applied', { written: [...written, vibe] });
  }

  async #releaseWorkspace(missionId: string, projectRoot?: string): Promise<void> {
    return this.#context.releaseWorkspace(missionId, projectRoot);
  }

  async #ensureProject(projectId: string) {
    return this.#context.ensureProject(projectId);
  }

  async #locate(missionId: string): Promise<{ mission: Mission; project: Project }> {
    return this.#context.locate(missionId);
  }

  async #locateItem(
    missionId: string,
    workItemId: string,
  ): Promise<{ mission: Mission; item: WorkItem }> {
    return this.#context.locateItem(missionId, workItemId);
  }

  /**
   * 校验调用方身份。
   *
   * 工具面只是第一道闸：HTTP 端点是可达的，所以"执行者不得改 Plan"这条
   * 必须在这里再挡一次——按 attempt 的 kind 判定，而不是相信调用方自称。
   */
  async #requireAttempt(
    missionId: string,
    attemptId: string,
    kind: AttemptKind,
  ): Promise<{ mission: Mission; project: Project; attempt: Attempt }> {
    return this.#context.requireAttempt(missionId, attemptId, kind);
  }

  async #event(
    mission: Mission,
    kind: string,
    data: unknown,
    workItemId?: string,
    attemptId?: string,
  ): Promise<void> {
    return this.#context.event(mission, kind, data, workItemId, attemptId);
  }
}

/**
 * Envelope 协议版本（S10.3）。
 *
 * 和 API_VERSION 分开：客户端接口和事件信封是两个会各自演进的东西，
 * 绑在一起就等于任何一边动了都要让另一边跟着升版本。
 */
export { PROTOCOL_VERSION } from './platform/context.ts';

/* ================================ 读模型 ================================ */















export { InvariantViolationError };

