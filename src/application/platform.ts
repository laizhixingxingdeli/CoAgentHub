/**
 * 平台用例层 —— coagent_* 工具背后的真实实现。
 *
 * 工具的 handler（住在各个 runtime 适配包里）只负责把结构化参数转发到这里。
 * 规则写在这一层而不是 prompt 里：**能用工具层挡住的，就不要指望模型记得住。**
 */

import { randomUUID } from 'node:crypto';
import {
  ACCEPTANCE_STATUSES,
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
  WorkItemStatus,
  WorkOrder,
  WorkspaceRef,
} from '../kernel/index.ts';
import {
  CONTEXT_METRICS_BRIEF_SOURCES,
  CONTEXT_METRICS_TOOL_KINDS,
} from './ports.ts';
import type {
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
import { InlineArtifactStore } from './artifact-store.ts';
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
  type ContextBundle,
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

/** 平台规则被违反（区别于领域流转错误）。 */
export class PlatformRuleError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PlatformRuleError';
    this.code = code;
  }
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

const ATTEMPT_STARTED_KIND = 'attempt.started';

function queuedAttemptStartedData<T extends { readonly kind: string }>(
  base: T,
  claim?: QueueClaimIdentity,
): T | (T & { readonly queue: true }) {
  return claim ? { ...base, queue: true } : base;
}

function eventMarksQueuedAttempt(
  event: { readonly kind: string; readonly attemptId?: string; readonly data: unknown },
  attemptId: string,
): boolean {
  if (event.kind !== ATTEMPT_STARTED_KIND || event.attemptId !== attemptId) return false;
  if (event.data === null || typeof event.data !== 'object') return false;
  return (event.data as { queue?: unknown }).queue === true;
}

function isFencedCommandTransaction(
  tx: CommandTransaction | undefined,
): tx is FencedCommandTransaction {
  return typeof (tx as FencedCommandTransaction | undefined)?.runFenced === 'function';
}

function mapClaimFenceError(error: unknown): never {
  if (error instanceof Error && error.message === 'claim fence rejected') {
    throw new PlatformRuleError(
      'CLAIM_FENCE_REJECTED',
      '队列租约已失效或代次不匹配，拒绝写入。',
    );
  }
  throw error;
}

/**
 * 单份摘要上限。再大就不是摘要——把正文/路径塞进来会打穿 Activity。
 * 用字节而不是字符：非 ASCII 观测值按 UTF-8 计才和落盘一致。
 */
const CONTEXT_METRICS_MAX_JSON_BYTES = 32 * 1024;
/** 与固定六源一一对应；多了就是在枚举别的来源名。 */
const CONTEXT_METRICS_MAX_SOURCE_BUCKETS = CONTEXT_METRICS_BRIEF_SOURCES.length;
/** 固定工具类别各至多一条。 */
const CONTEXT_METRICS_MAX_TOOL_BUCKETS = CONTEXT_METRICS_TOOL_KINDS.length;
/** 读文件去重桶。再多就是在枚举工作区。 */
const CONTEXT_METRICS_MAX_READ_BUCKETS = 64;
/** 非负有界整数。不挡的话 Infinity / 1e100 也会被当成观测事实。 */
const CONTEXT_METRICS_MAX_INT = 1_000_000_000;
const CONTEXT_METRICS_DIGEST_RE = /^[0-9a-f]{64}$/;
const CONTEXT_METRICS_COVERAGE = new Set<string>(['complete', 'partial', 'unknown']);
const CONTEXT_METRICS_BRIEF_SOURCE_SET: ReadonlySet<string> = new Set(CONTEXT_METRICS_BRIEF_SOURCES);
const CONTEXT_METRICS_TOOL_KIND_SET: ReadonlySet<string> = new Set(CONTEXT_METRICS_TOOL_KINDS);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function objectKeysAre(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return false;
  }
  return true;
}

/**
 * 分类事实投影：只保留 true / 'unknown' 叶子，丢弃 false 叶子；
 * 嵌套对象递归处理并保留父级标签（否则 false 占满的子树会被当成一整块丢掉，
 * 而同级的 true 父标签失去上下文）。非对象、非布尔/unknown 的值原样丢弃。
 */
function keepTrueOrUnknownLeaves(value: unknown): unknown {
  if (value === true || value === 'unknown') return value;
  if (value === false) return undefined;
  if (isPlainObject(value)) {
    const nested = Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, child]) => [key, keepTrueOrUnknownLeaves(child)])
        .filter(([, child]) => child !== undefined),
    );
    return Object.keys(nested).length > 0 ? nested : undefined;
  }
  return undefined;
}

function boundedNonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > CONTEXT_METRICS_MAX_INT) {
    return undefined;
  }
  return value;
}

function sha256Hex(value: unknown): string | undefined {
  return typeof value === 'string' && CONTEXT_METRICS_DIGEST_RE.test(value) ? value : undefined;
}

function utf8JsonBytes(value: unknown): number | undefined {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return undefined;
  }
}

function sanitizeBriefSource(value: unknown): ContextMetricsBriefSourceEntry | undefined {
  if (!isPlainObject(value) || !objectKeysAre(value, new Set(['source', 'estimatedTokens', 'truncated']))) {
    return undefined;
  }
  const source = value.source;
  if (typeof source !== 'string' || !CONTEXT_METRICS_BRIEF_SOURCE_SET.has(source)) return undefined;
  if (typeof value.truncated !== 'boolean') return undefined;
  const entry: {
    source: ContextMetricsBriefSource;
    truncated: boolean;
    estimatedTokens?: number;
  } = { source: source as ContextMetricsBriefSource, truncated: value.truncated };
  if (Object.prototype.hasOwnProperty.call(value, 'estimatedTokens')) {
    const tokens = boundedNonNegativeInt(value.estimatedTokens);
    if (tokens === undefined) return undefined;
    entry.estimatedTokens = tokens;
  }
  return entry;
}

function sanitizeBrief(value: unknown): ContextMetricsV1['brief'] | undefined {
  if (!isPlainObject(value) || !objectKeysAre(value, new Set(['renderedUtf8Bytes', 'sources']))) {
    return undefined;
  }
  const renderedUtf8Bytes = boundedNonNegativeInt(value.renderedUtf8Bytes);
  if (renderedUtf8Bytes === undefined || !Array.isArray(value.sources)) return undefined;
  if (value.sources.length > CONTEXT_METRICS_MAX_SOURCE_BUCKETS) return undefined;
  const sources: ContextMetricsBriefSourceEntry[] = [];
  const seen = new Set<string>();
  for (const item of value.sources) {
    const entry = sanitizeBriefSource(item);
    if (!entry || seen.has(entry.source)) return undefined;
    seen.add(entry.source);
    sources.push(entry);
  }
  return { renderedUtf8Bytes, sources };
}

function sanitizeToolBucket(value: unknown): ContextMetricsToolBucketV1 | undefined {
  if (!isPlainObject(value) || !objectKeysAre(value, new Set(['kind', 'calls', 'returnedUtf8Bytes']))) {
    return undefined;
  }
  const kind = value.kind;
  if (typeof kind !== 'string' || !CONTEXT_METRICS_TOOL_KIND_SET.has(kind)) return undefined;
  const calls = boundedNonNegativeInt(value.calls);
  const returnedUtf8Bytes = boundedNonNegativeInt(value.returnedUtf8Bytes);
  if (calls === undefined || returnedUtf8Bytes === undefined) return undefined;
  return { kind: kind as ContextMetricsToolKind, calls, returnedUtf8Bytes };
}

function sanitizeReadBucket(value: unknown): ContextMetricsReadBucketV1 | undefined {
  if (!isPlainObject(value) || !objectKeysAre(value, new Set(['pathDigest', 'contentDigest', 'repeats']))) {
    return undefined;
  }
  const pathDigest = sha256Hex(value.pathDigest);
  const contentDigest = sha256Hex(value.contentDigest);
  const repeats = boundedNonNegativeInt(value.repeats);
  if (!pathDigest || !contentDigest || repeats === undefined) return undefined;
  return { pathDigest, contentDigest, repeats };
}

function activityDataHasContextMetrics(data: unknown): boolean {
  return isPlainObject(data) && Object.prototype.hasOwnProperty.call(data, 'contextMetrics');
}

/**
 * 把不可信摘要收成 v1 白名单。失败返回 undefined：调用方仍可收尾，但不得把原字段落盘，
 * 也不得标 complete。错误路径不回显输入——摘要里可能夹着路径/正文/凭据。
 */
function sanitizeAttemptContextMetrics(input: unknown): ContextMetricsV1 | undefined {
  if (input === undefined) return undefined;
  const rawBytes = utf8JsonBytes(input);
  if (rawBytes === undefined || rawBytes > CONTEXT_METRICS_MAX_JSON_BYTES) return undefined;
  if (!isPlainObject(input) || !objectKeysAre(input, new Set(['version', 'coverage', 'brief', 'tools', 'reads']))) {
    return undefined;
  }
  if (input.version !== 1) return undefined;
  if (typeof input.coverage !== 'string' || !CONTEXT_METRICS_COVERAGE.has(input.coverage)) return undefined;
  const coverage = input.coverage as ContextMetricsCoverage;

  let brief: ContextMetricsV1['brief'] | undefined;
  if (Object.prototype.hasOwnProperty.call(input, 'brief')) {
    brief = sanitizeBrief(input.brief);
    if (brief === undefined) return undefined;
  }
  let tools: ContextMetricsToolBucketV1[] | undefined;
  if (Object.prototype.hasOwnProperty.call(input, 'tools')) {
    if (!Array.isArray(input.tools) || input.tools.length > CONTEXT_METRICS_MAX_TOOL_BUCKETS) return undefined;
    tools = [];
    const seen = new Set<string>();
    for (const item of input.tools) {
      const bucket = sanitizeToolBucket(item);
      if (!bucket || seen.has(bucket.kind)) return undefined;
      seen.add(bucket.kind);
      tools.push(bucket);
    }
  }
  let reads: ContextMetricsReadBucketV1[] | undefined;
  if (Object.prototype.hasOwnProperty.call(input, 'reads')) {
    if (!Array.isArray(input.reads) || input.reads.length > CONTEXT_METRICS_MAX_READ_BUCKETS) return undefined;
    reads = [];
    const seen = new Set<string>();
    for (const item of input.reads) {
      const bucket = sanitizeReadBucket(item);
      if (!bucket) return undefined;
      const key = `${bucket.pathDigest}:${bucket.contentDigest}`;
      if (seen.has(key)) return undefined;
      seen.add(key);
      reads.push(bucket);
    }
  }

  // complete 必须带齐三类观测。缺一块还自称 complete = 不可信，整段丢弃。
  if (coverage === 'complete' && (brief === undefined || tools === undefined || reads === undefined)) {
    return undefined;
  }

  const trusted: {
    version: 1;
    coverage: ContextMetricsCoverage;
    brief?: ContextMetricsV1['brief'];
    tools?: readonly ContextMetricsToolBucketV1[];
    reads?: readonly ContextMetricsReadBucketV1[];
  } = { version: 1, coverage };
  if (brief !== undefined) trusted.brief = brief;
  if (tools !== undefined) trusted.tools = tools;
  if (reads !== undefined) trusted.reads = reads;
  const trustedBytes = utf8JsonBytes(trusted);
  if (trustedBytes === undefined || trustedBytes > CONTEXT_METRICS_MAX_JSON_BYTES) return undefined;
  return trusted;
}

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

export class Platform {
  #projects: ProjectRepository;
  #activity: ActivityLog;
  #ids: IdGenerator;
  #deliveries: DeliveryRepository;
  #workspace: WorkspaceManager | undefined;
  #artifacts: ArtifactStore;
  #clock: Clock;
  #decisionProvider: DecisionProvider | undefined;
  #decisionHooks: ReadonlySet<DecisionHook>;
  #postExecutionEvaluator: PostExecutionEvaluator | undefined;
  #transaction: CommandTransaction | undefined;
  #validation: PlatformValidationDeps | undefined;
  #haAuthorityFile: string | undefined;
  #live: LiveOutput | undefined;

