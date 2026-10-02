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
  WorkItemStatus,
  WorkOrder,
  WorkspaceRef,
} from '../../kernel/index.ts';
import type {
  ActivityEvent,
  ActivityLog,
  Clock,
  CommandTransaction,
  ContextMetricsBriefSource,
  ContextMetricsBriefSourceEntry,
  ContextMetricsCoverage,
  ContextMetricsReadBucketV1,
  ContextMetricsToolBucketV1,
  ContextMetricsToolKind,
  ContextMetricsV1,
  DecisionHook,
  DecisionProvider,
  FencedCommandTransaction,
  IdGenerator,
  PostExecutionEvaluator,
  ProjectRepository,
} from '../ports.ts';
import type { ClaimFence } from '../durable-scheduler.ts';
import type { DeliveryRepository } from '../delivery.ts';
import type { WorkspaceManager } from '../workspace.ts';
import type { ArtifactStore } from '../artifact-store.ts';
import type { CommandRunner } from '../validation/ports.ts';
import type { LiveOutput } from '../live.ts';
import type { ClassificationResult } from '../task-classifier.ts';
import type { BoundWorkItem, ContractCheck, ContextBundle, WorkItemIndexEntry } from '../context-builder.ts';
import type { StandardAutoRedispatchReason, StandardAutoRedispatchSkipReason } from '../platform.ts';

/**
 * Lightweight 机器验收依赖（结构类型，避免 platform 直接耦合 validation 模块路径）。
 * engine / reports 由装配层注入；Standard 路径不读这组。
 */
export interface PlatformValidationDeps {
  readonly engine: {
    readonly validate: (input: {
      readonly missionId: string;
      readonly baseRevision: string;
      readonly projectRoot: string;
      readonly workItemId?: string;
      readonly attemptId?: string;
      readonly allowedScope: readonly string[];
      readonly commands: readonly {
        readonly argv: readonly string[];
        readonly cwd: string;
        readonly timeoutMs: number;
      }[];
      /** 仅从 frozen WorkOrder.validation 拷贝；缺省 = 检查不在 force。 */
      readonly forbiddenPaths?: readonly string[];
      readonly diffSize?: {
        readonly maxChangedFiles?: number;
        readonly maxChangedLines?: number;
      };
    }) => Promise<{
      readonly report: ValidationReport;
      readonly authority?: Extract<ReviewAuthority, { kind: 'validator' }>;
    }>;
  };
  readonly reports: {
    save(report: ValidationReport): Promise<void>;
    get(reportId: string): Promise<ValidationReport | undefined>;
  };
  /**
   * 跑方案级集成命令用。缺了就没有机器放行——fail-closed，不退化成「不验直接合」。
   *
   * 与 `engine` 分开：engine 验的是单条 Mission 自己的 diff（allowedScope /
   * changed-paths / diff-size），跑在合并**之前**的独立 worktree 里；集成检查只做
   * 一件事——在合并**之后**的集成分支上跑一组命令，看这个功能有没有打坏别人。
   * 两者证据来源不同，不能互相顶替。
   */
  readonly commandRunner?: CommandRunner;
}

/**
 * 生产 API / Orchestrator 传入的可信队列领取身份。
 *
 * 只含存储层能对上的 id/owner/代次；**不含 now**——调用方填 now 等于把租约时钟交给客户端，
 * 过期 Runner 可以把时间拨回去继续写。now 由平台 clock 在写事务启动时填进 ClaimFence。
 * 不要从 request body 构造这份身份。
 */
export interface QueueClaimIdentity {
  readonly id: string;
  readonly owner: string;
  readonly claimGeneration: number;
}

/**
 * 自动续派交给下一跳的交接信息。
 *
 * 它同时是**持久化**的（事件里 + 提交 Attempt 上），所以进程被杀之后编排器还能读回
 * 「上一轮为什么退回、上轮说明是什么」——只存在内存里的交接，恰好会在最需要它的
 * 那一刻（重启后）消失。
 */
