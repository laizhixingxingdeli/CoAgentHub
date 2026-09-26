/**
 * 领域载荷：契约、计划、工单、执行结果、证据、验收记录、用量。
 *
 * 这些是**不可变数据**，不是状态机。状态归聚合，载荷归这里。
 * 全部 freeze，避免调用方拿到引用后改掉聚合内部。
 */

/**
 * Mission 从哪来。结果最终要回到这里。
 *
 * 平台只当它是不透明的路由信息：`clientType` 说明该由哪个 Host 适配器投递，
 * `conversationRef` 是那个 Host 自己认得的会话标识。**不存 URL、令牌、命令**
 * —— Host 私有的恢复逻辑不属于平台。
 */
export interface OriginChannel {
  readonly clientType: string;
  readonly conversationRef?: string;
  /**
   * 这是哪条 Mission 的重跑。
   *
   * 重跑不是"把原来那条洗一遍再用"，是**另起一条、契约一字不改**。这样每次
   * 运行都是独立的一份记录（自己的 attempt、用量、耗时、结束原因），能横着比；
   * 原来那条的历史也一点不动。
   *
   * 放在 origin 里而不是 Mission 顶层：它讲的是"这条任务从哪来"，和
   * clientType/conversationRef 是同一件事的不同来源，不是新的领域概念。
   */
  readonly rerunOf?: string;
  /**
   * 这是哪条 QueryRun 显式 promote 来的。
   *
   * 与 rerunOf 同属来源图：只记可信的 QueryRunRecord.id，不复制 findings。
   * Findings 权威仍在 QueryRunRepository，下游靠 queryRunId 再 get。
   * Promotion 路径写入；rerun 路径不写。
   */
  readonly queryRunId?: string;
}

/** Mission 执行保障档位：创建时选定，全程只读。 */
export type MissionExecutionMode = 'lightweight' | 'standard' | 'high_assurance';

/**
 * Mission 运行种类：与 executionMode 正交的只读轴。
 *
 * - mutation：可修改仓库（默认；兼容既有行为）
 * - query：只读查询类运行（本阶段仅载荷/快照，不改变执行行为）
 */
export type RunKind = 'mutation' | 'query';

/**
 * Mission 六维复杂度评估载荷。可选、只读；不计算总分、不驱动路由。
 *
 * 未评估时整段为 undefined（禁止默认全 0）。分数本身只是数据合同。
 */
export interface ComplexityAssessment {
  readonly goalUncertainty: 0 | 1 | 2;
  readonly changeScope: 0 | 1 | 2;
  readonly operationalRisk: 0 | 1 | 2;
  readonly verificationDifficulty: 0 | 1 | 2;
  readonly coordinationNeed: 0 | 1 | 2;
  readonly recoveryDifficulty: 0 | 1 | 2;
  readonly reasons: readonly string[];
  readonly decidedBy: 'rule' | 'user' | 'coordinator';
  readonly assessedAt: string;
}

/**
 * Mission 执行预算上限载荷。可选、不可变；本阶段仅合同 + snapshot/restore，
 * 不实现 BudgetPolicy、不接 classifier/usage gates/promotion。
 *
 * 缺省/非法 -> undefined（禁止填默认预算）。不 clamp、不 partial。
 */
export interface ExecutionBudget {
  readonly maxAttempts: number;
  readonly maxRounds: number;
  readonly maxWallClockMs: number;
  readonly maxInputTokens?: number;
  readonly maxOutputTokens?: number;
  readonly maxTotalTokens?: number;
  readonly maxCost?: number;
  readonly maxChangedFiles?: number;
  readonly maxCommands?: number;
}

/**
 * Lightweight → Standard 升级触发码（PROMO-001）。
 *
 * 码表先齐；自动检测器后置。本阶段只作可信合同字段，不实现 detectors。
 */