  constructor(deps: PlatformDeps) {
    this.#projects = deps.projects;
    this.#activity = deps.activity;
    this.#ids = deps.ids;
    this.#deliveries = deps.deliveries;
    this.#workspace = deps.workspace;
    this.#artifacts = deps.artifacts ?? new InlineArtifactStore();
    this.#clock = deps.clock;
    this.#decisionProvider = deps.decisionProvider;
    this.#decisionHooks = deps.decisionHooks ?? new Set<DecisionHook>(['POST_EXECUTION']);
    this.#postExecutionEvaluator = deps.postExecutionEvaluator;
    this.#transaction = deps.transaction;
    this.#validation = deps.validation;
    this.#haAuthorityFile = deps.haAuthorityFile;
    this.#live = deps.live;
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
    return this.#tx(async () => {
      const { mission } = await this.#locate(missionId);
      if (mission.executionMode !== 'standard' || mission.runKind !== 'mutation') {
        throw new PlatformRuleError(
          'STANDARD_FALLBACK_ROUTE_FORBIDDEN',
          '分类回落路由事件仅适用于普通 Standard mutation Mission。',
        );
      }
      if (typeof input.fallbackReason !== 'string' || input.fallbackReason.trim().length === 0) {
        throw new PlatformRuleError('EMPTY_FALLBACK_REASON', 'fallbackReason 不能为空。');
      }
      if ((await this.#activity.list(missionId)).some((event) => event.kind === 'mission.routed')) {
        throw new PlatformRuleError('DUPLICATE_MISSION_ROUTE', 'Mission 已有 mission.routed 事件。');
      }
      const { classification } = input;
      const routedData: Record<string, unknown> = {
        recommended: classification.recommended,
        confidence: classification.confidence,
        facts: classification.facts,
        unknowns: classification.unknowns,
        criticalUnknowns: classification.criticalUnknowns,
        reasons: classification.reasons,
        fallbackReason: input.fallbackReason,
      };
      if (classification.assessmentRef !== undefined) {
        routedData.assessmentRef = classification.assessmentRef;
      }
      if (input.assessment !== undefined) {
        routedData.assessmentReasons = input.assessment.reasons;
      }
      await this.#event(mission, 'mission.routed', routedData);
    });
  }

  async #createMission(input: CreateMissionInput): Promise<{ missionId: string }> {
    const project = await this.#ensureProject(input.projectId);
    const missionId = input.missionId ?? this.#ids.next('M');
    const mission = project.createMission({
      id: missionId,
      contract: input.contract,
      origin: input.origin,
    });
    await this.#projects.save(project);
    await this.#event(mission, 'mission.created', { contractRevision: mission.contractRevision });
    return { missionId };
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
    assertNoCallerRouteOverride(input as unknown);

    const facts = parseTaskFactsStrict(input.facts);
    const assessment = parseComplexityAssessmentStrict(input.assessment);
    const classification = classifyTask({
      facts,
      ...(assessment !== undefined ? { assessment } : {}),
    });

    const { recommended } = classification;
    const hasWorkOrder = input.workOrder !== undefined && input.workOrder !== null;

    // ---- route guards（不建 Mission / 不 ensure Project）----
    if (recommended.runKind === 'query') {
      throw new PlatformRuleError(
        'QUERY_ROUTE_REQUIRED',
        '分类结果为 query：本入口不创建 Mission；请走 Query 路径（M3D-3）。',
      );
    }

    const mode = recommended.executionMode;
    if (mode === 'high_assurance') {
      const flagged = haForbiddenSideEffects(facts.highAssurance);
      if (flagged.length > 0) {
        throw new PlatformRuleError(
          'HA_SIDE_EFFECT_DENIED',
          `带外部副作用的 HA（${flagged.join(', ')}）首版一律拒绝，不创建 Mission。`,
        );
      }
      if (hasWorkOrder) {
        throw new PlatformRuleError(
          'HIGH_ASSURANCE_WORK_ORDER_FORBIDDEN',
          'high_assurance 路由禁止携带 Lightweight workOrder。',
        );
      }
    }

    if (mode === 'standard') {
      if (hasWorkOrder) {
        throw new PlatformRuleError(
          'STANDARD_WORK_ORDER_FORBIDDEN',
          'standard 路由禁止携带 workOrder（避免 Fast Lane 单混入 Standard）。',
        );
      }
    } else if (mode === 'lightweight') {
      if (!hasWorkOrder) {
        throw new PlatformRuleError(
          'LIGHTWEIGHT_WORK_ORDER_REQUIRED',
          'lightweight 路由必须提供 explicit workOrder。',
        );
      }
    } else if (mode !== 'high_assurance') {
      // HA 的副作用/workOrder 已在上面守卫过；这里不能再当未知 mode 拒掉。
      throw new PlatformRuleError(
        'UNSUPPORTED_ROUTE',
        `不支持的 executionMode：${String(mode)}`,
      );
    }

    // ---- 通过 guards 后才 ensure / 分配 id / 创建 ----
    const project = await this.#ensureProject(input.projectId);
    const missionId = input.missionId ?? this.#ids.next('M');

    let mission: Mission;
    let workItemId: string | undefined;

    if (mode === 'standard' || mode === 'high_assurance') {
      mission = project.createMission({
        id: missionId,
        contract: input.contract,
        origin: input.origin,
        executionMode: mode,
        runKind: 'mutation',
        ...(assessment !== undefined ? { complexityAssessment: assessment } : {}),
      });
    } else {
      // lightweight：原子 Mission + 唯一 Frozen WorkItem
      const workOrder = input.workOrder!;
      const initialId = this.#ids.next('W');
      const { mission: created, workItem } = project.createMissionWithInitialWorkItem({
        id: missionId,
        contract: input.contract,
        origin: input.origin,
        executionMode: 'lightweight',
        runKind: 'mutation',
        ...(assessment !== undefined ? { complexityAssessment: assessment } : {}),
        initialWorkItem: {
          id: initialId,
          title: workOrder.objective,
          order: workOrder,
        },
      });
      mission = created;
      workItemId = workItem.id;
    }

    await this.#projects.save(project);

    await this.#event(mission, 'mission.created', {
      contractRevision: mission.contractRevision,
      executionMode: mission.executionMode,
      runKind: mission.runKind,
      classified: true,
    });

    const routedData: Record<string, unknown> = {
      recommended: classification.recommended,
      confidence: classification.confidence,
      facts: classification.facts,
      unknowns: classification.unknowns,
      criticalUnknowns: classification.criticalUnknowns,
      reasons: classification.reasons,
    };
    if (classification.assessmentRef !== undefined) {
      routedData.assessmentRef = classification.assessmentRef;
    }
    await this.#event(mission, 'mission.routed', routedData);

    if (workItemId !== undefined) {
      const item = mission.workItem(workItemId);
      await this.#event(
        mission,
        'work_item.created',
        { title: item?.title ?? input.workOrder!.objective, executionMode: 'lightweight' },
        workItemId,
        // 无 Coordinator attemptId
      );
    }

    return {
      missionId,
      ...(workItemId !== undefined ? { workItemId } : {}),
      classification,
    };
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
    const { mission, project } = await this.#locate(missionId);
    if (!mission.contract) {
      throw new PlatformRuleError('NO_CONTRACT', `Mission ${missionId} 没有契约，没法重跑。`);
    }
    // 源头永远指向**最初那条**，不形成链：#3 是 #1 的重跑，不是 #2 的重跑。
    // 挂成链的话，"这个任务一共跑过几遍"就得顺着指针爬，而且断一环就散了。
    const root = mission.origin?.rerunOf ?? missionId;
    const runs = project.missions.filter(
      (m) => m.id === root || m.origin?.rerunOf === root,
    ).length;
    const newId = options?.newMissionId ?? `${root}#${runs + 1}`;
    const created = await this.createMission({
      projectId: mission.projectId,
      missionId: newId,
      contract: mission.contract,
      origin: { ...(mission.origin ?? { clientType: 'cli' }), rerunOf: root },
    });

    // **把起点钉死在源头那次的分叉基线上。**
    //
    // 不钉的话，worktree 会从"跑这一次时目标分支的 HEAD"分叉——而源头那次的
    // 产出多半已经合进去了，第二次一开始活儿就是干完的状态。两次运行起点
    // 不同，比出来的成本、耗时、跳数全都没有意义，而且**看不出来哪里不对**：
    // 两条记录都完整、都自洽，只是不可比。
    const base = options?.baseRevision ?? mission.workspaceRef?.baseRevision;
    if (base) {
      await this.recordWorkspace(created.missionId, {
        projectRoot: mission.workspaceRef?.projectRoot,
        branch: `mission/${created.missionId}`,
        baseRevision: base,
      });
    }
    // 字段都自己填齐，别直接把 createMission 的 { missionId } 透传出去：
    // 返回类型写了几个而实际只回一个，类型剥离不检查，调用方拿到的是 undefined。
    // 源头的产出落地过没有。看的是**最初那条**，不是链上任意一条：
    // 答案进没进项目只由它决定。
    const source = project.missions.find((m) => m.id === root) ?? mission;
    return {
      ...created,
      rerunOf: root,
      contractRevision: mission.contractRevision,
      baseRevision: base,
      sourceAlreadyLanded: source.finalReview?.verdict === 'merge',
    };
  }

  /**
   * 同一个任务的所有运行，按开始时间排。
   *
   * 这是"可比较"的读出口：一次运行一行，带上它花了多少、跑了多久、几跳、
   * 各跳因为什么结束、最后是什么结果。回答的是「这次改动到底让它变好了没有」——
   * 而在这之前，这个问题只能靠手写 SQL 去比两条碰巧相似的 Mission。
   */
  async listRuns(missionId: string): Promise<RunSummary[]> {
    const { mission, project } = await this.#locate(missionId);
    const root = mission.origin?.rerunOf ?? missionId;
    const runs = project.missions.filter((m) => m.id === root || m.origin?.rerunOf === root);
    return Promise.all(runs.map(async (m) => {
      const attempts = [
        ...m.coordinatorAttempts,
        ...m.workItems.flatMap((item) => item.attempts),
      ];
      const endedBy: Record<string, number> = {};
      for (const attempt of attempts) {
        const key = attempt.endedBy ?? 'in_progress';
        endedBy[key] = (endedBy[key] ?? 0) + 1;
      }

      const events = await this.#activity.list(m.id);
      const createdAt = events.find((event) => event.kind === 'mission.created')?.at;
      const firstExecutionResultAt = events.find(
        (event) => event.kind === 'execution_result.submitted',
      )?.at;

      let l2Reviews = 0;
      let l2Rejects = 0;
      let l3Reviews = 0;
      let l3SendBacks = 0;
      let validatorRuns = 0;
      let validatorFailures = 0;
      for (const event of events) {
        const data =
          event.data != null && typeof event.data === 'object' && !Array.isArray(event.data)
            ? event.data as Record<string, unknown>
            : undefined;
        if (event.kind === 'review.recorded' && data?.authority !== 'validator') {
          l2Reviews += 1;
          if (data?.verdict === 'reject') l2Rejects += 1;
        }
        // 白名单：只数人亲签。authority === 'human'，或旧记录没标 authority（undefined）。
        // 不能用「不等于 machine/plan/reviewer」的黑名单——authority:'unknown' 也会混进人类分母。
        // 检视者代签、夜跑机器放行、方案放弃都不是人亲签。
        const l3Authority = data?.authority;
        if (
          (event.kind === 'final_review.send_back' ||
            event.kind === 'final_review.merged' ||
            event.kind === 'final_review.abandoned') &&
          (l3Authority === 'human' || l3Authority === undefined)
        ) {
          l3Reviews += 1;
          if (event.kind === 'final_review.send_back') l3SendBacks += 1;
        }
        if (event.kind === 'validation.reported' && typeof data?.passed === 'boolean') {
          validatorRuns += 1;
          if (data.passed === false) validatorFailures += 1;
        }
      }

      const promotion = m.promotions[0];
      return {
        missionId: m.id,
        isOriginal: m.id === root,
        status: m.status,
        outcome: m.result?.outcome,
        contractRevision: m.contractRevision,
        entryMode: promotion?.fromMode ?? m.executionMode,
        currentMode: m.executionMode,
        promotionTrigger: promotion?.triggerCode,
        baseRevision: m.workspaceRef?.baseRevision,
        firstExecutionResultMs: elapsedMs(createdAt, firstExecutionResultAt),
        totalDurationMs:
          m.status === 'completed' || m.status === 'blocked'
            ? elapsedMs(createdAt, m.updatedAt)
            : undefined,
        l2Reviews,
        l2Rejects,
        l3Reviews,
        l3SendBacks,
        validatorRuns,
        validatorFailures,
        coordinatorHops: m.coordinatorAttempts.length,
        executorHops: m.workItems.reduce((n, item) => n + item.attempts.length, 0),
        workItems: m.workItems.length,
        usage: sumUsage(m),
        endedBy,
      };
    }));
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
    const { mission } = await this.#locate(missionId);
    const contractRevision = mission.reviseContract(contract);
    // 契约改了，之前那份交卷、以及**已经派出去的工单**，都是照着旧契约做的。
    // 一律退回规划，让协调者拿着新契约重新判断（S14.6：compatible / replan /
    // cancel-replace 是 L2 的判断，不是平台的）。
    //
    // 早先只在 awaiting_review 时退回。实测中途改需求时踩到了：Mission 还在
    // executing，工单已经派出去，调度器照样先跑执行者——等 L2 被叫醒时，
    // 按旧契约做的东西已经做完了。钱花了，而且做的是明确不要的那件事。
    if (mission.status === 'executing' || mission.status === 'awaiting_review') {
      mission.sendBackToPlanning({
        verdict: 'send_back',
        reasons: [`Contract 已更新到 r${contractRevision}，需要按新契约重新核对`],
      });
    }
    await this.#event(mission, 'contract.revised', { contractRevision, status: mission.status });
    return { contractRevision };
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
    const { mission } = await this.#locate(missionId);
    const attempt = mission.startCoordinatorAttempt();
    if (profile) attempt.recordProfile(profile);
    await this.#event(
      mission,
      ATTEMPT_STARTED_KIND,
      queuedAttemptStartedData({ kind: 'coordinator', profile }, claim),
      undefined,
      attempt.id,
    );
    return { attemptId: attempt.id };
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
    const { mission, item } = await this.#locateItem(missionId, workItemId);
    // 提交结果 ≠ 尝试结束。调度器必须在 finally 里 finishAttempt，否则运行时
    // 进程一崩，这个工作项就永远开不了下一次尝试。把这种卡死报成看得懂的话，
    // 而不是一句泛泛的不变量冲突。
    const stuck = item.attempts.find((a) => a.status === 'in_progress');
    if (stuck) {
      throw new PlatformRuleError(
        'ATTEMPT_STILL_RUNNING',
        `工作项 ${workItemId} 上的 attempt ${stuck.id} 还是 in_progress：` +
          '上一次尝试没有被收尾。先 finishAttempt 再开新的。',
      );
    }
    const attempt = item.startAttempt();
    if (profile) attempt.recordProfile(profile);
    await this.#event(
      mission,
      ATTEMPT_STARTED_KIND,
      queuedAttemptStartedData({ kind: 'executor', profile }, claim),
      workItemId,
      attempt.id,
    );
    return { attemptId: attempt.id };
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
    const { mission } = await this.#locate(missionId);
    const blocked = this.#independentReviewOpenBlock(mission, candidates);
    if (blocked) {
      mission.recordIndependentReviewBlock(blocked.reason, blocked.detail);
      await this.#event(mission, 'independent_review.blocked', blocked);
      return { ok: false, code: blocked.code, detail: blocked.detail };
    }

    const excluded = this.#participantProfileIds(mission);
    if (!excluded) {
      const detail =
        '本 Mission 有历史协调者或执行者 Attempt 缺 profileId，无法证明独立，拒绝开检视。';
      mission.recordIndependentReviewBlock('history_missing_profile', detail);
      await this.#event(mission, 'independent_review.blocked', {
        reason: 'history_missing_profile',
        detail,
      });
      return { ok: false, code: 'INDEPENDENT_REVIEW_HISTORY_MISSING_PROFILE', detail };
    }

    const picked = candidates.find(
      (row) => row.profileId && !excluded.has(row.profileId),
    );
    if (!picked) {
      const hasAny = candidates.some((row) => typeof row.profileId === 'string' && row.profileId.trim() !== '');
      const reason: IndependentReviewBlockReason = hasAny ? 'all_candidates_conflict' : 'no_candidates';
      const detail = hasAny
        ? '独立检视候选全部与本 Mission 历史协调者或执行者 profileId 冲突，拒绝自审。'
        : '候选池没有 independent_reviewer 候选，拒绝开检视。';
      mission.recordIndependentReviewBlock(reason, detail);
      await this.#event(mission, 'independent_review.blocked', { reason, detail });
      return {
        ok: false,
        code: hasAny ? 'INDEPENDENT_REVIEW_ALL_CONFLICT' : 'INDEPENDENT_REVIEW_NO_CANDIDATES',
        detail,
      };
    }

    let reviewedCommit: string;
    try {
      reviewedCommit = await this.#missionReviewedCommit(mission);
    } catch (error) {
      const detail =
        error instanceof PlatformRuleError
          ? error.message
          : '读不到 Mission worktree 的 HEAD，拒绝开检视。';
      mission.recordIndependentReviewBlock('reviewed_commit_unavailable', detail);
      await this.#event(mission, 'independent_review.blocked', {
        reason: 'reviewed_commit_unavailable',
        detail,
      });
      return { ok: false, code: 'REVIEWED_COMMIT_UNAVAILABLE', detail };
    }
    const l2 = this.#l2ReviewSnapshot(mission);
    let validationReportId = l2.validationReportId;
    if (mission.executionMode === 'high_assurance') {
      const fromHa = await this.#currentHaValidationReport(
        mission.id,
        reviewedCommit,
        l2.fingerprint,
        mission.contractRevision,
      );
      // 开审不得回退 L2 validator 报告：没有当前 HA 报告就 fail-closed，不建 Attempt。
      if (!fromHa || !fromHa.passed) {
        const detail =
          '当前 HEAD、契约与 L2 没有通过的 HA 确定性验证报告，拒绝开检视。';
        return { ok: false, code: 'INDEPENDENT_REVIEW_HA_REPORT_MISSING', detail };
      }
      validationReportId = fromHa.id;
    }
    const attempt = mission.startIndependentReviewerAttempt({
      contractRevision: mission.contractRevision,
      reviewedCommit,
      l2Fingerprint: l2.fingerprint,
      l2ReviewRefs: l2.refs,
      ...(validationReportId !== undefined ? { validationReportId } : {}),
    });
    attempt.recordProfile(picked);
    await this.#event(
      mission,
      ATTEMPT_STARTED_KIND,
      queuedAttemptStartedData({ kind: 'independent_reviewer', profile: picked }, claim),
      undefined,
      attempt.id,
    );
    return { ok: true, attemptId: attempt.id, profileId: picked.profileId };
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
    const { mission } = await this.#requireAttempt(missionId, attemptId, 'independent_reviewer');
    const l2 = this.#l2ReviewSnapshot(mission);
    const reviewedCommit =
      mission.independentReviewOpen?.attemptId === attemptId
        ? mission.independentReviewOpen.reviewedCommit
        : await this.#missionReviewedCommit(mission);
    const reportIds = new Set<string>();
    if (l2.validationReportId) reportIds.add(l2.validationReportId);
    if (mission.independentReviewOpen?.validationReportId) {
      reportIds.add(mission.independentReviewOpen.validationReportId);
    }
    return {
      missionId: mission.id,
      contractRevision: mission.contractRevision,
      reviewedCommit,
      l2ItemResults: l2.items,
      validationReportRefs: [...reportIds].map((id) => ({ id })),
    };
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
    const { mission, attempt } = await this.#requireAttempt(
      missionId,
      attemptId,
      'independent_reviewer',
    );
    if (input.verdict !== 'pass' && input.verdict !== 'send_back') {
      throw new PlatformRuleError(
        'INDEPENDENT_REVIEW_INVALID',
        'verdict 必须是 pass 或 send_back。',
      );
    }
    if (
      !Array.isArray(input.reasons) ||
      input.reasons.length === 0 ||
      input.reasons.some((r) => typeof r !== 'string' || r.trim() === '')
    ) {
      throw new PlatformRuleError(
        'INDEPENDENT_REVIEW_INVALID',
        'reasons 必须是非空字符串数组。',
      );
    }
    const verdict = input.verdict as IndependentReviewVerdict;
    const reasons = input.reasons as readonly string[];
    const open = mission.independentReviewOpen;
    if (!open || open.attemptId !== attemptId) {
      throw new PlatformRuleError(
        'INDEPENDENT_REVIEW_OPEN_MISSING',
        '没有与本次 Attempt 对应的开审对照，拒绝收结论。',
      );
    }

    const headNow = await this.#missionReviewedCommit(mission);
    const l2Now = this.#l2ReviewSnapshot(mission);
    const profileId = attempt.profile?.profileId;
    if (!profileId) {
      throw new PlatformRuleError(
        'INDEPENDENT_REVIEW_PROFILE_REQUIRED',
        '本次检视 Attempt 缺 profileId，无法记下独立结论。',
      );
    }

    if (verdict === 'pass') {
      if (mission.contractRevision !== open.contractRevision) {
        throw new PlatformRuleError(
          'INDEPENDENT_REVIEW_REVISION_CHANGED',
          `契约已从 r${open.contractRevision} 变到 r${mission.contractRevision}，旧对照不能 pass。`,
        );
      }
      if (headNow !== open.reviewedCommit) {
        throw new PlatformRuleError(
          'INDEPENDENT_REVIEW_HEAD_CHANGED',
          '被审 HEAD 已变化，拒绝记录 pass。',
        );
      }
      if (l2Now.fingerprint !== open.l2Fingerprint) {
        throw new PlatformRuleError(
          'INDEPENDENT_REVIEW_EVIDENCE_CHANGED',
          '被引用的 L2 逐条结果已变化，拒绝记录 pass。',
        );
      }
      if (!this.#l2RefsBelongToMission(mission, open.l2ReviewRefs) || open.l2ReviewRefs.length === 0) {
        throw new PlatformRuleError(
          'INDEPENDENT_REVIEW_L2_MISSING',
          'L2 逐条结果引用缺失或不属本 Mission，拒绝 pass。',
        );
      }
      if (mission.executionMode === 'high_assurance') {
        const ha = await this.#currentHaValidationReport(
          mission.id,
          headNow,
          l2Now.fingerprint,
          mission.contractRevision,
        );
        // 收 pass 同样只认当前 HA 报告，避免开审后改用 L2 validator 报告凑。
        if (!ha || !ha.passed || open.validationReportId !== ha.id) {
          throw new PlatformRuleError(
            'INDEPENDENT_REVIEW_REPORT_MISSING',
            '当前没有通过且属于本提交的 HA 确定性验证报告，不能 pass。',
          );
        }
        const report = await this.#validation?.reports.get(ha.id);
        if (!report || report.missionId !== mission.id || report.passed !== true) {
          throw new PlatformRuleError(
            'INDEPENDENT_REVIEW_REPORT_MISSING',
            'HA 确定性验证报告不存在、不属本 Mission 或未通过，不能 pass。',
          );
        }
      } else {
        const reportId = open.validationReportId ?? l2Now.validationReportId;
        if (!reportId) {
          throw new PlatformRuleError(
            'INDEPENDENT_REVIEW_REPORT_MISSING',
            '缺 ValidationReport，不能 pass。',
          );
        }
        const report = await this.#validation?.reports.get(reportId);
        if (!report || report.missionId !== mission.id) {
          throw new PlatformRuleError(
            'INDEPENDENT_REVIEW_REPORT_MISSING',
            'ValidationReport 不存在或不属本 Mission，不能 pass。',
          );
        }
      }
    }

    const recorded = mission.recordIndependentReview(attemptId, {
      reviewerProfileId: profileId,
      contractRevision: open.contractRevision,
      reviewedCommit: open.reviewedCommit,
      l2ReviewRefs: open.l2ReviewRefs,
      l2Fingerprint: open.l2Fingerprint,
      verdict,
      reasons,
      recordedAt: this.#clock.now().toISOString(),
      ...(open.validationReportId !== undefined
        ? { validationReportId: open.validationReportId }
        : {}),
    });
    await this.#event(
      mission,
      'independent_review.recorded',
      {
        verdict: recorded.verdict,
        reviewerAttemptId: recorded.reviewerAttemptId,
        contractRevision: recorded.contractRevision,
        reviewedCommit: recorded.reviewedCommit,
      },
      undefined,
      attemptId,
    );
    return { recorded };
  }

  /**
   * 读取方判断「当前有效的 pass」：revision / HEAD / L2 / 报告任一变化即失效。
   * 同一证据下最新若是 send_back，不得回退到更早的 pass。HA 受控放行在合并前核对这一份。
   */
  async effectiveIndependentReviewPass(
    missionId: string,
  ): Promise<IndependentReviewRecord | undefined> {
    const { mission } = await this.#locate(missionId);
    let head: string;
    try {
      head = await this.#missionReviewedCommit(mission);
    } catch {
      return undefined;
    }
    const fingerprint = this.#l2ReviewSnapshot(mission).fingerprint;
    const currentReport = await this.#currentHaValidationReport(
      mission.id,
      head,
      fingerprint,
      mission.contractRevision,
    );
    // HA：没有当前证据下 passed 的 HA 报告就不能认 pass，不能拿别的已通过报告凑。
    if (mission.executionMode === 'high_assurance' && (!currentReport || !currentReport.passed)) {
      return undefined;
    }
    for (let i = mission.independentReviews.length - 1; i >= 0; i -= 1) {
      const row = mission.independentReviews[i]!;
      if (row.contractRevision !== mission.contractRevision) continue;
      if (row.reviewedCommit !== head) continue;
      if (row.l2Fingerprint !== fingerprint) continue;
      if (row.verdict === 'send_back') return undefined;
      if (row.verdict !== 'pass') continue;
      if (!row.validationReportId) return undefined;
      if (mission.executionMode === 'high_assurance') {
        if (!currentReport?.passed || row.validationReportId !== currentReport.id) return undefined;
      } else if (currentReport && (!currentReport.passed || row.validationReportId !== currentReport.id)) {
        return undefined;
      }
      const report = await this.#validation?.reports.get(row.validationReportId);
      if (!report || report.missionId !== mission.id || report.passed !== true) return undefined;
      return row;
    }
    return undefined;
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
    const events = await this.#activity.list(missionId);
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]!;
      if (event.kind !== 'validation.reported') continue;
      const data = event.data;
      if (data == null || typeof data !== 'object' || Array.isArray(data)) continue;
      const row = data as {
        purpose?: unknown;
        reportId?: unknown;
        passed?: unknown;
        reviewedCommit?: unknown;
        l2Fingerprint?: unknown;
        contractRevision?: unknown;
        workItemIds?: unknown;
        commands?: unknown;
      };
      if (row.purpose !== 'ha_deterministic') continue;
      if (row.reviewedCommit !== head) continue;
      if (row.l2Fingerprint !== fingerprint) continue;
      if (row.contractRevision !== contractRevision) continue;
      if (typeof row.reportId !== 'string') return undefined;
      const report = await this.#validation?.reports.get(row.reportId);
      // 事件对得上但仓储里没有这份报告，不能拿事件自己的 passed 凑。
      if (!report || report.missionId !== missionId) return undefined;
      const workItemIds = this.#parseHaWorkItemIds(row.workItemIds);
      const commands = this.#parseHaCommands(row.commands);
      return {
        id: row.reportId,
        passed: report.passed === true,
        ...(workItemIds ? { workItemIds } : {}),
        ...(commands ? { commands } : {}),
      };
    }
    return undefined;
  }

  #parseHaWorkItemIds(value: unknown): readonly string[] | undefined {
    if (!Array.isArray(value) || value.length === 0) return undefined;
    if (value.some((id) => typeof id !== 'string' || id.trim() === '')) return undefined;
    return value as string[];
  }

  #parseHaCommands(
    value: unknown,
  ): readonly { argv: readonly string[]; timeoutMs: number }[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const rows: { argv: readonly string[]; timeoutMs: number }[] = [];
    for (const item of value) {
      if (item == null || typeof item !== 'object' || Array.isArray(item)) return undefined;
      const row = item as { argv?: unknown; timeoutMs?: unknown };
      if (!Array.isArray(row.argv) || row.argv.some((part) => typeof part !== 'string')) {
        return undefined;
      }
      if (typeof row.timeoutMs !== 'number' || !Number.isFinite(row.timeoutMs)) return undefined;
      rows.push({ argv: row.argv as string[], timeoutMs: row.timeoutMs });
    }
    return rows;
  }

  #frozenHaCommands(mission: Mission): { argv: string[]; timeoutMs: number }[] {
    return mission.workItems
      .filter((item) => item.status !== 'retired')
      .flatMap((item) =>
        (item.order?.validation?.commands ?? []).map((command) => ({
          argv: [...command.argv],
          timeoutMs: command.timeoutMs,
        })),
      );
  }

  #sameHaCommands(
    left: readonly { argv: readonly string[]; timeoutMs: number }[],
    right: readonly { argv: readonly string[]; timeoutMs: number }[],
  ): boolean {
    if (left.length !== right.length) return false;
    for (let i = 0; i < left.length; i += 1) {
      const a = left[i]!;
      const b = right[i]!;
      if (a.timeoutMs !== b.timeoutMs || a.argv.length !== b.argv.length) return false;
      if (a.argv.some((part, j) => part !== b.argv[j])) return false;
    }
    return true;
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
    // 复用旧报告时必须核覆盖集合与冻结命令；缺字段视为无法证明，拒绝复用。
    if (!meta.workItemIds || !meta.commands) return false;
    if (meta.workItemIds.length !== activeIds.length) return false;
    const covered = new Set(meta.workItemIds);
    if (covered.size !== activeIds.length) return false;
    if (!activeIds.every((id) => covered.has(id))) return false;
    if (!this.#sameHaCommands(meta.commands, frozen)) return false;
    const reported = report.checks.filter((check) => check.kind === 'command');
    if (reported.length !== frozen.length) return false;
    for (let i = 0; i < frozen.length; i += 1) {
      const argv = reported[i]?.command?.argv;
      const expected = frozen[i]!.argv;
      if (!argv || argv.length !== expected.length) return false;
      if (argv.some((part, j) => part !== expected[j])) return false;
    }
    return true;
  }

  #independentReviewOpenBlock(
    mission: Mission,
    _candidates: readonly UsedProfile[],
  ): { reason: IndependentReviewBlockReason; code: string; detail: string } | undefined {
    if (mission.status !== 'awaiting_review') {
      return {
        reason: 'not_awaiting_review',
        code: 'INDEPENDENT_REVIEW_NOT_AWAITING',
        detail: `Mission ${mission.id} 现在是 ${mission.status}，只能在 awaiting_review 开独立检视。`,
      };
    }
    if (mission.result?.outcome !== 'delivered') {
      return {
        reason: 'not_delivered',
        code: 'INDEPENDENT_REVIEW_NOT_DELIVERED',
        detail: `Mission ${mission.id} 交卷不是 delivered，不能开独立检视。`,
      };
    }
    const unfinished = mission.workItems.filter(
      (item) => item.status !== 'accepted' && item.status !== 'retired',
    );
    if (unfinished.length > 0) {
      return {
        reason: 'work_items_unfinished',
        code: 'INDEPENDENT_REVIEW_WORK_ITEMS_UNFINISHED',
        detail: `还有未验收的工作项：${unfinished.map((i) => i.id).join(', ')}。`,
      };
    }
    if (mission.independentReviewerAttempts.some((a) => a.status === 'in_progress')) {
      return {
        reason: 'concurrent_attempt',
        code: 'INDEPENDENT_REVIEW_CONCURRENT',
        detail: `Mission ${mission.id} 已有 in_progress 的 independent_reviewer Attempt。`,
      };
    }
    return undefined;
  }

  /**
   * 历史参与者的 profileId 集合。任一缺 profile 则无法证明独立，返回 undefined。
   */
  #participantProfileIds(mission: Mission): Set<string> | undefined {
    const ids = new Set<string>();
    const attempts: Attempt[] = [...mission.coordinatorAttempts];
    for (const item of mission.workItems) attempts.push(...item.attempts);
    for (const attempt of attempts) {
      const profileId = attempt.profile?.profileId;
      if (typeof profileId !== 'string' || profileId.trim() === '') return undefined;
      ids.add(profileId);
    }
    return ids;
  }

  #missionWorkspaceCwd(mission: Mission): string | undefined {
    const root = mission.workspaceRef?.projectRoot;
    if (typeof root !== 'string' || root.trim() === '') return undefined;
    const viaTree = this.#workspace?.worktreePath?.(mission.id, root);
    const cwd = viaTree ?? root;
    return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : undefined;
  }

  async #missionReviewedCommit(mission: Mission): Promise<string> {
    if (!this.#workspace) {
      throw new PlatformRuleError(
        'REVIEWED_COMMIT_UNAVAILABLE',
        '没有工作区管理，无法核对被审 HEAD。',
      );
    }
    const cwd = this.#missionWorkspaceCwd(mission);
    if (!cwd) {
      throw new PlatformRuleError(
        'REVIEWED_COMMIT_UNAVAILABLE',
        'Mission 没有 projectRoot，无法核对被审 HEAD。',
      );
    }
    const head = await this.#workspace.head(cwd);
    if (typeof head !== 'string' || head.trim() === '') {
      throw new PlatformRuleError(
        'REVIEWED_COMMIT_UNAVAILABLE',
        '读不到 Mission worktree 的 HEAD。',
      );
    }
    return head;
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
    const refs: IndependentReviewL2Ref[] = [];
    const items: {
      workItemId: string;
      submittedAttemptId?: string;
      reviewAttemptId?: string;
      verdict?: string;
      acceptanceResults?: unknown;
    }[] = [];
    let validationReportId: string | undefined;
    const canonical: unknown[] = [];
    for (const item of mission.workItems) {
      if (item.status === 'retired') continue;
      const last = item.reviews.at(-1);
      const ref: IndependentReviewL2Ref = {
        workItemId: item.id,
        ...(item.submittedAttemptId !== undefined
          ? { submittedAttemptId: item.submittedAttemptId }
          : {}),
        ...(last?.attemptId !== undefined ? { reviewAttemptId: last.attemptId } : {}),
      };
      refs.push(ref);
      items.push({
        workItemId: item.id,
        ...(item.submittedAttemptId !== undefined
          ? { submittedAttemptId: item.submittedAttemptId }
          : {}),
        ...(last?.attemptId !== undefined ? { reviewAttemptId: last.attemptId } : {}),
        ...(last?.verdict !== undefined ? { verdict: last.verdict } : {}),
        ...(last?.acceptanceResults !== undefined
          ? { acceptanceResults: last.acceptanceResults }
          : {}),
      });
      canonical.push({
        id: item.id,
        status: item.status,
        submittedAttemptId: item.submittedAttemptId ?? null,
        reviews: item.reviews.map((r) => ({
          attemptId: r.attemptId ?? null,
          submittedAttemptId: r.submittedAttemptId ?? null,
          verdict: r.verdict,
          reasons: r.reasons,
          acceptanceResults: r.acceptanceResults ?? null,
          authority: r.authority ?? null,
        })),
      });
      const authority = last?.authority;
      if (authority && authority.kind === 'validator' && !validationReportId) {
        validationReportId = authority.reportId;
      }
    }
    return {
      fingerprint: JSON.stringify(canonical),
      refs,
      items,
      ...(validationReportId !== undefined ? { validationReportId } : {}),
    };
  }

  #l2RefsBelongToMission(mission: Mission, refs: readonly IndependentReviewL2Ref[]): boolean {
    // pass 必须能指回真实 L2：每个非 retired WorkItem 都要有 ReviewRecord、
    // 属于本项/本 Mission 的 submitted 与 review Attempt、以及覆盖工单每条验收的结果。
    // 只查 WorkItem 存在会让缺 review / 缺逐条 / 错 reviewAttemptId 的 pass 混过去。
    const active = mission.workItems.filter((item) => item.status !== 'retired');
    if (refs.length !== active.length) return false;
    for (const item of active) {
      const ref = refs.find((row) => row.workItemId === item.id);
      if (!ref) return false;
      const last = item.reviews.at(-1);
      if (!last) return false;

      const submittedAttemptId = item.submittedAttemptId;
      if (!submittedAttemptId || ref.submittedAttemptId !== submittedAttemptId) return false;
      if (last.submittedAttemptId !== undefined && last.submittedAttemptId !== submittedAttemptId) {
        return false;
      }
      const submitted = item.attempts.find((row) => row.id === submittedAttemptId);
      if (
        !submitted ||
        submitted.kind !== 'executor' ||
        submitted.workItemId !== item.id ||
        (submitted.missionId !== undefined && submitted.missionId !== mission.id)
      ) {
        return false;
      }

      const reviewAttemptId = last.attemptId;
      if (!reviewAttemptId || ref.reviewAttemptId !== reviewAttemptId) return false;
      const reviewAttempt = mission.coordinatorAttempts.find((row) => row.id === reviewAttemptId);
      if (
        !reviewAttempt ||
        reviewAttempt.kind !== 'coordinator' ||
        (reviewAttempt.missionId !== undefined && reviewAttempt.missionId !== mission.id)
      ) {
        return false;
      }

      const required = item.order?.acceptance ?? [];
      const results = last.acceptanceResults;
      if (!Array.isArray(results)) return false;
      for (const criterion of required) {
        if (!results.some((row) => row.criterion === criterion)) return false;
      }
    }
    return true;
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
    // 失败原文与输出尾部都会落盘、进界面：agent 打过 `env` 的话，本机的 key 就在里面。
    const failureMessage =
      outcome.failureMessage !== undefined ? redactSecrets(outcome.failureMessage) : undefined;
    const { mission } = await this.#locate(missionId);
    const attempt = mission.attempt(attemptId);
    if (!attempt) {
      throw new PlatformRuleError('UNKNOWN_ATTEMPT', `attempt ${attemptId} 不存在`);
    }
    // 已终态再收尾仍走旧副作用（用量/输出），但不得再写一份采集成功事实。
    const alreadyTerminal = attempt.status !== 'in_progress';
    // 必须在 live.finish 之前取（编排器先 finishAttempt 再裁剪缓冲）。
    // 已终态不再取尾：否则重复收尾会把同一段 appendOutput 无限接上。
    let liveTail: string | undefined;
    if (this.#live && !alreadyTerminal) {
      try {
        liveTail = await collectAttemptLiveTail(this.#live, missionId, attemptId);
      } catch {
        // 实时通道读失败不能挡收尾，否则 attempt 卡在 in_progress。
      }
    }
    const merged = mergeAttemptOutput(outcome.output, liveTail);
    const output = merged !== undefined ? redactSecrets(merged) : undefined;
    if (outcome.usage) attempt.recordUsage(outcome.usage);
    if (outcome.resumeRef) attempt.recordResumeRef(outcome.resumeRef);
    // 把运行时报回来的实际身份并进开跑时记的那份（S13.3）。
    // 开跑时只知道 profileId —— 它指向什么，只有跑完了适配层才说得出来。
    if (outcome.resolvedProfile && attempt.profile) {
      attempt.recordProfile({
        ...attempt.profile,
        revision: outcome.resolvedProfile.revision,
        resolved: outcome.resolvedProfile.resolved,
      });
    }
    if (output) {
      // 大输出外置：状态是一次整份写出去的，把几十万字符塞进去会让
      // **每一次工具调用**都变慢。
      const blob = this.#artifacts.put(output);
      attempt.appendOutput(blob.inline ?? `${blob.preview ?? ''}
…（共 ${blob.bytes} 字节，完整内容见 artifact:${blob.ref}）`);
      if (blob.ref) attempt.recordOutputRef(blob.ref);
    }
    for (const name of outcome.toolCalls ?? []) {
      attempt.recordToolCall(name, new Date().toISOString());
    }
    attempt.recordEndReason(outcome.endedBy);
    if (attempt.status === 'in_progress') {
      if (outcome.endedBy === 'structured_submit') attempt.succeed();
      else attempt.fail(failureMessage ?? outcome.endedBy);
    }
    let contextMetrics: ContextMetricsV1 | undefined;
    if (!alreadyTerminal) {
      contextMetrics = sanitizeAttemptContextMetrics(outcome.contextMetrics);
      if (contextMetrics !== undefined) {
        const prior = await this.#activity.list(missionId);
        if (
          prior.some(
            (event) =>
              event.kind === 'attempt.ended' &&
              event.attemptId === attemptId &&
              activityDataHasContextMetrics(event.data),
          )
        ) {
          contextMetrics = undefined;
        }
      }
    }
    await this.#event(
      mission,
      'attempt.ended',
      {
        endedBy: outcome.endedBy,
        failureMessage,
        usage: attempt.usage,
        retriable: outcome.endedBy === 'upstream_failure',
        ...(contextMetrics !== undefined ? { contextMetrics } : {}),
      },
      attempt.workItemId,
      attemptId,
    );
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
    const { mission, project } = await this.#locate(missionId);
    const attempt = mission.attempt(attemptId);
    if (!attempt || attempt.status !== 'in_progress') return;
    attempt.beat(this.#clock.now().toISOString(), owner);
    // **必须落盘。** 心跳的全部作用就是让*别的进程*看见它；只改内存对象的话，
    // 别的进程读到的仍然是"从没心跳过"，于是照样把它判死。
    await this.#projects.save(project);
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
    const { mission, item } = await this.#locateItem(missionId, workItemId);
    // 挡两种：已经作废过的，和**已经验收过的**。
    //
    // accepted 不让作废是刻意的：那件事做过、也被验收过了，作废等于抹掉这段
    // 记录（"想反悔"不是作废的理由）。契约改了让它变得多余的话，诚实的说法
    // 是"它在旧契约下被验收过"。
    //
    // 但 blocked 与 rejected **必须**能作废。早先这两个也被挡着，理由写的是
    // "不需要作废"——那句话是错的：它们都会拦着 Mission 交卷。实测 W5 撞上过，
    // 被打回又被新工单取代的那张既不能再验收（没有新结果）也不能作废，卡死。
    if (item.status === 'retired' || item.status === 'accepted') {
      throw new PlatformRuleError(
        'NOT_RETIRABLE',
        item.status === 'retired'
          ? `工作项 ${workItemId} 已经作废过了。`
          : `工作项 ${workItemId} 已经验收通过，不能作废——那是在改历史。`,
      );
    }
    // 走 retire 而不是 recordBlocked：blocked 的含义是"这张工单不成立、
    // 需要有人去改"，会拦住交卷；retired 的含义是"不用做了"，不该拦。
    item.retire(reason);
    await this.#event(mission, 'work_item.retired', { reason }, workItemId);
    return { status: item.status };
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
    const { mission } = await this.#locate(missionId);
    // detail 变了也要写：同一个 no_available_agent，"卡在 exec-a" 和
    // "卡在 exec-d" 对排障的人是两条不同的信息。
    if (mission.waitReason === reason && mission.waitDetail === detail) return;
    mission.setWaitReason(reason, detail);
    await this.#event(mission, reason ? 'mission.waiting' : 'mission.resumed', {
      reason,
      detail,
    });
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
    const { mission } = await this.#locate(missionId);
    mission.cancel();
    await this.#event(mission, 'mission.cancelled', { reason });
    await this.#releaseWorkspace(missionId, mission.workspaceRef?.projectRoot);
    return { status: mission.status };
  }

  /** 暂停：调度器不再碰它，但阶段保持原样。 */
  async pauseMission(missionId: string): Promise<{ paused: boolean }> {
    // 单事务命令（C4）：状态改动与事件一起提交，或者一个都不落。
    return this.#tx(() => this.#pauseMission(missionId));
  }

  async #pauseMission(missionId: string): Promise<{ paused: boolean }> {
    const { mission } = await this.#locate(missionId);
    mission.pause();
    await this.#event(mission, 'mission.paused', {});
    return { paused: mission.isPaused };
  }

  async parkMission(
    missionId: string,
    input: { reason: string; reviewer: string },
  ): Promise<{ parked: boolean; reason: string }> {
    return this.#tx(async () => {
      const { mission } = await this.#locate(missionId);
      const reason = input?.reason?.trim();
      const reviewer = input?.reviewer?.trim();
      if (!reason || !reviewer) throw new PlatformRuleError('INVALID_PARK_REQUEST', 'park 需要非空 reason 与 reviewer。');
      if (mission.isParked) return { parked: true, reason: mission.parkReason ?? reason };
      if (mission.status === 'completed' || mission.status === 'cancelled' || mission.status === 'failed') {
        throw new PlatformRuleError('MISSION_TERMINAL', `Mission ${missionId} 已终态，不能 park。`);
      }
      const ref = mission.workspaceRef;
      const workspace = this.#workspace;
      const cwd = ref?.projectRoot && workspace?.worktreePath?.(mission.id, ref.projectRoot);
      if (!workspace || !ref?.projectRoot || !ref.branch || ref.branch === '(in-place)' || !cwd || cwd === ref.projectRoot) {
        throw new PlatformRuleError('TRUSTED_WORKSPACE_REQUIRED', 'park 修改中的 Mission 需要可信隔离 workspace。');
      }
      const accepted = mission.workItems.filter((item) => item.status === 'accepted');
      const authorized = new Set<string>();
      for (const item of accepted) {
        const paths = item.order?.allowedScope;
        if (!Array.isArray(paths) || paths.length === 0 || paths.some((path) => typeof path !== 'string' || !path.trim())) {
          throw new PlatformRuleError('CHECKPOINT_SCOPE_REQUIRED', `已验收工作项 ${item.id} 缺少冻结的 allowedScope。`);
        }
        for (const path of paths) authorized.add(path);
      }
      if (accepted.length > 0) {
        if (!workspace.checkpoint) {
          throw new PlatformRuleError('TRUSTED_WORKSPACE_REQUIRED', 'park 已验收成果需要 checkpoint 能力。');
        }
        await workspace.checkpoint(cwd, mission.id, 'park', [...authorized].sort());
      } else {
        if (!workspace.assertMissionWorktreeClean) {
          throw new PlatformRuleError('TRUSTED_WORKSPACE_REQUIRED', '零验收项 park 需要 Mission worktree 洁净检查能力。');
        }
        await workspace.assertMissionWorktreeClean(mission.id, ref.projectRoot);
      }
      mission.park(reason);
      await this.#event(mission, 'mission.parked', { reason, reviewer, checkpointedWorkItems: accepted.map((item) => item.id) });
      return { parked: true, reason };
    });
  }

  async resumeParkedMission(
    missionId: string,
    input: { reason: string; reviewer: string; answer?: string },
  ): Promise<{ parked: boolean; conflictFiles: string[]; targetHead: string }> {
    const reason = input?.reason?.trim();
    const reviewer = input?.reviewer?.trim();
    if (!reason || !reviewer) throw new PlatformRuleError('INVALID_PARK_REQUEST', '续跑需要非空 reason 与 reviewer。');
    const { mission, project } = await this.#locate(missionId);
    if (!mission.isParked) throw new PlatformRuleError('MISSION_NOT_PARKED', `Mission ${missionId} 未挂起。`);
    if (input.answer !== undefined) {
      if (typeof input.answer !== 'string' || !input.answer.trim()) {
        throw new PlatformRuleError('INVALID_ESCALATION_ANSWER', '升级答复不能为空。');
      }
      if (mission.openEscalations.length === 0) {
        throw new PlatformRuleError('NO_OPEN_ESCALATION', `Mission ${missionId} 没有待答复的升级。`);
      }
    }
    const holder = project.missions.find((m) => m.id !== mission.id && m.isMutating);
    if (holder) throw new PlatformRuleError('PROJECT_BUSY', `Mission ${holder.id} 占用项目改动名额。`);
    const ref = mission.workspaceRef;
    const workspace = this.#workspace;
    const cwd = ref?.projectRoot && workspace?.worktreePath?.(mission.id, ref.projectRoot);
    if (!workspace?.syncMissionWithTarget || !workspace.worktreePath || !ref?.projectRoot || !ref.branch ||
        ref.branch === '(in-place)' || !cwd || cwd === ref.projectRoot || !ref.targetBranch || ref.targetBranch === '(in-place)') {
      throw new PlatformRuleError('TRUSTED_WORKSPACE_REQUIRED', '续跑需要可信 Mission worktree 与目标分支。');
    }
    const synced = await workspace.syncMissionWithTarget({ missionId, projectRoot: ref.projectRoot, targetBranch: ref.targetBranch });
    await this.#tx(async () => {
      const current = await this.#locate(missionId);
      current.mission.recordWorkspace({ ...current.mission.workspaceRef!, baseRevision: synced.targetHead });
      if (synced.conflictFiles.length) {
        current.mission.unpark();
        await this.#event(current.mission, 'mission.resume_sync_conflict', {
          reason, reviewer, conflictFiles: synced.conflictFiles, baseRevision: synced.targetHead,
        });
      } else {
        current.mission.unpark();
        await this.#event(current.mission, 'mission.resumed_from_park', { reason, reviewer, baseRevision: synced.targetHead });
      }
      if (input.answer?.trim()) await this.#answerEscalation(missionId, input.answer.trim());
    });
    return { parked: false, conflictFiles: synced.conflictFiles, targetHead: synced.targetHead };
  }

  async resumeMission(missionId: string): Promise<{ paused: boolean }> {
    // 单事务命令（C4）：状态改动与事件一起提交，或者一个都不落。
    return this.#tx(() => this.#resumeMission(missionId));
  }

  async #resumeMission(missionId: string): Promise<{ paused: boolean }> {
    const { mission } = await this.#locate(missionId);
    mission.resume();
    await this.#event(mission, 'mission.resumed_from_pause', {});
    return { paused: mission.isPaused };
  }

  /**
   * 项目长期知识（S09.2 的 coagent_get_project_context）。
   *
   * 给协调者看的是**架构约束 + Capability 索引**，不是把所有 Spec 全文
   * 倒给它。S10.4：只传最小充分上下文；需要哪份再按 slug 取。
   */
  async getProjectContext(missionId: string, slug?: string) {
    const { mission } = await this.#locate(missionId);
    const root = mission.workspaceRef?.projectRoot;
    if (!root) {
      return { available: false, note: '这条 Mission 还没有工作区，读不到项目记忆。' };
    }
    const memory = readProjectMemory(root, mission.projectId);
    if (!memory.exists) {
      return {
        available: false,
        note: `${root} 里还没有 .coagent/ —— 这个项目没有长期记忆可读。`,
      };
    }
    if (slug) {
      const doc =
        memory.specs.find((s) => s.slug === slug) ??
        memory.decisions.find((d) => d.slug === slug);
      return doc
        ? { available: true, slug, title: doc.title, body: doc.body }
        : {
            available: false,
            note: `没有 ${slug}。现有的：${[...memory.specs, ...memory.decisions].map((d) => d.slug).join(', ') || '（空）'}`,
          };
    }
    return {
      available: true,
      projectName: memory.projectName,
      projectProfile: memory.projectProfile,
      // 只给索引，正文按需取——把所有 Spec 全文塞进每一轮对话是纯浪费。
      specs: memory.specs.map((s) => ({ slug: s.slug, title: s.title })),
      decisions: memory.decisions.map((d) => ({ slug: d.slug, title: d.title })),
    };
  }

  /* ============================== 读模型 ============================== */

  /** 项目清单（S12.2 的 getProjects）。 */
  async listProjects() {
    const rows = [];
    for (const project of await this.#projects.list()) {
      rows.push({
        projectId: project.id,
        missions: project.missions.length,
        // 谁占着改动名额——一眼看出这个项目现在能不能派新活。
        mutating: project.missions.find((m) => m.isMutating)?.id,
        // 项目级用量（S11.5）。花了多少钱是项目层面的问题，
        // 要人挨个 Mission 点进去自己加，等于没提供。
        usage: combine(
          project.missions.flatMap((m) => [
            ...m.coordinatorAttempts,
            ...m.independentReviewerAttempts,
            ...m.workItems.flatMap((w) => w.attempts),
          ]).map((a) => a.usage),
        ),
      });
    }
    return rows;
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
    const byProject = new Map<string, TokenUsage[]>();
    const byMission = new Map<string, TokenUsage[]>();
    const byRole = new Map<string, TokenUsage[]>();
    // 键值对不能拼成一个字符串再切回来——模型名里出现分隔符就散架了。
    const byFact = new Map<string, { key: string; value: string; list: TokenUsage[] }>();
    const all: TokenUsage[] = [];
    let unattributed = 0;

    for (const project of await this.#projects.list()) {
      if (filter?.projectId && project.id !== filter.projectId) continue;
      for (const mission of project.missions) {
        if (filter?.missionId && mission.id !== filter.missionId) continue;
        const attempts: Attempt[] = [
          ...mission.coordinatorAttempts,
          ...mission.independentReviewerAttempts,
          ...mission.workItems.flatMap((item) => item.attempts),
        ];
        for (const attempt of attempts) {
          const usage = attempt.usage;
          all.push(usage);
          push(byProject, project.id, usage);
          push(byMission, mission.id, usage);
          push(byRole, attempt.kind, usage);
          const facts = attempt.profile?.resolved;
          if (!facts || facts.length === 0) {
            unattributed += 1;
            continue;
          }
          for (const fact of facts) {
            const composite = JSON.stringify([fact.key, fact.value]);
            const bucket = byFact.get(composite) ?? { key: fact.key, value: fact.value, list: [] };
            bucket.list.push(usage);
            byFact.set(composite, bucket);
          }
        }
      }
    }

    const rows = (map: Map<string, TokenUsage[]>) =>
      [...map].map(([key, list]) => ({ key, attempts: list.length, usage: combine(list) }));

    return {
      total: combine(all),
      attempts: all.length,
      unattributed,
      byProject: rows(byProject),
      byMission: rows(byMission),
      byRole: rows(byRole),
      byFact: [...byFact.values()].map(({ key, value, list }) => ({
        key,
        value,
        attempts: list.length,
        usage: combine(list),
      })),
    };
  }

  /** 所有 Mission 的概览，给列表页用。 */
  async listMissions(): Promise<MissionSummary[]> {
    const rows: MissionSummary[] = [];
    for (const project of await this.#projects.list()) {
      for (const mission of project.missions) {
        rows.push({
          missionId: mission.id,
          projectId: mission.projectId,
          status: mission.status,
          waitReason: mission.waitReason,
          waitDetail: mission.waitDetail,
          updatedAt: mission.updatedAt,
          paused: mission.isPaused,
          isMutating: mission.isMutating,
          intent: mission.contract?.intent ?? '',
          workItems: mission.workItems.length,
          accepted: mission.workItems.filter((item) => item.status === 'accepted').length,
          openEscalations: mission.openEscalations.length,
          usage: sumUsage(mission),
          ...planRunListFields(mission),
        });
      }
    }
    return rows;
  }

  /**
   * 单次 Attempt 的明细：证据 + 原始输出（Timeline 第三层，S11.3）。
   *
   * 单独一个口而不是塞进 MissionView：输出可以很长，列表页不该为了显示
   * 一行状态就把它全拉过来。
   */
  async getAttemptDetail(missionId: string, attemptId: string) {
    const { mission } = await this.#locate(missionId);
    const attempt = mission.attempt(attemptId);
    if (!attempt) {
      throw new PlatformRuleError('UNKNOWN_ATTEMPT', `attempt ${attemptId} 不存在`);
    }
    return {
      attemptId: attempt.id,
      kind: attempt.kind,
      workItemId: attempt.workItemId,
      status: attempt.status,
      endedBy: attempt.endedBy,
      failReason: attempt.failReason,
      usage: attempt.usage,
      profile: attempt.profile,
      evidence: attempt.evidence,
      // 外置的取回来给人看——界面不该要求人再手动拼一次路径。
      output: attempt.outputRef
        ? (this.#artifacts.get(attempt.outputRef) ?? attempt.output)
        : attempt.output,
      outputRef: attempt.outputRef,
      toolActivity: attempt.toolActivity,
    };
  }

  /** Mission 的事件流，给 Timeline 用。 */
  async getActivity(missionId: string) {
    // 不存在就报错，别返回空数组糊弄——空 Timeline 和不存在的 Mission
    // 在界面上长得一模一样。
    await this.#locate(missionId);
    return this.#activity.list(missionId);
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
    const { mission, project } = await this.#locate(missionId);
    // 谁挡着我。要 Project 才算得出来，所以在这一层补，不放进 viewOf。
    const holder = project.missions.find((m) => m.id !== mission.id && m.isMutating);
    const view = { ...viewOf(mission), blockedByMission: holder?.id };
    if (mission.executionMode === 'high_assurance' && mission.status === 'awaiting_review') {
      return { ...view, haReviewHold: await this.#haReviewHold(mission) };
    }
    return view;
  }

  /**
   * agent 专用紧凑 Mission 视图：契约 + 完整规划 + 工作项索引 + 升级问答摘要，
   * 不含工单正文、执行结果或评审正文。网页 getMissionView 不受影响（不改动它）。
   * 只读投影，不写任何状态。
   */
  async getAgentMissionView(missionId: string): Promise<AgentMissionView> {
    const { mission } = await this.#locate(missionId);
    return {
      missionId: mission.id,
      projectId: mission.projectId,
      status: mission.status,
      executionMode: mission.executionMode,
      runKind: mission.runKind,
      updatedAt: mission.updatedAt,
      contractRevision: mission.contractRevision,
      planRevision: mission.planRevision,
      contract: mission.contract,
      plan: mission.plan,
      workItemIndex: agentWorkItemIndex(mission),
      escalations: agentEscalationAnswers(mission),
      openEscalations: mission.openEscalations.length,
    };
  }

  async #haReviewHold(
    mission: Mission,
  ): Promise<'pending_dispatch' | 'in_review' | 'pending_release' | 'fault'> {
    // 结论一旦记下，这条 Attempt 不再算在审。生产 hop 的 finally 仍负责收尾吊销。
    const reviewing = mission.independentReviewerAttempts.some(
      (row) =>
        row.status === 'in_progress' &&
        !mission.independentReviews.some((rec) => rec.reviewerAttemptId === row.id),
    );
    if (reviewing) return 'in_review';
    if (mission.independentReviewBlockReason) return 'fault';
    if (
      mission.waitReason === 'no_available_agent' ||
      mission.waitReason === 'platform_unreachable' ||
      mission.waitReason === 'attempt_limit_reached'
    ) {
      return 'fault';
    }
    const detail = mission.waitDetail ?? '';
    if (detail.startsWith('HA 确定性验证') || detail.startsWith('HA 独立检视故障')) {
      return 'fault';
    }
    const pass = await this.effectiveIndependentReviewPass(mission.id);
    if (pass) return 'pending_release';
    return 'pending_dispatch';
  }

  /**
   * HA：在当前 HEAD 上用冻结工单跑确定性验证，覆盖全部非 retired 工作项。
   * 已有匹配当前证据且落盘的报告则复用，避免重跑清掉有效证据。
   */
  async runHaDeterministicValidation(
    missionId: string,
    _cwd: string,
  ): Promise<{ reportId: string; passed: boolean; reviewedCommit: string }> {
    const { mission } = await this.#locate(missionId);
    if (mission.executionMode !== 'high_assurance') {
      throw new PlatformRuleError(
        'HA_VALIDATION_MODE_REQUIRED',
        '确定性验证只跑 high_assurance Mission。',
      );
    }
    if (mission.status !== 'awaiting_review' || mission.result?.outcome !== 'delivered') {
      throw new PlatformRuleError(
        'HA_VALIDATION_NOT_READY',
        '须在 delivered 且 awaiting_review 之后跑确定性验证。',
      );
    }
    const validation = this.#validation;
    if (!validation) {
      throw new PlatformRuleError(
        'VALIDATION_DEPS_REQUIRED',
        'HA 确定性验证需要注入 validation.engine 与 reports。',
      );
    }
    // 不信调用方 cwd：命令必须跑在从 workspaceRef / worktree 解析出的 Mission 工作区。
    const trustedCwd = this.#missionWorkspaceCwd(mission);
    const projectRoot = mission.workspaceRef?.projectRoot;
    const baseRevision = mission.workspaceRef?.baseRevision;
    if (!trustedCwd || !projectRoot || !baseRevision) {
      throw new PlatformRuleError(
        'VALIDATION_WORKSPACE_REQUIRED',
        `Mission ${mission.id} 缺少可核实的工作区（workspaceRef/worktree），不跑 engine。`,
      );
    }
    const reviewedCommit = await this.#missionReviewedCommit(mission);
    const l2 = this.#l2ReviewSnapshot(mission);
    const active = mission.workItems.filter((item) => item.status !== 'retired');
    const frozenCommands = this.#frozenHaCommands(mission);
    const existingMeta = await this.#currentHaValidationReport(
      mission.id,
      reviewedCommit,
      l2.fingerprint,
      mission.contractRevision,
    );
    if (existingMeta) {
      const existing = await validation.reports.get(existingMeta.id);
      if (existing && existing.missionId === mission.id) {
        if (
          !this.#haReuseMatches(
            existingMeta,
            existing,
            active.map((item) => item.id),
            frozenCommands,
          )
        ) {
          throw new PlatformRuleError(
            'HA_VALIDATION_STALE',
            '已有 HA 报告的工作项覆盖或冻结命令与当前不符，拒绝复用。',
          );
        }
        return { reportId: existing.id, passed: existing.passed, reviewedCommit };
      }
    }
    const allowedScope = [...new Set(active.flatMap((item) => [...(item.order?.allowedScope ?? [])]))];
    const commands = active.flatMap((item) =>
      (item.order?.validation?.commands ?? []).map((command) => ({
        argv: [...command.argv],
        timeoutMs: command.timeoutMs,
        cwd: trustedCwd,
      })),
    );
    const hasForbidden = active.some((item) => item.order?.validation?.forbiddenPaths !== undefined);
    const forbiddenPaths = hasForbidden
      ? [...new Set(active.flatMap((item) => [...(item.order?.validation?.forbiddenPaths ?? [])]))]
      : undefined;
    let diffSize: { maxChangedFiles?: number; maxChangedLines?: number } | undefined;
    for (const item of active) {
      const size = item.order?.validation?.diffSize;
      if (!size) continue;
      diffSize ??= {};
      if (size.maxChangedFiles !== undefined) {
        diffSize.maxChangedFiles =
          diffSize.maxChangedFiles === undefined
            ? size.maxChangedFiles
            : Math.min(diffSize.maxChangedFiles, size.maxChangedFiles);
      }
      if (size.maxChangedLines !== undefined) {
        diffSize.maxChangedLines =
          diffSize.maxChangedLines === undefined
            ? size.maxChangedLines
            : Math.min(diffSize.maxChangedLines, size.maxChangedLines);
      }
    }
    const result = await validation.engine.validate({
      missionId: mission.id,
      projectRoot,
      baseRevision,
      allowedScope,
      commands,
      ...(forbiddenPaths !== undefined ? { forbiddenPaths } : {}),
      ...(diffSize !== undefined ? { diffSize } : {}),
    });
    const headAfter = await this.#missionReviewedCommit(mission);
    if (headAfter !== reviewedCommit) {
      throw new PlatformRuleError(
        'HA_VALIDATION_HEAD_CHANGED',
        '确定性验证运行期间工作区 HEAD 已变化，不产出有效报告。',
      );
    }
    await this.#tx(async () => {
      const { mission: live } = await this.#locate(missionId);
      await validation.reports.save(result.report);
      await this.#event(
        live,
        'validation.reported',
        {
          reportId: result.report.id,
          passed: result.report.passed,
          purpose: 'ha_deterministic',
          reviewedCommit,
          l2Fingerprint: l2.fingerprint,
          contractRevision: live.contractRevision,
          workItemIds: active.map((item) => item.id),
          commands: frozenCommands,
        },
      );
    });
    if (!result.report.passed) {
      await this.setWaitReason(
        missionId,
        'waiting_l3',
        `HA 确定性验证未通过（报告 ${result.report.id}），不能开独立检视。`,
      );
    }
    return { reportId: result.report.id, passed: result.report.passed, reviewedCommit };
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
    /** 可追溯的角色视图；旧字段从这里投影，缺省语义保持不变。 */
    contextBundle: ContextBundle;
  }> {
    const { mission } = await this.#locate(missionId);
    const attempt = mission.attempt(attemptId);
    if (!attempt) {
      throw new PlatformRuleError('UNKNOWN_ATTEMPT', `attempt ${attemptId} 不存在`);
    }

    // 红线从项目记忆里读。读不到就是没有，不是错误——不是每个项目都写了。
    let projectRules: string | undefined;
    const root = mission.workspaceRef?.projectRoot;
    if (root) {
      try {
        projectRules = readProjectMemory(root, mission.projectId).projectProfile;
      } catch {
        projectRules = undefined;
      }
    }

    if (budget !== undefined && (!Number.isSafeInteger(budget) || budget < 0)) {
      throw new PlatformRuleError('INVALID_BUDGET', 'budget 必须是非负安全整数');
    }

    const item =
      attempt.kind === 'executor' && attempt.workItemId
        ? mission.workItem(attempt.workItemId)
        : undefined;
    let classification: string | undefined;
    if (attempt.kind === 'coordinator') {
      const routed = (await this.#activity.list(missionId)).find(
        (event) => event.kind === 'mission.routed',
      );
      if (routed) {
        const data = routed.data && typeof routed.data === 'object'
          ? (routed.data as Record<string, unknown>)
          : {};
        const factsRaw = data.facts && typeof data.facts === 'object'
          ? (data.facts as Record<string, unknown>)
          : {};
        const facts = Object.fromEntries(
          Object.entries(factsRaw)
            .map(([key, value]) => [key, keepTrueOrUnknownLeaves(value)])
            .filter(([, value]) => value !== undefined),
        );
        const lines = [
          '分类阶段已查明',
          `facts: ${JSON.stringify(facts)}`,
          `unknowns: ${JSON.stringify(data.unknowns ?? [])}`,
          `reasons: ${JSON.stringify(data.reasons ?? [])}`,
        ];
        const assessmentReasons = mission.complexityAssessment?.reasons ?? data.assessmentReasons;
        if (assessmentReasons !== undefined) {
          lines.push(`assessmentReasons: ${JSON.stringify(assessmentReasons)}`);
        }
        if (typeof data.fallbackReason === 'string') {
          lines.push(`fallbackReason: ${data.fallbackReason}`);
        }
        const full = lines.join('\n');
        classification = full.length <= 2000
          ? full
          : `${full.slice(0, 2000 - '（已截断）'.length)}（已截断）`;
      }
    }
    // 读路径仍在这里：构造器只吃显式值，不自己找 Mission。
    const contextBundle = buildContextBundle(
      {
        role: attempt.kind === 'executor' ? 'executor' : 'coordinator',
        projectRules,
        environmentNotes: environmentNotes(),
        contract: mission.contract,
        contractRevision: mission.contractRevision,
        plan: mission.plan,
        planRevision: mission.planRevision,
        workItem: item ? boundWorkItemForExecutor(mission, item) : undefined,
        finalReview: mission.finalReview,
        classification,
      },
      budget,
    );

    const report = contextBundle.budgetReport;
    // 只有 omittedSources 非空才是实际裁剪。恰好放下或没给预算时写事件，
    // 审计会把「没裁」说成「裁过」，后续同 Attempt 去重也锁死在假记录上。
    if (report && report.omittedSources.length > 0) {
      await this.#recordContextTruncated(missionId, attemptId, claim, {
        role: contextBundle.role,
        budget: report.budget,
        estimatedBefore: report.estimatedBefore,
        estimatedAfter: report.estimatedAfter,
        omittedSources: report.omittedSources,
        overflow: report.overflow,
        remainingOverBudget: report.remainingOverBudget,
      });
    }

    return {
      role: attempt.kind,
      projectId: mission.projectId,
      missionId: mission.id,
      status: mission.status,
      ...projectStartupBriefFields(contextBundle),
      contextBundle,
    };
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
    await this.#attemptWrite(missionId, attemptId, claim, async () => {
      const { mission } = await this.#locate(missionId);
      const events = await this.#activity.list(missionId);
      const already = events.some(
        (event) => event.kind === 'context.truncated' && event.attemptId === attemptId,
      );
      if (already) return;
      await this.#event(mission, 'context.truncated', data, undefined, attemptId);
    });
  }

  /**
   * 只读契约（S09.2 的 coagent_get_contract）。
   *
   * 和 getMissionView 分开的理由是**成本**：调查阶段协调者要反复回看验收标准
   * 和红线，而整个 MissionView 带着全部工作项、尝试、时间线——每看一眼红线
   * 就得连着几千 token 一起读进去。契约本身只有几行。
   */
  async getContract(missionId: string): Promise<{
    contract: Readonly<MissionContract> | undefined;
    contractRevision: number;
  }> {
    const { mission } = await this.#locate(missionId);
    return { contract: mission.contract, contractRevision: mission.contractRevision };
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
    const { mission } = await this.#requireAttempt(missionId, attemptId, 'coordinator');
    const previous = mission.plan;
    const accumulatedFindings = previous?.findings
      ? `${previous.findings}\n\n—— 第 ${mission.planRevision + 1} 次补充\n${findings}`
      : findings;
    const accumulatedHypotheses = rejectedHypotheses === undefined
      ? [...(previous?.rejectedHypotheses ?? [])]
      : [...new Set([...(previous?.rejectedHypotheses ?? []), ...rejectedHypotheses])];
    const planRevision = mission.updatePlan({
      findings: accumulatedFindings,
      // 其余字段沿用上一版：这个口的语义是"只补发现"，不是"把没填的清空"。
      rootCause: previous?.rootCause,
      rejectedHypotheses: accumulatedHypotheses,
      decisions: [...(previous?.decisions ?? [])],
      direction: previous?.direction ?? '',
      risks: [...(previous?.risks ?? [])],
    });
    await this.#event(
      mission,
      'plan.updated',
      { planRevision, findingsOnly: true },
      undefined,
      attemptId,
    );
    return { planRevision };
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
    const { mission } = await this.#requireAttempt(missionId, attemptId, 'coordinator');
    const planRevision = mission.updatePlan(plan);
    await this.#event(mission, 'plan.updated', { planRevision }, undefined, attemptId);
    return { planRevision };
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
    const { mission } = await this.#requireAttempt(missionId, attemptId, 'coordinator');
    if (mission.planRevision === 0) {
      throw new PlatformRuleError(
        'PLAN_REQUIRED',
        '还没有 Plan：先把调查结论写回平台（update_plan），再创建工作项。',
      );
    }
    const workItemId = input.workItemId ?? this.#ids.next('W');
    mission.createWorkItem({ id: workItemId, title: input.title, order: input.order });
    // 软警告只经两个 coordinator HTTP 工具路径：直接调用不传该标志，保持原语义。
    // 只审计、不硬拒——超限的工单照常建出来，由协调者照建议拆单/补引用。
    const warnings = options?.viaCoordinatorTool ? checkWorkOrderStandard(input.order) : undefined;
    await this.#event(
      mission,
      'work_item.created',
      { title: input.title, ...(warnings ? { warnings } : {}) },
      workItemId,
      attemptId,
    );
    return warnings ? { workItemId, warnings } : { workItemId };
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
    const { mission } = await this.#requireAttempt(missionId, attemptId, 'coordinator');
    const item = mission.workItem(workItemId);
    if (!item) {
      throw new PlatformRuleError('UNKNOWN_WORK_ITEM', `工作项 ${workItemId} 不存在`);
    }
    // 运行中 / 已有结果的工单不能就地改：执行者手上那份是冻结的，改了它就会
    // 出现「按旧工单交的结果对不上新验收标准」。kernel 也挡这些状态（抛
    // ILLEGAL_TRANSITION），这里先挡一次是为了给协调者一句能照做的下一步。
    const hint = REVISE_BLOCKED_HINT[item.status];
    if (hint) {
      throw new PlatformRuleError('WORK_ITEM_NOT_REVISABLE', `工作项 ${workItemId} ${hint}`);
    }
    // 差异取调用方提交的整份工单 vs 修订前的整份工单；orderRevision 是
    // kernel 机械递增的，不算「协调者改了哪个字段」，单独由 revision 事件字段给出。
    const changedFields = orderChangedFields(item.order, order);
    item.reviseOrder(order);
    const revision = item.order?.orderRevision ?? 'r1';
    // 软警告只经两个 coordinator HTTP 工具路径：直接调用不传该标志，保持原语义。
    // 只审计、不硬拒——超限的修订照常生效，由协调者照建议拆单/补引用。
    const warnings = options?.viaCoordinatorTool ? checkWorkOrderStandard(order) : undefined;
    // 只记修订号与字段名，不把工单全文写进事件：事件流是给人看的，
    // 全文会在每条时间线上重复一遍工单。超工单标准的警告一并带上，不另造事件种类。
    await this.#event(
      mission,
      'work_item.order_revised',
      { revision, changedFields, ...(warnings ? { warnings } : {}) },
      workItemId,
      attemptId,
    );
    return warnings
      ? { workItemId, revision, changedFields, warnings }
      : { workItemId, revision, changedFields };
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
    const { mission } = await this.#locate(missionId);
    this.#requireLightweightMutationLane(mission);

    if (mission.status !== 'investigating' && mission.status !== 'planning') {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_BAD_STATUS',
        `Lightweight create 要求 mission.status=investigating|planning，当前是 ${mission.status}。`,
      );
    }
    if (mission.coordinatorAttempts.length !== 0) {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_COORDINATOR_FORBIDDEN',
        'Lightweight create 要求 coordinatorAttempts 为空（零 Coordinator）。',
      );
    }
    if (mission.workItems.length !== 0) {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_SINGLE_WORK_ITEM',
        'Lightweight Mission 恰好只能有一个 WorkItem；已有 WorkItem，拒绝再建。',
      );
    }

    const title = input.title ?? input.order.objective;
    const workItemId = input.workItemId ?? this.#ids.next('W');
    // WorkItem 构造器 strict normalize/freeze validation；create 不另验 commands 非空。
    mission.createWorkItem({ id: workItemId, title, order: input.order });
    await this.#event(
      mission,
      'work_item.created',
      { title, executionMode: 'lightweight' },
      workItemId,
      // attemptId 留空：无 Coordinator reviewer。
    );
    return { workItemId };
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
    const { mission, project } = await this.#locate(missionId);
    this.#requireLightweightMutationLane(mission);

    if (mission.coordinatorAttempts.length !== 0) {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_COORDINATOR_FORBIDDEN',
        'Lightweight dispatch 要求 coordinatorAttempts 仍为空。',
      );
    }

    const item = mission.workItem(workItemId);
    if (!item) {
      throw new PlatformRuleError('UNKNOWN_WORK_ITEM', `工作项 ${workItemId} 不存在`);
    }
    if (mission.workItems.length !== 1 || mission.workItems[0]?.id !== workItemId) {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_SINGLE_WORK_ITEM',
        'Lightweight dispatch 要求该 WorkItem 是 mission 唯一 WorkItem。',
      );
    }
    if (item.status !== 'created') {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_NOT_DISPATCHABLE',
        `工作项 ${workItemId} 当前是 ${item.status}，Lightweight 只能从 created 派发。`,
      );
    }

    // 与 Standard 相同顺序：mutation-slot → shadow → item.dispatch。
    await this.#acquireMutationSlotForDispatch(mission, project);

    // PRE_DISPATCH shadow：observational；provider/activity 失败不阻断 dispatch。
    // attemptId 省略——绝不伪造 Coordinator attempt。
    if (this.#decisionProvider && this.#decisionHooks.has('PRE_DISPATCH')) {
      await runDecisionShadow({
        provider: this.#decisionProvider,
        activity: this.#activity,
        clock: this.#clock,
        stateInput: {
          hook: 'PRE_DISPATCH',
          projectId: mission.projectId,
          missionId: mission.id,
          workItemId,
        },
        workItemIds: [workItemId],
      });
    }

    item.dispatch();
    await this.#event(
      mission,
      'work_item.dispatched',
      { ids: [workItemId], executionMode: 'lightweight' },
      workItemId,
      // attemptId 留空
    );
    return { dispatched: workItemId };
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
    const { mission, item } = await this.#locateItem(input.missionId, input.workItemId);
    this.#requireLightweightMutationLane(mission);

    if (!this.#validation) {
      throw new PlatformRuleError(
        'VALIDATION_DEPS_REQUIRED',
        'Lightweight 验收需要注入 PlatformDeps.validation（engine + reports）。',
      );
    }

    if (item.status !== 'submitted') {
      throw new PlatformRuleError(
        'VALIDATION_NOT_SUBMITTED',
        `工作项 ${item.id} 当前是 ${item.status}，只能对 submitted 做机器验收。`,
      );
    }

    const submittedAttemptId = item.submittedAttemptId;
    if (!submittedAttemptId) {
      throw new PlatformRuleError(
        'VALIDATION_SUBMITTED_ATTEMPT_REQUIRED',
        `工作项 ${item.id} 缺少 submittedAttemptId，拒绝机器验收。`,
      );
    }

    const order = item.order;
    if (!order) {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_ORDER_REQUIRED',
        `工作项 ${item.id} 缺少 order，不跑 engine。`,
      );
    }
    // empty / absent validation.commands 合法：只跑 changed-paths。
    const commands = order.validation?.commands ?? [];
    // VAL-002：forbiddenPaths / diffSize 仅从 frozen order 拷贝；缺省 = 不在 force。
    // 不得从 ExecutionBudget / promotion / prose 填默认值。
    const forbiddenPaths = order.validation?.forbiddenPaths;
    const diffSize = order.validation?.diffSize;

    const projectRoot = mission.workspaceRef?.projectRoot;
    const baseRevision = mission.workspaceRef?.baseRevision;
    if (!projectRoot || !baseRevision) {
      throw new PlatformRuleError(
        'VALIDATION_WORKSPACE_REQUIRED',
        `Mission ${mission.id} 缺少 workspaceRef.projectRoot/baseRevision，不跑 engine。`,
      );
    }

    if (typeof input.cwd !== 'string' || input.cwd.trim().length === 0) {
      throw new PlatformRuleError(
        'VALIDATION_CWD_REQUIRED',
        'Lightweight 验收要求非空 cwd（trusted WorkspaceManager.prepare().cwd）。',
      );
    }
    const trustedCwd = input.cwd.trim();

    // ValidationInput 只能由 Platform 绑定；每个 command 的 cwd 强制覆盖成 trusted cwd。
    const result = await this.#validation.engine.validate({
      missionId: mission.id,
      workItemId: item.id,
      attemptId: submittedAttemptId,
      projectRoot,
      baseRevision,
      allowedScope: [...order.allowedScope],
      commands: commands.map((c) => ({
        argv: [...c.argv],
        timeoutMs: c.timeoutMs,
        cwd: trustedCwd,
      })),
      ...(forbiddenPaths !== undefined ? { forbiddenPaths: [...forbiddenPaths] } : {}),
      ...(diffSize !== undefined
        ? {
            diffSize: {
              ...(diffSize.maxChangedFiles !== undefined
                ? { maxChangedFiles: diffSize.maxChangedFiles }
                : {}),
              ...(diffSize.maxChangedLines !== undefined
                ? { maxChangedLines: diffSize.maxChangedLines }
                : {}),
            },
          }
        : {}),
    });

    // 跑完验收命令之后才开事务（C4）：跑命令可能要几分钟，不能占着事务。
    // 报告、validation.reported、validator accept 一起提交；报告是 append-only 事实，authority 对不上时
    // 照旧保留——拒绝在事务里只做标记，提交之后再抛。
    const validation = this.#validation;
    const committed = await this.#tx(async () => {
      // 事务里重取：跑命令那几分钟里，活对象可能已经被别处换过。
      const { mission: live, item: liveItem } = await this.#locateItem(input.missionId, input.workItemId);

      // append-only：必须先于任何 review / accept。
      await validation.reports.save(result.report);

      await this.#event(
        live,
        'validation.reported',
        {
          reportId: result.report.id,
          passed: result.report.passed,
          submittedAttemptId,
        },
        liveItem.id,
        // ActivityEvent.attemptId 不要冒充 reviewer
      );

      if (result.report.passed === false) {
        // failed report 已保存；不 accept / reject，item 保持 submitted。
        return { kind: 'failed' as const, status: liveItem.status };
      }

      // §4.3：实际改动超出 Lightweight 的规模（>3 文件 / >2 顶层目录）时，机器验收过了也不放行。
      // 一旦 accept，升级到 Standard 之后 L2 就没东西可审了——大改动会绕过评审。
      // 留在 submitted，由 promoteLightweightAfterValidation 凭这份报告升级。
      const held = lightweightGateTrigger(result.report);
      if (held) {
        return { kind: 'held' as const, status: liveItem.status, held: held.code };
      }

      const authority = result.authority;
      const report = result.report;
      const mismatch =
        !authority ||
        authority.kind !== 'validator' ||
        authority.reportId !== report.id ||
        authority.policyRevision !== report.policyRevision ||
        report.missionId !== live.id ||
        report.workItemId !== liveItem.id ||
        report.attemptId !== submittedAttemptId;

      if (mismatch) {
        // 报告保留，item 仍 submitted：提交之后再抛。
        return { kind: 'mismatch' as const, status: liveItem.status };
      }

      liveItem.review('accept', {
        submittedAttemptId,
        authority,
        reasons: [`ValidationReport ${report.id} passed`],
        requiredChanges: [],
      });

      await this.#event(
        live,
        'review.recorded',
        {
          verdict: 'accept',
          authority: 'validator',
          reportId: report.id,
          reasons: [`ValidationReport ${report.id} passed`],
        },
        liveItem.id,
        // ActivityEvent.attemptId 留空
      );

      return { kind: 'accepted' as const, status: liveItem.status };
    });

    if (committed.kind === 'failed') {
      return { reportId: result.report.id, passed: false, status: committed.status };
    }
    if (committed.kind === 'held') {
      return { reportId: result.report.id, passed: true, status: committed.status, held: committed.held };
    }
    if (committed.kind === 'mismatch') {
      throw new PlatformRuleError(
        'VALIDATION_AUTHORITY_MISMATCH',
        `ValidationReport ${result.report.id} 通过，但 authority/linkage 与 WorkItem 不一致，拒绝 accept。`,
      );
    }

    return { reportId: result.report.id, passed: true, status: committed.status };
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
    const { mission } = await this.#locate(missionId);
    // Guard 顺序：先校验后 mutation。
    this.#requireLightweightMutationLane(mission);

    if (mission.coordinatorAttempts.length !== 0) {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_COORDINATOR_FORBIDDEN',
        'Lightweight submit-for-review 要求 coordinatorAttempts 为空。',
      );
    }
    if (mission.status !== 'executing') {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_BAD_STATUS',
        `Lightweight submit-for-review 要求 mission.status=executing，当前是 ${mission.status}。`,
      );
    }
    if (mission.workItems.length !== 1) {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_SINGLE_WORK_ITEM',
        `Lightweight submit-for-review 要求恰好一个 WorkItem，当前 ${mission.workItems.length} 个。`,
      );
    }

    const item = mission.workItems[0]!;
    if (item.status !== 'accepted') {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_NOT_ACCEPTED',
        `工作项 ${item.id} 当前是 ${item.status}，需要 accepted 才能交卷。`,
      );
    }

    const executionResult = item.executionResult;
    if (!executionResult || executionResult.outcome !== 'completed') {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_EXECUTION_NOT_COMPLETED',
        `工作项 ${item.id} 缺少 outcome=completed 的 executionResult。`,
      );
    }

    const submittedAttemptId = item.submittedAttemptId;
    if (!submittedAttemptId || submittedAttemptId.trim().length === 0) {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_SUBMITTED_ATTEMPT_REQUIRED',
        `工作项 ${item.id} 缺少 submittedAttemptId。`,
      );
    }

    const lastReview = item.reviews.at(-1);
    if (!lastReview) {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_REVIEW_REQUIRED',
        `工作项 ${item.id} 没有 review 记录。`,
      );
    }
    if (lastReview.authority?.kind !== 'validator') {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_VALIDATOR_AUTHORITY_REQUIRED',
        `工作项 ${item.id} last review 不是 validator authority。`,
      );
    }
    if (lastReview.submittedAttemptId !== submittedAttemptId) {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_SUBMITTED_ATTEMPT_MISMATCH',
        `review.submittedAttemptId 与 item.submittedAttemptId 不一致。`,
      );
    }

    if (!this.#validation) {
      throw new PlatformRuleError(
        'VALIDATION_DEPS_REQUIRED',
        'Lightweight submit-for-review 需要注入 PlatformDeps.validation（engine + reports）。',
      );
    }

    const authority = lastReview.authority;
    // 重新读 durable report；不信任内存里的 authority  alone。
    const report = await this.#validation.reports.get(authority.reportId);
    if (!report) {
      throw new PlatformRuleError(
        'VALIDATION_REPORT_MISSING',
        `ValidationReport ${authority.reportId} 不存在，拒绝交卷。`,
      );
    }
    if (report.passed !== true) {
      throw new PlatformRuleError(
        'VALIDATION_REPORT_NOT_PASSED',
        `ValidationReport ${report.id} passed=false，拒绝交卷。`,
      );
    }
    if (report.policyRevision !== authority.policyRevision) {
      throw new PlatformRuleError(
        'VALIDATION_POLICY_MISMATCH',
        `ValidationReport ${report.id} policyRevision 与 authority 不一致。`,
      );
    }
    if (
      report.missionId !== mission.id ||
      report.workItemId !== item.id ||
      report.attemptId !== submittedAttemptId
    ) {
      throw new PlatformRuleError(
        'VALIDATION_LINKAGE_MISMATCH',
        `ValidationReport ${report.id} mission/workItem/attempt 与当前对象不一致。`,
      );
    }

    // Platform 内部 derive；不解析 notes，不接受 caller body。
    const body: MissionResultBody = {
      outcome: 'delivered',
      summary: executionResult.summary,
      acceptanceEvidence: [`validation-report:${report.id}`],
      memoryDelta: [],
      openRisks: [],
    };

    mission.recordResult(body);
    mission.submitForReview();

    await this.#event(
      mission,
      'mission_result.submitted',
      {
        outcome: 'delivered',
        missionStatus: 'awaiting_review',
        executionMode: 'lightweight',
        reportId: report.id,
      },
      // ActivityEvent.attemptId 省略：无 Coordinator
    );

    const delivery = await this.#deliveries.create({
      missionId: mission.id,
      projectId: mission.projectId,
      recipient: mission.origin?.conversationRef ?? mission.origin?.clientType ?? 'unknown',
      outcome: 'delivered',
      // 没有协调者：这一次交卷由那份验收报告唯一确定。
      idempotencyKey: resultDeliveryKey(report.id),
      summary: body.summary,
    });
    await this.#event(
      mission,
      'delivery.created',
      { deliveryId: delivery.id },
      // 无 fake attemptId
    );

    return { status: 'awaiting_review', reportId: report.id };
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
    const { mission, project } = await this.#requireAttempt(missionId, attemptId, 'coordinator');
    if (workItemIds.length === 0) {
      throw new PlatformRuleError('EMPTY_DISPATCH', '没有指定任何工作项。');
    }
    const items = workItemIds.map((id) => {
      const item = mission.workItem(id);
      if (!item) throw new PlatformRuleError('UNKNOWN_WORK_ITEM', `工作项 ${id} 不存在`);
      return item;
    });
    // 先全部校验再统一改状态：被拒绝的调用不留下半套流转。
    for (const item of items) {
      const dispatchable = ['created', 'rejected', 'blocked', 'accepted'];
      if (!dispatchable.includes(item.status)) {
        throw new PlatformRuleError(
          'NOT_DISPATCHABLE',
          `工作项 ${item.id} 当前是 ${item.status}，不能派发`,
        );
      }
    }
    // 门禁（W-292）：执行者曾报 blocked 或交 partial/blocked 结果的工作项，
    // 未修订不得原样重派。查「最近一次」相关事件（不是只看当前状态），
    // 与当前 orderRevision 比较；修订后不相等即可派发，旧快照没记则兼容放行。
    // 必须在 #acquireMutationSlotForDispatch / PRE_DISPATCH shadow / 状态修改之前判定，
    // 否则被拒的调用会留下半套流转。
    const history = await this.#activity.list(mission.id);
    for (const item of items) {
      const lastRelevant = [...history].reverse().find((event) => {
        if (event.workItemId !== item.id) return false;
        if (event.kind === 'blocked.reported') return true;
        if (event.kind === 'execution_result.submitted') {
          const outcome = (event.data as { outcome?: string } | undefined)?.outcome;
          return outcome === 'blocked' || outcome === 'partial';
        }
        return false;
      });
      if (!lastRelevant) continue;
      const recorded = (lastRelevant.data as { orderRevision?: string } | undefined)?.orderRevision;
      if (recorded === undefined) continue; // 老快照未记，兼容放行
      const current = item.order?.orderRevision ?? 'r1';
      if (recorded === current) {
        throw new PlatformRuleError(
          'WORK_ORDER_REVISION_REQUIRED',
          `工作项 ${item.id} 最近一次被报 blocked 或提交 partial/blocked 结果时工单仍是 ${recorded}，` +
            '未修订的同一张工单不能原样重派。请先做其一：' +
            '(1) 用 coagent_revise_work_order 修订工单（修订号递增）后重派；' +
            '(2) 若这张工单已无意义，用 retire/作废取代重派；' +
            '(3) 若重派不成立，升级给 L3 重新判断。',
        );
      }
    }
    // Standard 调用顺序保持原样：先 startExecuting/处理 PROJECT_BUSY，
    // 再 PRE_DISPATCH shadow，再 item.dispatch。
    await this.#acquireMutationSlotForDispatch(mission, project);

    // PRE_DISPATCH shadow：确认硬规则全部通过之后、真实 dispatch 之前。
    // 信号 / provider 失败 / shadow append 失败都不改变后续 item.dispatch。
    if (this.#decisionProvider && this.#decisionHooks.has('PRE_DISPATCH')) {
      const soleWorkItemId = workItemIds.length === 1 ? workItemIds[0] : undefined;
      await runDecisionShadow({
        provider: this.#decisionProvider,
        activity: this.#activity,
        clock: this.#clock,
        stateInput: {
          hook: 'PRE_DISPATCH',
          projectId: mission.projectId,
          missionId: mission.id,
          attemptId,
          ...(soleWorkItemId !== undefined ? { workItemId: soleWorkItemId } : {}),
        },
        workItemIds: [...workItemIds],
      });
    }

    for (const item of items) item.dispatch();
    await this.#event(mission, 'work_item.dispatched', { ids: [...workItemIds] }, undefined, attemptId);
    return { dispatched: [...workItemIds] };
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
    const { mission } = await this.#requireAttempt(missionId, attemptId, 'coordinator');
    const item = mission.workItem(input.workItemId);
    if (!item) {
      throw new PlatformRuleError('UNKNOWN_WORK_ITEM', `工作项 ${input.workItemId} 不存在`);
    }
    if (!item.hasResult) {
      throw new PlatformRuleError(
        'NO_RESULT',
        `${input.workItemId} 还没有执行结果，无法验收。`,
      );
    }
    // 打回却说不出要改什么，下一张工单就会和上一张逐字相同。
    if (input.verdict === 'reject' && input.requiredChanges.length === 0) {
      throw new PlatformRuleError(
        'REJECT_NEEDS_CHANGES',
        'reject 必须给出 requiredChanges，否则重发的工单与上一次没有可见差异。',
      );
    }
    const acceptanceResults = checkAcceptanceResults(item.id, item.order?.acceptance ?? [], input.acceptanceResults);
    if (input.verdict === 'accept' && acceptanceResults?.some((r) => r.status === 'fail')) {
      // 内核也挡这一条；在这里先挡是为了给协调者一句能照做的话。
      throw new PlatformRuleError(
        'ACCEPT_WITH_FAILED_CRITERION',
        '有验收标准判为 fail 却给了 accept：没过的那条要么改判，要么 reject 并在 requiredChanges 里写清要改什么。',
      );
    }
    const record: Omit<ReviewRecord, 'verdict'> = {
      attemptId,
      reasons: [...input.reasons],
      requiredChanges: [...input.requiredChanges],
      ...(acceptanceResults ? { acceptanceResults } : {}),
    };
    item.review(input.verdict, record);
    await this.#event(
      mission,
      'review.recorded',
      {
        verdict: input.verdict,
        reasons: record.reasons,
        ...(acceptanceResults
          ? {
              acceptance: tallyAcceptance(acceptanceResults),
              unverified: acceptanceResults.filter((r) => r.status === 'unverified').map((r) => r.criterion),
            }
          : {}),
      },
      input.workItemId,
      attemptId,
    );
    return { status: item.status };
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
    const { mission } = await this.#requireAttempt(missionId, attemptId, 'coordinator');
    await this.#recordEscalationAndDeliver(mission, { ...body, attemptId });
  }

  /**
   * 记一条 Mission 升级并投递一次。协调者 escalateToL3 与轻量 reportBlocked 共用：
   * 分开写会变成两次升级/两封信，L3 对同一提问会看到两张单。
   */
  async #recordEscalationAndDeliver(mission: Mission, body: EscalationBody): Promise<void> {
    mission.recordEscalation(body);
    // 第几次升级：每一次都要进收件箱，重建同一次的投递不会多一条。
    const escalationIndex = mission.escalations.length - 1;
    await this.#event(mission, 'escalated', { question: body.question }, undefined, body.attemptId);
    // 升级只写进平台是不够的：L3 不盯着数据库看。进收件箱才叫升级。
    const delivery = await this.#deliveries.create({
      missionId: mission.id,
      projectId: mission.projectId,
      recipient: mission.origin?.conversationRef ?? mission.origin?.clientType ?? 'unknown',
      outcome: 'escalated',
      idempotencyKey: escalationDeliveryKey(escalationIndex),
      summary: `${body.question}

为什么需要 L3：${body.why}`,
    });
    await this.#event(mission, 'delivery.created', { deliveryId: delivery.id }, undefined, body.attemptId);
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
    const { mission } = await this.#requireAttempt(missionId, attemptId, 'coordinator');
    if (body.outcome === 'delivered') {
      // 作废掉的不算"没做完"——它是被判定为不用做了，拦着交卷没有道理。
      // 早先只认 accepted，于是任何作废过工作项的 Mission 都永远交不了卷，
      // 只能改用 outcome=blocked 绕过去——那等于对外宣称任务失败了。
      const unfinished = mission.workItems.filter(
        (item) => item.status !== 'accepted' && item.status !== 'retired',
      );
      if (unfinished.length > 0) {
        throw new PlatformRuleError(
          'WORK_ITEMS_UNFINISHED',
          `还有未验收的工作项：${unfinished.map((i) => `${i.id}(${i.status})`).join(', ')}。` +
            '每一张都要么验收通过、要么作废（coagent_retire_work_item）之后才能交卷；' +
            '确实交不出来就用 outcome=blocked。',
        );
      }
    }
    mission.recordResult(body);
    // **交卷 ≠ 完成。** 改动还躺在未合并的分支上，要等 L3 最终检视。
    // 名额也继续握着——这时候放掉，下一条 Mission 就会从看不见这些改动的
    // 基线上分叉。
    mission.submitForReview();
    await this.#event(
      mission,
      'mission_result.submitted',
      { outcome: body.outcome, missionStatus: mission.status },
      undefined,
      attemptId,
    );
    const delivery = await this.#deliveries.create({
      missionId: mission.id,
      projectId: mission.projectId,
      recipient: mission.origin?.conversationRef ?? mission.origin?.clientType ?? 'unknown',
      outcome: body.outcome,
      // 这一次交卷由提交它的协调者 attempt 唯一确定：L3 打回后重新交卷是另一次，照投。
      idempotencyKey: resultDeliveryKey(attemptId),
      summary: body.summary,
    });
    await this.#event(mission, 'delivery.created', { deliveryId: delivery.id }, undefined, attemptId);
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
    const { mission } = await this.#locate(missionId);
    const capturedAt = this.#clock.now().toISOString();
    const attempts = [
      ...mission.coordinatorAttempts,
      ...mission.workItems.flatMap((item) => item.attempts),
    ];
    const activity = await this.#activity.list(missionId);

    const snapInput: {
      missionId: string;
      capturedAt: string;
      attempts: typeof attempts;
      roundCount?: number;
      wallClockMs?: number;
      commandCount?: number;
      changedFiles?: readonly string[];
    } = {
      missionId,
      capturedAt,
      attempts,
    };

    const rounds = countAuthoritativeRounds(activity);
    if (rounds.status === 'known') snapInput.roundCount = rounds.count;

    const wall = projectAuthoritativeWallClockMs(activity, capturedAt);
    if (wall.status === 'known') snapInput.wallClockMs = wall.ms;

    const commands = countAuthoritativeCommands(activity);
    if (commands.status === 'known') snapInput.commandCount = commands.count;

    if (opts && Object.prototype.hasOwnProperty.call(opts, 'changedFiles') && opts.changedFiles !== undefined) {
      snapInput.changedFiles = opts.changedFiles;
    }

    const snapshot = buildBudgetUsageSnapshot(snapInput);
    const evaluation = evaluateExecutionBudget(mission.executionBudget, snapshot);
    return Object.freeze({
      budgetPresent: mission.executionBudget !== undefined,
      snapshot,
      evaluation,
    });
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
    const { mission } = await this.#locate(missionId);
    const activity = await this.#activity.list(missionId);
    const seen = new Set<string>();
    for (const event of activity) {
      if (event.kind !== 'mission.budget.threshold') continue;
      const data = event.data;
      if (data == null || typeof data !== 'object' || Array.isArray(data)) continue;
      const row = data as {
        schemaVersion?: unknown;
        dimension?: unknown;
        threshold?: unknown;
      };
      if (row.schemaVersion !== 1) continue;
      if (typeof row.dimension !== 'string' || typeof row.threshold !== 'number') continue;
      seen.add(`${row.dimension}:${row.threshold}`);
    }

    for (const crossing of budgetThresholdCrossings(evaluation)) {
      const key = `${crossing.dimension}:${crossing.threshold}`;
      if (seen.has(key)) continue;
      seen.add(key);
      await this.#event(mission, 'mission.budget.threshold', {
        schemaVersion: 1,
        dimension: crossing.dimension,
        threshold: crossing.threshold,
        limit: crossing.limit,
        used: crossing.used,
        class: crossing.class,
      });
    }
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
    const { mission } = await this.#locate(missionId);

    if (mission.executionMode === 'standard' && mission.promotions.length === 1) {
      const existing = mission.promotions[0]!;
      if (existing.triggerCode === 'budget_exceeded') {
        return { changed: false, promotion: existing };
      }
    }

    if (mission.executionMode !== 'lightweight') {
      throw new PlatformRuleError(
        'LIGHTWEIGHT_MODE_REQUIRED',
        `promoteLightweightForBudgetExceeded 需要 executionMode=lightweight，当前是 ${mission.executionMode}。`,
      );
    }

    const { evaluation } = await this.evaluateMissionBudget(missionId);
    if (!anyHardAuthoritativeExceeded(evaluation)) {
      throw new PlatformRuleError(
        'BUDGET_NOT_AUTHORITATIVELY_EXCEEDED',
        '权威硬预算未 exceeded，拒绝 budget_exceeded promotion。',
      );
    }

    const dims = hardExceededVerdicts(evaluation).map((d) => d.dimension);
    const rule = `hard:${dims.join(',')}`;
    return this.#commitPromotionToStandard(missionId, {
      code: 'budget_exceeded',
      rule,
    });
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
    const { mission } = await this.#locate(missionId);
    await this.#event(
      mission,
      'runtime.command_tracking.enabled',
      { schemaVersion: 1 },
      undefined,
      attemptId,
    );
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
    const { mission } = await this.#locate(missionId);
    await this.#event(
      mission,
      'runtime.command.started',
      { schemaVersion: 1, callId },
      undefined,
      attemptId,
    );
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
    const { mission } = await this.#locate(missionId);
    await this.#event(
      mission,
      'runtime.command_tracking.invalid',
      { schemaVersion: 1 },
      undefined,
      attemptId,
    );
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
    const { mission } = await this.#locate(missionId);
    if (mission.openEscalations.length === 0) {
      throw new PlatformRuleError('NO_OPEN_ESCALATION', `Mission ${missionId} 没有待答复的升级。`);
    }
    const answered = mission.answerEscalation(answer, new Date().toISOString());
    await this.#event(mission, 'escalation.answered', { question: answered.question, answer });
    await this.#redispatchLightweightBlockedAfterAnswer(mission, answered);
    return { question: answered.question, answer };
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
    if (mission.executionMode !== 'lightweight') return;
    const attempt = mission.attempt(answered.attemptId);
    const workItemId = attempt?.workItemId;
    if (!workItemId) return;
    const item = mission.workItem(workItemId);
    if (!item || item.status !== 'blocked') return;
    item.dispatch();
    await this.#event(
      mission,
      'work_item.redispatched',
      { ids: [workItemId], reason: 'escalation_answered' },
      workItemId,
      answered.attemptId,
    );
  }

  /**
   * 给 L3 看的改动摘要。没有工作区管理或没动过代码时返回空。
   *
   * `pendingMemory` 是**这份 diff 里看不到、但会跟它同一次提交落地**的文件。
   * 记忆文件是 merge 那一刻才写进 worktree 的，检视时还不存在；不把它们
   * 单独报出来，L3 就是在一份不完整的清单上签字。实测 P1 因此落了三个
   * 没人看过的文件，其中 VIBE.md 连 memoryDelta 里都没有。
   */
  async getMissionDiff(
    missionId: string,
  ): Promise<{ stat: string; files: string[]; pendingMemory: string[] }> {
    const { mission } = await this.#locate(missionId);
    const ref = mission.workspaceRef;
    const pendingMemory = plannedMemoryFiles(mission.result?.memoryDelta ?? []);
    if (!this.#workspace || !ref) {
      return { stat: '（没有工作区信息）', files: [], pendingMemory };
    }
    const diff = await this.#workspace.diff(missionId, ref.baseRevision, ref.projectRoot);
    return { ...diff, pendingMemory };
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
    const text = (value: unknown) => typeof value === 'string' && value.trim() !== '';
    if (!text(input.planRunId) || !text(input.escalationId)) {
      throw new PlatformRuleError(
        'PLAN_ABANDON_INVALID',
        '方案放弃必须指向方案运行与那张升级单——否则早上查不到为什么放弃。',
      );
    }
    if (!Array.isArray(input.reasons) || !input.reasons.some(text)) {
      throw new PlatformRuleError('PLAN_ABANDON_INVALID', '方案放弃必须写理由。');
    }
    const { mission } = await this.#locate(missionId);
    if (mission.status === 'completed' || mission.status === 'blocked') {
      throw new PlatformRuleError(
        'MISSION_ALREADY_TERMINAL',
        `Mission ${missionId} 已经是 ${mission.status}，没什么可放弃的。`,
      );
    }
    mission.block({
      verdict: 'abandon',
      reasons: [...input.reasons],
      authority: Object.freeze({
        kind: 'plan' as const,
        planRunId: input.planRunId,
        escalationId: input.escalationId,
      }),
    });
    await this.#event(mission, 'final_review.abandoned', {
      reasons: input.reasons,
      authority: 'plan',
      planRunId: input.planRunId,
      escalationId: input.escalationId,
    });
    await this.#releaseWorkspace(missionId, mission.workspaceRef?.projectRoot ?? input.projectRoot);
    return { status: mission.status };
  }

  /* ============================ L1 执行者面 ============================ */

  async getWorkOrder(missionId: string, workItemId: string): Promise<WorkOrderView> {
    const { mission, item } = await this.#locateItem(missionId, workItemId);
    if (!item.order) {
      throw new PlatformRuleError('NO_WORK_ORDER', `工作项 ${workItemId} 没有工单正文。`);
    }
    const contract = mission.contract;
    return {
      workItemId: item.id,
      title: item.title,
      status: item.status,
      order: item.order,
      missionIntent: contract?.intent ?? '',
      guardrails: contract?.guardrails ?? [],
      // 打回理由与问答都是事后补的，不能写进冻结 order；缺省不带键。
      ...priorGuidanceForWorkItem(mission, item),
    };
  }

  /**
   * agent 专用单项详情：沿用 #locateItem 的 UNKNOWN_WORK_ITEM 规则（不存在即抛）。
   * 返回工单及 orderRevision、历次执行结果证据摘要（脱敏截尾）与评审信息。
   * 单项序列化 UTF-8 不超过 20 KB，超长显式标记 truncated。只读投影，不写状态。
   */
  async getAgentWorkItem(missionId: string, workItemId: string): Promise<AgentWorkItemView> {
    const { item } = await this.#locateItem(missionId, workItemId);
    return buildAgentWorkItemView(item, item.order?.orderRevision, item.order, item.executionResult ?? undefined);
  }