export interface StandardAutoRedispatchHandoff {
  readonly workItemId: string;
  readonly reason: StandardAutoRedispatchReason;
  /** 触发这次接续的原提交 attemptId。 */
  readonly attemptId: string;
  /** 该原因下累计的自动续派次数（含这一次）。 */
  readonly count: number;
  /** partial 的上轮说明 / 验证失败报告的失败摘要；已脱敏、已截尾。 */
  readonly summary: string;
  /**
   * validation_failed 时的报告 id。
   * 原报告留在仓储里不删，第三次失败时 L2 据此把各次报告逐份复核。
   */
  readonly reportId?: string;
  /** partial 时上一跳留下的续跑句柄；没有就缺省 = 起新会话。 */
  readonly resumeRef?: string;
}

export interface StandardAutoRedispatchResult {
  readonly redispatched: boolean;
  /** 续派成功是依据，未续派是没有续派的原因。 */
  readonly reason: StandardAutoRedispatchReason | StandardAutoRedispatchSkipReason;
  /** 续派成功时的本次交接；未续派时缺省（历史交接仍可用 getStandardAutoRedispatchHandoff 读回）。 */
  readonly handoff?: StandardAutoRedispatchHandoff;
}

export interface PlatformDeps {
  projects: ProjectRepository;
  deliveries: DeliveryRepository;
  /** 落地改动要用。不配就只能做 send_back / abandon。 */
  workspace?: WorkspaceManager;
  /** 大日志/大 diff 外置。不配就全内联（状态文件会变大）。 */
  artifacts?: ArtifactStore;
  activity: ActivityLog;
  clock: Clock;
  ids: IdGenerator;
  /**
   * 可选 DecisionProvider。仅用于 shadow 审计（跑哪些钩子见 decisionHooks）：
   * 不注入则完全跳过；注入后信号/失败也不影响真实 dispatch。
   */
  decisionProvider?: DecisionProvider;
  /**
   * 注入了 provider 时哪些钩子跑 shadow。缺省只有 POST_EXECUTION（见 parseDecisionHooks）：
   * PRE_DISPATCH 只给 ID 时答案是常数，要显式开。
   */
  decisionHooks?: ReadonlySet<DecisionHook>;
  /**
   * POST_EXECUTION 评估器（J2）。注入且钩子含 POST_EXECUTION 时，编排器在交卷 + 确定性验收之后
   * 调 runPostExecutionShadow；不注入则完全跳过。
   */
  postExecutionEvaluator?: PostExecutionEvaluator;
  /**
   * 命令事务（C2）。注入了，交卷与升级这几条命令的状态改动、事件、投递一起提交，或者一个都不落；
   * 缺省（内存版、PG 暂未接）直接跑，行为与之前相同。
   */
  transaction?: CommandTransaction;
  /**
   * Lightweight 机器验收依赖（成组 optional）。
   * Standard 路径不读这组；缺省时 validateAndAcceptLightweightWorkItem fail-closed。
   */
  validation?: PlatformValidationDeps;
  /**
   * 测试注入 HA 授权文件绝对路径。生产只读 COAGENT_HA_AUTHORITY_FILE，每次现读。
   */
  haAuthorityFile?: string;
  /**
   * 可选实时通道。finishAttempt 落地前取本跳尾部写入 Attempt.output。
   * 不注入则行为与原来一样（只信 outcome.output）。Orchestrator 仍在收尾之后才 live.finish。
   */
  live?: LiveOutput;
}

export interface CreateMissionInput {
  projectId: string;
  missionId?: string;
  contract: MissionContract;
  /** 结果最终回到哪里。缺省表示无人认领——结果仍会进收件箱，只是没有收件人。 */
  origin?: OriginChannel;
}

/**
 * Classified Mission 入口：facts/assessment + Contract + 可选 explicit WorkOrder。
 * caller **不得**传 executionMode / runKind / ClassificationResult 等 route override。
 * 平台内部 strict parse + classifyTask 决定路由。
 */
