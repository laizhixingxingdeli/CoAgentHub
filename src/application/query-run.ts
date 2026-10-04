/**
 * 独立 QueryRun —— 只读问答，不进入 Mission 状态机。
 *
 * 与 runMission 并列的 application 用例：不 createMission、不 prepare worktree、
 * 不启 Coordinator、不发 Mission run token。只读靠**工具 allowlist**强制，
 * 不靠 prompt。
 */

import { EMPTY_USAGE } from '../kernel/index.ts';
import type { AttemptEndReason, TokenUsage } from '../kernel/index.ts';
import { PlatformRuleError } from './platform.ts';
import { redactSecrets } from './redact.ts';
import type {
  AgentRuntime,
  Clock,
  ExecutionProfile,
  IdGenerator,
  RuntimeOutcome,
  CandidateCircuitRepository,
} from './ports.ts';
import { classifyCandidateFailure, resolveQuotaResetTime } from './candidate-circuit.ts';

/* ------------------------------ 模型 ------------------------------ */

/** 一次 query 怎么收尾。needs_mutation 本路径只记账，不 createMission。 */
export type QueryOutcome = 'answered' | 'failed' | 'needs_mutation';

/**
 * QueryRun 记录。
 *
 * 仓储可有内存 / File / PG 实现；本模块只定义端口与用例，不绑定存储。
 * 跨进程可追溯由 FileQueryRunRepository / PgQueryRunRepository 负责。
 */
export interface QueryRunRecord {
  readonly profileId?: string;
  readonly runtimeKind?: string;
  readonly id: string;
  readonly projectId: string;
  /** 调用来源（cli / api / test / …），不解释语义。 */
  readonly source: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly outcome?: QueryOutcome;
  /** running | ended —— 与 outcome 正交：失败也是 ended。 */
  readonly status: 'running' | 'ended';
  readonly usage: TokenUsage;
  readonly endedBy?: AttemptEndReason;
  readonly failureMessage?: string;
  readonly output?: string;
  readonly toolCalls?: readonly string[];
}

export interface QueryRunRepository {
  save(run: QueryRunRecord): Promise<void>;
  get(id: string): Promise<QueryRunRecord | undefined>;
  list(projectId?: string): Promise<readonly QueryRunRecord[]>;
}

/* ------------------------------ 只读工具 ------------------------------ */

/**
 * query 路径明确允许的只读工具。
 *
 * 名单是闭集：不要凭名字宽泛放行 shell（bash/powershell），也不放行
 * write/edit 或任何 coagent_*（那些是 Mission 写路径）。
 */
export const QUERY_READONLY_TOOLS: readonly string[] = Object.freeze([
  'read',
  'grep',
  'find',
  'ls',
]);

const QUERY_READONLY_SET = new Set<string>(QUERY_READONLY_TOOLS);

/** 明确禁止的写/执行类工具（即使调用方混进 tools 也要在 start 前拒绝）。 */
const QUERY_DENIED_TOOLS = Object.freeze([
  'write',
  'edit',
  'bash',
  'powershell',
  'shell',
]);

/**
 * 校验 tools 是否全部落在只读 allowlist。
 * 返回被拒的工具名；空数组表示通过。
 */
export function rejectedQueryTools(tools: readonly string[]): readonly string[] {
  const rejected: string[] = [];
  for (const name of tools) {
    if (QUERY_READONLY_SET.has(name)) continue;
    // coagent_* 一律拒：query 不挂 Mission 写工具 endpoint。
    if (name.startsWith('coagent_') || QUERY_DENIED_TOOLS.includes(name)) {
      rejected.push(name);
      continue;
    }
    // 不在 allowlist 里的一律拒——宽泛放行会把未知写工具漏进去。
    rejected.push(name);
  }
  return rejected;
}

export function assertQueryToolsAllowed(tools: readonly string[]): void {
  const bad = rejectedQueryTools(tools);
  if (bad.length === 0) return;
  throw new PlatformRuleError(
    'QUERY_TOOLS_NOT_READONLY',
    `query 路径只允许只读工具（${QUERY_READONLY_TOOLS.join(', ')}）；` +
      `拒绝：${bad.join(', ')}。只读靠 allowlist，不靠 prompt。`,
  );
}

/**
 * Query 只接受**显式**声明 supportsQuery 的 runtime。
 * 不得凭 kind 猜安全性；未声明 = fail-closed。
 */
export function assertQueryRuntimeSupported(runtime: AgentRuntime): void {
  if (runtime.supportsQuery === true) return;
  throw new PlatformRuleError(
    'QUERY_RUNTIME_UNSUPPORTED',
    `query 路径只接受明确声明 supportsQuery 的 runtime（当前 kind=${runtime.kind}）。` +
      `不得凭 kind 名称猜测安全性；Spawn/Pi/未知 runtime 默认 fail-closed。`,
  );
}

