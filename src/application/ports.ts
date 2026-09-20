/**
 * 应用层端口。
 *
 * 这里定义平台**需要**什么，不定义它怎么实现。持久化、Agent 运行时、时钟、
 * id 生成全部经由这些接口，好让领域与用例可以在没有数据库、没有网络、
 * 没有任何 Agent 的情况下跑测试。
 */

import type { Project } from '../kernel/index.ts';
import type { AttemptEndReason, TokenUsage } from '../kernel/index.ts';

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
  start(spec: AgentRunSpec): Promise<AgentRun>;
}

export interface AgentRunSpec {
  readonly role: 'coordinator' | 'executor';
  readonly attemptId: string;
  readonly missionId: string;
  readonly workItemId?: string;
  /** 工作目录（Mission worktree）。 */
  readonly cwd: string;
  readonly profile: ExecutionProfile;
  /** 已渲染好的首轮输入。 */
  readonly instruction: string;
  /** 允许调用的工具名。 */
  readonly tools: readonly string[];
  /** 续跑：上一次留下的运行时句柄。平台不解释它的内容。 */
  readonly resumeRef?: string;
  /**
   * 工具端点。运行时（以及跑在里面的 agent）只拿到 token，**不自述身份**——
   * 所以"执行者不得改 Plan"这条不依赖调用方诚实填写自己的角色。
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
    }
  | { readonly kind: 'tool.completed'; readonly name: string; readonly callId: string }
  | { readonly kind: 'usage'; readonly usage: TokenUsage };

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

/** 一次 decide 返回的命名 answers 包；key 为 question id，value 仍是 DecisionSignal。 */
export interface DecisionAnswerSet {
  readonly answers: Readonly<Record<string, DecisionSignal>>;
}

export interface DecisionProvider {
  readonly kind: string;
  decide(request: DecisionRequest): Promise<DecisionAnswerSet>;
}