export interface CreateClassifiedMissionInput {
  projectId: string;
  missionId?: string;
  contract: MissionContract;
  origin?: OriginChannel;
  /** 结构化 facts；由 strict parser 校验。 */
  facts: unknown;
  /** 可选六维评估；缺省不传。 */
  assessment?: unknown;
  /**
   * explicit WorkOrder。lightweight 必填；standard / 合规 HA 禁止；
   * query 与带禁止副作用的 HA 路径到不了创建。
   */
  workOrder?: WorkOrder;
}

export interface CreateClassifiedMissionResult {
  missionId: string;
  workItemId?: string;
  classification: ClassificationResult;
}

export interface MissionView {
  missionId: string;
  projectId: string;
  status: string;
  /** 创建时选定的执行保障档位；只读，不从 origin/workItems 推断。 */
  executionMode: MissionExecutionMode;
  /** 创建时选定的运行种类；只读，与 executionMode 正交。 */
  runKind: RunKind;
  /** Lightweight→Standard 升级历史（只读）；便于观测面显示原模式/当前模式/升级原因。 */
  promotions: readonly PromotionRecord[];
  /** 为什么停着。undefined = 没停。 */
  waitReason: WaitReason | undefined;
  waitDetail: string | undefined;
  updatedAt: string | undefined;
  paused: boolean;
  isMutating: boolean;
  parked: boolean;
  parkReason: string | undefined;
  /**
   * 同 Project 里**别的**哪条 Mission 正占着改动名额（不变量 C）。没有就是
   * undefined；自己占着也是 undefined —— 这一格回答的是"谁挡着我"。
   *
   * 有它，调度器才能在**花钱之前**停下来。原先只有 dispatchWorkItems 会撞上
   * PROJECT_BUSY，而那是在协调者调查完、规划完、拆完工作项之后——实测 P2
   * 因此花掉 $0.70 才被告知名额被占，而占着它的是一条早就死掉的测量跑。
   */
  blockedByMission: string | undefined;
  contractRevision: number;
  contract: MissionContract | undefined;
  planRevision: number;
  plan: PlanBody | undefined;
  workItems: {
    id: string;
    title: string;
    status: string;
    hasResult: boolean;
    attempts: number;
    attemptIds: string[];
    lastReview?: ReviewRecord;
    /**
     * submitted 工作项：最新提交 attempt 的**每条**证据，脱敏后再截尾，协调者直接拿到可核实的
     * 产物，不必再自己重跑测试（实测每跳命令输出平均 40 KB）。每条 {command,exitCode,
     * summary,outputTail}；output 先 redactSecrets 再 slice(-1000)，command/summary 也过脱敏。
     * 其它状态（含已验收）为 undefined——已验收成果看 executionResult 摘要即可，不返还证据输出。
     */
    submittedEvidence?: readonly {
      readonly command: string | undefined;
      readonly exitCode: number | undefined;
      readonly summary: string;
      readonly outputTail: string;
    }[];
    /**
     * accepted / rejected 工作项：只给证据条数和最后一次评审结论，不泄露证据输出。
     * evidenceCount 取自最新提交 attempt 的证据条数；verdict 即该工作项当前验收态
     * （= 最后一次评审的 verdict）。其它状态为 undefined；submitted 走 submittedEvidence，不填这一格。
     */
    reviewSummary?: {
      readonly evidenceCount: number;
      readonly verdict: 'accept' | 'reject';
    };
    /**
     * 最近一次交卷的机器验证简版。只读，来自 W-321 落盘的报告而非命令输出自报；
     * 不是 Evidence，也不是 validator accept。没有报告时不带这一格。
     */
    validationReport?: ValidationReportView;
    /**
     * 工单正文。**这是 L2 交给 L1 的那封信**——目标、范围、怎么验证、
     * 什么算做完。观测面要让人看到 agent 之间到底传了什么，缺了它就只剩
     * 一个标题，而"为什么它做成了这样"全在这份正文里。
     */
    order?: WorkOrder;
    /** L1 交回的那封信：做完了什么、动了哪些文件、有什么要说的。 */
    executionResult?: ExecutionResultBody;
  }[];
  result: MissionResultBody | undefined;
  /** 升级次数。调度器据此判断「该停下来等 L3 了」。 */
  escalations: number;
  /** 未答复的升级。有就说明在等 L3，不该再叫协调者。 */
  openEscalations: EscalationBody[];
  escalationLog: EscalationBody[];
  /**
   * 这条 Mission 从哪来。调度器据此认出**重跑**（rerunOf 有值）——重跑的起点
   * 是钉住的，按定义处在"基线 ≠ 目标分支当前位置"的状态，不该被派发前的
   * 过期闸拦下。
   */
  origin: OriginChannel | undefined;
  coordinatorResumeRef: string | undefined;
  coordinatorAttemptIds: string[];
  independentReviewerAttemptIds: string[];
  independentReviews: readonly IndependentReviewRecord[];
  independentReviewBlockReason: IndependentReviewBlockReason | undefined;
  independentReviewBlockDetail: string | undefined;
  /** HA 停在 awaiting_review 时的可读子态；非 HA 为 undefined。 */
  haReviewHold?: 'pending_dispatch' | 'in_review' | 'pending_release' | 'fault';
  finalReview: FinalReview | undefined;
  workspaceRef: WorkspaceRef | undefined;
  usage: TokenUsage;
}