/* ------------------------------ 输入 / 结果 ------------------------------ */

export interface RunQueryInput {
  readonly projectId: string;
  readonly prompt: string;
  /** 调用方现有 checkout，只作只读上下文；不 create worktree。 */
  readonly cwd: string;
  readonly source: string;
  readonly profile?: ExecutionProfile;
  /**
   * 覆盖默认只读工具表。仍须通过 allowlist 校验——
   * 传入写工具会在 runtime.start **之前**失败。
   */
  readonly tools?: readonly string[];
}

export interface RunQueryResult {
  readonly queryRunId: string;
  readonly outcome: QueryOutcome;
  readonly record: QueryRunRecord;
}

export interface QueryRunnerDeps {
  runtime: AgentRuntime;
  queryRuns: QueryRunRepository;
  clock: Clock;
  ids: IdGenerator;
  /** 默认 query 用的 profile；input.profile 优先。 */
  defaultProfile?: ExecutionProfile;
  /** 服务装配提供分类角色池；有此端口时禁止按请求覆盖或自动借其他角色。 */
  loadCandidates?: () => Promise<readonly ExecutionProfile[]>;
  candidateCircuits?: CandidateCircuitRepository;
}

const DEFAULT_QUERY_PROFILE: ExecutionProfile = Object.freeze({
  endpoint: 'local',
  profileId: 'query-default',
});

/* ------------------------------ QueryRunner ------------------------------ */

export class QueryRunner {
  #runtime: AgentRuntime;
  #queryRuns: QueryRunRepository;
  #clock: Clock;
  #ids: IdGenerator;
  #defaultProfile: ExecutionProfile;
  #loadCandidates?: QueryRunnerDeps['loadCandidates'];
  #circuits?: CandidateCircuitRepository;

  constructor(deps: QueryRunnerDeps) {
    // 构造期即 fail-closed：未声明 supportsQuery 的 runtime 不得挂上 QueryRunner。
    assertQueryRuntimeSupported(deps.runtime);
    this.#runtime = deps.runtime;
    this.#queryRuns = deps.queryRuns;
    this.#clock = deps.clock;
    this.#ids = deps.ids;
    this.#defaultProfile = deps.defaultProfile ?? DEFAULT_QUERY_PROFILE;
    this.#loadCandidates = deps.loadCandidates;
    this.#circuits = deps.candidateCircuits;
  }