export type PromotionTriggerCode =
  | 'changed_files_gt_3'
  | 'top_level_modules_gt_2'
  | 'new_dependency'
  | 'new_public_interface'
  | 'persistence_format_change'
  | 'executor_ambiguity'
  | 'invalid_premise'
  | 'design_decision'
  | 'validator_failure_unrepairable'
  | 'permission_expansion'
  | 'budget_exceeded'
  | 'diff_intent_unprovable';

/** 权威触发码表；kernel / platform 共用，禁止各写一份。 */
export const PROMOTION_TRIGGER_CODES: readonly PromotionTriggerCode[] = [
  'changed_files_gt_3',
  'top_level_modules_gt_2',
  'new_dependency',
  'new_public_interface',
  'persistence_format_change',
  'executor_ambiguity',
  'invalid_premise',
  'design_decision',
  'validator_failure_unrepairable',
  'permission_expansion',
  'budget_exceeded',
  'diff_intent_unprovable',
] as const;

export function isPromotionTriggerCode(value: unknown): value is PromotionTriggerCode {
  return (
    typeof value === 'string' &&
    (PROMOTION_TRIGGER_CODES as readonly string[]).includes(value)
  );
}

/** 升级发生时 Mission 所处阶段（fromStatus）。 */
export type PromotionStatus = 'investigating' | 'planning' | 'executing';

/**
 * 升级快照里尚无权威计量的维度。
 *
 * pre-BUDGET 阶段不得用 0 冒充精确 cost/remaining；未知就显式列出。
 */
export type PromotionUnknownDimension =
  | 'tokens'
  | 'cost'
  | 'wallClockMs'
  | 'rounds'
  | 'changedFiles'
  | 'commands'
  | 'budgetRemaining';

/**
 * 升级时汇总的 token 用量快照。**不带 cost**——预算权威未就绪时不得伪精确。
 */
export interface PromotionTokenUsageSnapshot {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly total: number;
  readonly quality: 'reported' | 'estimated' | 'unknown';
}

/**
 * 升级时已消耗用量的可信摘要。
 *
 * `budgetAuthoritative` 本阶段固定 false：BudgetPolicy 未实现。
 */
export interface PromotionUsageSnapshot {
  readonly attemptCount: number;
  readonly tokenUsage?: PromotionTokenUsageSnapshot;
  readonly dimensionsUnknown: readonly PromotionUnknownDimension[];
  readonly budgetAuthoritative: false;
}

/**
 * 升级瞬间的 workspace HEAD。禁止用 workspaceRef.baseRevision 冒充 current HEAD。
 */
export type PromotionWorkspaceRevision =
  | { readonly kind: 'head'; readonly revision: string }
  | { readonly kind: 'unknown' };

/**
 * Lightweight → Standard 一次升级记录。
 *
 * `id` 由 Platform 生成并持久化；caller 不得自填审计身份。
 * 本阶段每 Mission 最多一次 L→S。数组 / nested object 必须 deep-freeze、copy-safe。
 */
export interface PromotionRecord {
  /** Platform 生成的稳定身份；restore 时空/缺则丢弃该条。 */
  readonly id: string;
  readonly fromMode: 'lightweight';
  readonly toMode: 'standard';
  readonly triggerCode: PromotionTriggerCode;
  readonly triggerRule: string;
  readonly at: string;
  readonly fromStatus: PromotionStatus;
  readonly toStatus: 'investigating' | 'planning';
  readonly consumedUsage: PromotionUsageSnapshot;
  readonly evidenceIds: readonly string[];
  readonly validationReportIds: readonly string[];
  readonly workspaceRevision: PromotionWorkspaceRevision;
  readonly workItemIdsSnapshot: readonly string[];
}

export interface MissionContract {
  readonly intent: string;
  readonly acceptance: readonly string[];
  readonly constraints: readonly string[];
  readonly nonGoals: readonly string[];
  readonly guardrails: readonly string[];
}

