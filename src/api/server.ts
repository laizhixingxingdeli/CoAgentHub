/**
 * HTTP 面。零依赖，直接用 node:http。
 *
 * 两组端点：
 *   /api/agent/*   —— coagent_* 工具的真实实现。身份来自 run token，不来自请求体。
 *   /api/missions* —— 客户端（L3 / Web / CLI）读写 Mission。
 *
 * 工具实现放在平台侧、而不是各个 runtime 适配包里，是为了接第二个 agent 时
 * 不用把这十来个工具重写一遍。
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { Platform, PlatformRuleError } from '../application/platform.ts';
import type { MissionSummary } from '../application/platform.ts';
import {
  isSafePlanRunId,
  listPlanRuns,
  readPlanRunById,
  type PlanRunListItem,
} from '../application/plan-run-store.ts';
import { ClassifiedMissionInputError } from '../application/classified-mission-intake.ts';
import { AgentPoolError, InMemoryAgentPoolRepository } from '../application/agent-pool.ts';
import type {
  AgentPoolAddInput,
  AgentPoolCandidate,
  AgentPoolCandidateHealth,
  AgentPoolRepository,
} from '../application/agent-pool.ts';
import { KernelError } from '../kernel/index.ts';
import { RunTokenRegistry } from './run-tokens.ts';
import { WEB_PAGE } from './web.ts';
import { serveStatic } from './static.ts';
import { listRuntimeModels, type RuntimeCatalog } from '../application/runtime-catalog.ts';
import { NoLiveOutput, PLAN_LIVE_EMPTY_REASON } from '../application/live.ts';
import type { LiveOutput, PlanLiveChunk, PlanRunLiveOutput } from '../application/live.ts';
import type { DeliveryRepository } from '../application/delivery.ts';
import type { RunContext } from './run-tokens.ts';
import type { ControlPrincipalResolver } from './control-auth.ts';
import { redactSecretsDeep } from '../application/redact.ts';
import type { CandidateCircuitRepository, QueuedHopRepository } from '../application/ports.ts';
import {
  activeHopOccupancy,
  activeLeaseForProfile,
  countQueuedHopStatuses,
  DEFAULT_HOP_CAPACITY_LIMITS,
  summarizeDeadLetters,
  type HopCapacityLimits,
  type QueuedHop,
} from '../application/durable-scheduler.ts';
import {
  classifyCandidateFailure,
  closedCandidateCircuit,
  resolveCandidateLastFailure,
  type CandidateCircuit,
  type CandidateFailureHint,
} from '../application/candidate-circuit.ts';
import type { AttemptEndReason } from '../kernel/index.ts';
import {
  AGENT_TOOL_ACTION,
  evaluatePolicy,
  POLICY_ACTION,
  POLICY_REASON,
  principalFromControl,
  principalFromRun,
  type PolicyAction,
} from '../application/policy-engine.ts';

/** 客户端 API 版本。破坏性改动时要加。 */
export const API_VERSION = 'v1';

/**
 * 成功的模型清单在同一 createApi 实例内缓存这么久。
 * 适配层一次约数秒，页面连刷不能每次都等；到期必须重取，否则界面会选已经下线的模型。
 */
export const RUNTIME_MODELS_CACHE_MS = 10 * 60 * 1000;

/** hosted run 的一行进度。channel 必须可区分，客户端不能靠猜 stdout/stderr。 */
export type HostedRunEmit = (channel: 'stdout' | 'stderr', line: string) => void;

/**
 * 没有进度可写时隔这么久发一帧 `{ heartbeat: true }`。
 * 必须短于 Node 19+ keep-alive 套接字默认 5s 空闲超时：方案等升级决定的 poll
 * 缺省 15s，中间没有 stdout；不心跳的话 CLI 会误报断线，对端 job 还在跑。
 * 帧上不得带 channel，否则会进 CLI stdout。
 */
export const HOSTED_RUN_HEARTBEAT_IDLE_MS = 2_000;

/**
 * 常驻编排入口回调。返回进程式 exitCode；抛错由 HTTP 面写成 stderr + 非零终态。
 * 不在这里取消：请求断线不等于 job 该停。
 */
export type HostedRunHandler = (
  body: Record<string, unknown>,
  emit: HostedRunEmit,
) => Promise<number>;

export interface ApiDeps {
  platform: Platform;
  tokens: RunTokenRegistry;
  deliveries: DeliveryRepository;
  /**
   * 每次成功的写请求之后调用。
   *
   * 落盘放在这一个地方，而不是散在各个用例里：用例直接改活对象，
   * 漏掉一处就是"重启后这条改动没了"，而且很难发现。
   */
  onMutation?: () => void | Promise<void>;
  /** 实时输出来源。不配就是没有实时——界面那一栏会显示「还没有实时输出」。 */
  live?: LiveOutput;
  /**
   * 每次读请求之前调用，用来把别的进程写过的东西读进来。
   *
   * 不做这件事的话，常驻服务器会一直显示启动那一刻的快照——文件版踩过一次
   * （靠 mtime 修的），换成数据库之后同一个坑还在，只是判据换了。
   */
  beforeRead?: () => Promise<void> | void;
  /** Web 资源根目录。缺省 src/web/；测试用临时目录，免得几个测试文件互相看见。 */
  webRoot?: string;
  /**
   * 文件回环写者身份。注入后所有 JSON 应答（含错误）带
   * x-coagent-instance / x-coagent-state-id，与 /api/health 一致。
   * 不注入则不加这两头：内存测试与 PG 没有文件锁身份。
   */
  identity?: { readonly instanceId: string; readonly stateId: string };
  /**
   * 候选池仓储。不传就是内存版（进程退了配置就没了）。
   *
   * 为什么是可选的：这一堆 createApi 调用点里绝大多数只关心 Mission 流转，
   * 把候选池做成必填会让十几个测试文件为了一个它们根本不碰的端点改一遍。
   * 少一个默认实现，比少一类调用点便宜。
   */
  agentPool?: AgentPoolRepository;
  /**
   * 持久队列。注入后平台状态报五态/死信/占用，资源池用有效租约判断是否在跑。
   * 不注入就标明不适用 / 无运行时原因，不编造空队列或 0 占用。
   */
  queuedHops?: QueuedHopRepository;
  /**
   * 候选熔断仓储。注入后 GET /api/pools 带 circuit；不注入则 health.circuit 说明原因。
   */
  candidateCircuits?: CandidateCircuitRepository;
  /**
   * 常驻装配给出的身份与只读 env 观测。不注入则文件锁/路径/env 标不适用，不虚构。
   */
  platformStatus?: {
    readonly store: 'file' | 'pg' | 'memory';
    readonly startedAt: string;
    readonly instanceId?: string;
    readonly statePath?: string;
    readonly holdsMainLock?: boolean;
    readonly agentEnv?: {
      readonly passthroughDeclared: boolean;
      readonly baselineFiltered: boolean;
      readonly extraPassthroughCount: number;
    };
    readonly defaultAdapter?: string;
    readonly capacityLimits?: HopCapacityLimits;
  };
  /**
   * 控制面 Principal 解析。注入后，敏感读允许 viewer/operator，写/控制路由要求 operator；
   * 不注入则保持历史行为（本地与既有测试零摩擦）。
   * 与 /api/agent/* 的 run token 正交，不能互相替代。
   */
  resolveControlPrincipal?: ControlPrincipalResolver;
  /**
   * 把 CLI run-mission 接到持锁服务。不注入则 POST /api/control/run-mission 明确拒绝：
   * 否则调用方会把「没人接」当成已经开跑。
   */
  runMission?: HostedRunHandler;
  /** 同上，对应 POST /api/control/run-plan。 */
  runPlan?: HostedRunHandler;
  /**
   * 读运行时模型清单。缺省走适配层真实命令。
   *
   * 为什么可注入：清单要等适配层约数秒，测试不能真等；缓存命中 / 过期 / 失败重试
   * 必须用假函数数调用次数。不注入不得改默认路径，否则页面拿到的就不是适配层真相。
   */
  listRuntimeModels?: () => Promise<RuntimeCatalog>;
  /**
   * 模型清单缓存用的时钟（epoch ms）。缺省 Date.now。
   *
   * 为什么单独注入、不复用 Platform 的 Clock：缓存只属于这一份 HTTP 服务实例，
   * 和领域时间无关；测试要把有效期拨过 10 分钟而不拨业务时钟。
   */
  now?: () => number;
  /**
   * 方案运行记录目录。缺省 `resolve('.coagent-plans')`，给独立 createApi 实例用。
   * 常驻服务的状态文件旁目录与 hosted `--run-dir` 由装配方注入；这里不猜 main 的路径，
   * 否则独立实例和测试会去读装配环境的目录。
   */
  planRunDirs?: () => readonly string[];
  /**
   * 托管方案 CLI 行的内存游标。不注入则 GET live 仍 200，chunks 空并带 reason——
   * 独立 createApi / 无 hosted 回调的测试不能因此 404 把观测面打崩。
   */
  planLive?: PlanRunLiveOutput;
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'BAD_JSON', '请求体不是合法 JSON');
  }
}

