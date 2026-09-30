/**
 * 应用层端口。
 *
 * 这里定义平台**需要**什么，不定义它怎么实现。持久化、Agent 运行时、时钟、
 * id 生成全部经由这些接口，好让领域与用例可以在没有数据库、没有网络、
 * 没有任何 Agent 的情况下跑测试。
 */

import type { Project } from '../kernel/index.ts';
import type { PostExecutionRemoteState } from './post-execution-remote-input.ts';
import type { AttemptEndReason, TokenUsage } from '../kernel/index.ts';
import type { CapacityClaimResult, ClaimAvailableHopInput, ClaimFence, QueuedHop, ReportHopFailureInput } from './durable-scheduler.ts';
import type { CandidateCircuit, ClaimCandidateProbeInput, OpenCandidateCircuitInput, ResolveCandidateProbeInput } from './candidate-circuit.ts';

export interface ProjectRepository {
  get(projectId: string): Promise<Project | undefined>;
  save(project: Project): Promise<void>;
  list(): Promise<readonly Project[]>;
  /**
   * 没有就建一个。
   *
   * 放在端口上而不是某个实现上：之前平台用 `instanceof InMemoryProjectRepository`
   * 来决定要不要自动建 Project，于是换成文件仓储的那一刻整条链路就报
   * 「project 不存在」。用例层不该认识仓储的具体类。
   */
  ensure(projectId: string): Promise<Project>;
}

/** Timeline 的原料。写入必须是追加，永不改写。 */
export interface ActivityEvent {
  readonly at: string;
  readonly projectId: string;
  readonly missionId: string;
  readonly workItemId?: string;
  readonly attemptId?: string;
  readonly kind: string;
  readonly data: unknown;

  /* ---- Envelope 公共语义（S10.3）。全部可选：历史事件没有这些字段。 ---- */

  readonly protocolVersion?: string;
  /** 这条事件自己的 id。 */
  readonly messageId?: string;
  /** 归属哪条因果链。同一 Mission 的事件共用一个。 */
  readonly correlationId?: string;
  /**
   * 由哪一跳引发。
   *
   * 没有它，"这一步为什么会发生"只能靠时间戳前后猜——而同一秒内发生好几件事
   * 是常态（提交结果、验收、派发下一项）。
   */
  readonly causationId?: string;
  readonly contractRevision?: number;
  readonly planRevision?: number;
}

export interface ActivityLog {
  append(event: Omit<ActivityEvent, 'at'>): Promise<void>;
  list(missionId: string): Promise<readonly ActivityEvent[]>;
}

export interface QueuedHopRepository {
  enqueue(hop: QueuedHop): Promise<QueuedHop>;
  get(id: string): Promise<QueuedHop | undefined>;
  list(): Promise<readonly QueuedHop[]>;
  /** Atomic conditional transitions; undefined means rejected without mutation. */
  claim(id: string, owner: string, now: string, leaseUntil: string): Promise<QueuedHop | undefined>;
  renew(id: string, owner: string, claimGeneration: number, now: string, leaseUntil: string): Promise<QueuedHop | undefined>;
  complete(id: string, owner: string, claimGeneration: number, now: string): Promise<QueuedHop | undefined>;
  /**
   * Fenced failure with persistent (id, claimGeneration, attemptId) dedupe.
   * Optional so existing test stubs and single-id adapters keep compiling;
   * File/PG implement it. Missing is not success — DurableScheduler rejects.
   */
  reportFailure?(input: ReportHopFailureInput): Promise<QueuedHop | undefined>;
}

/**
 * Capacity-aware claim. File/PG implement this in a later ticket; old single-id
 * claim/renew/complete stay on {@link QueuedHopRepository} and remain required.
 *
 * `claimAvailable` MUST, in one transaction (single-writer section / DB tx):
 * consider only `input.eligible` hop ids; apply priority/FIFO across those rows;
 * check five-dimension occupancy against durable active leases using each hop's
 * own runtime/profile; persist that hop's identity on the claimed row only.
 * Never claim, return, or relabel a hop that is not eligible. Skipped rows stay
 * queued. Legacy rows without runtime/profile remain readable.
 */
export interface QueuedHopCapacityRepository extends QueuedHopRepository {
  claimAvailable(input: ClaimAvailableHopInput): Promise<CapacityClaimResult>;
}