export interface PlanBody {
  readonly findings: string;
  readonly rootCause?: string;
  readonly rejectedHypotheses: readonly string[];
  readonly decisions: readonly string[];
  readonly direction: string;
  readonly risks: readonly string[];
}

/**
 * 工单。判据写在应用层：一个没读过上游对话的执行者，只拿这张单就能动手。
 */
/**
 * Frozen WorkOrder 上的一条机器验收命令（MODE-003）。
 *
 * 只认 argv + timeoutMs；**绝不**接受 caller cwd，也绝不从 verification prose 解析。
 */
export interface WorkOrderValidationCommand {
  readonly argv: readonly string[];
  readonly timeoutMs: number;
}

/**
 * Frozen WorkOrder 上可选的 diff 体积上限（VAL-002）。
 *
 * 至少一项；缺省 = 该检查不在 force。**不得**从 ExecutionBudget / promotion 抄默认值。
 */
export interface WorkOrderValidationDiffSize {
  readonly maxChangedFiles?: number;
  readonly maxChangedLines?: number;
}

/**
 * Frozen WorkOrder 可选的结构化 Validator command spec。
 *
 * `commands` 允许空数组（表示仅靠后续 changed-paths 等检查；是否足够由 Platform 决定）。
 * `forbiddenPaths` / `diffSize` 缺省 = 对应检查不在 force（VAL-001 路径不变）。
 */
export interface WorkOrderValidationSpec {
  readonly commands: readonly WorkOrderValidationCommand[];
  /** 显式 denylist；`[]` 仍算在 force（无 forbidden → pass）。 */
  readonly forbiddenPaths?: readonly string[];
  readonly diffSize?: WorkOrderValidationDiffSize;
}

export interface WorkOrder {
  readonly objective: string;
  readonly allowedScope: readonly string[];
  readonly requiredBehaviour: string;
  readonly constraints: readonly string[];
  readonly acceptance: readonly string[];
  readonly verification: readonly string[];
  readonly doNot: readonly string[];
  /**
   * 最小充分上下文。
   *
   * 既接裸字符串（当成 file）也接带类型的 ContextRef —— 老工单不用迁移，
   * 新的可以说清楚"这是一份 Living Spec，去 get_project_context 取"。
   */
  readonly contextRefs: readonly (string | ContextRef)[];
  /**
   * 可选结构化机器验收命令。缺省 = 旧行为；有则只认 commands，不解析 verification。
   */
  readonly validation?: WorkOrderValidationSpec;
}

export type ExecutionOutcome = 'completed' | 'partial';

export interface ExecutionResultBody {
  readonly outcome: ExecutionOutcome;
  readonly summary: string;
  readonly changedFiles: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly notes: string;
}

export type EvidenceKind =
  | 'test'
  | 'command'
  | 'diff'
  | 'typecheck'
  | 'build'
  | 'observation';

/**
 * ContextRef（S10.4）。
 *
 * 带类型而不是一串裸字符串：下游拿到 `{kind:'living_spec', ref:'scheduling'}`
 * 知道该去 coagent_get_project_context 取，拿到一个裸 "scheduling" 就只能猜。
 */
export type ContextRefKind =
  | 'file'
  | 'living_spec'
  | 'adr'
  | 'contract'
  | 'decision'
  | 'artifact'
  | 'previous_result';

export interface ContextRef {
  readonly kind: ContextRefKind;
  /** 具体指向什么：文件路径、spec slug、工作项 id …… */
  readonly ref: string;
  /** 为什么给它。省掉这句，下游只能把所有 ref 都读一遍。 */
  readonly why?: string;
}

/**
 * 运行时解析出来的一条身份事实，逐字冻结。
 *
 * 为什么是通用键值而不是两个写死的字段：**这一层不该知道"身份"由哪几个轴
 * 构成。** 今天的适配层是两个轴，换一个运行时可能是三个（多一个区域）或
 * 一个（只有端点名）。写死就等于把今天那个运行时的词汇刻进领域模型，
 * 接第二个 agent 时要改内核。
 *
 * 键的含义由适配层与用例层约定，kernel 只负责原样存、原样还。
 */