/**
   * 解析工单里的 ContextRef（S09.3 的 coagent_get_context）。
   *
   * 工单只给**引用**，正文按需取——把所有引用的内容都塞进工单，
   * 执行者的上下文一半是它可能根本不看的东西。
   */
  async getContext(
    missionId: string,
    attemptId: string,
    ref: string,
  ): Promise<{ found: boolean; kind?: string; body?: string; note?: string }> {
    const { mission, attempt } = await this.#requireAttempt(missionId, attemptId, 'executor');
    const item = attempt.workItemId ? mission.workItem(attempt.workItemId) : undefined;
    const declared = item?.order?.contextRefs ?? [];

    // 只让它取工单里声明过的引用。不限制的话，"最小充分上下文"就没有意义了。
    const match = declared.find((entry) =>
      typeof entry === 'string' ? entry === ref : entry.ref === ref,
    );
    if (!match) {
      const list = declared
        .map((entry) => (typeof entry === 'string' ? entry : entry.ref))
        .join('、');
      return {
        found: false,
        note: `工单里没有声明 ${ref}。可取的是：${list || '（无）'}。` +
          '需要别的东西说明工单给的上下文不够——用 coagent_report_blocked 交回去。',
      };
    }

    const kind = typeof match === 'string' ? 'file' : match.kind;
    if (kind === 'living_spec' || kind === 'adr') {
      const doc = (await this.getProjectContext(missionId, ref)) as {
        available: boolean;
        body?: string;
        note?: string;
      };
      return doc.available
        ? { found: true, kind, body: doc.body }
        : { found: false, note: doc.note };
    }
    if (kind === 'contract') {
      return { found: true, kind, body: JSON.stringify(mission.contract, null, 2) };
    }
    if (kind === 'previous_result') {
      const other = mission.workItem(ref);
      return other?.hasResult
        ? { found: true, kind, body: JSON.stringify(other.executionResult, null, 2) }
        : { found: false, note: `${ref} 还没有执行结果。` };
    }
    // file / artifact / decision：路径类的东西自己用 read 工具读，
    // 平台不代读——那只会多一条会读到错文件的路径。
    return {
      found: true,
      kind,
      note: `这是一个 ${kind} 引用：${ref}。用 read/grep 直接读它。`,
    };
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
    const { mission, attempt } = await this.#requireAttempt(missionId, attemptId, 'executor');
    const evidenceId = this.#ids.next('E');
    attempt.addEvidence({ ...evidence, id: evidenceId, attemptId });
    await this.#event(
      mission,
      'evidence.submitted',
      { evidenceId, kind: evidence.kind, exitCode: evidence.exitCode },
      attempt.workItemId,
      attemptId,
    );
    return { evidenceId };
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
    const { mission, attempt } = await this.#requireAttempt(missionId, attemptId, 'executor');
    const workItemId = attempt.workItemId;
    if (!workItemId) {
      throw new PlatformRuleError('ATTEMPT_NOT_BOUND', `attempt ${attemptId} 没有绑定工作项`);
    }
    const item = mission.workItem(workItemId);
    if (!item) {
      throw new PlatformRuleError('UNKNOWN_WORK_ITEM', `工作项 ${workItemId} 不存在`);
    }
    // S11.1 [MUST]：「已完成」必须有证据撑着。
    //
    // 挡在工具层而不是只写进 prompt——这正是本层存在的理由：能用工具层挡住的，
    // 就不要指望模型记得住。不挡的话，一句没有任何验证支撑的 completed 会一路
    // 走到 L2 验收面前，而那时它看起来和真做完了一模一样。
    //
    // 只卡 completed：blocked / failed 本来就是"没做成"，要求它们举证等于
    // 逼模型为了交卷去编一条。
    if (body.outcome === 'completed' && attempt.evidence.length === 0) {
      throw new PlatformRuleError(
        'NO_EVIDENCE',
        '提交 completed 之前必须先用 coagent_submit_evidence 提交至少一条证据：' +
          '跑过的命令与退出码、测试结果、diff 摘要都算。' +
          '没跑过的不要提交；确实做不完就交 blocked 或用 coagent_report_blocked。',
      );
    }
    // 提交只到 submitted。执行者没有任何通向 accepted 的路（不变量 A）。
    // 把 executionResult 绑到**实际提交它的** executor attempt（只读 provenance，
    // 供后续平台内验收报告绑定；本变更不接线、不改 review 面）。
    item.submit(body, attemptId);
    await this.#event(
      mission,
      'execution_result.submitted',
      {
        outcome: body.outcome,
        changedFiles: body.changedFiles.length,
        // 记当时工单修订号：重派门禁据此判断「未修订是否原样重派」，
        // 不另造事件种类、不依赖当前状态（修订后当前会变大）。
        orderRevision: item.order?.orderRevision ?? 'r1',
      },
      workItemId,
      attemptId,
    );
    return { status: item.status };
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
    const { mission, attempt } = await this.#requireAttempt(missionId, attemptId, 'executor');
    const workItemId = attempt.workItemId;
    if (!workItemId) {
      throw new PlatformRuleError('ATTEMPT_NOT_BOUND', `attempt ${attemptId} 没有绑定工作项`);
    }
    const item = mission.workItem(workItemId);
    if (!item) {
      throw new PlatformRuleError('UNKNOWN_WORK_ITEM', `工作项 ${workItemId} 不存在`);
    }
    item.recordBlocked({ ...body, attemptId });
    await this.#event(
      mission,
      'blocked.reported',
      {
        reason: body.reason,
        // 记当时工单修订号：重派门禁据此判断「未修订是否原样重派」，
        // 不另造事件种类、不依赖当前状态。
        orderRevision: item.order?.orderRevision ?? 'r1',
      },
      workItemId,
      attemptId,
    );
    // Lightweight 没有协调者：执行者提问只能走 Mission 升级，否则 L3 看不到。
    // Standard 和空白需求不是提问，保持只记 blocked。
    const needs = typeof body.needsFromUpstream === 'string' ? body.needsFromUpstream : '';
    if (mission.executionMode === 'lightweight' && needs.trim() !== '') {
      await this.#recordEscalationAndDeliver(mission, {
        attemptId,
        question: body.needsFromUpstream,
        why: body.reason,
        optionsConsidered: [...(body.whatWasTried ?? [])],
      });
    }
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
    return this.#transaction ? this.#transaction.run(fn) : fn();
  }

  /**
   * 队列身份写：核对与状态/事件/投递必须在同一 runFenced 事务里。
   * 事务外 get 预检会在核对和提交之间被接管，旧 Runner 仍能迟到落盘。
   * 没注入 FencedCommandTransaction 时 fail-closed，避免内存平台把领取身份当成已授权。
   * 无领取身份走既有 #tx，原调用方不用改。
   */
  #txFenced<T>(claim: QueueClaimIdentity | undefined, fn: () => Promise<T>): Promise<T> {
    if (!claim) return this.#tx(fn);
    if (!isFencedCommandTransaction(this.#transaction)) {
      throw new PlatformRuleError(
        'CLAIM_FENCE_UNAVAILABLE',
        '携带队列领取身份的写请求需要同一事务内的租约核对，但当前平台没有 FencedCommandTransaction。',
      );
    }
    const fence: ClaimFence = {
      id: claim.id,
      owner: claim.owner,
      claimGeneration: claim.claimGeneration,
      now: this.#clock.now().toISOString(),
    };
    return this.#transaction.runFenced(fence, fn).catch(mapClaimFenceError);
  }

  async #attemptHasQueueMark(missionId: string, attemptId: string): Promise<boolean> {
    const events = await this.#activity.list(missionId);
    return events.some((event) => eventMarksQueuedAttempt(event, attemptId));
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
    if (claim) return this.#txFenced(claim, fn);
    return this.#tx(async () => {
      if (await this.#attemptHasQueueMark(missionId, attemptId)) {
        throw new PlatformRuleError(
          'QUEUE_CLAIM_REQUIRED',
          '该 Attempt 由队列领取启动，写入必须携带当前租约身份。',
        );
      }
      return fn();
    });
  }

  /**
   * POST_EXECUTION shadow（Jev 设计 §9，J2）：编排器在「执行者交卷 + 确定性验收」之后调用。
   *
   * 非权威、从不抛：评估器没注入、钩子没开、工作项不在交卷状态，都直接返回；取数或调用出任何错也只进事件。
   * 输入只取平台自己存的：工单、当前那次提交、那个 attempt 的证据，改动清单优先用平台算的 diff。
   */
  async runPostExecutionShadow(missionId: string, workItemId: string): Promise<void> {
    const evaluator = this.#postExecutionEvaluator;
    if (!evaluator || !this.#decisionHooks.has('POST_EXECUTION')) return;
    try {
      const { mission } = await this.#locate(missionId);
      const item = mission.workItem(workItemId);
      const submittedAttemptId = item?.submittedAttemptId;
      const order = item?.order;
      const result = item?.executionResult;
      if (!item || (item.status !== 'submitted' && item.status !== 'accepted') || !submittedAttemptId || !order || !result) return;
      // 一次交卷只问一次：崩溃后接着跑会把同一次提交再验一遍，这时不再多花一次付费调用。
      const events = await this.#activity.list(missionId);
      if (events.some((e) => e.kind === POST_EXECUTION_SHADOW_EVENT_KIND && shadowAttemptOf(e.data) === submittedAttemptId)) return;
      const attempt = item.attempts.find((a) => a.id === submittedAttemptId);
      const trustedFiles = await this.#trustedChangedFiles(mission);
      const { input, filesSource } = postExecutionInputFrom({
        order,
        result,
        evidence: attempt?.evidence ?? [],
        ...(trustedFiles ? { trustedFiles } : {}),
        ...(attempt ? { toolActivityCount: attempt.toolActivity.length } : {}),
      });
      await recordPostExecutionShadow(
        { evaluator, activity: this.#activity, clock: this.#clock },
        { projectId: mission.projectId, missionId, workItemId, submittedAttemptId, input, filesSource },
      );
    } catch {
      // shadow 从不影响主流程。
    }
  }

  /**
   * 平台自己算的改动清单。只在真有隔离工作区时可信：原地模式的 diff 永远是空的，
   * 分不清「没改」和「没隔离」，这时返回 undefined，让调用方照实退回执行者自报。
   */
  async #trustedChangedFiles(mission: Mission): Promise<readonly string[] | undefined> {
    const ref = mission.workspaceRef;
    if (!this.#workspace || typeof this.#workspace.worktreePath !== 'function') return undefined;
    if (!ref?.projectRoot || !ref.baseRevision) return undefined;
    try {
      return (await this.#workspace.diff(mission.id, ref.baseRevision, ref.projectRoot)).files;
    } catch {
      return undefined;
    }
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
    const { mission } = await this.#locate(missionId);
    this.#requireLightweightMutationLane(mission);
    if (!this.#validation) {
      throw new PlatformRuleError(
        'VALIDATION_DEPS_REQUIRED',
        'Lightweight 自动升级要读验收报告，需要注入 PlatformDeps.validation（engine + reports）。',
      );
    }
    const report = await this.#validation.reports.get(reportId);
    if (!report || report.missionId !== mission.id) {
      throw new PlatformRuleError(
        'PROMOTION_REPORT_MISMATCH',
        `ValidationReport ${reportId} 不存在或不属于 Mission ${mission.id}。`,
      );
    }
    const item = mission.workItem(report.workItemId);
    if (!item || item.status !== 'submitted' || item.submittedAttemptId !== report.attemptId) {
      throw new PlatformRuleError(
        'PROMOTION_REPORT_STALE',
        `ValidationReport ${reportId} 不是工作项 ${report.workItemId} 当前这次提交的报告` +
          `（工作项 ${item?.status ?? '不存在'}，当前提交 ${item?.submittedAttemptId ?? '无'}，报告 ${report.attemptId}）。`,
      );
    }
    const trigger = lightweightGateTrigger(report);
    if (!trigger) {
      throw new PlatformRuleError(
        'NO_PROMOTION_TRIGGER',
        `ValidationReport ${reportId} 通过且改动在轻量规模内，没有升级的理由。`,
      );
    }
    return this.#commitPromotionToStandard(mission.id, trigger);
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
    const rule = typeof trigger?.rule === 'string' ? trigger.rule.trim() : '';
    if (!rule) {
      throw new PlatformRuleError(
        'INVALID_PROMOTION_TRIGGER',
        'promoteMissionToStandard 要求非空 trigger.rule。',
      );
    }
    if (!isPromotionTriggerCode(trigger?.code)) {
      throw new PlatformRuleError(
        'INVALID_PROMOTION_TRIGGER',
        `非法 promotion trigger code：${String(trigger?.code)}`,
      );
    }
    // 公开入口永不接受 caller 自拟 budget_exceeded（BUDGET-001-S5）。
    if (trigger.code === 'budget_exceeded') {
      throw new PlatformRuleError(
        'BUDGET_PROMOTION_NOT_READY',
        'budget_exceeded 不得由调用方手填；仅 Platform 在权威硬超限自检后内部发放。',
      );
    }

    return this.#commitPromotionToStandard(missionId, {
      code: trigger.code,
      rule,
    });
  }

  /**
   * Shared LW→Standard commit after trigger validation.
   * Used by public non-budget triggers and internal budget hard-exceed path.
   */
  async #commitPromotionToStandard(
    missionId: string,
    trigger: { readonly code: PromotionTriggerCode; readonly rule: string },
  ): Promise<{ changed: boolean; promotion: Readonly<PromotionRecord> }> {
    const rule = trigger.rule.trim();
    const { mission, project } = await this.#locate(missionId);

    // 已 standard + 既有 promotion：按 trigger code/rule 幂等匹配，不重采样。
    if (mission.executionMode === 'standard' && mission.promotions.length === 1) {
      const existing = mission.promotions[0]!;
      if (existing.triggerCode === trigger.code && existing.triggerRule === rule) {
        return { changed: false, promotion: existing };
      }
      throw new PlatformRuleError(
        'PROMOTION_ALREADY_APPLIED',
        `Mission ${missionId} 已升级为 standard，拒绝不同 trigger。`,
      );
    }

    const fromStatus = mission.status as PromotionStatus;
    const toStatus: 'investigating' | 'planning' =
      mission.status === 'executing' ? 'planning' : (fromStatus as 'investigating' | 'planning');

    const record: PromotionRecord = {
      // 审计身份只由 Platform 生成；不接受 caller 自带 id。
      id: this.#ids.next('promo'),
      fromMode: 'lightweight',
      toMode: 'standard',
      triggerCode: trigger.code,
      triggerRule: rule,
      at: this.#clock.now().toISOString(),
      fromStatus,
      toStatus,
      consumedUsage: buildPromotionUsageSnapshot(mission),
      evidenceIds: collectPromotionEvidenceIds(mission),
      validationReportIds: await collectPromotionValidationReportIds(
        mission,
        this.#activity,
      ),
      workspaceRevision: await this.#derivePromotionWorkspaceRevision(mission),
      workItemIdsSnapshot: mission.workItems.map((item) => item.id),
    };

    const result = mission.promoteToStandard(record);
    if (!result.changed) {
      return result;
    }

    // promotion snapshot 独立于 API 外层 persist 也要落盘。
    await this.#projects.save(project);
    await this.#event(mission, 'mission.promoted', {
      id: result.promotion.id,
      oldMode: result.promotion.fromMode,
      newMode: result.promotion.toMode,
      triggerCode: result.promotion.triggerCode,
      triggerRule: result.promotion.triggerRule,
      consumedUsage: result.promotion.consumedUsage,
      evidenceIds: result.promotion.evidenceIds,
      validationReportIds: result.promotion.validationReportIds,
      workspaceRevision: result.promotion.workspaceRevision,
      workItemIdsSnapshot: result.promotion.workItemIdsSnapshot,
      fromStatus: result.promotion.fromStatus,
      toStatus: result.promotion.toStatus,
    });
    return result;
  }

  /**
   * 升级瞬间 workspace HEAD 的可信推导。
   * 禁止用 workspaceRef.baseRevision 冒充 current HEAD。
   */
  async #derivePromotionWorkspaceRevision(
    mission: Mission,
  ): Promise<PromotionWorkspaceRevision> {
    const projectRoot = mission.workspaceRef?.projectRoot;
    if (!this.#workspace || !mission.workspaceRef || !projectRoot) {
      return { kind: 'unknown' };
    }
    const cwd =
      this.#workspace.worktreePath?.(mission.id, projectRoot) ?? projectRoot;
    try {
      const head = await this.#workspace.head(cwd);
      const revision = typeof head === 'string' ? head.trim() : '';
      if (!revision) return { kind: 'unknown' };
      return { kind: 'head', revision };
    } catch {
      return { kind: 'unknown' };
    }
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
    if (!this.#workspace || !projectRoot) return;
    await this.#workspace.release(missionId, projectRoot).catch(() => undefined);
  }

  async #ensureProject(projectId: string) {
    return this.#projects.ensure(projectId);
  }

  async #locate(missionId: string): Promise<{ mission: Mission; project: Project }> {
    for (const project of await this.#projects.list()) {
      const mission = project.missions.find((m) => m.id === missionId);
      // 也把 Project 带出来：不变量 C 的报错要点名"被谁占着"，
      // 那个信息只有在兄弟 Mission 里找得到。
      if (mission) return { mission, project };
    }
    throw new PlatformRuleError('UNKNOWN_MISSION', `mission ${missionId} 不存在`);
  }

  async #locateItem(
    missionId: string,
    workItemId: string,
  ): Promise<{ mission: Mission; item: WorkItem }> {
    const { mission } = await this.#locate(missionId);
    const item = mission.workItem(workItemId);
    if (!item) {
      throw new PlatformRuleError('UNKNOWN_WORK_ITEM', `工作项 ${workItemId} 不存在`);
    }
    return { mission, item };
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
    const { mission, project } = await this.#locate(missionId);
    const attempt = mission.attempt(attemptId);
    if (!attempt) {
      throw new PlatformRuleError('UNKNOWN_ATTEMPT', `attempt ${attemptId} 不存在`);
    }
    if (attempt.kind !== kind) {
      throw new PlatformRuleError(
        'WRONG_ROLE',
        `这个动作只允许 ${kind} 调用，attempt ${attemptId} 是 ${attempt.kind}。`,
      );
    }
    if (attempt.status !== 'in_progress') {
      throw new PlatformRuleError(
        'ATTEMPT_NOT_ACTIVE',
        `attempt ${attemptId} 已经是 ${attempt.status}，不能再提交。`,
      );
    }
    return { mission, project, attempt };
  }

  async #event(
    mission: Mission,
    kind: string,
    data: unknown,
    workItemId?: string,
    attemptId?: string,
  ): Promise<void> {
    // 每记一条事件就顺手更新"最后动过"。放在这一个地方，
    // 而不是散在十几个用例里——散着写一定会漏，而漏掉的那条在界面上
    // 表现成"这个 Mission 好像停了"。
    const at = this.#clock.now().toISOString();
    mission.touch(at);
    await this.#activity.append({
      projectId: mission.projectId,
      missionId: mission.id,
      workItemId,
      attemptId,
      kind,
      data,
      // ---- Envelope 公共语义（S10.3）----
      protocolVersion: PROTOCOL_VERSION,
      // 用 UUID 而不是发号器：messageId 只需要唯一，不需要连续。
      // 走发号器的话，每记一条事件都要占一个号段位——号段用尽时
      // 一次**记日志**会把正经操作顶失败，代价和收益完全不成比例。
      messageId: randomUUID(),
      // 因果链：同一条 Mission 的事件串在一起，而每条事件由哪一跳引发
      // 则看 causationId。没有这两个，"为什么会有这一步"只能靠时间戳猜。
      correlationId: mission.id,
      causationId: attemptId,
      contractRevision: mission.contractRevision,
      planRevision: mission.planRevision,
    });
  }
}