/** Persistent per-profile circuit. tryClaimProbe must be an atomic conditional transition. */
export interface CandidateCircuitRepository {
  /** Missing records are observed as closed without requiring a stored row. */
  get(profileId: string): Promise<CandidateCircuit>;
  /** Opens/reopens a circuit, including from closed or half_open. */
  open(input: OpenCandidateCircuitInput): Promise<CandidateCircuit>;
  /** Returns true only when this call changed eligible open to claimed half_open. */
  tryClaimProbe(input: ClaimCandidateProbeInput): Promise<boolean>;
  /** Only a claimed half_open probe may resolve; invalid/repeated resolution rejects without mutation. */
  resolveProbe(input: ResolveCandidateProbeInput): Promise<CandidateCircuit>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(prefix: string): string;
}

/* ------------------------------ 运行时端口 ------------------------------ */

/**
 * Agent 运行时端口。
 *
 * **第一版只接 pi，但这个接口从第一天起就有第二个实现**（ScriptedRuntime），
 * 而且内核与用例的测试全部跑在那个实现上。只有一个实现的接口一定会长成
 * 那个实现的形状——所以"为别的 agent 预留"这句话的判据不是接口存在，
 * 是第二个实现存在。
 *
 * 刻意**不**包含的东西：coagent_* 工具本身。那些是平台契约，实现住在平台侧，
 * 运行时只负责"把这些工具名以它自己的方式暴露出去"。否则接第二个 agent
 * 就要把十来个工具重写一遍。
 */
export interface AgentRuntime {
  readonly kind: string;
  /**
   * 显式声明可承接独立只读 QueryRun。
   *
   * 未声明则 fail-closed：不得构造/暴露 QueryRunner，也不得凭 `kind`
   * 名称猜测安全性（Spawn/Pi/未知 runtime 默认不支持）。
   * 仅 `true` 有意义——不要扩成 capabilities 框架。
   */
  readonly supportsQuery?: true;
  start(spec: AgentRunSpec): Promise<AgentRun>;
}

export interface AgentRunSpec {
  /**
   * `query`：独立只读问答，不进入 Mission 状态机。
   * coordinator / executor / independent_reviewer 走 Mission 路径。
   */
  readonly role: 'coordinator' | 'executor' | 'independent_reviewer' | 'query';
  /**
   * 运行身份 id。Mission 路径是 attemptId；query 路径是 queryRunId
   * （字段名保持兼容，避免每个 runtime 适配器分叉）。
   */
  readonly attemptId: string;
  /**
   * Mission id。query 路径无 Mission，可传空字符串——调用方不得据此
   * createMission / 发 run token。
   */
  readonly missionId: string;
  readonly workItemId?: string;
  /** 工作目录。Mission 是 worktree；query 是调用方现有 checkout（只读上下文）。 */
  readonly cwd: string;
  readonly profile: ExecutionProfile;
  /** 已渲染好的首轮输入。 */
  readonly instruction: string;
  /** 允许调用的工具名。query 路径必须是只读 allowlist，由 application 在 start 前强制。 */
  readonly tools: readonly string[];
  /** 续跑：上一次留下的运行时句柄。平台不解释它的内容。 */
  readonly resumeRef?: string;
  /**
   * 工具端点。运行时（以及跑在里面的 agent）只拿到 token，**不自述身份**——
   * 所以"执行者不得改 Plan"这条不依赖调用方诚实填写自己的角色。
   *
   * query 路径不挂 Mission coagent 写工具 endpoint；仍保留字段形状以兼容
   * 既有 runtime 适配，内容可为空。
   */
  readonly endpoint: { readonly baseUrl: string; readonly token: string };
}

/** 运行时配置。平台只当它是不透明的选择键，不认识具体取值。 */
export interface ExecutionProfile {
  readonly endpoint: string;
  readonly profileId: string;
  readonly reasoning?: string;
  /**
   * 建这条候选时定下的运行时身份，例如从界面上选的那个模型。
   *
   * 键值都是**不透明的**：这一层不认识 provider / model 这些词（S08.3 要求
   * Kernel 与 Application 不出现它们），只负责原样传给适配层。
   * 适配层认得这些键——它本来就是唯一知道模型长什么样的地方。
   *
   * 不带就走适配层自己那张静态表，行为和以前一样。
   */
  readonly facts?: readonly { readonly key: string; readonly value: string }[];
}