export interface ProfileFact {
  readonly key: string;
  readonly value: string;
}

/**
 * 一次尝试实际用了什么配置。**冻结在 Attempt 上**（S13.3）。
 *
 * profileId 对这一层是**不透明的选择键**：它具体指向哪个外部服务、
 * 哪个版本，由适配层解释，kernel 不认识也不该认识。
 *
 * `revision` + `resolved` 合起来回答"当时到底跑的是什么"。**这个必须冻**：
 * 不冻的话，这个问题只能去查适配层那张会变的表——表一改，全部历史归因
 * 静默错位，而且错得看不出来。S13.3 要防的正是这件事。
 */
export interface UsedProfile {
  readonly profileId: string;
  readonly endpoint: string;
  /** 候选配置表当时的版本。 */
  readonly revision?: string;
  readonly reasoning?: string;
  /** 运行时报回来的实际身份。kernel 不解释其中任何一项。 */
  readonly resolved?: readonly ProfileFact[];
}

export interface EvidenceRecord {
  readonly id: string;
  readonly attemptId: string;
  readonly kind: EvidenceKind;
  readonly summary: string;
  readonly command?: string;
  readonly exitCode?: number;
  readonly output?: string;
}

/**
 * 独立验收权威。
 *
 * `validator` 来自 ValidationEngine 的机器结论（绑定 reportId + policyRevision），
 * 与协调者自报权威分开；**没有** executor 分支——执行者不得给自己签发通过。
 */
export type ReviewAuthority =
  | { readonly kind: 'coordinator'; readonly attemptId: string }
  | { readonly kind: 'validator'; readonly reportId: string; readonly policyRevision: number };

export type ValidationCheckKind =
  | 'command'
  | 'changed-paths'
  | 'forbidden-paths'
  | 'diff-size';

/**
 * 机器可证明的结构性验收契约缺陷码。
 * 仅当 Frozen WorkOrder 本身不可执行/不可支撑时写入；可选以兼容旧报告。
 */
export type ValidationCheckFailureCode = 'invalid_argv' | 'unsupported_scope';

/** diff-size 检查中无法计量的维度（in-force 时 fail-closed）。 */
export type ValidationDiffSizeUnknownDimension = 'changedFiles' | 'changedLines';

export interface ValidationCheckResult {
  readonly kind: ValidationCheckKind;
  readonly passed: boolean;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly summary: string;
  /** 仅结构性契约缺陷；旧报告无此字段，不得据此触发 unrepairable。 */
  readonly failureCode?: ValidationCheckFailureCode;
  readonly command?: {
    readonly argv: readonly string[];
    readonly cwd: string;
    readonly exitCode: number | null;
    readonly timedOut: boolean;
    readonly durationMs: number;
    readonly outputTail: string;
  };
  readonly changedPaths?: {
    readonly allowedScope: readonly string[];
    readonly actual: readonly string[];
    readonly violations: readonly string[];
    readonly unsupportedScope: readonly string[];
  };
  readonly forbiddenPaths?: {
    readonly forbiddenScope: readonly string[];
    readonly actual: readonly string[];
    readonly violations: readonly string[];
    readonly unsupportedScope: readonly string[];
  };
  readonly diffSize?: {
    readonly limits: {
      readonly maxChangedFiles?: number;
      readonly maxChangedLines?: number;
    };
    readonly used: {
      readonly changedFiles?: number;
      readonly changedLines?: number;
    };
    readonly unknown: readonly ValidationDiffSizeUnknownDimension[];
  };
}

/**
 * 机器独立验收报告。不可变、可追溯；与 EvidenceRecord（执行者自报证据）分立。
 */