/**
 * Envelope 协议版本（S10.3）。
 *
 * 和 API_VERSION 分开：客户端接口和事件信封是两个会各自演进的东西，
 * 绑在一起就等于任何一边动了都要让另一边跟着升版本。
 */
export const PROTOCOL_VERSION = 'cdp/1';

/* ================================ 读模型 ================================ */

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

/**
 * 列表投影：origin.conversationRef 给出 runId，Mission id 必须是
 * `<runId>-<featureId>[-rN]`。对不上就不写——猜错的关联比没有更糟。
 * 功能 id 含 `-rN` 的消歧由 HTTP 层用已知 PlanRun.features.missionIds 覆盖。
 */
function planRunListFields(mission: Mission): { planRunId: string; featureId: string } | Record<string, never> {
  const origin = mission.origin;
  if (!origin || origin.clientType !== 'plan-run') return {};
  const ref = origin.conversationRef;
  if (typeof ref !== 'string' || !ref.startsWith('plan-run:')) return {};
  const planRunId = ref.slice('plan-run:'.length);
  if (planRunId === '' || planRunId.includes('/') || planRunId.includes('\\') || planRunId.includes(':')) {
    return {};
  }
  const prefix = `${planRunId}-`;
  if (!mission.id.startsWith(prefix)) return {};
  const rest = mission.id.slice(prefix.length);
  if (rest === '') return {};
  const rerun = /^(.*)-r([1-9]\d*)$/.exec(rest);
  const featureId = rerun && rerun[1] !== '' ? rerun[1] : rest;
  if (featureId === '') return {};
  return { planRunId, featureId };
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
 * 这台机器上会**静默**咬人的地方。
 *
 * 判准只有一条：**出错的时候没有声音**。会报错的东西 agent 自己撞一次就知道了，
 * 写进简报只是噪音；而下面这些不报错、只是悄悄做了另一件事——那种要提前说。
 *
 * 按平台分：在 Linux 上讲 Windows 的坑同样是噪音。
 */
function environmentNotes(): string[] {
  if (process.platform !== 'win32') return [];
  return [
    'Windows：bash 的 `/tmp` 和 Node 的 `/tmp` **不是同一个目录**（前者在 ' +
      '%LOCALAPPDATA%\\Temp，后者是 C:\\tmp）。要落临时文件就用工作区里的相对路径，' +
      '跨这两者传文件必须用绝对路径——弄错不会报错，只会读到一个旧文件或空文件。',
    'Windows：Git Bash 里没有 `pgrep`。`if ! pgrep -f x` 这类判据**恒为真**，' +
      '不会报"命令不存在"，只会让你以为进程已经没了。判进程死活用 tasklist，' +
      '或者干脆改判产物（文件 mtime、库里的记录）。',
  ];
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

/** 两个 ISO 时间的非负差；缺失、非法、倒序都保持 unknown，不 clamp 成 0。 */
function elapsedMs(start: string | undefined, end: string | undefined): number | undefined {
  if (!start || !end) return undefined;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return undefined;
  return endMs - startMs;
}

/** 聚合用量：**分项相加**，不要只滚一个 total。 */
function sumUsage(mission: Mission): TokenUsage {
  const all: Attempt[] = [
    ...mission.coordinatorAttempts,
    ...mission.independentReviewerAttempts,
  ];
  for (const item of mission.workItems) all.push(...item.attempts);
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  let reported = 0;
  for (const attempt of all) {
    const u = attempt.usage;
    input += u.input;
    output += u.output;
    cacheRead += u.cacheRead;
    cacheWrite += u.cacheWrite;
    cost += u.cost ?? 0;
    if (u.quality === 'reported') reported += 1;
  }
  // 不得伪装精确：一条都没上报就是 unknown，部分上报就是 estimated，
  // 只有全部上报才敢说 reported。在途 attempt 还没上报不该把整体拉成
  // "估算过"——那会让读数看起来比实际更有依据。
  const quality: TokenUsage['quality'] =
    all.length === 0 || reported === 0
      ? 'unknown'
      : reported === all.length
        ? 'reported'
        : 'estimated';
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
    cost,
    quality,
  };
}

/** 收集全部 attempts 的 evidence id，去重且保持出现顺序。 */
function collectPromotionEvidenceIds(mission: Mission): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const attempts: Attempt[] = [
    ...mission.coordinatorAttempts,
    ...mission.independentReviewerAttempts,
  ];
  for (const item of mission.workItems) attempts.push(...item.attempts);
  for (const attempt of attempts) {
    for (const ev of attempt.evidence) {
      if (seen.has(ev.id)) continue;
      seen.add(ev.id);
      ids.push(ev.id);
    }
  }
  return ids;
}