export interface MissionSummary {
  missionId: string;
  projectId: string;
  status: string;
  waitReason: WaitReason | undefined;
  waitDetail: string | undefined;
  updatedAt: string | undefined;
  paused: boolean;
  isMutating: boolean;
  intent: string;
  workItems: number;
  accepted: number;
  openEscalations: number;
  usage: TokenUsage;
  /** 仅 origin 可准确确认为 plan-run 时出现；普通 Mission 不带这两个键。 */
  planRunId?: string;
  featureId?: string;
}

export interface WorkOrderView {
  workItemId: string;
  title: string;
  status: string;
  order: WorkOrder;
  missionIntent: string;
  guardrails: readonly string[];
  /**
   * 最近一次 reject 的 requiredChanges。**没有 reject 就不带这个键**——`[]` 会被
   * 读成「上次要求是空」，而真相是「上次根本没打回过」，比缺字段更误导。
   */
  previousRequiredChanges?: readonly string[];
  /** L3 打回整个 Mission 的理由。和 previousRequiredChanges 各自可缺，互不依赖。 */
  l3SendBackReasons?: readonly string[];
  question?: string;
  answer?: string;
  answeredAt?: string;
}

/**
 * 同一个任务的一次运行。listRuns 的行。
 *
 * 刻意**不含**"哪个模型跑的"：那是候选池的事，一条 Mission 里不同跳可能
 * 用了不同候选。要按配置归因，看各 attempt 上冻住的 resolvedProfile。
 */
export interface RunSummary {
  missionId: string;
  /** 是不是最初那一条（其余都是它的重跑）。 */
  isOriginal: boolean;
  status: string;
  /** 交卷结论；还没交卷就是 undefined。 */
  outcome: string | undefined;
  contractRevision: number;
  /** 进入本次运行时的 lane；晋升后仍保留 lightweight，避免被当前 standard 覆盖。 */
  entryMode: MissionExecutionMode;
  /** 当前 lane。发生过 lightweight → standard 晋升时与 entryMode 不同。 */
  currentMode: MissionExecutionMode;
  /** 可信 PromotionRecord 的触发原因；没有晋升就是 undefined。 */
  promotionTrigger: PromotionTriggerCode | undefined;
  /** 用于判断两次运行是否同一 Git 起点；历史没记录就 unknown。 */
  baseRevision: string | undefined;
  /** mission.created → 第一条 execution_result.submitted；缺任一可信时间即 unknown。 */
  firstExecutionResultMs: number | undefined;
  /** 仅终态：mission.created → 最后状态事件时间；历史缺时间即 unknown。 */
  totalDurationMs: number | undefined;
  /** Standard L2 review 计数；validator authority 不混进来。 */
  l2Reviews: number;
  l2Rejects: number;
  /** L3 最终检视决策计数与 send_back 次数。 */
  l3Reviews: number;
  l3SendBacks: number;
  /** 机器 Validator 的真实 report 次数/失败次数。 */
  validatorRuns: number;
  validatorFailures: number;
  coordinatorHops: number;
  executorHops: number;
  workItems: number;
  usage: TokenUsage;
  /** 各跳的结束原因分布。**分类的价值就在这一格**：以前全是 upstream_failure。 */
  endedBy: Record<string, number>;
}