export interface ValidationReport {
  readonly id: string;
  readonly policyRevision: number;
  readonly missionId: string;
  readonly workItemId?: string;
  readonly attemptId?: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly passed: boolean;
  readonly checks: readonly ValidationCheckResult[];
}

/**
 * 一次验收记录。
 *
 * - `attemptId`：做 review 的 Coordinator reviewer Attempt（Standard 路径继续写）。
 *   可选是为了未来 validator review 能诚实 omit，而不是伪造 Coordinator Attempt。
 * - `submittedAttemptId`：被 review 的 Executor Attempt（validator 路径必填）。
 * - `authority`：独立权威；validator 时必有（reportId 在 authority 内，不另造 validationReportId）。
 *   legacy / 直接 kernel review 可不带。
 */
/** L2 对一条验收标准的结论（方案 §11）。 */
export type AcceptanceStatus = 'pass' | 'fail' | 'unverified' | 'not_applicable';

export const ACCEPTANCE_STATUSES: readonly AcceptanceStatus[] = Object.freeze([
  'pass',
  'fail',
  'unverified',
  'not_applicable',
]);

/**
 * 评审对工单里一条验收标准的交代。
 *
 * 为什么要逐条：一句总结里「都过了」和「三条过了、第四条没法验」看起来一样，
 * 而后者正是 L3 最需要看到的。
 */
export interface AcceptanceResult {
  /** 工单 acceptance 原文。 */
  readonly criterion: string;
  readonly status: AcceptanceStatus;
  /** pass 时的证据。 */
  readonly evidence?: string;
  /** unverified / not_applicable 时的原因。 */
  readonly note?: string;
}

export interface ReviewRecord {
  readonly attemptId?: string;
  readonly submittedAttemptId?: string;
  readonly authority?: ReviewAuthority;
  readonly verdict: 'accept' | 'reject';
  readonly reasons: readonly string[];
  readonly requiredChanges: readonly string[];
  /** 协调者评审的逐条结果；机器评审与旧快照没有。 */
  readonly acceptanceResults?: readonly AcceptanceResult[];
}

/**
 * 独立检视结论（Mission 级，追加式）。
 *
 * 为什么不进 WorkItem.ReviewRecord：那是 L2/validator 对单张工单的验收，
 * 既不绑定契约 revision / 被审 HEAD，也不代表与协调者、执行者独立的检视。
 * 混进去之后读取方分不清「工单过了」和「独立检视过了」。
 */
export type IndependentReviewVerdict = 'pass' | 'send_back';

export type IndependentReviewBlockReason =
  | 'no_candidates'
  | 'all_candidates_conflict'
  | 'history_missing_profile'
  | 'not_awaiting_review'
  | 'not_delivered'
  | 'concurrent_attempt'
  | 'reviewed_commit_unavailable'
  | 'work_items_unfinished';

export interface IndependentReviewL2Ref {
  readonly workItemId: string;
  readonly submittedAttemptId?: string;
  readonly reviewAttemptId?: string;
}

export interface IndependentReviewRecord {
  readonly missionId: string;
  readonly reviewerAttemptId: string;
  readonly reviewerProfileId: string;
  readonly contractRevision: number;
  readonly reviewedCommit: string;
  readonly l2ReviewRefs: readonly IndependentReviewL2Ref[];
  readonly validationReportId?: string;
  /**
   * 开审时冻住的 L2 逐条结果指纹。平台生成、kernel 不解释。
   * 证据一变，读取方用它判断旧 pass 是否还有效。
   */
  readonly l2Fingerprint: string;
  readonly verdict: IndependentReviewVerdict;
  readonly reasons: readonly string[];
  readonly recordedAt: string;
}

/** 开独立检视 Attempt 时冻住的对照物；交结论时再核一次。 */
export interface IndependentReviewOpen {
  readonly attemptId: string;
  readonly contractRevision: number;
  readonly reviewedCommit: string;
  readonly l2Fingerprint: string;
  readonly l2ReviewRefs: readonly IndependentReviewL2Ref[];
  readonly validationReportId?: string;
}