/**
 * 收集 promotion 审计用 validation reportId，去重保序。
 * 来源（既有可信状态，不另造审计入口）：
 *   1) WorkItem.reviews 中 validator authority.reportId
 *   2) activity `validation.reported` 事件 data.reportId
 *      （Lightweight 失败只落 report+事件、不写 ReviewRecord 时仍须计入）
 */
/**
 * 工单处于「正在跑 / 已出结果」时不能修订。每条给协调者下一步能照做的事：
 * 等结果、先验收、或走作废重建。created / rejected / blocked 不在表里，可修订。
 */
const REVISE_BLOCKED_HINT: Partial<Record<WorkItemStatus, string>> = {
  dispatched: '正在执行中，改不了：等执行者交卷（或报告卡住）后再修订，或先作废重建。',
  submitted: '已有执行结果待验收，先 review_execution_result 收掉这次结果，再决定是否修订。',
  accepted: '已经验收通过，不能修订；契约若变应由 L3 打回，再重建工单。',
  retired: '已经作废，不能修订；需要的话请新建一张工单。',
};

/**
 * 两份工单的顶层字段差异（字段名，排序）。
 *
 * orderRevision 由 kernel 机械递增，不代表协调者改了什么，所以从两侧剔掉；
 * 修订号单独由事件的 revision 字段给出。用 JSON 值比较能连数组 / 对象的
 * 内容差异一起认出来，而不是只看引用是否变了。
 */