/**
 * 显式 Bundle 预算。缺省 = 不裁；只接受十进制非负安全整数。
 * 1e2 / 01 / -1 若被 Number() 吞掉，调用方分不清「没裁」和「裁过」。
 */
function parseBriefBudget(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  if (!/^(0|[1-9]\d*)$/.test(raw)) {
    throw new HttpError(400, 'INVALID_BUDGET', 'budget 必须是非负安全整数');
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) {
    throw new HttpError(400, 'INVALID_BUDGET', 'budget 必须是非负安全整数');
  }
  return n;
}

/**
 * 成功 JSON 先记在这里，等 onMutation 完成再 writeHead。
 * 若 send() 当时就写头，落盘失败时客户端已经拿到 2xx，无法改口。
 */
const deferredJson = new WeakMap<ServerResponse, { status: number; body: unknown }>();

function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  identity?: { readonly instanceId: string; readonly stateId: string },
): void {
  if (res.headersSent || res.writableEnded) {
    // 头已经出去就不要假装还能改状态码：拆掉连接，让调用方把结果当成不确定。
    res.destroy();
    return;
  }
  const payload = JSON.stringify(body ?? {});
  const headers: Record<string, number | string> = {
    'x-coagent-api': API_VERSION,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  };
  if (identity) {
    headers['x-coagent-instance'] = identity.instanceId;
    headers['x-coagent-state-id'] = identity.stateId;
  }
  res.writeHead(status, headers);
  res.end(payload);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  deferredJson.set(res, { status, body });
}

function writeNdjsonHeaders(
  res: ServerResponse,
  identity?: { readonly instanceId: string; readonly stateId: string },
): void {
  if (res.headersSent || res.writableEnded) return;
  const headers: Record<string, string> = {
    'x-coagent-api': API_VERSION,
    'content-type': 'application/x-ndjson; charset=utf-8',
  };
  if (identity) {
    headers['x-coagent-instance'] = identity.instanceId;
    headers['x-coagent-state-id'] = identity.stateId;
  }
  res.writeHead(200, headers);
}

function writeNdjsonEvent(res: ServerResponse, event: Record<string, unknown>): void {
  if (res.writableEnded || res.destroyed || !res.writable) return;
  try {
    res.write(`${JSON.stringify(event)}\n`);
  } catch {
    // 回传失败不得冒泡：断线 CLI 不能把已接受 job 的终态写成未处理异常。
  }
}

function endNdjson(res: ServerResponse): void {
  if (res.writableEnded || res.destroyed) return;
  try {
    res.end();
  } catch {
    // 同上：end 失败只表示客户端已经走了。
  }
}

/**
 * createApi 返回的 server 的排空入口。不用挂在 Server 实例上，免得污染 node:http 类型。
 * 后续 close 包装先 drain，再停周期 tick / persist / close。
 */
const apiGates = new WeakMap<Server, { drain: () => Promise<void> }>();

export function drainApi(server: Server): Promise<void> {
  const gate = apiGates.get(server);
  if (!gate) return Promise.resolve();
  return gate.drain();
}

/**
 * 用已读到的 PlanRun.features.missionIds 消歧 featureId。
 * 不改其它字段；对不上就保持 Platform 按 id 前缀投影的结果。
 */
function refineMissionPlanOrigin(rows: MissionSummary[], runs: readonly PlanRunListItem[]): MissionSummary[] {
  const byId = new Map<string, Extract<PlanRunListItem, { planId: string }>>();
  for (const item of runs) {
    if (Object.hasOwn(item, 'error')) continue;
    byId.set(item.id, item as Extract<PlanRunListItem, { planId: string }>);
  }
  return rows.map((row) => {
    if (row.planRunId === undefined) return row;
    const run = byId.get(row.planRunId);
    if (!run) return row;
    const hits = run.features.filter((feature) => feature.missionIds.includes(row.missionId));
    if (hits.length !== 1) return row;
    const featureId = hits[0]?.featureId;
    if (featureId === undefined || featureId === row.featureId) return row;
    return { ...row, featureId };
  });
}

function publicPlanLiveChunk(chunk: PlanLiveChunk): {
  readonly seq: number;
  readonly at: string;
  readonly channel: PlanLiveChunk['channel'];
  readonly line: string;
} {
  return { seq: chunk.seq, at: chunk.at, channel: chunk.channel, line: chunk.line };
}

/**
 * 方案 live 只读体。空必须说明原因：记录文件在、缓冲空（未托管 / 重启）时
 * 客户端不能把空白终端当成「还没吐第一行」。
 */