/**
 * 工单违背「工单标准」（用户 2026-10-01）时的软警告项。
 *
 * 只审计、不硬拒：协调者工具路径仍照常成功，警告随建单/修订事件一并记录，
 * 由协调者照建议拆单或补文件引用。直接调用 Platform 不触发此检查。
 */
export interface WorkOrderStandardWarning {
  /** 违规项：允许改动范围过大、验证超过两条、最小上下文缺失。 */
  readonly rule: 'allowedScope' | 'verification' | 'contextRefs';
  /** 给协调者的一句能照做的下一步（拆单 / 补文件引用建议）。 */
  readonly suggestion: string;
}

/**
 * 机器验证简版里单条命令的结果。
 *
 * `outputTail` **只在命令失败时出现**：简版要进协调者索引与启动简报，把每条命令
 * 最多 4096 字符的尾巴全搬回去，等于换一种方式把测试输出重新灌进上下文；协调者
 * 要看的是「过没过、慢不慢、哪儿越界」，只有失败的那条需要原文。
 */
export interface ValidationReportCommandView {
  readonly passed: boolean;
  readonly durationMs: number;
  /** 失败命令的输出尾：先 redactSecrets 再只留尾 1000 字。 */
  readonly outputTail?: string;
}

/**
 * 机器验证简版：W-321 落盘 ValidationReport 的只读投影。
 *
 * 它不是 Evidence（执行者自报的证据），也不是 validator accept——报告来自 platform
 * 自己跑出来、存在仓储里的事实。只按 workItemId + submittedAttemptId 对应，旧提交的
 * 报告绝不挂到新交卷头上；没有报告就不带这一格，不臆造。
 */
export interface ValidationReportView {
  readonly reportId: string;
  readonly passed: boolean;
  readonly commands: readonly ValidationReportCommandView[];
  /** changed-paths（allowedScope 越界）检查；报告里没有这条检查时缺省。 */
  readonly changedPaths?: {
    readonly passed: boolean;
    readonly violations: readonly string[];
  };
}

/**
 * agent 紧凑视图里的工作项索引：只给「编号/标题/状态/执行次数/最后评审 verdict」，
 * 不含工单正文、执行结果或评审理由——那些按需按 id 取（getAgentWorkItem）。
 * 抽成 module 级只读 helper，协调者简报后续可复用同一份投影。
 */
export interface AgentWorkItemIndexEntry {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly planRevision: number | undefined;
  readonly attempts: number;
  readonly attemptIds: readonly string[];
  readonly lastReviewVerdict: 'accept' | 'reject' | undefined;
  /** 最近一次交卷的机器验证简版；没有报告时整格缺省（不臆造）。 */
  readonly validationReport?: ValidationReportView;
  /** 覆盖的 acceptance 序号副本；无关联显式 `'—'`（空数组是另一回事）。 */
  readonly criteria: readonly number[] | '—';
}

/** 一条验收标准上的连续失败链：三个不同工作项先后没过它（AC1）。 */
export interface CriteriaFailureDiagnostic {
  /** 触发停派的那条标准序号（1-based）。 */
  readonly criterion: number;
  /** 按失败先后顺序的不同工作项 id。 */
  readonly workItemIds: readonly string[];
  /** 与 workItemIds 一一对应的失败理由原文。 */
  readonly reasons: readonly string[];
}

/**
 * 升级问答摘要：只取已被 L3 答复的升级，给「问了什么、答了什么、何时答」三件套。
 * 不带未答复升级的草稿，也不带 why / optionsConsidered 等内部字段。
 */
export interface AgentEscalationAnswer {
  readonly question: string;
  readonly answer: string;
  readonly answeredAt: string;
}