function orderChangedFields(
  previous: Readonly<WorkOrder> | undefined,
  next: WorkOrder,
): string[] {
  const prev = { ...((previous ?? {}) as Record<string, unknown>) };
  const curr = { ...(next as unknown as Record<string, unknown>) };
  delete prev.orderRevision;
  delete curr.orderRevision;
  const fields = new Set([...Object.keys(prev), ...Object.keys(curr)]);
  const changed: string[] = [];
  for (const field of fields) {
    const before = JSON.stringify(prev[field] ?? null);
    const after = JSON.stringify(curr[field] ?? null);
    if (before !== after) changed.push(field);
  }
  return changed.sort();
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
 * 纯校验：工单是否超出「工单标准」又不至于硬拒。
 *
 * 规则放在 Platform 而非 HTTP handler：两个 coordinator 工具共用同一份真话。
 * 仅按末尾扩展名识别文件、把纯目录路径剔除——目录不得冒充文件；
 * 不发明任何新硬拒，所有命中项都只是软警告。
 */
function checkWorkOrderStandard(order: WorkOrder): WorkOrderStandardWarning[] {
  const warnings: WorkOrderStandardWarning[] = [];
  const files = (order.allowedScope ?? []).filter((p) => /\.[^/]+$/.test(p));
  const dirs = (order.allowedScope ?? []).filter((p) => !/\.[^/]+$/.test(p));
  if (files.length + dirs.length > 2) {
    warnings.push({
      rule: 'allowedScope',
      suggestion:
        'allowedScope 超过 2 项：一张工单只做一个行为、改 1–2 个文件，请拆成多张工单。',
    });
  } else if (dirs.length > 0) {
    warnings.push({
      rule: 'allowedScope',
      suggestion: 'allowedScope 含纯目录路径，不得冒充文件：请列出具体文件（带扩展名）。',
    });
  }
  if ((order.verification ?? []).length > 2) {
    warnings.push({
      rule: 'verification',
      suggestion: 'verification 超过 2 条：每条验收 1–2 条验证即可，请精简或拆单。',
    });
  }
  if ((order.contextRefs ?? []).length === 0) {
    warnings.push({
      rule: 'contextRefs',
      suggestion: 'contextRefs 为空：至少给出最小充分上下文（文件行段或 Living Spec 引用）。',
    });
  }
  return warnings;
}

/**
 * 协调者评审的逐条结果（方案 §11）：工单有验收标准时必须一条对一条、照抄原文。
 *
 * 为什么强制：一句总结里「都过了」和「三条过了、第四条没法验」看起来一样，
 * 而后者正是 L3 最需要看到的。报错写成协调者能照做的话——它下一步就是按这句改。
 * 没有验收标准的旧工作项不要求；给了就得是空的，不然对不上。
 */
function checkAcceptanceResults(
  workItemId: string,
  acceptance: readonly string[],
  raw: unknown,
): AcceptanceResult[] | undefined {
  if (acceptance.length === 0) {
    if (raw === undefined || (Array.isArray(raw) && raw.length === 0)) return undefined;
    throw new PlatformRuleError('ACCEPTANCE_RESULTS_MISMATCH', `工作项 ${workItemId} 的工单没有验收标准，acceptanceResults 应为空数组。`);
  }
  if (!Array.isArray(raw)) {
    throw new PlatformRuleError(
      'ACCEPTANCE_RESULTS_REQUIRED',
      `工作项 ${workItemId} 有 ${acceptance.length} 条验收标准，评审必须逐条给出 acceptanceResults：` +
        'criterion 照抄原文，status 为 pass / fail / unverified / not_applicable。只写一句总结不收。',
    );
  }
  if (raw.length !== acceptance.length) {
    throw new PlatformRuleError(
      'ACCEPTANCE_RESULTS_MISMATCH',
      `逐条结果 ${raw.length} 条、验收标准 ${acceptance.length} 条：要一条对一条、顺序一致。`,
    );
  }
  return raw.map((entry, i) => {
    const r = (entry ?? {}) as Partial<AcceptanceResult>;
    if (r.criterion !== acceptance[i]) {
      throw new PlatformRuleError('ACCEPTANCE_RESULTS_MISMATCH', `第 ${i + 1} 条的 criterion 要照抄验收原文：「${acceptance[i]}」。`);
    }
    if (!(ACCEPTANCE_STATUSES as readonly unknown[]).includes(r.status)) {
      throw new PlatformRuleError('ACCEPTANCE_RESULT_INVALID', `第 ${i + 1} 条的 status 只能是 pass / fail / unverified / not_applicable。`);
    }
    if (r.status === 'pass' && !(typeof r.evidence === 'string' && r.evidence.trim())) {
      throw new PlatformRuleError('ACCEPTANCE_EVIDENCE_REQUIRED', `第 ${i + 1} 条判 pass 要写出证据（命令 + 退出码、diff 的位置……）。`);
    }
    if ((r.status === 'unverified' || r.status === 'not_applicable') && !(typeof r.note === 'string' && r.note.trim())) {
      throw new PlatformRuleError('ACCEPTANCE_NOTE_REQUIRED', `第 ${i + 1} 条判 ${r.status} 要写明原因。`);
    }
    return {
      criterion: r.criterion,
      status: r.status as AcceptanceResult['status'],
      ...(typeof r.evidence === 'string' && r.evidence.trim() ? { evidence: r.evidence } : {}),
      ...(typeof r.note === 'string' && r.note.trim() ? { note: r.note } : {}),
    };
  });
}

const HA_FORBIDDEN_SIDE_EFFECTS = [
  'productionDeployRelease',
  'externalPaidOp',
  'unrecoverableExternalSideEffect',
  'destructiveData',
] as const;

/** 无法证明为 false 的禁止副作用：true 与 unknown 都算未证明安全。 */
function haForbiddenSideEffects(ha: {
  readonly productionDeployRelease: unknown;
  readonly externalPaidOp: unknown;
  readonly unrecoverableExternalSideEffect: unknown;
  readonly destructiveData: unknown;
}): string[] {
  return HA_FORBIDDEN_SIDE_EFFECTS.filter((key) => ha[key] !== false);
}

function tallyAcceptance(results: readonly AcceptanceResult[]): Record<AcceptanceResult['status'], number> {
  const tally = { pass: 0, fail: 0, unverified: 0, not_applicable: 0 };
  for (const r of results) tally[r.status] += 1;
  return tally;
}

async function collectPromotionValidationReportIds(
  mission: Mission,
  activity: ActivityLog,
): Promise<string[]> {
  const ids: string[] = [];
  const seen = new Set<string>();
  const push = (reportId: unknown): void => {
    if (typeof reportId !== 'string' || reportId.length === 0) return;
    if (seen.has(reportId)) return;
    seen.add(reportId);
    ids.push(reportId);
  };

  for (const item of mission.workItems) {
    for (const review of item.reviews) {
      const authority = review.authority;
      if (!authority || authority.kind !== 'validator') continue;
      push(authority.reportId);
    }
  }

  const events = await activity.list(mission.id);
  for (const event of events) {
    if (event.kind !== 'validation.reported') continue;
    const data = event.data;
    if (data == null || typeof data !== 'object' || Array.isArray(data)) continue;
    push((data as { reportId?: unknown }).reportId);
  }

  return ids;
}

/**
 * 从 trusted attempts 构造 promotion usage 快照。
 * 只累加 reported/estimated；unknown 永不贡献假 0。
 * 任一 attempt token 事实未知 => dimensionsUnknown 含 tokens。
 * 无任何非 unknown usage => 省略 tokenUsage。
 */
function buildPromotionUsageSnapshot(mission: Mission): PromotionUsageSnapshot {
  const attempts: Attempt[] = [
    ...mission.coordinatorAttempts,
    ...mission.independentReviewerAttempts,
  ];
  for (const item of mission.workItems) attempts.push(...item.attempts);
  const attemptCount = attempts.length;

  const baseUnknown: PromotionUnknownDimension[] = [
    'cost',
    'wallClockMs',
    'rounds',
    'changedFiles',
    'commands',
    'budgetRemaining',
  ];

  const known = attempts.filter(
    (a) => a.usage.quality === 'reported' || a.usage.quality === 'estimated',
  );
  const hasUnknownTokens =
    attemptCount === 0 || known.length < attemptCount;

  const dimensionsUnknown: PromotionUnknownDimension[] = hasUnknownTokens
    ? ['tokens', ...baseUnknown]
    : [...baseUnknown];

  if (known.length === 0) {
    return {
      attemptCount,
      dimensionsUnknown,
      budgetAuthoritative: false,
    };
  }

  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let reported = 0;
  for (const attempt of known) {
    const u = attempt.usage;
    input += u.input;
    output += u.output;
    cacheRead += u.cacheRead;
    cacheWrite += u.cacheWrite;
    if (u.quality === 'reported') reported += 1;
  }
  const quality: PromotionTokenUsageSnapshot['quality'] =
    reported === known.length ? 'reported' : 'estimated';
  const tokenUsage: PromotionTokenUsageSnapshot = {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
    quality,
  };
  return {
    attemptCount,
    tokenUsage,
    dimensionsUnknown,
    budgetAuthoritative: false,
  };
}

function answeredQaForWorkItem(
  mission: Mission,
  item: WorkItem,
): { question: string; answer: string; answeredAt: string } | undefined {
  const attemptIds = new Set(item.attempts.map((attempt) => attempt.id));
  let latest: Readonly<EscalationBody> | undefined;
  for (const escalation of mission.escalations) {
    if (escalation.answer && escalation.answeredAt && attemptIds.has(escalation.attemptId)) {
      latest = escalation;
    }
  }
  if (!latest?.answer || !latest.answeredAt) return undefined;
  return {
    question: latest.question,
    answer: latest.answer,
    answeredAt: latest.answeredAt,
  };
}

/**
 * 派回执行者的可见理由：工单视图与开跑简报共用这一份投影，两处不能各算各的。
 *
 * 为什么不能只取 `item.reviews.at(-1)`：工作项被 reject 后重做、又被 accept，最后
 * 一条评审是 accept，其 requiredChanges 是空的。这时 L3 再打回整个 Mission 重派，
 * 执行者读到的「上次要改什么」是空——真正该先看的打回理由一条也没到它手上。
 * 倒着找**最近一次 reject** 既保住旧的「重派带上要改什么」语义，又不会被随后的
 * accept 抹掉。
 *
 * L3 理由只在当前 finalReview 是 send_back 时带（Mission 每次 send_back 都覆盖
 * finalReview，所以同轮多次打回自然只剩最新一条）。它**不**要求本项有 reject：
 * 「已验收的工作项被 L3 打回重派」正是本投影要救的场景，那时 reviews 里只有 accept。
 */
function priorGuidanceForWorkItem(
  mission: Mission,
  item: WorkItem,
): {
  previousRequiredChanges?: readonly string[];
  l3SendBackReasons?: readonly string[];
  question?: string;
  answer?: string;
  answeredAt?: string;
} {
  const latestReject = [...item.reviews]
    .reverse()
    .find((review) => review.verdict === 'reject');
  const finalReview = mission.finalReview;
  const answered = answeredQaForWorkItem(mission, item);
  return {
    ...(latestReject ? { previousRequiredChanges: latestReject.requiredChanges } : {}),
    ...(finalReview?.verdict === 'send_back' && finalReview.reasons.length > 0
      ? { l3SendBackReasons: finalReview.reasons }
      : {}),
    ...(answered ?? {}),
  };
}

function boundWorkItemForExecutor(mission: Mission, item: WorkItem): BoundWorkItem {
  return {
    id: item.id,
    title: item.title,
    order: item.order,
    ...priorGuidanceForWorkItem(mission, item),
  };
}

/* ===================== agent 专用只读投影（不写状态） ===================== */

/** 单项序列化后允许的最大 UTF-8 字节数；超长显式标记 truncated。 */
const MAX_AGENT_WORK_ITEM_BYTES = 20 * 1024;

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
}