export interface BlockedRecord {
  readonly attemptId: string;
  readonly reason: string;
  readonly whatWasTried: readonly string[];
  readonly needsFromUpstream: string;
}

/**
 * 协调者提议的长期知识改动。
 *
 * 结构化而不是一句自由文本，是因为 L3 批准之后平台要**真的把它写进
 * `.coagent/`**。自由文本只能留在 Mission 记录里，没人会回头去抄进文档——
 * 于是"代码改了文档没跟上"就成了常态。
 */
export interface MemoryDeltaProposal {
  readonly kind: 'living_spec' | 'adr';
  /** Living Spec 用稳定的 Capability 名，不要用 Mission 名或日期。 */
  readonly slug: string;
  readonly title: string;
  readonly body: string;
}

export interface MissionResultBody {
  readonly outcome: 'delivered' | 'blocked';
  readonly summary: string;
  readonly acceptanceEvidence: readonly string[];
  /** 本次该沉淀的长期知识。**没有就空数组**——不是每次改动都该留永久文档。 */
  readonly memoryDelta: readonly MemoryDeltaProposal[];
  readonly openRisks: readonly string[];
}

/**
 * Mission 为什么停着。
 *
 * S06.1 要的第二条轴：阶段（status）说"走到哪了"，这条说"为什么不动"。
 * 刻意只列真正会发生的几种——不要为了完备性预先编一堆没人会遇到的原因。
 */
export type WaitReason =
  /** 候选池里没有可用的了（全在冷却或不可用） */
  | 'no_available_agent'
  /** 等 L3 答复升级 / 做最终检视 */
  | 'waiting_l3'
  /** 同 Project 有别的 Mission 正占着改动名额 */
  | 'project_busy'
  /** 工作项失败次数到上限，交回上游 */
  | 'attempt_limit_reached'
  /** 目标分支在检视期间变了 */
  | 'target_changed'
  /** 分叉基线已经过期，需要重新核对 */
  | 'base_revision_stale'
  /** 被人叫停 */
  | 'cancelled_by_user'
  /** agent 连不上平台自己 —— 这是平台侧故障，不是候选的问题 */
  | 'platform_unreachable'
  /**
   * 一跳跑得太久，疑似在打转，已经停下来等人看。
   *
   * 和 `no_available_agent` / `attempt_limit_reached` 分开，因为处置不同：
   * 那两个等一等就能重跑，这个**必须有人去看它这段时间在干什么**——
   * 实测有一跳跑了 72 分钟，做的是一个后来被作废的工单。
   */
  | 'runaway_suspected'
  /**
   * 权威 ExecutionBudget 硬维已耗尽（BUDGET-001-S5）。
   *
   * 与 pool `attempt_limit_reached` / 启发式轮次上限分开：这是 Mission 上
   * persist 的 budget 经可信用量求值后的硬闸，不是候选池或 for 循环默认。
   */
  | 'execution_budget_exceeded';

/**
 * Mission 在版本控制里的落脚点：它自己的分支，和分叉时的基线版本。
 * 落地前要拿 baseRevision 去核对目标分支有没有动过。
 */
export interface WorkspaceRef {
  /** 项目仓库根目录。落地时要回到这里做合并，所以得记住。 */
  readonly projectRoot?: string;
  /** 本 Mission 自己的分支。 */
  readonly branch: string;
  /**
   * 要合回去的那条分支。
   *
   * 和 `branch` 是两回事，界面上尤其容易混：早先项目页把 `branch` 当成
   * "目标分支"显示，于是每条 Mission 都把自己的分支名报成了项目的目标分支。
   * 分叉时记下来，之后目标分支被切换也不影响这条记录该是什么。
   */
  readonly targetBranch?: string;
  readonly baseRevision: string;
}