  /**
   * 可编程入口：只读问答。
   *
   * **不做**的事（硬边界，不是遗漏）：
   *   - Orchestrator.runMission / createMission / startCoordinator|ExecutorAttempt
   *   - workspace.prepare / merge / rollback / clean
   *   - 发 Mission run token / 挂 coagent 写工具
   *   - Decision / 状态机 / ActivityLog（强制 missionId）
   */
  async runQuery(input: RunQueryInput): Promise<RunQueryResult> {
    // 能力门禁必须在 save / start 之前——不支持时不得留下 running record。
    assertQueryRuntimeSupported(this.#runtime);
    const tools = Object.freeze([...(input.tools ?? QUERY_READONLY_TOOLS)]);
    // 写工具必须在 runtime.start 前拒绝——进了 runtime 再靠 prompt 已经晚了。
    assertQueryToolsAllowed(tools);

    if (this.#loadCandidates) {
      const candidates = await this.#loadCandidates();
      if (candidates.length === 0) throw new PlatformRuleError('QUERY_NO_CANDIDATES', '分类角色没有启用候选，请先配置 classifier 池。');
      let result: RunQueryResult | undefined;
      for (const profile of candidates) {
        const run = await this.#runCandidate(input, profile, tools);
        if (!run) continue;
        result = run.result;
        if (!run.failover) return result;
      }
      if (!result) throw new PlatformRuleError('QUERY_NO_CANDIDATES', '分类角色候选全部不可用，请核对熔断状态。');
      return result;
    }
    return this.#runOne(input, tools);
  }

  async #runCandidate(input: RunQueryInput, profile: ExecutionProfile, tools: readonly string[]) {
    const now = this.#clock.now().toISOString();
    const circuit = await this.#circuits?.get(profile.profileId);
    let probe = false;
    if (circuit && circuit.state !== 'closed') {
      if (circuit.state === 'half_open' || circuit.openUntil === null || Date.parse(circuit.openUntil) > Date.parse(now)) return undefined;
      probe = await this.#circuits!.tryClaimProbe({ profileId: profile.profileId, now });
      if (!probe) return undefined;
    }
    const result = await this.#runOne({ ...input, profile }, tools);
    const failure = classifyCandidateFailure(result.record.endedBy ?? 'structured_submit', result.record.failureMessage)
      ?? { failureClass: 'unknown', failover: false };
    const failed = result.outcome === 'failed';
    const openUntil = failure.failureClass === 'quota'
      ? resolveQuotaResetTime({ message: result.record.failureMessage, now })
      : new Date(Date.parse(now) + 5 * 60_000).toISOString();
    if (probe) await this.#circuits!.resolveProbe({ profileId: profile.profileId, succeeded: !failed,
      ...(failed ? { failureClass: failure.failureClass, openUntil } : {}) });
    else if (failed && failure.failover) await this.#circuits?.open({ profileId: profile.profileId, failureClass: failure.failureClass, openUntil });
    return { result, failover: failed && failure.failover };
  }

  async #runOne(input: RunQueryInput, tools: readonly string[]): Promise<RunQueryResult> {

    const id = this.#ids.next('Q');
    const startedAt = this.#clock.now().toISOString();
    const running: QueryRunRecord = {
      id,
      profileId: (input.profile ?? this.#defaultProfile).profileId,
      runtimeKind: this.#runtime.kind,
      projectId: input.projectId,
      source: input.source,
      prompt: input.prompt,
      cwd: input.cwd,
      startedAt,
      status: 'running',
      usage: EMPTY_USAGE,
    };
    await this.#queryRuns.save(running);

    let outcome: RuntimeOutcome;
    try {
      const run = await this.#runtime.start({
        role: 'query',
        attemptId: id,
        // 无 Mission：空字符串占位，保持 AgentRunSpec 字段形状兼容。
        missionId: '',
        cwd: input.cwd,
        profile: input.profile ?? this.#defaultProfile,
        instruction: input.prompt,
        tools,
        // 不发 Mission token，不挂 coagent 写工具 endpoint。
        endpoint: { baseUrl: '', token: '' },
      });
      outcome = await run.wait();
    } catch (error) {
      // 这条出口同样落盘：上游 401 之类的错误原文里可能带着 key（A6 第一轮 L2 抓到的漏口）。
      const failureMessage = redactSecrets(error instanceof Error ? error.message : String(error));
      const failed = endRecord(running, {
        endedAt: this.#clock.now().toISOString(),
        outcome: 'failed',
        endedBy: 'upstream_failure',
        failureMessage,
        usage: EMPTY_USAGE,
      });
      await this.#queryRuns.save(failed);
      return { queryRunId: id, outcome: 'failed', record: failed };
    }

    const queryOutcome = resolveQueryOutcome(outcome);
    const ended = endRecord(running, {
      endedAt: this.#clock.now().toISOString(),
      outcome: queryOutcome,
      endedBy: outcome.endedBy,
      // 查询的回答原文会落盘、被检视者翻看：同样先脱敏。
      failureMessage: outcome.failureMessage === undefined ? undefined : redactSecrets(outcome.failureMessage),
      usage: outcome.usage ?? EMPTY_USAGE,
      output: outcome.output === undefined ? undefined : redactSecrets(outcome.output),
      toolCalls: outcome.toolCalls,
    });
    await this.#queryRuns.save(ended);
    return { queryRunId: id, outcome: queryOutcome, record: ended };
  }

  async getQueryRun(id: string): Promise<QueryRunRecord | undefined> {
    return this.#queryRuns.get(id);
  }

  async listQueryRuns(projectId?: string): Promise<readonly QueryRunRecord[]> {
    return this.#queryRuns.list(projectId);
  }
}

function resolveQueryOutcome(outcome: RuntimeOutcome): QueryOutcome {
  if (outcome.queryOutcome) return outcome.queryOutcome;
  if (
    outcome.endedBy === 'upstream_failure' ||
    outcome.endedBy === 'platform_unreachable' ||
    outcome.endedBy === 'killed_idle' ||
    outcome.endedBy === 'killed_wall_clock' ||
    outcome.endedBy === 'cancelled' ||
    outcome.endedBy === 'interrupted'
  ) {
    return 'failed';
  }
  return 'answered';
}

function endRecord(
  running: QueryRunRecord,
  end: {
    endedAt: string;
    outcome: QueryOutcome;
    endedBy?: AttemptEndReason;
    failureMessage?: string;
    usage: TokenUsage;
    output?: string;
    toolCalls?: readonly string[];
  },
): QueryRunRecord {
  return {
    id: running.id,
    profileId: running.profileId,
    runtimeKind: running.runtimeKind,
    projectId: running.projectId,
    source: running.source,
    prompt: running.prompt,
    cwd: running.cwd,
    startedAt: running.startedAt,
    endedAt: end.endedAt,
    outcome: end.outcome,
    status: 'ended',
    usage: end.usage,
    endedBy: end.endedBy,
    failureMessage: end.failureMessage,
    output: end.output,
    toolCalls: end.toolCalls,
  };
}

/** 便捷函数：无类实例时的一次性调用。 */
export async function runQuery(
  deps: QueryRunnerDeps,
  input: RunQueryInput,
): Promise<RunQueryResult> {
  return new QueryRunner(deps).runQuery(input);
}
