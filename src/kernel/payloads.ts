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

export interface ReviewRecord {
  readonly attemptId: string;
  readonly verdict: 'accept' | 'reject';
  readonly reasons: readonly string[];
  readonly requiredChanges: readonly string[];
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
  | 'runaway_suspected';

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
export interface FinalReview {
  readonly verdict: 'merge' | 'send_back' | 'abandon';
  readonly reasons: readonly string[];
  readonly mergedInto?: string;
  readonly mergedAt?: string;
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