function agentWorkItemIndex(mission: Mission): readonly AgentWorkItemIndexEntry[] {
  return mission.workItems.map((item) => ({
    id: item.id,
    title: item.title,
    status: item.status,
    planRevision: item.planRevision,
    attempts: item.attempts.length,
    attemptIds: item.attempts.map((a) => a.id),
    lastReviewVerdict: item.reviews.at(-1)?.verdict,
  }));
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

function agentEscalationAnswers(mission: Mission): readonly AgentEscalationAnswer[] {
  return mission.escalations
    .filter((e) => e.answer && e.answeredAt)
    .map((e) => ({ question: e.question, answer: e.answer!, answeredAt: e.answeredAt! }));
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

export interface AgentWorkItemView {
  readonly workItemId: string;
  readonly title: string;
  readonly status: string;
  readonly orderRevision: string | undefined;
  readonly order: WorkOrder | undefined;
  readonly executionResult: ExecutionResultBody | undefined;
  readonly reviews: readonly { readonly verdict: 'accept' | 'reject'; readonly reasons: readonly string[]; readonly requiredChanges: readonly string[] }[];
  readonly evidenceSummary: readonly AgentWorkItemEvidenceSummary[];
  /** 序列化 UTF-8 超过 20 KB 时为真，内容已被截断到尽量贴近上限。 */
  readonly truncated: boolean;
}

/**
 * 把一次 attempt 的证据投影成脱敏 + 截尾的摘要。output 一律先 redactSecrets 再截尾——
 * 顺序反了会把截出来的尾巴里的 token 明文露出去。maxTail 控制尾巴长度；summary 过长时按
 * summaryCap 截断、dropCommand 时直接丢弃 command，均为超限时逐步收紧所用。
 */
function agentEvidenceSummary(
  attempts: readonly Readonly<{ id: string; evidence: readonly Readonly<EvidenceRecord>[] }>[],
  maxTail: number,
  opts: { summaryCap?: number; dropCommand?: boolean } = {},
): AgentWorkItemEvidenceSummary[] {
  const out: AgentWorkItemEvidenceSummary[] = [];
  for (const attempt of attempts) {
    for (const e of attempt.evidence) {
      const summary =
        opts.summaryCap !== undefined
          ? capString(redactSecrets(e.summary), opts.summaryCap)
          : redactSecrets(e.summary);
      out.push({
        attemptId: attempt.id,
        kind: e.kind,
        summary,
        command: opts.dropCommand ? undefined : e.command !== undefined ? redactSecrets(e.command) : undefined,
        exitCode: e.exitCode,
        // maxTail=0 必须产出空串：slice(-0) 实际返回整串，会漏掉裁切。
        outputTail: maxTail > 0 ? (e.output !== undefined ? redactSecrets(e.output) : '').slice(-maxTail) : '',
      });
    }
  }
  return out;
}

/** 超长字符串按 n 字符截断并注明被裁掉多少，避免静默丢失"这里有内容"的信息。 */
function capString(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…[truncated ${s.length - n} chars]`;
}

/** 工单里会膨胀的长文本字段按 n 字符上限收紧；contextRefs 是取上下文用的结构，保留。 */
function capOrderText(order: WorkOrder, n: number): WorkOrder {
  return {
    ...order,
    objective: capString(order.objective, n),
    requiredBehaviour: capString(order.requiredBehaviour, n),
    constraints: order.constraints.map((s) => capString(s, n)),
    acceptance: order.acceptance.map((s) => capString(s, n)),
    verification: order.verification.map((s) => capString(s, n)),
    doNot: order.doNot.map((s) => capString(s, n)),
  };
}

/** 执行结果里 summary / notes 会膨胀，按 n 字符上限收紧；文件清单保留为有用结构。 */
function capResultText(result: ExecutionResultBody, n: number): ExecutionResultBody {
  return {
    ...result,
    summary: capString(result.summary, n),
    notes: capString(result.notes, n),
  };
}

/**
 * 构造单项视图并按 20 KB 上限收紧：所有外显文本先深层脱敏（redactSecretsDeep），
 * 之后按 UTF-8 实测大小逐级收紧——先裁证据 output 尾巴，再裁证据 summary/command，
 * 再裁工单 / 执行结果 / 评审的长文本，始终保留 id/status/orderRevision 与有用结构；
 * 仍超大时返回仅含索引字段的紧凑 truncated 摘要。每条 return 前都复核 <=20KB。
 */
function buildAgentWorkItemView(
  item: WorkItem,
  orderRevision: string | undefined,
  order: WorkOrder | undefined,
  executionResult: ExecutionResultBody | undefined,
): AgentWorkItemView {
  // 外显文本先统一深层脱敏：order / executionResult / reviews / title 都可能含凭据。
  const redactedTitle = redactSecrets(item.title);
  const redactedOrder = order !== undefined ? redactSecretsDeep(order) : undefined;
  const redactedResult = executionResult !== undefined ? redactSecretsDeep(executionResult) : undefined;
  const reviews = item.reviews.map((r) => ({
    verdict: r.verdict,
    reasons: r.reasons.map((t) => redactSecrets(t)),
    requiredChanges: r.requiredChanges.map((t) => redactSecrets(t)),
  }));

  const byteSize = (v: AgentWorkItemView): number => Buffer.byteLength(JSON.stringify(v), 'utf8');

  // 一条候选视图：证据尾巴 maxTail，summary/command/order/result/reviews 的字符上限可选。
  const build = (
    maxTail: number,
    t: { summaryCap?: number; dropCommand: boolean; orderCap?: number; resultCap?: number; reviewCap?: number },
  ): AgentWorkItemView => {
    const evidenceSummary = agentEvidenceSummary(item.attempts, maxTail, {
      summaryCap: t.summaryCap,
      dropCommand: t.dropCommand,
    });
    const cappedOrder =
      t.orderCap !== undefined && redactedOrder !== undefined ? capOrderText(redactedOrder, t.orderCap) : redactedOrder;
    const cappedResult =
      t.resultCap !== undefined && redactedResult !== undefined
        ? capResultText(redactedResult, t.resultCap)
        : redactedResult;
    const cappedReviews =
      t.reviewCap !== undefined
        ? reviews.map((r) => {
            const cap = t.reviewCap as number;
            return {
              verdict: r.verdict,
              reasons: r.reasons.map((s) => capString(s, cap)),
              requiredChanges: r.requiredChanges.map((s) => capString(s, cap)),
            };
          })
        : reviews;
    return {
      workItemId: item.id,
      title: redactedTitle,
      status: item.status,
      orderRevision,
      order: cappedOrder,
      executionResult: cappedResult,
      reviews: cappedReviews,
      evidenceSummary,
      truncated: false,
    };
  };

  // 完整（1000 字符尾巴、不裁其它字段）若已在上限内，直接返回、未截断。
  const base = build(1000, { dropCommand: false });
  if (byteSize(base) <= MAX_AGENT_WORK_ITEM_BYTES) return base;

  // 逐级收紧：证据尾巴优先，再依次裁 summary/command、工单、执行结果、评审。每级都复核大小。
  const levels: { summaryCap?: number; dropCommand: boolean; orderCap?: number; resultCap?: number; reviewCap?: number }[] = [
    { dropCommand: false },
    { dropCommand: true, summaryCap: 400 },
    { dropCommand: true, summaryCap: 300, orderCap: 300 },
    { dropCommand: true, summaryCap: 200, orderCap: 200, resultCap: 200 },
    { dropCommand: true, summaryCap: 120, orderCap: 120, resultCap: 120, reviewCap: 120 },
  ];
  for (const lvl of levels) {
    for (const mt of [1000, 500, 250, 100, 0]) {
      const candidate = build(mt, lvl);
      if (byteSize(candidate) <= MAX_AGENT_WORK_ITEM_BYTES) return { ...candidate, truncated: true };
    }
  }

  // 仍超大：只保留索引字段的紧凑摘要，明确标 truncated。标题本身也可能极长，
  // 必须按 UTF-8 实测复核并逐级截断到上限内——否则极长标题会撑爆 20KB，
  // 违背「任何情况下 JSON UTF-8 <=20KB 并标 truncated」的硬约束。
  const buildFallback = (title: string): AgentWorkItemView => ({
    workItemId: item.id,
    title,
    status: item.status,
    orderRevision,
    order: undefined,
    executionResult: undefined,
    reviews: [],
    evidenceSummary: [],
    truncated: true,
  });
  let fallbackTitleCap = Math.max(0, Math.floor(MAX_AGENT_WORK_ITEM_BYTES / 4));
  while (
    fallbackTitleCap > 1 &&
    byteSize(buildFallback(capString(redactedTitle, fallbackTitleCap))) > MAX_AGENT_WORK_ITEM_BYTES
  ) {
    fallbackTitleCap = Math.floor(fallbackTitleCap / 2);
  }
  return buildFallback(capString(redactedTitle, fallbackTitleCap));
}

function viewOf(mission: Mission): MissionView {
  return {
    missionId: mission.id,
    projectId: mission.projectId,
    status: mission.status,
    executionMode: mission.executionMode,
    runKind: mission.runKind,
    promotions: mission.promotions,
    waitReason: mission.waitReason,
    waitDetail: mission.waitDetail,
    updatedAt: mission.updatedAt,
    paused: mission.isPaused,
    isMutating: mission.isMutating,
    parked: mission.isParked,
    parkReason: mission.parkReason,
    // 只有 getMissionView 那一层算得出来（要看兄弟 Mission）。这里给 undefined
    // 而不是省略：省略会让类型上是可选的东西在运行时变成"没查过"和"查了没有"
    // 分不开。
    blockedByMission: undefined,
    contractRevision: mission.contractRevision,
    contract: mission.contract,
    planRevision: mission.planRevision,
    plan: mission.plan,
    workItems: mission.workItems.map((item) => ({
      id: item.id,
      title: item.title,
      status: item.status,
      hasResult: item.hasResult,
      // 拆它时的规划版本（S05.2）。和 Mission 当前的 planRevision 不同
      // 就说明规划在它之后改过——检视时这是必须看得见的。
      planRevision: item.planRevision,
      attempts: item.attempts.length,
      attemptIds: item.attempts.map((a) => a.id),
      lastReview: item.reviews.at(-1),
      // submitted：只投影最新提交 attempt（item.submittedAttemptId）的证据，脱敏后再截尾。
      // 先 redactSecrets 再 slice(-1000)——顺序反了会把截出来的尾巴里的 token 明文露出去。
      ...(item.status === 'submitted' && item.submittedAttemptId !== undefined
        ? {
            submittedEvidence: (item.attempts.find((a) => a.id === item.submittedAttemptId)?.evidence ?? []).map(
              (e) => ({
                command: e.command !== undefined ? redactSecrets(e.command) : undefined,
                exitCode: e.exitCode,
                summary: redactSecrets(e.summary),
                outputTail: (e.output !== undefined ? redactSecrets(e.output) : '').slice(-1000),
              }),
            ),
          }
        : {}),
      // accepted / rejected：只给证据条数和验收结论，不泄露证据输出。
      ...((item.status === 'accepted' || item.status === 'rejected')
        ? {
            reviewSummary: {
              evidenceCount: item.attempts.find((a) => a.id === item.submittedAttemptId)?.evidence.length ?? 0,
              verdict: item.status === 'accepted' ? 'accept' : 'reject',
            },
          }
        : {}),
      // 两封信的正文。观测面要回答"这两个 agent 之间到底传了什么"，
      // 光有 title 和一个 hasResult 布尔量回答不了。
      order: item.order,
      executionResult: item.executionResult,
    })),
    result: mission.result,
    escalations: mission.escalations.length,
    openEscalations: [...mission.openEscalations],
    escalationLog: [...mission.escalations],
    origin: mission.origin,
    coordinatorResumeRef: mission.latestCoordinatorResumeRef(),
    coordinatorAttemptIds: mission.coordinatorAttempts.map((a) => a.id),
    independentReviewerAttemptIds: mission.independentReviewerAttempts.map((a) => a.id),
    independentReviews: mission.independentReviews,
    independentReviewBlockReason: mission.independentReviewBlockReason,
    independentReviewBlockDetail: mission.independentReviewBlockDetail,
    finalReview: mission.finalReview,
    workspaceRef: mission.workspaceRef,
    usage: sumUsage(mission),
  };
}

export { InvariantViolationError };

/** 往分组里塞一条。 */
function push(map: Map<string, TokenUsage[]>, key: string, usage: TokenUsage): void {
  const list = map.get(key);
  if (list) list.push(usage);
  else map.set(key, [usage]);
}

/**
 * 合并若干条用量。
 *
 * quality 的规则和 sumUsage 一致，而且**必须一致**：同一个数在 Mission 页
 * 标"已上报"、在用量页标"估算"，人只会不信这两个数。
 */
function combine(list: readonly TokenUsage[]): TokenUsage {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  let reported = 0;
  for (const u of list) {
    input += u.input;
    output += u.output;
    cacheRead += u.cacheRead;
    cacheWrite += u.cacheWrite;
    cost += u.cost ?? 0;
    if (u.quality === 'reported') reported += 1;
  }
  const quality: TokenUsage['quality'] =
    list.length === 0 || reported === 0
      ? 'unknown'
      : reported === list.length
        ? 'reported'
        : 'estimated';
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
    cost,
    quality,
  };
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

/** decision.post_execution 事件问的是哪一次提交；读不出来就当不是（宁可多问一次，不漏问）。 */
function shadowAttemptOf(data: unknown): string | undefined {
  if (data === null || typeof data !== 'object') return undefined;
  const ids = (data as { ids?: unknown }).ids;
  if (ids === null || typeof ids !== 'object') return undefined;
  const id = (ids as { submittedAttemptId?: unknown }).submittedAttemptId;
  return typeof id === 'string' ? id : undefined;
}