function planLiveResponse(
  planLive: PlanRunLiveOutput | undefined,
  runId: string,
  cursor: number,
): { cursor: number; chunks: ReturnType<typeof publicPlanLiveChunk>[]; reason?: string } {
  const chunks = planLive ? planLive.since(runId, cursor).map(publicPlanLiveChunk) : [];
  const body: {
    cursor: number;
    chunks: ReturnType<typeof publicPlanLiveChunk>[];
    reason?: string;
  } = {
    cursor: chunks.at(-1)?.seq ?? cursor,
    chunks,
  };
  if (chunks.length === 0 && (!planLive || !planLive.hosted(runId))) {
    body.reason = PLAN_LIVE_EMPTY_REASON;
  }
  return body;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function inapplicable(reason: string): { readonly inapplicable: true; readonly reason: string } {
  return { inapplicable: true, reason };
}

function listenObservation(server: Server): { address: string; port: number } | { inapplicable: true; reason: string } {
  const addr = server.address();
  if (!addr || typeof addr === 'string') return inapplicable('listen_address_unavailable');
  return { address: addr.address, port: addr.port };
}

function assembledOrInapplicable<T>(value: T | undefined, reason: string): T | { inapplicable: true; reason: string } {
  return value !== undefined ? value : inapplicable(reason);
}

function circuitHealth(circuit: CandidateCircuit): Exclude<AgentPoolCandidateHealth['circuit'], { state: 'unknown' }> {
  if (circuit.state === 'closed') return { state: 'closed' };
  if (circuit.state === 'open') {
    return { state: 'open', failureClass: circuit.failureClass, openUntil: circuit.openUntil };
  }
  return {
    state: 'half_open',
    failureClass: circuit.failureClass,
    openUntil: circuit.openUntil,
    probeClaimed: true,
  };
}

function runtimeHealth(lease: QueuedHop | undefined): AgentPoolCandidateHealth['runtime'] {
  if (!lease) return { running: false, reason: 'no_active_lease' };
  if (typeof lease.runtimeKind !== 'string' || lease.runtimeKind.length === 0) {
    return { running: false, reason: 'active_lease_missing_runtime_kind' };
  }
  return { running: true, hopId: lease.id, runtimeKind: lease.runtimeKind };
}

function attemptIdsFromMissionView(view: {
  readonly coordinatorAttemptIds?: readonly string[];
  readonly independentReviewerAttemptIds?: readonly string[];
  readonly workItems?: readonly { readonly attemptIds?: readonly string[] }[];
}): string[] {
  const ids = [
    ...(view.coordinatorAttemptIds ?? []),
    ...(view.independentReviewerAttemptIds ?? []),
  ];
  for (const item of view.workItems ?? []) {
    if (item.attemptIds) ids.push(...item.attemptIds);
  }
  return ids;
}

interface CandidateUsageAcc {
  attempts: number;
  successes: number;
  reportedCost: number | null;
}

async function collectCandidateObservations(
  platform: Platform,
  hops: readonly QueuedHop[],
  nowMs: number,
): Promise<{
  hints: Map<string, CandidateFailureHint[]>;
  usage: Map<string, CandidateUsageAcc>;
}> {
  const hints = new Map<string, CandidateFailureHint[]>();
  const usage = new Map<string, CandidateUsageAcc>();
  const pushHint = (profileId: string, hint: CandidateFailureHint): void => {
    const list = hints.get(profileId) ?? [];
    list.push(hint);
    hints.set(profileId, list);
  };
  for (const hop of hops) {
    if (typeof hop.profileId !== 'string' || hop.profileId.length === 0) continue;
    const last = hop.lastFailure;
    if (!last) continue;
    pushHint(hop.profileId, {
      failureClass: last.classification,
      at: last.at,
      source: 'queue',
    });
  }
  let missions: Awaited<ReturnType<Platform['listMissions']>>;
  try {
    missions = await platform.listMissions();
  } catch {
    return { hints, usage };
  }
  const windowStart = nowMs - SEVEN_DAYS_MS;
  for (const row of missions) {
    let view: Awaited<ReturnType<Platform['getMissionView']>>;
    let events: Awaited<ReturnType<Platform['getActivity']>>;
    try {
      view = await platform.getMissionView(row.missionId);
      events = await platform.getActivity(row.missionId);
    } catch {
      continue;
    }
    const atByAttempt = new Map<string, number>();
    for (const event of events) {
      if (typeof event.attemptId !== 'string' || event.attemptId.length === 0) continue;
      const ts = Date.parse(event.at);
      if (!Number.isFinite(ts)) continue;
      if (event.kind === 'attempt.started' || event.kind === 'attempt.ended') {
        const prev = atByAttempt.get(event.attemptId);
        if (prev === undefined || ts > prev) atByAttempt.set(event.attemptId, ts);
      }
    }
    for (const attemptId of attemptIdsFromMissionView(view)) {
      let detail: Awaited<ReturnType<Platform['getAttemptDetail']>>;
      try {
        detail = await platform.getAttemptDetail(row.missionId, attemptId);
      } catch {
        continue;
      }
      const profileId = detail.profile?.profileId;
      if (typeof profileId !== 'string' || profileId.length === 0) continue;
      const ended = events.find((event) => event.kind === 'attempt.ended' && event.attemptId === attemptId);
      if (ended) {
        const data = ended.data;
        const endedBy =
          data !== null && typeof data === 'object' && !Array.isArray(data)
            ? (data as { endedBy?: unknown }).endedBy
            : undefined;
        const failureMessage =
          data !== null && typeof data === 'object' && !Array.isArray(data)
            ? (data as { failureMessage?: unknown }).failureMessage
            : undefined;
        if (typeof endedBy === 'string') {
          const classified = classifyCandidateFailure(
            endedBy as AttemptEndReason,
            typeof failureMessage === 'string' ? failureMessage : undefined,
          );
          if (classified) {
            pushHint(profileId, {
              failureClass: classified.failureClass,
              at: ended.at,
              source: 'attempt.ended',
            });
          }
        }
      }
      const at = atByAttempt.get(attemptId);
      if (at === undefined || at < windowStart || at > nowMs) continue;
      const acc = usage.get(profileId) ?? { attempts: 0, successes: 0, reportedCost: null };
      acc.attempts += 1;
      if (detail.status === 'succeeded') acc.successes += 1;
      const cost = detail.usage?.cost;
      if (detail.usage?.quality === 'reported' && typeof cost === 'number' && Number.isFinite(cost)) {
        acc.reportedCost = (acc.reportedCost ?? 0) + cost;
      }
      usage.set(profileId, acc);
    }
  }
  return { hints, usage };
}

function emptyUsage(): CandidateUsageAcc {
  return { attempts: 0, successes: 0, reportedCost: null };
}

async function buildPoolsHealth(
  platform: Platform,
  snapshot: Awaited<ReturnType<AgentPoolRepository['list']>>,
  queuedHops: QueuedHopRepository | undefined,
  candidateCircuits: CandidateCircuitRepository | undefined,
  nowMsValue: number,
) {
  const hops = queuedHops ? await queuedHops.list() : [];
  const nowIso = new Date(nowMsValue).toISOString();
  const observed = await collectCandidateObservations(platform, hops, nowMsValue);
  const healthOf = async (candidate: AgentPoolCandidate): Promise<AgentPoolCandidateHealth> => {
    const lease = activeLeaseForProfile(hops, candidate.profileId, nowIso);
    const hints = observed.hints.get(candidate.profileId) ?? [];
    const window7d = observed.usage.get(candidate.profileId) ?? emptyUsage();
    const runtime = queuedHops
      ? runtimeHealth(lease)
      : { running: false as const, reason: 'queued_hops_unavailable' };
    if (!candidateCircuits) {
      return {
        circuit: { state: 'unknown', reason: 'candidate_circuits_unavailable' },
        lastFailure: resolveCandidateLastFailure(closedCandidateCircuit(candidate.profileId), hints),
        window7d,
        runtime,
      };
    }
    const circuit = await candidateCircuits.get(candidate.profileId);
    return {
      circuit: circuitHealth(circuit),
      lastFailure: resolveCandidateLastFailure(circuit, hints),
      window7d,
      runtime,
    };
  };
  const attach = async (rows: readonly AgentPoolCandidate[]) => {
    const out = [];
    for (const row of rows) out.push({ ...row, health: await healthOf(row) });
    return out;
  };
  return {
    coordinator: await attach(snapshot.coordinator),
    executor: await attach(snapshot.executor),
    independent_reviewer: await attach(snapshot.independent_reviewer),
  };
}

export function createApi(deps: ApiDeps): Server {
  const { platform, tokens, deliveries, onMutation, beforeRead, resolveControlPrincipal } = deps;
  const planRunDirs = deps.planRunDirs ?? (() => [resolve('.coagent-plans')]);
  const planLive = deps.planLive;
  const live: LiveOutput = deps.live ?? new NoLiveOutput();
  const agentPool: AgentPoolRepository = deps.agentPool ?? new InMemoryAgentPoolRepository();
  const listModels = deps.listRuntimeModels ?? listRuntimeModels;
  const nowMs = deps.now ?? Date.now;
  /** 成功清单按实例缓存。失败不进这里——否则一次适配层故障会锁死 10 分钟旧错误。 */
  let cachedRuntimeCatalog: { readonly at: number; readonly catalog: RuntimeCatalog } | undefined;

  const requireRun = (req: IncomingMessage): RunContext => {
    const header = req.headers['x-coagent-run'];
    const token = Array.isArray(header) ? header[0] : header;
    const context = tokens.resolve(token);
    if (!context) {
      throw new HttpError(401, 'UNKNOWN_RUN_TOKEN', 'x-coagent-run 缺失或已失效');
    }
    return context;
  };

  /**
   * 可选控制面门禁：未注入 resolver 直接放行，保持本地/既有调用兼容。
   * 注入后先解析身份再求 PolicyEngine：缺失/未知 401，过期 401，其余拒绝 403。
   * HTTP 状态码与文案与接线前一致。错误体不得带回原始凭据。
   */
  const requireControl = async (req: IncomingMessage, action: PolicyAction): Promise<void> => {
    if (!resolveControlPrincipal) return;
    const resolved = await resolveControlPrincipal(req);
    const verdict = evaluatePolicy({
      principal: principalFromControl(resolved),
      action,
    });
    if (verdict.decision === 'allow') return;
    if (verdict.reason.code === POLICY_REASON.PRINCIPAL_MISSING) {
      throw new HttpError(401, 'CONTROL_UNAUTHORIZED', '控制面凭据缺失或未知');
    }
    if (verdict.reason.code === POLICY_REASON.PRINCIPAL_EXPIRED) {
      throw new HttpError(401, 'CONTROL_EXPIRED', '控制面凭据已过期');
    }
    throw new HttpError(403, 'CONTROL_FORBIDDEN', '当前身份无权执行此操作');
  };

  /**
   * agent 工具在 Run Token 解析之后求策略。角色对错仍让 Platform 抛出原
   * WRONG_ROLE 文案（除作废工单这条本来就在 HTTP 层）。绑定不匹配在这里挡。
   */
  const enforceAgentPolicy = (run: RunContext, action: PolicyAction): void => {
    const verdict = evaluatePolicy({
      principal: principalFromRun(run),
      action,
      context: {
        missionId: run.missionId,
        attemptId: run.attemptId,
        ...(run.workItemId !== undefined ? { workItemId: run.workItemId } : {}),
      },
    });
    if (verdict.decision === 'allow') return;
    if (verdict.reason.code === POLICY_REASON.ACTION_DENIED) {
      if (action.scope === 'workItem' && action.name === 'retire') {
        throw new HttpError(409, 'WRONG_ROLE', '只有协调者能作废工作项。');
      }
      // 协调者 / 执行者保留「让 Platform 抛 WRONG_ROLE」的旧错误码。
      // 新身份不能走这条兼容回退，否则 ACTION_DENIED 会被当成放行。
      if (run.role === 'independent_reviewer') {
        throw new HttpError(403, 'ACTION_DENIED', verdict.reason.detail);
      }
      return;
    }
    if (verdict.reason.code === POLICY_REASON.BINDING_MISMATCH) {
      if (!run.workItemId && action.scope === 'workItem' && action.name === 'getOrder') {
        throw new HttpError(409, 'ATTEMPT_NOT_BOUND', '本次运行没有绑定工作项');
      }
      throw new HttpError(409, 'WRONG_ROLE', '本次运行绑定的 Mission / Attempt / WorkItem 与动作不一致');
    }
    throw new HttpError(409, 'WRONG_ROLE', verdict.reason.detail);
  };

  const requireWorkItem = (run: RunContext): string => {
    if (!run.workItemId) {
      throw new HttpError(409, 'ATTEMPT_NOT_BOUND', '本次运行没有绑定工作项');
    }
    return run.workItemId;
  };

  /** 每个工具一个 handler。handler 里没有规则，规则都在 Platform。 */
  const agentTools: Record<
    string,
    (run: RunContext, body: Record<string, never>) => Promise<unknown>
  > = {
    async coagent_get_mission(run) {
      return platform.getMissionView(run.missionId);
    },

    async coagent_get_contract(run) {
      return platform.getContract(run.missionId);
    },

    async coagent_update_findings(run, body) {
      const { findings, rejectedHypotheses } = body as unknown as {
        findings: string;
        rejectedHypotheses?: string[];
      };
      return platform.updateFindings(
        run.missionId,
        run.attemptId,
        findings,
        rejectedHypotheses,
        run.claim,
      );
    },

    async coagent_update_plan(run, body) {
      return platform.updatePlan(run.missionId, run.attemptId, body as never, run.claim);
    },

    async coagent_create_work_item(run, body) {
      const { title, ...order } = body as unknown as { title: string };
      return platform.createWorkItem(
        run.missionId,
        run.attemptId,
        {
          title,
          order: order as never,
        },
        run.claim,
      );
    },

    async coagent_retire_work_item(run, body) {
      const { workItemId, reason } = body as unknown as {
        workItemId: string;
        reason: string;
      };
      // 只有协调者能作废：S14.6 说 cancel-replace 是 L2 的判断。
      // 执行者要是能作废自己手上的工单，"做不完就把它作废掉"会变成一条捷径。
      // 角色闸在入口 PolicyEngine（WRONG_ROLE 文案与原来一致）。
      return platform.retireWorkItem(run.missionId, workItemId, reason);
    },

    async coagent_dispatch_work_item(run, body) {
      const { workItemIds } = body as unknown as { workItemIds: string[] };
      return platform.dispatchWorkItems(run.missionId, run.attemptId, workItemIds ?? [], run.claim);
    },

    async coagent_review_execution_result(run, body) {
      return platform.reviewExecutionResult(run.missionId, run.attemptId, body as never, run.claim);
    },

    async coagent_escalate_to_l3(run, body) {
      await platform.escalateToL3(run.missionId, run.attemptId, body as never, run.claim);
      return {};
    },

    async coagent_submit_mission_result(run, body) {
      await platform.submitMissionResult(run.missionId, run.attemptId, body as never, run.claim);
      return {};
    },

    async coagent_get_project_context(run, body) {
      const { slug } = body as unknown as { slug?: string };
      return platform.getProjectContext(run.missionId, slug);
    },

    async coagent_get_work_order(run) {
      return platform.getWorkOrder(run.missionId, requireWorkItem(run));
    },

    async coagent_get_context(run, body) {
      const { ref } = body as unknown as { ref: string };
      return platform.getContext(run.missionId, run.attemptId, ref);
    },

    async coagent_submit_evidence(run, body) {
      return platform.submitEvidence(run.missionId, run.attemptId, body as never, run.claim);
    },

    async coagent_submit_execution_result(run, body) {
      return platform.submitExecutionResult(run.missionId, run.attemptId, body as never, run.claim);
    },

    async coagent_report_blocked(run, body) {
      await platform.reportBlocked(run.missionId, run.attemptId, body as never, run.claim);
      return {};
    },

    async coagent_get_mission_review_bundle(run) {
      return platform.getMissionReviewBundle(run.missionId, run.attemptId);
    },

    async coagent_submit_independent_review(run, body) {
      const { verdict, reasons } = body as unknown as {
        verdict: unknown;
        reasons: unknown;
      };
      return platform.submitIndependentReview(
        run.missionId,
        run.attemptId,
        {
          verdict,
          reasons,
        },
        run.claim,
      );
    },
  };

  const identity = deps.identity;

  let shuttingDown = false;
  let inFlightWrites = 0;
  let inFlightRuns = 0;
  const drainWaiters: Array<() => void> = [];

  const notifyDrain = (): void => {
    if (!shuttingDown || inFlightWrites > 0 || inFlightRuns > 0) return;
    while (drainWaiters.length > 0) {
      const waiter = drainWaiters.pop();
      if (waiter) waiter();
    }
  };

  const drainGate = (): Promise<void> => {
    shuttingDown = true;
    if (inFlightWrites === 0 && inFlightRuns === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      drainWaiters.push(resolve);
    });
  };

  const server = createServer((req, res) => {
    const isPost = (req.method ?? 'GET') === 'POST';
    if (isPost) inFlightWrites += 1;
    void handle(req, res)
      .then(async () => {
        // 成功应答必须在 onMutation 完成之后才 writeHead。先写头再 persist，
        // 落盘失败时客户端已经拿到 2xx，无法改成非 2xx。
        // **要 await**：即发即忘的话写冲突会变成 unhandledRejection，调用方只看到断连。
        if (req.method === 'POST' && onMutation && deferredJson.has(res)) {
          try {
            await onMutation();
          } catch (error) {
            deferredJson.delete(res);
            throw new HttpError(
              500,
              'PERSIST_FAILED',
              error instanceof Error
                ? `落盘失败，本次写入结果不确定：${error.message}`
                : '落盘失败，本次写入结果不确定',
            );
          }
        }
        const pending = deferredJson.get(res);
        if (pending) {
          deferredJson.delete(res);
          writeJson(res, pending.status, pending.body, identity);
        }
      })
      .catch((error) => {
      if (error instanceof HttpError) {
        writeJson(res, error.status, { error: error.code, message: error.message }, identity);
      } else if (error instanceof ClassifiedMissionInputError) {
        writeJson(res, 400, { error: error.code, message: error.message }, identity);
      } else if (error instanceof PlatformRuleError) {
        // 409：请求本身合法，是当前状态不允许。工具会把 message 原样回给模型，
        // 所以 message 必须写成「下一步该干什么」，不是一句 invalid state。
        writeJson(res, 409, { error: error.code, message: error.message }, identity);
      } else if (error instanceof AgentPoolError) {
        // 与 PlatformRuleError 同构：请求本身合法，是当前候选池容不下它。
        // 界面要把 message 原样显示出来，所以那里写的就是「下一步该干什么」。
        writeJson(res, 409, { error: error.code, message: error.message }, identity);
      } else if (error instanceof KernelError) {
        writeJson(res, 409, { error: error.code, message: error.message }, identity);
      } else {
        writeJson(
          res,
          500,
          {
            error: 'INTERNAL',
            message: error instanceof Error ? error.message : String(error),
          },
          identity,
        );
      }
      })
      .finally(() => {
        if (!isPost) return;
        inFlightWrites -= 1;
        notifyDrain();
      });
  });
  apiGates.set(server, { drain: drainGate });
  return server;

  async function startHostedRun(
    req: IncomingMessage,
    res: ServerResponse,
    handler: HostedRunHandler | undefined,
    kind: 'run-mission' | 'run-plan',
  ): Promise<void> {
    await requireControl(req, POLICY_ACTION.missionCreate);
    if (!handler) {
      throw new HttpError(501, 'HOSTED_RUN_UNAVAILABLE', `本服务未配置 hosted ${kind}`);
    }
    if (shuttingDown) {
      throw new HttpError(503, 'SERVICE_DRAINING', '服务正在关闭，拒绝新的 hosted 启动');
    }
    const body = await readJson(req);
    // 读 body 期间可能已经开始 drain；接受 job 之前再看一次。
    if (shuttingDown) {
      throw new HttpError(503, 'SERVICE_DRAINING', '服务正在关闭，拒绝新的 hosted 启动');
    }
    inFlightRuns += 1;
    let terminalSent = false;
    let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
    const stopHeartbeat = (): void => {
      if (heartbeatTimer === undefined) return;
      clearTimeout(heartbeatTimer);
      heartbeatTimer = undefined;
    };
    const armHeartbeat = (): void => {
      stopHeartbeat();
      heartbeatTimer = setTimeout(() => {
        heartbeatTimer = undefined;
        if (terminalSent || res.writableEnded || res.destroyed) return;
        writeNdjsonEvent(res, { heartbeat: true });
        armHeartbeat();
      }, HOSTED_RUN_HEARTBEAT_IDLE_MS);
    };
    const emit: HostedRunEmit = (channel, line) => {
      if (terminalSent) return;
      writeNdjsonEvent(res, { channel, line });
      armHeartbeat();
    };
    res.on('error', () => {
      // 断线只丢掉回传通道。已接受的 job 继续，终态写失败也不能变成未处理异常。
    });
    try {
      // 长流期间关掉套接字空闲超时。不这么做，服务端 keepAlive 5s 会在等决定时拆连接。
      req.socket?.setTimeout(0);
      writeNdjsonHeaders(res, identity);
      armHeartbeat();
    } catch {
      // 头写不出也不取消 job：接受已经发生。
    }
    let exitCode = 1;
    try {
      const code = await handler(body, emit);
      exitCode = typeof code === 'number' && Number.isFinite(code) ? code : 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emit('stderr', message);
      exitCode = 1;
    } finally {
      terminalSent = true;
      stopHeartbeat();
      writeNdjsonEvent(res, { exitCode });
      endNdjson(res);
      inFlightRuns -= 1;
      notifyDrain();
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    if (method === 'GET' && beforeRead && path.startsWith('/api/')) await beforeRead();

    if (method === 'GET' && path === '/api/health') {
      return send(res, 200, { ok: true, api: API_VERSION });
    }

    // S12.1：客户端 API 带版本。所有客户端（Web / L3 CLI / 别的 Host）
    // 走同一套，没有谁是特权客户端。
    if (method === 'GET' && path === '/api/version') {
      return send(res, 200, { api: API_VERSION });
    }

    if (method === 'GET' && path === '/api/platform/status') {
      await requireControl(req, POLICY_ACTION.missionRead);
      const assembled = deps.platformStatus;
      const nowIso = new Date(nowMs()).toISOString();
      let queue: unknown = inapplicable('queued_hops_unavailable');
      let occupancy: unknown = inapplicable('queued_hops_unavailable');
      if (deps.queuedHops) {
        const hops = await deps.queuedHops.list();
        queue = {
          counts: countQueuedHopStatuses(hops),
          deadLetters: summarizeDeadLetters(hops),
        };
        occupancy = activeHopOccupancy(
          hops,
          nowIso,
          assembled?.capacityLimits ?? DEFAULT_HOP_CAPACITY_LIMITS,
        );
      }
      const httpServer = (req.socket as { server?: Server }).server;
      const listen = httpServer ? listenObservation(httpServer) : inapplicable('listen_address_unavailable');
      return send(
        res,
        200,
        redactSecretsDeep({
          api: API_VERSION,
          pid: process.pid,
          startedAt: assembledOrInapplicable(assembled?.startedAt, 'started_at_not_assembled'),
          listen,
          store: assembledOrInapplicable(assembled?.store, 'store_not_assembled'),
          instanceId: assembledOrInapplicable(assembled?.instanceId, assembled?.store === 'pg'
            ? 'pg_has_no_file_instance_lock'
            : assembled?.store === 'memory'
              ? 'memory_has_no_file_instance_lock'
              : 'instance_id_not_assembled'),
          statePath: assembledOrInapplicable(assembled?.statePath, assembled?.store === 'pg'
            ? 'pg_has_no_state_file'
            : assembled?.store === 'memory'
              ? 'memory_has_no_state_file'
              : 'state_path_not_assembled'),
          holdsMainLock: assembledOrInapplicable(assembled?.holdsMainLock, assembled?.store === 'pg'
            ? 'pg_has_no_file_main_lock'
            : assembled?.store === 'memory'
              ? 'memory_has_no_file_main_lock'
              : 'main_lock_not_assembled'),
          queue,
          occupancy,
          agentEnv: assembledOrInapplicable(assembled?.agentEnv, 'agent_env_not_assembled'),
          defaultAdapter: assembledOrInapplicable(assembled?.defaultAdapter, 'default_adapter_not_assembled'),
        }),
      );
    }

    // S11.5：用量报表。projectId / missionId 可选，用来收窄范围。
    if (method === 'GET' && path === '/api/usage') {
      await requireControl(req, POLICY_ACTION.missionRead);
      return send(
        res,
        200,
        await platform.getUsage({
          projectId: url.searchParams.get('projectId') ?? undefined,
          missionId: url.searchParams.get('missionId') ?? undefined,
        }),
      );
    }

    // 可用模型清单。平台自己不认识模型——这里只是把适配层吐的 JSON 转出去。
    if (method === 'GET' && path === '/api/runtime/models') {
      await requireControl(req, POLICY_ACTION.missionRead);
      const hit = cachedRuntimeCatalog;
      if (hit && nowMs() - hit.at < RUNTIME_MODELS_CACHE_MS) {
        return send(res, 200, hit.catalog);
      }
      const catalog = await listModels();
      if (catalog.available === true) {
        cachedRuntimeCatalog = { at: nowMs(), catalog };
      }
      return send(res, 200, catalog);
    }

    if (method === 'GET' && path === '/api/projects') {
      await requireControl(req, POLICY_ACTION.missionRead);
      return send(res, 200, await platform.listProjects());
    }

    /* ---- 候选池（资源池页的原料）。只有列与追加两个动作 ---- */

    // 没有 DELETE / PATCH / PUT，也没有播种：GET 只读且受 control-read 门禁；
    // 「打开界面看一眼」不会改写候选池配置。
    if (method === 'GET' && path === '/api/pools') {
      await requireControl(req, POLICY_ACTION.poolList);
      const snapshot = await agentPool.list();
      return send(
        res,
        200,
        redactSecretsDeep(
          await buildPoolsHealth(
            platform,
            snapshot,
            deps.queuedHops,
            deps.candidateCircuits,
            nowMs(),
          ),
        ),
      );
    }

    if (method === 'POST' && path === '/api/pools') {
      await requireControl(req, POLICY_ACTION.poolAdd);
      const body = await readJson(req);
      const input: AgentPoolAddInput = body as unknown as AgentPoolAddInput;
      const added = await agentPool.add(input);
      // add 能返回就说明 role 已过校验，回显它才不会与请求里那个是两个字。
      return send(res, 201, { role: input.role, ...added });
    }

    // 正式 Web 端：src/web/ 下的无构建静态文件（ADR-0001）。
    // 只读——放行/打回走 src/l3.ts，规则只该有一份实现。
    if (method === 'GET' && serveStatic(path, res, deps.webRoot)) return;

    // 回退到内置的单页观测面。
    //
    // 留着它不是懒得删：`src/web/` 还没铺好、或者被谁删了的时候，
    // 平台至少还能自证还活着。丢了这条路，一个空目录会表现成整个平台挂了。
    if (method === 'GET' && (path === '/' || path === '/index.html')) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(WEB_PAGE);
      return;
    }

    if (method === 'GET' && path === '/api/plan-runs') {
      await requireControl(req, POLICY_ACTION.missionRead);
      const project = url.searchParams.get('project');
      return send(res, 200, listPlanRuns(planRunDirs(), project === null ? undefined : project));
    }

    const planRunMatch = /^\/api\/plan-runs\/([^/]+)$/.exec(path);
    if (method === 'GET' && planRunMatch) {
      await requireControl(req, POLICY_ACTION.missionRead);
      const id = planRunMatch[1];
      const result = readPlanRunById(planRunDirs(), id);
      if (result.status === 'missing') {
        throw new HttpError(
          404,
          'PLAN_RUN_NOT_FOUND',
          isSafePlanRunId(id) ? `没有方案运行记录：${id}` : '没有方案运行记录',
        );
      }
      if (result.status === 'corrupt') {
        throw new HttpError(409, 'PLAN_RUN_CORRUPT', result.error);
      }
      return send(res, 200, result.snapshot);
    }

    const planRunLiveMatch = /^\/api\/plan-runs\/([^/]+)\/live$/.exec(path);
    if (method === 'GET' && planRunLiveMatch) {
      await requireControl(req, POLICY_ACTION.missionRead);
      const id = planRunLiveMatch[1];
      if (!isSafePlanRunId(id)) {
        throw new HttpError(404, 'PLAN_RUN_NOT_FOUND', '没有方案运行记录');
      }
      const cursor = Number(url.searchParams.get('cursor') ?? 0);
      return send(res, 200, planLiveResponse(planLive, id, Number.isFinite(cursor) ? cursor : 0));
    }

    if (method === 'GET' && path === '/api/missions') {
      await requireControl(req, POLICY_ACTION.missionRead);
      const rows = await platform.listMissions();
      return send(res, 200, refineMissionPlanOrigin(rows, listPlanRuns(planRunDirs())));
    }

    const activityMatch = /^\/api\/missions\/([^/]+)\/activity$/.exec(path);
    if (method === 'GET' && activityMatch) {
      await requireControl(req, POLICY_ACTION.missionRead);
      return send(res, 200, await platform.getActivity(activityMatch[1]));
    }

    // 实时输出：游标轮询。
    //
    // 没用 SSE 是想清楚的：生产者（调度器）在另一个进程，服务端拿到新内容
    // 本来就得去存储里取，SSE 只是把「谁来轮询」换了个位置，延迟省不了多少。
    // 而游标轮询天然能续——刷新页面、断线重连都从上次的位置接上，
    // SSE 这些都得自己处理。
    const liveMatch = /^\/api\/missions\/([^/]+)\/live$/.exec(path);
    if (method === 'GET' && liveMatch) {
      await requireControl(req, POLICY_ACTION.missionRead);
      const cursor = Number(url.searchParams.get('cursor') ?? 0);
      const chunks = await live.since(liveMatch[1], Number.isFinite(cursor) ? cursor : 0);
      return send(res, 200, {
        // 没有新内容时把游标原样回去，客户端不用判空。
        cursor: chunks.at(-1)?.seq ?? cursor,
        chunks,
      });
    }

    // attempt id 里带点（W-1.exec-1），所以尾段用 (.+) 而不是 ([^/]+)。
    const attemptMatch = /^\/api\/missions\/([^/]+)\/attempts\/(.+)$/.exec(path);
    if (method === 'GET' && attemptMatch) {
      await requireControl(req, POLICY_ACTION.attemptGetDetail);
      return send(res, 200, await platform.getAttemptDetail(attemptMatch[1], attemptMatch[2]));
    }

    // 开跑简报（S09.1）。**不是工具**——它是适配层在模型开口之前自己取的，
    // 模型不该有"要不要看架构红线"这个选择。身份同样来自 run token。
    if (method === 'GET' && path === '/api/run/brief') {
      const run = requireRun(req);
      enforceAgentPolicy(run, POLICY_ACTION.attemptGetBrief);
      // 未提供不裁剪；非法值在这里 400，否则构造器抛 Error 会变成 500 INTERNAL。
      const budget = parseBriefBudget(url.searchParams.get('budget'));
      return send(
        res,
        200,
        await platform.getStartupBrief(run.missionId, run.attemptId, budget, run.claim),
      );
    }

    if (path.startsWith('/api/agent/')) {
      if (method !== 'POST') throw new HttpError(405, 'METHOD', '只接受 POST');
      const tool = path.slice('/api/agent/'.length);
      const handler = agentTools[tool];
      if (!handler) throw new HttpError(404, 'UNKNOWN_TOOL', `没有这个工具：${tool}`);
      const run = requireRun(req);
      const action = AGENT_TOOL_ACTION[tool];
      if (!action) throw new HttpError(404, 'UNKNOWN_TOOL', `没有这个工具：${tool}`);
      enforceAgentPolicy(run, action);
      // agent 交进来的一切（证据、结果、评审、交卷、工单）都从这一个口进来，在这里整体脱敏一次：
      // 它跑过 `env` 或 `cat .env` 的话，输出就在证据里。
      const body = redactSecretsDeep(await readJson(req));
      return send(res, 200, await handler(run, body as Record<string, never>));
    }

    if (method === 'POST' && path === '/api/missions') {
      await requireControl(req, POLICY_ACTION.missionCreate);
      const body = await readJson(req);
      return send(res, 201, await platform.createMission(body as never));
    }

    if (method === 'POST' && path === '/api/missions/classified') {
      await requireControl(req, POLICY_ACTION.missionCreateClassified);
      const body = await readJson(req);
      return send(res, 201, await platform.createClassifiedMission(body as never));
    }

    const missionMatch = /^\/api\/missions\/([^/]+)$/.exec(path);
    if (method === 'GET' && missionMatch) {
      await requireControl(req, POLICY_ACTION.missionRead);
      return send(res, 200, await platform.getMissionView(missionMatch[1]));
    }

    /* ---- L3 面：最终检视 ---- */

    const diffMatch = /^\/api\/missions\/([^/]+)\/diff$/.exec(path);
    if (method === 'GET' && diffMatch) {
      await requireControl(req, POLICY_ACTION.missionRead);
      return send(res, 200, await platform.getMissionDiff(diffMatch[1]));
    }


    const answerMatch = /^\/api\/missions\/([^/]+)\/escalations\/answer$/.exec(path);
    if (method === 'POST' && answerMatch) {
      await requireControl(req, POLICY_ACTION.missionAnswerEscalation);
      const body = await readJson(req);
      return send(res, 200, await platform.answerEscalation(answerMatch[1], String(body.answer ?? '')));
    }

    const reviseMatch = /^\/api\/missions\/([^/]+)\/contract$/.exec(path);
    if (method === 'POST' && reviseMatch) {
      await requireControl(req, POLICY_ACTION.missionRevise);
      const body = await readJson(req);
      return send(res, 200, await platform.reviseContract(reviseMatch[1], body as never));
    }

    const controlMatch = /^\/api\/missions\/([^/]+)\/(cancel|pause|resume)$/.exec(path);
    if (method === 'POST' && controlMatch) {
      const [, id, verb] = controlMatch;
      const controlAction =
        verb === 'cancel'
          ? POLICY_ACTION.missionCancel
          : verb === 'pause'
            ? POLICY_ACTION.missionPause
            : POLICY_ACTION.missionResume;
      await requireControl(req, controlAction);
      const body = await readJson(req);
      if (verb === 'cancel') return send(res, 200, await platform.cancelMission(id, String(body.reason ?? '')));
      if (verb === 'pause') return send(res, 200, await platform.pauseMission(id));
      return send(res, 200, await platform.resumeMission(id));
    }

    const rejectIndependentFinalReview = (req: IncomingMessage): void => {
      const runHeader = req.headers['x-coagent-run'];
      const runToken = Array.isArray(runHeader) ? runHeader[0] : runHeader;
      const run = tokens.resolve(runToken);
      if (run?.role === 'independent_reviewer') {
        throw new HttpError(403, 'ACTION_DENIED', 'independent_reviewer 不能终审。');
      }
    };

    const reviewerFinalizeMatch = /^\/api\/missions\/([^/]+)\/finalize\/reviewer$/.exec(path);
    if (method === 'POST' && reviewerFinalizeMatch) {
      rejectIndependentFinalReview(req);
      // 控制面仍是 operator 门禁；reviewer / HA 权威由 Platform 入口判定，不在这里伪造。
      await requireControl(req, POLICY_ACTION.finalizeHuman);
      const body = await readJson(req);
      const missionId = reviewerFinalizeMatch[1];
      const verdict = body.verdict as 'merge' | 'send_back' | 'abandon';
      const reasons = Array.isArray(body.reasons) ? body.reasons.map((row) => String(row)) : [];
      const projectRoot = typeof body.projectRoot === 'string' ? body.projectRoot : undefined;
      const reviewerId = String(body.reviewerId ?? '');
      const confirmedBy = String(body.confirmedBy ?? '');
      if (verdict === 'merge') {
        const view = await platform.getMissionView(missionId);
        if (view.executionMode === 'high_assurance') {
          return send(
            res,
            200,
            await platform.finalizeMissionByHaAuthority(missionId, {
              reviewerId,
              confirmedBy,
              ...(projectRoot !== undefined ? { projectRoot } : {}),
              reasons,
            }),
          );
        }
      }
      return send(
        res,
        200,
        await platform.finalizeMissionByReviewer(missionId, {
          verdict,
          reasons,
          ...(projectRoot !== undefined ? { projectRoot } : {}),
          reviewerId,
          confirmedBy,
        }),
      );
    }

    const finalizeMatch = /^\/api\/missions\/([^/]+)\/finalize$/.exec(path);
    if (method === 'POST' && finalizeMatch) {
      rejectIndependentFinalReview(req);
      await requireControl(req, POLICY_ACTION.finalizeHuman);
      const body = await readJson(req);
      return send(res, 200, await platform.finalizeMission(finalizeMatch[1], body as never));
    }

    const retireMatch = /^\/api\/missions\/([^/]+)\/work-items\/([^/]+)\/retire$/.exec(path);
    if (method === 'POST' && retireMatch) {
      // 控制面 L3 作废：有 resolver 时与其它 L3 写口一样要 operator。权威规则在 Platform。
      await requireControl(req, POLICY_ACTION.missionRevise);
      const body = await readJson(req);
      return send(
        res,
        200,
        await platform.retireWorkItem(retireMatch[1], retireMatch[2], String(body.reason ?? '')),
      );
    }

    const rerunMatch = /^\/api\/missions\/([^/]+)\/rerun$/.exec(path);
    if (method === 'POST' && rerunMatch) {
      await requireControl(req, POLICY_ACTION.missionCreate);
      const body = await readJson(req);
      const newMissionId = typeof body.newMissionId === 'string' ? body.newMissionId : undefined;
      const baseRevision = typeof body.baseRevision === 'string' ? body.baseRevision : undefined;
      return send(
        res,
        200,
        await platform.rerunMission(rerunMatch[1], {
          ...(newMissionId !== undefined ? { newMissionId } : {}),
          ...(baseRevision !== undefined ? { baseRevision } : {}),
        }),
      );
    }

    /* ---- 收件箱：结果回到发起方。Host 离线时结果就在这儿等着 ---- */

    if (method === 'GET' && path === '/api/inbox') {
      await requireControl(req, POLICY_ACTION.inboxRead);
      const recipient = url.searchParams.get('recipient') ?? undefined;
      return send(res, 200, { pending: await deliveries.pending(recipient) });
    }

    const ackMatch = /^\/api\/deliveries\/([^/]+)\/ack$/.exec(path);
    if (method === 'POST' && ackMatch) {
      await requireControl(req, POLICY_ACTION.inboxAck);
      const delivery = await deliveries.acknowledge(ackMatch[1]);
      if (!delivery) throw new HttpError(404, 'UNKNOWN_DELIVERY', `没有这条投递：${ackMatch[1]}`);
      return send(res, 200, delivery);
    }

    /* ---- 控制面：调度器用来开/收一次 attempt 并换取 run token ---- */

    const coordMatch = /^\/api\/missions\/([^/]+)\/coordinator-attempts$/.exec(path);
    if (method === 'POST' && coordMatch) {
      await requireControl(req, POLICY_ACTION.attemptStartCoordinator);
      const missionId = coordMatch[1];
      const { attemptId } = await platform.startCoordinatorAttempt(missionId);
      const run = tokens.issue({ missionId, attemptId, role: 'coordinator' });
      return send(res, 201, { attemptId, token: run.token });
    }

    const reviewMatch = /^\/api\/missions\/([^/]+)\/independent-reviewer-attempts$/.exec(path);
    if (method === 'POST' && reviewMatch) {
      await requireControl(req, POLICY_ACTION.attemptStartIndependentReviewer);
      const missionId = reviewMatch[1];
      const pool = await agentPool.list();
      const { attemptId, profileId } = await platform.startIndependentReviewerAttempt(
        missionId,
        pool.independent_reviewer.map((row) => ({
          profileId: row.profileId,
          endpoint: row.endpoint,
        })),
      );
      const run = tokens.issue({
        missionId,
        attemptId,
        role: 'independent_reviewer',
      });
      return send(res, 201, { attemptId, token: run.token, profileId });
    }

    const execMatch = /^\/api\/missions\/([^/]+)\/work-items\/([^/]+)\/executor-attempts$/.exec(path);
    if (method === 'POST' && execMatch) {
      await requireControl(req, POLICY_ACTION.attemptStartExecutor);
      const [, missionId, workItemId] = execMatch;
      const { attemptId } = await platform.startExecutorAttempt(missionId, workItemId);
      const run = tokens.issue({ missionId, attemptId, role: 'executor', workItemId });
      return send(res, 201, { attemptId, token: run.token });
    }

    const finishMatch = /^\/api\/missions\/([^/]+)\/attempts\/([^/]+)\/finish$/.exec(path);
    if (method === 'POST' && finishMatch) {
      await requireControl(req, POLICY_ACTION.attemptFinish);
      const [, missionId, attemptId] = finishMatch;
      const body = await readJson(req);
      // 队列标记在 attempt.started 上，不在内存 token 表。重启丢牌后仍必须当队列拒绝。
      // 身份只从已解析 header token 取，不信 body 里的 owner/代次。
      const queued = await platform.attemptRequiresQueueClaim(missionId, attemptId);
      if (queued) {
        const run = requireRun(req);
        if (run.missionId !== missionId || run.attemptId !== attemptId) {
          throw new HttpError(409, 'WRONG_ROLE', '本次运行绑定的 Mission / Attempt 与收尾目标不一致');
        }
        if (!run.claim) {
          throw new HttpError(
            409,
            'QUEUE_CLAIM_REQUIRED',
            '队列 Attempt 收尾必须使用带领取身份的 Run Token',
          );
        }
        await platform.finishAttempt(missionId, attemptId, body as never, run.claim);
      } else {
        await platform.finishAttempt(missionId, attemptId, body as never);
      }
      // 只在成功收尾后吊销。拒绝时当前代次的有效 token 必须还能用。
      tokens.revokeAttempt(missionId, attemptId);
      return send(res, 200, {});
    }

    if (method === 'POST' && path === '/api/control/run-mission') {
      return startHostedRun(req, res, deps.runMission, 'run-mission');
    }
    if (method === 'POST' && path === '/api/control/run-plan') {
      return startHostedRun(req, res, deps.runPlan, 'run-plan');
    }

    throw new HttpError(404, 'NOT_FOUND', `${method} ${path}`);
  }
}

export { HttpError, RunTokenRegistry };