export interface AgentRun {
  /** 续跑用的句柄；拿不到时为 undefined。 */
  readonly resumeRef: string | undefined;
  on(handler: (event: RuntimeEvent) => void): () => void;
  abort(reason: string): Promise<void>;
  wait(): Promise<RuntimeOutcome>;
}

export type RuntimeEvent =
  | { readonly kind: 'output'; readonly text: string }
  | {
      /**
       * Adapter-declared command-activity classification protocol (BUDGET-001-S4).
       * Hub never infers classification from tool names.
       */
      readonly kind: 'runtime.capabilities';
      readonly commandActivityClassification: 'v1';
    }
  | {
      readonly kind: 'tool.started';
      readonly name: string;
      readonly callId: string;
      /**
       * 这次调用**具体在干什么**（bash 的命令、read 的路径），截断成一行。
       *
       * 只记工具名的话，一跳挂住之后留下来的尾巴就是一串 `bash`——看得出它卡在
       * 某次 bash 上，看不出卡在**哪条命令**上，而那是唯一有用的那半。
       * 实测踩过：执行者干到一半静默 5 分钟被杀，尾巴里只有工具名。
       */
      readonly detail?: string;
      /**
       * Adapter-classified activity (BUDGET-001-S4). Optional so legacy adapters
       * still type-check. Hub must not infer this from `name`.
       */
      readonly activityClass?: 'command' | 'other';
    }
  | { readonly kind: 'tool.completed'; readonly name: string; readonly callId: string }
  | { readonly kind: 'usage'; readonly usage: TokenUsage };

/** 简报来源白名单，与 ContextBundle 固定六源对齐。 */
export const CONTEXT_METRICS_BRIEF_SOURCES = [
  'project_rules',
  'environment_notes',
  'contract',
  'plan',
  'final_review',
  'work_order',
] as const;
export type ContextMetricsBriefSource = (typeof CONTEXT_METRICS_BRIEF_SOURCES)[number];

/** 工具桶固定类别。任意字符串会变成「调了什么都可以写」，所以闭集。 */
export const CONTEXT_METRICS_TOOL_KINDS = ['read', 'grep', 'find', 'ls', 'bash'] as const;
export type ContextMetricsToolKind = (typeof CONTEXT_METRICS_TOOL_KINDS)[number];

export type ContextMetricsCoverage = 'complete' | 'partial' | 'unknown';

export interface ContextMetricsBriefSourceEntry {
  readonly source: ContextMetricsBriefSource;
  readonly estimatedTokens?: number;
  readonly truncated: boolean;
}

export interface ContextMetricsBriefV1 {
  readonly renderedUtf8Bytes: number;
  readonly sources: readonly ContextMetricsBriefSourceEntry[];
}

export interface ContextMetricsToolBucketV1 {
  readonly kind: ContextMetricsToolKind;
  readonly calls: number;
  readonly returnedUtf8Bytes: number;
}

export interface ContextMetricsReadBucketV1 {
  readonly pathDigest: string;
  readonly contentDigest: string;
  readonly repeats: number;
}

/**
 * Attempt 级上下文采集摘要 v1。只含观测事实：桶、非负整数、SHA-256 摘要。
 * 不含路径、正文、missionId/attemptId（后两者走事件 envelope）。
 */
export interface ContextMetricsV1 {
  readonly version: 1;
  readonly coverage: ContextMetricsCoverage;
  readonly brief?: ContextMetricsBriefV1;
  readonly tools?: readonly ContextMetricsToolBucketV1[];
  readonly reads?: readonly ContextMetricsReadBucketV1[];
}