/**
 * L3 的最终检视结论。
 *
 * L3 看的是 Contract、架构边界和 Project Memory 变化，不是重做一遍 L2 的
 * 技术验收。`mergedInto` 记下改动实际落到了哪。
 */
/**
 * 谁做的最终检视。形状照 {@link ReviewAuthority}：判别联合，各自带可追溯凭据。
 *
 * **为什么必须记。** 无人值守推进时，一条被机器放行的 Mission 早上看起来和
 * 人工放行的一模一样。不记权威就回答不了「这是谁放的」——而出事后第一个要问的
 * 就是这个。
 *
 * `human` 的 `principalId` 可缺：公开入口仍然可以只记「人」。**宁可记「人，但不知道是谁」，也不要留空让它看起来像没人放行过。**
 * 检视者代签走 `reviewer`，不伪装成 human。
 */
export type FinalReviewAuthority =
  | { readonly kind: 'human'; readonly principalId?: string }
  | {
      /** 机器放行：必须指向一次**合并之后**在集成分支上跑出来的验证报告。 */
      readonly kind: 'machine';
      readonly integrationReportId: string;
      readonly policyRevision: number;
    }
  | {
      /**
       * 无人值守的方案运行放弃了这条 Mission——只用于 abandon，永远不放行。
       *
       * 失败的 Mission 占着项目的改动名额，不放掉的话后面的功能一个都派发不了。
       * 是检视者选的动作还是升级单等过了期，记在那张升级单上；这里只指向它。
       */
      readonly kind: 'plan';
      readonly planRunId: string;
      readonly escalationId: string;
    }
  | {
      /**
       * 用户确认之后由检视者代签。确认人是调用方声明的，平台没有身份名册、
       * 不宣称已经核对过那一次点击。确认时刻用平台时钟，不接受调用方传入的时间。
       */
      readonly kind: 'reviewer';
      readonly reviewerId: string;
      readonly confirmedBy: string;
      readonly confirmedAt: string;
    };

export interface FinalReview {
  readonly verdict: 'merge' | 'send_back' | 'abandon';
  readonly reasons: readonly string[];
  readonly mergedInto?: string;
  readonly mergedAt?: string;
  /** 旧快照没有这个字段；恢复时保持 undefined，**不伪造成 human**。 */
  readonly authority?: FinalReviewAuthority;
}

export interface EscalationBody {
  readonly attemptId: string;
  readonly question: string;
  readonly why: string;
  readonly optionsConsidered: readonly string[];
  /**
   * L3 的答复。没有答复的升级等于石沉大海——协调者被唤醒后只会再升级一次。
   * 所以调度器把"还有未答复的升级"当成停机条件。
   */
  readonly answer?: string;
  readonly answeredAt?: string;
}

/**
 * 用量。**必须分项存**：只存 total 会严重高估——缓存命中那一项可以是
 * 其余各项之和的十倍。quality 标明这组数字的来源可信度，不得伪装精确。
 */
export interface TokenUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly total: number;
  readonly cost?: number;
  readonly quality: 'reported' | 'estimated' | 'unknown';
}

export const EMPTY_USAGE: TokenUsage = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  quality: 'unknown' as const,
});

/** 浅冻结 + 冻结其中的数组字段。载荷只有一层，够用。 */
export function freezePayload<T extends object>(value: T): Readonly<T> {
  for (const key of Object.keys(value)) {
    const field = (value as Record<string, unknown>)[key];
    if (Array.isArray(field)) {
      Object.freeze(field);
    }
  }
  return Object.freeze(value);
}

/** 深度冻结（ValidationReport 等嵌套结构用）。 */
export function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (const item of value) freezeDeep(item);
    return Object.freeze(value) as T;
  }
  for (const v of Object.values(value as Record<string, unknown>)) {
    freezeDeep(v);
  }
  return Object.freeze(value as object) as T;
}