export interface AgentMissionView {
  readonly missionId: string;
  readonly projectId: string;
  readonly status: string;
  readonly executionMode: string;
  readonly runKind: string;
  readonly updatedAt: string;
  readonly contractRevision: number;
  readonly planRevision: number;
  /** 完整契约（不截断）。 */
  readonly contract: MissionContract | undefined;
  /** 完整规划（不截断）。 */
  readonly plan: PlanBody | undefined;
  /** 只含工作项索引，不含工单、执行结果或评审正文。 */
  readonly workItemIndex: readonly AgentWorkItemIndexEntry[];
  /** 升级问答摘要。 */
  readonly escalations: readonly AgentEscalationAnswer[];
  readonly openEscalations: number;
}

export interface AgentWorkItemEvidenceSummary {
  readonly attemptId: string;
  readonly kind: EvidenceKind;
  readonly summary: string;
  readonly command: string | undefined;
  readonly exitCode: number | undefined;
  readonly outputTail: string;
}

/**
 * 单次 execution_result.submitted 的现存元数据摘要。
 * 只记事件里实际存下的 outcome / changedFiles(数量) / orderRevision / 时间；
 * 非最新的提交正文（执行结果全文）未被持久化、不可恢复，显式标注「旧正文未保存」。
 * 绝不臆造旧正文——旧记录只给上述元数据，最新一次正文仍经 executionResult 取。
 */
export interface AgentWorkItemSubmissionSummary {
  /** 事件发生时间（ISO 字符串），保留原时间顺序。 */
  readonly at: string;
  readonly outcome: string | undefined;
  readonly changedFiles: number | undefined;
  readonly orderRevision: string | undefined;
  /** 是否最新一次提交：只有它对应的全文经 executionResult 可取。 */
  readonly isLatest: boolean;
  /** 非最新提交：正文未保存、仅存元数据，不可恢复。 */
  readonly note: string | undefined;
}

export interface AgentWorkItemView {
  readonly workItemId: string;
  readonly title: string;
  readonly status: string;
  readonly orderRevision: string | undefined;
  readonly order: WorkOrder | undefined;
  readonly executionResult: ExecutionResultBody | undefined;
  readonly reviews: readonly { readonly verdict: 'accept' | 'reject'; readonly reasons: readonly string[]; readonly requiredChanges: readonly string[] }[];
  readonly evidenceSummary: readonly AgentWorkItemEvidenceSummary[];
  /** 历次 execution_result.submitted 的现存元数据；早于最新的标「旧正文未保存」。 */
  readonly submissionSummaries: readonly AgentWorkItemSubmissionSummary[];
  /**
   * 最近一次交卷的机器验证简版（W-321 落盘报告）。不是 Evidence，也不是
   * validator accept；没有报告时不带这一格。受下面 20 KB 上限约束：极端超限时
   * 只保索引字段与历史提交摘要，它会被丢掉。
   */
  readonly validationReport?: ValidationReportView;
  /**
   * 覆盖的 acceptance 序号，无关联 `'—'`。顶层字段：20KB 收紧时 order 会被裁掉，
   * 这一格必须还在——它回答「这项服务哪条验收标准」。
   */
  readonly criteria: readonly number[] | '—';
  /** 序列化 UTF-8 超过 20 KB 时为真，内容已被截断到尽量贴近上限。 */
  readonly truncated: boolean;
}

/** 一个分组维度上的一行。 */
export interface UsageBucket {
  key: string;
  attempts: number;
  usage: TokenUsage;
}

/** 用量报表（S11.5）。 */
export interface UsageReport {
  total: TokenUsage;
  attempts: number;
  /**
   * 没冻结过身份、因而进不了 byFact 的 attempt 数。
   *
   * 单列出来而不是摊给某个身份：摊给谁都是编的，而这个数本身就是信号——
   * 它不为零就说明有一批 attempt 的归因是缺的。
   */
  unattributed: number;
  byProject: UsageBucket[];
  byMission: UsageBucket[];
  byRole: UsageBucket[];
  /** 按运行时报回来的事实分组。适配层填 provider / model，所以这一项覆盖了两者。 */
  byFact: { key: string; value: string; attempts: number; usage: TokenUsage }[];
}