export interface RuntimeOutcome {
  /**
   * 这一程是怎么结束的。上游失败与"没做结构化提交"必须分开——
   * 前者允许换候选重试，后者不允许。
   */
  readonly endedBy: AttemptEndReason;
  readonly usage: TokenUsage;
  readonly resumeRef?: string;
  /** endedBy === 'upstream_failure' 时的原文，用于排障与候选冷却判定。 */
  readonly failureMessage?: string;
  /** 原始输出（尾部）。Timeline 第三层用。 */
  readonly output?: string;
  /** 调过的工具名序列。Timeline 第二层用。 */
  readonly toolCalls?: readonly string[];
  /**
   * 运行时**实际**解析到的身份（S13.3）。平台侧只有不透明的 profileId，
   * 具体跑的是什么只有适配层知道——报回来冻在 Attempt 上，
   * 适配层那张表改了之后历史归因才不会静默错位。
   */
  readonly resolvedProfile?: {
    readonly revision: string;
    readonly resolved: readonly { readonly key: string; readonly value: string }[];
  };
  /**
   * query 角色专用：结构化终态。未填时由 QueryRunner 按 endedBy 推导。
   * Mission 路径忽略此字段。
   */
  readonly queryOutcome?: 'answered' | 'failed' | 'needs_mutation';
  /**
   * 本跳上下文采集摘要。调用方/运行时都不可信：平台 finishAttempt 再校验，
   * 未通过则整段丢弃，不得原样 spread 进 Activity。
   */
  readonly contextMetrics?: unknown;
}

/* ------------------------------ 决策信号端口 ------------------------------ */

/**
 * DecisionProvider —— 与 AgentRuntime **并列**的 Application 侧横向信号能力。
 *
 * 只产 Choice / Score / No-op 信号；不写 kernel 状态、不降审查、不替代
 * Orchestrator / Harness 的执行权。钩子语义见 adr-0002；本端口本轮只钉形状，
 * 不接生产 dispatch / review。
 */
export type DecisionHook = 'PRE_DISPATCH' | 'POST_EXECUTION';

export interface DecisionRequest {
  readonly hook: DecisionHook;
  readonly projectId: string;
  readonly missionId: string;
  readonly workItemId?: string;
  readonly attemptId?: string;
  /** 不透明事实键值；本层不解释 key/value 语义。 */
  readonly facts?: readonly { readonly key: string; readonly value: string }[];
}

export type DecisionSignal =
  | { readonly kind: 'choice'; readonly option: string }
  | { readonly kind: 'score'; readonly value: number; readonly scale?: string }
  | { readonly kind: 'noop'; readonly reason?: string };

/** Provider 报告的 token 用量（与 kernel TokenUsage 解耦，仅决策侧）。 */
export interface DecisionUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** decide 成功时可选的 provider-neutral 元数据（不含 confidence/probabilities）。 */
export interface DecisionAnswerMeta {
  readonly resolvedModel?: string;
  readonly usage?: DecisionUsage;
}

/** 一次 decide 返回的命名 answers 包；key 为 question id，value 仍是 DecisionSignal。 */
export interface DecisionAnswerSet {
  readonly answers: Readonly<Record<string, DecisionSignal>>;
  readonly meta?: DecisionAnswerMeta;
}

export interface DecisionProvider {
  readonly kind: string;
  decide(request: DecisionRequest): Promise<DecisionAnswerSet>;
}

/**
 * POST_EXECUTION 评估（Jev 设计 §9）。与 DecisionProvider 分开：PRE 只拿 ID 与 facts（远端默认拒绝），
 * POST 拿的是按预算投影过的执行摘要——两者放出去的数据不同，端口也分开，免得一个口子上两套放行规则。
 * 同样只产信号、不具执行权威（ADR-0002）。
 */
export interface PostExecutionEvaluator {
  readonly kind: string;
  evaluate(state: PostExecutionRemoteState): Promise<DecisionAnswerSet>;
}

/**
 * 单事务命令（设计 §8.1，C2）：run 里对状态、事件、投递的写一起提交，或者一个都不落。
 *
 * 实现方保证：fn 抛错或提交失败时，存储回到 run 开始时的样子——内存与盘上都是——之后
 * 别处的写不会把半截改动带下去。嵌套调用并进外层事务。只包短命令：事务之间串行。
 */
export interface CommandTransaction {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * 测试可调用的领取 fencing 命令事务。与 {@link CommandTransaction.run} 分开，生产 Agent API 不走这里。
 *
 * 实现方必须在**同一**命令/数据库事务内核对 `id/owner/claimGeneration/now`（见 {@link holdsCurrentClaim}），
 * 通过后才让回调里的状态写入提交；不存在、过期或身份不合则拒绝并回滚。
 * 不得在入口或回调前单独 get 当作成功 fencing。嵌套进已有 `run` 时并进外层事务，
 * 核对失败必须抛出——内部 catch 会让外层把半截写入当成功提交。
 */
export interface FencedCommandTransaction {
  runFenced<T>(fence: ClaimFence, fn: () => Promise<T>): Promise<T>;
}
