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
import { waitForReviewerTodos } from './reviewer-wait.ts';
import type { MissionSummary, ReviewerTodo } from '../application/platform.ts';
import {
  isSafePlanRunId,
  listPlanRuns,
  readPlanRunById,
  updatePlanRunById,
  type PlanRunListItem,
} from '../application/plan-run-store.ts';
import { ClassifiedMissionInputError } from '../application/classified-mission-intake.ts';
import { ChangeImpactConflictError } from '../application/change-impact.ts';
import { ChangeReceiptConflictError } from '../application/change-receipt.ts';
import { AgentPoolError, InMemoryAgentPoolRepository, agentPoolSnapshotRevision } from '../application/agent-pool.ts';
import type {
  AgentPoolAddInput,
  AgentPoolCandidate,
  AgentPoolCandidateHealth,
  AgentPoolRepository,
} from '../application/agent-pool.ts';
import { KernelError } from '../kernel/index.ts';
import { RunTokenRegistry } from './run-tokens.ts';
import {
  IMPACT_READ_ONLY_MESSAGE,
  isImpactAllowedAction,
  isImpactRun,
} from './impact-run-policy.ts';
import { WEB_PAGE } from './web.ts';
import { serveStatic } from './static.ts';
import { getRuntimeUsage, listRuntimeModels, type RuntimeCatalog, type RuntimeUsage, type UsageRow } from '../application/runtime-catalog.ts';
import { NoLiveOutput, PLAN_LIVE_EMPTY_REASON } from '../application/live.ts';
import type { LiveOutput, PlanLiveChunk, PlanRunLiveOutput } from '../application/live.ts';
import type { DeliveryRepository } from '../application/delivery.ts';
import type { QueryRunRepository } from '../application/query-run.ts';
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
 * POST /api/missions/:id/checkpoint/approve 的输入形状校验用。
 *
 * 与 Platform 里的 WORK_ITEM_CHECKPOINT_INTERVAL 是同一个 15，这里不 import：
 * 接口层只验形状，业务规则只有 Platform 一份；反向 import 会把接口层钉在用例模块上。
 */
const CHECKPOINT_THRESHOLD_INTERVAL = 15;

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
  queryRuns?: QueryRunRepository;
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
  getRuntimeUsage?: () => Promise<RuntimeUsage>;
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
  /**
   * 方案运行读时的运行态投影来源。不注入则列表与详情一律标 unknown。
   *
   * 为什么是只读投影、不写回：观测面不能改记录格式或停止语义（plan-run-web-observability）。
   * 推导规则——记录有 stopped 即 stopped；无 stopped 且 id 在 activeRunIds 登记即 running；
   * 不在登记且注入方是状态文件写者（isStateFileWriter）即 interrupted；否则 unknown。
   */
  planRunRuntime?: {
    activeRunIds: () => readonly string[];
    isStateFileWriter: boolean;
  };
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
 * URL 里的 profileId。名字带 / 等字符时是百分号编码进来的，原样用会和池里的名字
 * 对不上；编码坏了（比如孤零零一个 %）必须当时报错，不能拿半截名字去查。
 */
function decodeProfileId(raw: string): string {
  let profileId: string;
  try {
    profileId = decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, 'INVALID_PROFILE_ID', 'profileId 不是合法的百分号编码');
  }
  if (!profileId.trim()) throw new HttpError(400, 'INVALID_PROFILE_ID', 'profileId 不能为空');
  return profileId;
}

/**
 * 复位审计里的 actor 必须来自受控主体，不是请求体。没有 resolver 时无从得知身份 ——
 * 记固定的 'operator'，也不放行让调用方自己填名字。
 */
function controlActor(
  resolve: ControlPrincipalResolver | undefined,
  req: IncomingMessage,
): Promise<string> {
  if (!resolve) return Promise.resolve('operator');
  return Promise.resolve(resolve(req)).then((resolved) => {
    if (resolved && !('status' in resolved) && resolved.id.trim()) return resolved.id;
    return 'operator';
  });
}

/**
 * 仓储只说「不存在 / 已 closed」，HTTP 要把它翻成明确的 4xx 与固定文案。
 * 原样透出仓储消息会把内部路径与实现细节带进应答。
 */
function circuitResetHttpError(error: unknown, profileId: string): HttpError {
  const message = error instanceof Error ? error.message : String(error);
  if (/does not exist/.test(message)) {
    return new HttpError(404, 'CIRCUIT_NOT_FOUND', `还没有熔断记录，无需复位：${profileId}`);
  }
  if (/closed/.test(message)) {
    return new HttpError(409, 'CIRCUIT_NOT_OPEN', `熔断已经是 closed，无需复位：${profileId}`);
  }
  return new HttpError(500, 'CIRCUIT_RESET_FAILED', '复位失败');
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

/**
 * 把一条方案运行记录投影成带 runtimeState 的只读视图，不改动入参快照。
 * 读面推导运行态：stopped 看记录；running 看本进程托管登记；interrupted 看写者身份；
 * 都不满足就 unknown。坏记录（{id,error}）原样返回，不投影。
 */
function withRuntimeState(
  item: PlanRunListItem,
  runtime: { activeRunIds: () => readonly string[]; isStateFileWriter: boolean } | undefined,
): PlanRunListItem {
  if (Object.hasOwn(item, 'error')) return item;
  const ok = item as { readonly id: string; readonly stopped?: unknown };
  if (ok.stopped !== undefined) {
    return { ...ok, runtimeState: 'stopped' } as PlanRunListItem;
  }
  if (runtime !== undefined && runtime.activeRunIds().includes(ok.id)) {
    return { ...ok, runtimeState: 'running' } as PlanRunListItem;
  }
  if (runtime !== undefined && runtime.isStateFileWriter) {
    return { ...ok, runtimeState: 'interrupted' } as PlanRunListItem;
  }
  return { ...ok, runtimeState: 'unknown' } as PlanRunListItem;
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

/**
 * 人工复位的命令模板。
 *
 * 界面只显示不执行：复位是有人确认过「已经充值」之后的动作，API 替人做等于
 * 把「额度耗尽」这条熔断当成一个可以自动重试的普通失败 —— 那正是它要挡的事
 * （每一跳都先探测它再失败换候选，PLAT3 一张票里就撞了 11 次）。
 */
const CANDIDATE_RESET_COMMAND = 'node src/l3.ts candidate reset <profileId> --reason "…"';

function resetCommandFor(profileId: string): string {
  return CANDIDATE_RESET_COMMAND.replace('<profileId>', profileId);
}

/**
 * 熔断原因是 quota 时给人看的那句话。
 *
 * 两种必须分开说：一个是「等到某个时刻就好」，一个是「没人充值就永远不好」。
 * 合成一句话的后果是运维一直等一个不会到来的自动恢复。
 */
function quotaExtras(circuit: CandidateCircuit): Pick<AgentPoolCandidateHealth, 'quotaReason' | 'resetCommand'> {
  if (circuit.state !== 'open' || circuit.failureClass !== 'quota') return {};
  if (circuit.openUntil === null) {
    return {
      quotaReason: '额度已用完，适配层没有给出重置时间 —— 不会自动恢复，要等充值后人工复位。',
      resetCommand: resetCommandFor(circuit.profileId),
    };
  }
  return {
    quotaReason: `额度已用完，${circuit.openUntil} 重置后再派活。`,
    resetCommand: resetCommandFor(circuit.profileId),
  };
}

/** 候选 facts 里的 provider 对上哪条用量行。没有 provider fact 就无从对应 —— 不猜。 */
function usageRowFor(candidate: AgentPoolCandidate, rows: readonly UsageRow[]): UsageRow | undefined {
  const provider = candidate.facts.find((fact) => fact.key === 'provider')?.value;
  if (!provider) return undefined;
  return rows.find((row) => row.provider === provider && row.status === 'ok');
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
  usageRows: readonly UsageRow[],
  queryRuns?: QueryRunRepository,
) {
  const hops = queuedHops ? await queuedHops.list() : [];
  const nowIso = new Date(nowMsValue).toISOString();
  const observed = await collectCandidateObservations(platform, hops, nowMsValue);
  const queries = await queryRuns?.list() ?? [];
  for (const query of queries) {
    if (!query.profileId) continue;
    const failure = query.endedBy ? classifyCandidateFailure(query.endedBy, query.failureMessage) : undefined;
    if (failure) {
      const hints = observed.hints.get(query.profileId) ?? [];
      hints.push({ failureClass: failure.failureClass, at: query.endedAt ?? null, source: 'query.ended' });
      observed.hints.set(query.profileId, hints);
    }
    const at = Date.parse(query.startedAt);
    if (at < nowMsValue - SEVEN_DAYS_MS || at > nowMsValue || !Number.isFinite(at)) continue;
    const acc = observed.usage.get(query.profileId) ?? emptyUsage();
    acc.attempts += 1;
    if (query.outcome === 'answered') acc.successes += 1;
    if (query.usage.quality === 'reported' && typeof query.usage.cost === 'number' && Number.isFinite(query.usage.cost)) {
      acc.reportedCost = (acc.reportedCost ?? 0) + query.usage.cost;
    }
    observed.usage.set(query.profileId, acc);
  }
  const healthOf = async (candidate: AgentPoolCandidate): Promise<AgentPoolCandidateHealth> => {
    const lease = activeLeaseForProfile(hops, candidate.profileId, nowIso);
    const runningQuery = queries.find((query) => query.profileId === candidate.profileId && query.status === 'running');
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
    const usage = usageRowFor(candidate, usageRows);
    return {
      circuit: circuitHealth(circuit),
      lastFailure: resolveCandidateLastFailure(circuit, hints),
      window7d,
      runtime: runningQuery?.runtimeKind ? { running: true, hopId: runningQuery.id, runtimeKind: runningQuery.runtimeKind } : runtime,
      // 原样附上整行：套餐、remainingPercent、resetAt 都是适配层的字段，摘几个重命名等于又抄一份会过期的表。
      ...(usage ? { usage } : {}),
      ...quotaExtras(circuit),
    };
  };
  const attach = async (rows: readonly AgentPoolCandidate[]) => {
    const out = [];
    for (const row of rows) out.push({ ...row, health: await healthOf(row) });
    return out;
  };
  return {
    classifier: await attach(snapshot.classifier ?? []),
    coordinator: await attach(snapshot.coordinator),
    executor: await attach(snapshot.executor),
    independent_reviewer: await attach(snapshot.independent_reviewer),
  };
}

export function createApi(deps: ApiDeps): Server {
  const { platform, tokens, deliveries, onMutation, beforeRead, resolveControlPrincipal } = deps;
  const planRunDirs = deps.planRunDirs ?? (() => [resolve('.coagent-plans')]);
  const planLive = deps.planLive;
  const planRuntime = deps.planRunRuntime;
  const live: LiveOutput = deps.live ?? new NoLiveOutput();
  const agentPool: AgentPoolRepository = deps.agentPool ?? new InMemoryAgentPoolRepository();
  const listModels = deps.listRuntimeModels ?? listRuntimeModels;
  const nowMs = deps.now ?? Date.now;
  /** 成功清单按实例缓存。失败不进这里——否则一次适配层故障会锁死 10 分钟旧错误。 */
  let cachedRuntimeCatalog: { readonly at: number; readonly catalog: RuntimeCatalog } | undefined;
  let cachedRuntimeUsage: { readonly at: number; readonly usage: RuntimeUsage } | undefined;

  /**
   * 这一次请求要用的适配层用量。与 GET /api/runtime/usage **共用同一份缓存**：两个页面问的是
   * 同一个问题，各读一次意味着打开资源池页要等两遍适配层（一遍好几十秒）。失败只降级不进缓存
   * —— 否则一次适配层故障会把「取不到用量」锁死 10 分钟。成功（UsageRow[]）和适配器自己给出
   * 的 unavailable 都原样交出去，由调用方决定怎么显示；只有**抛异常**才往上传。
   */
  const readUsage = async (): Promise<RuntimeUsage> => {
    const hit = cachedRuntimeUsage;
    if (hit && nowMs() - hit.at < RUNTIME_MODELS_CACHE_MS) return hit.usage;
    const usage = await (deps.getRuntimeUsage ?? getRuntimeUsage)();
    if (Array.isArray(usage) || usage.available === true) {
      cachedRuntimeUsage = { at: nowMs(), usage };
    }
    return usage;
  };

  /**
   * 资源池那一列要用的用量行。拿不到（适配层不在 / 不可用 / 抛异常）就是空数组：资源池
   * 照原样返回，用量那几个可选键干脆不出现。凭空造一行等于告诉运维「还有额度」。
   */
  const readUsageRows = async (): Promise<readonly UsageRow[]> => {
    try {
      const usage = await readUsage();
      return Array.isArray(usage) ? usage : [];
    } catch {
      return [];
    }
  };

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
  const requireControlAuth = async (req: IncomingMessage, action: PolicyAction): Promise<void> => {
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

  const requireControl = async (req: IncomingMessage, action: PolicyAction): Promise<void> => {
    await requireControlAuth(req, action);
    if (req.method !== 'POST') return;
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const controlled = /^\/api\/missions\/([^/]+)\/(?:budget\/raise|checkpoint\/approve|escalations\/answer|contract|park|parked-resume|cancel|pause|resume|finalize(?:\/reviewer)?|work-items\/[^/]+\/retire|rerun)$/.exec(path);
    if (!controlled) return;
    const mission = await platform.getMissionView(controlled[1]);
    const duty = await platform.getReviewerDuty(mission.projectId);
    if (duty?.active || req.headers['x-coagent-reviewer']) {
      await platform.requireReviewerDuty(mission.projectId, String(req.headers['x-coagent-reviewer'] ?? ''), Number(req.headers['x-coagent-reviewer-generation']));
    }
  };

  const reviewerTodoList = async (projectId?: string) => {
    const todos: Array<ReviewerTodo | { id: string; kind: 'plan_escalation'; projectId: string;
      runId: string; missionId?: string; title: string; at: string; blocking: boolean;
      state: 'open'; notify: boolean; decisionPath: 'plan_run' }> = await platform.listReviewerTodos(projectId);
    for (const item of listPlanRuns(planRunDirs(), projectId)) {
      if ('error' in item || withRuntimeState(item, planRuntime).runtimeState !== 'running') continue;
      const record = readPlanRunById(planRunDirs(), item.id);
      if (record.status !== 'ok') continue;
      for (const entry of record.snapshot.escalations.filter((row) => !row.resolution)) {
        // 真实 PlanRun 承载时只保留它的决策入口，避免同一问题走普通 Mission 答复。
        const duplicate = todos.findIndex((row) => row.missionId === entry.missionId && row.title === entry.question && row.kind !== 'result' && row.kind !== 'documentation');
        if (duplicate >= 0) todos.splice(duplicate, 1);
        todos.push({ id: `plan:${item.id}:${entry.id}`, kind: 'plan_escalation', projectId: item.projectId,
          runId: item.id, missionId: entry.missionId, title: entry.question, at: entry.openedAt,
          blocking: true, state: 'open', notify: true, decisionPath: 'plan_run' });
      }
    }
    return todos.sort((a, b) => b.at.localeCompare(a.at));
  };

  /**
   * impact 牌专属的两个工具。
   *
   * 按**精确工具名**写死，不入 AGENT_TOOL_ACTION、也不复用任何宽泛的写别名：
   * 走别名的话，将来给协调者加一条新写就顺带把限权身份的那条也开了，而这里
   * 要的是「多一个都不行」。所以这两个名字不在策略矩阵里，门禁写在下面两层。
   */
  const IMPACT_EXCLUSIVE_TOOLS = new Set([
    'coagent_get_change_request',
    'coagent_submit_change_impact',
  ]);

  /**
   * 回执专属的两个工具：只有**执行者自己的牌**能调。
   *
   * 与上面那组 impact 工具刻意分开：两组是两条链的两端（判断 / 接收），身份来源
   * 不同（impact hop / 执行者自己的 hop）、代次互不相干。混进同一个集合的话，
   * 将来「给 impact 多开一格」会顺手把执行者回执也开给限权身份。
   */
  const RECEIPT_EXCLUSIVE_TOOLS = new Set([
    'coagent_get_change_deliveries',
    'coagent_ack_change_receipt',
  ]);

  /**
   * 覆盖声明专属工具：只有**普通协调者牌**（L2）能调。
   *
   * 与上面两组刻意分开：三组身份互不相同（impact hop / 执行者自己的 hop /
   * 普通协调者 hop），合并成一组的话，将来给其中一端多开一格会顺手把另外
   * 两端也开出去。它同样不入 AGENT_TOOL_ACTION、也不进 impact 白名单——
   * impact 牌是只读的限权身份，让它声明覆盖等于拿「只做判断」的牌写执行侧的
   * 恢复事实。
   */
  const COVERAGE_EXCLUSIVE_TOOLS = new Set(['coagent_record_change_coverage']);

  /**
   * 验收处置专属工具：只有**普通协调者牌**（L2）能调。
   *
   * 与上面三组刻意分开：四组身份来源互不相同（impact hop / 执行者自己的 hop /
   * 普通协调者 hop 声明覆盖 / 普通协调者 hop 写验收处置），合并成一组的话，
   * 将来给其中一端加名字会顺手把处置也开出去。它不入 AGENT_TOOL_ACTION、
   * 也不进 impact 白名单——impact 牌是只读的限权身份，让它写验收处置等于拿
   * 「只做判断」的牌给自己签验收结论。
   */
  const DISPOSITION_EXCLUSIVE_TOOLS = new Set(['coagent_record_acceptance_disposition']);

  /**
   * impact Run 在整个 HTTP 面的入口白名单。
   *
   * 只看 path + method + 已解析 token：请求体在这一步还没读，也不会被读——
   * 读 body 才能让 body 影响判定，而 body 是对方填的。
   * agent 工具走 /api/agent/<已有 handler>，且要么映射到一个只读白名单动作、
   * 要么是上面那两个显式点名的专属工具；其余一切入口（包括将来新加的路由）
   * 默认拒绝。
   */
  const rejectImpactRunOutsideAllowlist = (req: IncomingMessage): void => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (!path.startsWith('/api/')) return;
    const header = req.headers['x-coagent-run'];
    const token = Array.isArray(header) ? header[0] : header;
    // 未解析出 impact 牌（无 token / 普通牌）完全按原路径走：这里不改任何旧行为。
    if (!isImpactRun(tokens.resolve(token))) return;
    const method = req.method ?? 'GET';
    const tool = path.startsWith('/api/agent/') ? path.slice('/api/agent/'.length) : undefined;
    const known = tool !== undefined && Object.hasOwn(agentTools, tool);
    const allowed =
      (method === 'GET' && path === '/api/run/brief') ||
      (method === 'POST' &&
        known &&
        (isImpactAllowedAction(AGENT_TOOL_ACTION[tool!]) || IMPACT_EXCLUSIVE_TOOLS.has(tool!)));
    if (!allowed) throw new HttpError(403, 'ACTION_DENIED', IMPACT_READ_ONLY_MESSAGE);
  };

  /**
   * agent 工具在 Run Token 解析之后求策略。角色对错仍让 Platform 抛出原
   * WRONG_ROLE 文案（除作废工单这条本来就在 HTTP 层）。绑定不匹配在这里挡。
   */
  const enforceAgentPolicy = (run: RunContext, action: PolicyAction): void => {
    // impact 牌只允许白名单里的读动作。放在 evaluatePolicy 之前：协调者的通用
    // 矩阵里写动作占了绝大多数，让 impact 牌落下去的话 ACTION_DENIED 会顺着
    // 下面那条「交回 Platform 抛 WRONG_ROLE」的旧兼容回退变成放行。
    if (isImpactRun(run) && !isImpactAllowedAction(action)) {
      throw new HttpError(403, 'ACTION_DENIED', IMPACT_READ_ONLY_MESSAGE);
    }
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

  /**
   * 两个 impact 专属工具的门禁：只有 role=coordinator、purpose=impact、changeId /
   * workItemId 非空、且带完整 claim 三元组的牌能过。
   *
   * 普通 coordinator / executor / independent_reviewer 牌一律 403，而且**不看
   * body**——body 是对方填的，拿它判断身份等于把门禁交给调用方。
   *
   * 为什么这里把 role / workItemId / claim 也逐个再验一遍（发牌时已经验过）：
   * 门禁是 fail-closed 的那一层，它只能依赖 RunContext 自身的形状，不能依赖
   * 「发牌方一定按规矩填了」。少了任一条，一张缺目标或缺领取身份的牌就会带着
   * 半截身份走进 Platform，而 Platform 那边只会按它拿到的那半截去核对。
   */
  const requireImpactChangeId = (run: RunContext): string => {
    const claim = run.claim;
    const complete =
      run.role === 'coordinator' &&
      run.purpose === 'impact' &&
      typeof run.changeId === 'string' &&
      run.changeId.trim().length > 0 &&
      typeof run.workItemId === 'string' &&
      run.workItemId.trim().length > 0 &&
      claim !== undefined &&
      claim.id.trim().length > 0 &&
      claim.owner.trim().length > 0 &&
      Number.isSafeInteger(claim.claimGeneration) &&
      claim.claimGeneration > 0;
    if (!complete) {
      throw new HttpError(
        403,
        'ACTION_DENIED',
        '只有 impact 目的牌能调用这个工具；普通协调者 / 执行者 / 独立检视者，以及缺 changeId / 目标 / 领取身份的牌一律拒绝。',
      );
    }
    return run.changeId as string;
  };

  /**
   * 两个回执专属工具的门禁：只有 role=executor、**不是** impact 牌、workItemId /
   * attemptId 非空、且带完整 claim 三元组的牌能过。
   *
   * 为什么专门排掉 purpose='impact'：impact 牌是只读的限权身份，让它签回执等于
   * 拿「只做判断」的牌去写接收侧事实。它不在 IMPACT_EXCLUSIVE_TOOLS 里，所以会
   * 在 rejectImpactRunOutsideAllowlist 处、读 body 之前就 403。
   *
   * 同样**不看 body**：执行者的目标与代次只能来自牌，body 里自称什么都是对方填的。
   */
  const requireExecutorReceiptRun = (run: RunContext): void => {
    const claim = run.claim;
    const complete =
      run.role === 'executor' &&
      run.purpose !== 'impact' &&
      typeof run.workItemId === 'string' &&
      run.workItemId.trim().length > 0 &&
      typeof run.attemptId === 'string' &&
      run.attemptId.trim().length > 0 &&
      claim !== undefined &&
      claim.id.trim().length > 0 &&
      claim.owner.trim().length > 0 &&
      Number.isSafeInteger(claim.claimGeneration) &&
      claim.claimGeneration > 0;
    if (!complete) {
      throw new HttpError(
        403,
        'ACTION_DENIED',
        '只有执行者自己的牌能调用这个工具；impact 牌、协调者 / 独立检视者，以及缺目标 / 领取身份的牌一律拒绝。',
      );
    }
  };

  /**
   * 覆盖声明工具的门禁：只有 role=coordinator、**不是** impact 牌、attemptId
   * 非空、且带完整 claim 三元组的牌能过。
   *
   * 为什么不收 workItemId 而是 attemptId：这一条工具做的是 L2 在重派后声明
   * 「旧 Attempt 的差异已并入修订后的工单」，说话的是协调者这一趟 hop 本身，
   * 不是某个被派发的目标工作项；绑工作项反而会把「这一趟说了什么」和「派给
   * 谁」混成一件。
   *
   * 同样**不看 body**：L2 的身份与代次只能来自牌，body 里自称什么都是对方填的。
   */
  const requireCoordinatorCoverageRun = (run: RunContext): void => {
    const claim = run.claim;
    const complete =
      run.role === 'coordinator' &&
      run.purpose !== 'impact' &&
      typeof run.attemptId === 'string' &&
      run.attemptId.trim().length > 0 &&
      claim !== undefined &&
      claim.id.trim().length > 0 &&
      claim.owner.trim().length > 0 &&
      Number.isSafeInteger(claim.claimGeneration) &&
      claim.claimGeneration > 0;
    if (!complete) {
      throw new HttpError(
        403,
        'ACTION_DENIED',
        '只有普通协调者牌能调用这个工具；执行者、独立检视者与 impact 牌一律拒绝。',
      );
    }
  };

  /**
   * 验收处置的门禁：只有 role=coordinator、**不是** impact 牌、attemptId 非空的
   * 牌能过。
   *
   * 为什么**不要** claim 也不要 workItemId：处置是 L2 在验收时对着整份契约说的
   * 话，一条处置可以点名多个工作项，且协调者这一趟 hop 本身可能就没有队列领取
   * 身份（控制面直接发的牌）。要求它们只会把「L2 这一趟说了什么」变成「某个被
   * 派发的 hop 领到了什么」。
   *
   * 同样**不看 body**：身份只能来自牌，body 里自称什么都是对方填的。这也是分流
   * 必须排在 readJson 之前的原因。
   */
  const requireCoordinatorDispositionRun = (run: RunContext): void => {
    const complete =
      run.role === 'coordinator' &&
      run.purpose !== 'impact' &&
      typeof run.attemptId === 'string' &&
      run.attemptId.trim().length > 0;
    if (!complete) {
      throw new HttpError(
        403,
        'ACTION_DENIED',
        '只有普通协调者牌能调用这个工具；执行者、独立检视者与 impact 牌一律拒绝。',
      );
    }
  };

  /**
   * 处置体只认这五个业务键。
   *
   * 多一个键就 400（含 missionId / attemptId / role / claim / at / contractRevision
   * 这些身份与代次字段：它们全由牌与平台侧的已持久事实补齐，允许调用方补一个
   * 就是自己签自己的来源）。缺字段与类型不对**不在 HTTP 层再判一遍**：规则已经
   * 写在 Platform 一份，这里复制一份只会两处各自漂移。
   */
  const requireDispositionBody = (body: Record<string, unknown>): Record<string, unknown> => {
    const known = new Set(['dispositionId', 'index', 'decision', 'workItemIds', 'basis']);
    for (const key of Object.keys(body)) {
      if (!known.has(key)) {
        throw new HttpError(
          400,
          'BAD_REQUEST',
          `验收处置只接受 dispositionId / index / decision / workItemIds / basis：${key} 不受理`,
        );
      }
    }
    return {
      dispositionId: body.dispositionId,
      index: body.index,
      decision: body.decision,
      workItemIds: body.workItemIds,
      basis: body.basis,
    };
  };

  /**
   * 覆盖声明体只认三个业务字段：changeId / orderRevision / workOrderHash。
   *
   * 其余字段一律 400，尤其 changeId 之外的任何身份与结论字段（missionId /
   * attemptId / role / claim / claimGeneration / verified / applied）：它们全由
   * 牌与平台侧的已持久事实补齐，允许调用方补一个就是自己签自己的来源。
   */
  const requireCoverageBody = (body: Record<string, unknown>): Record<string, unknown> => {
    const known = new Set(['changeId', 'orderRevision', 'workOrderHash']);
    for (const key of Object.keys(body)) {
      if (!known.has(key)) {
        throw new HttpError(
          400,
          'BAD_REQUEST',
          `覆盖声明只接受 changeId / orderRevision / workOrderHash：${key} 不受理`,
        );
      }
    }
    for (const key of ['changeId', 'orderRevision', 'workOrderHash']) {
      const value = body[key];
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new HttpError(400, 'BAD_REQUEST', `${key} 必须是非空字符串。`);
      }
    }
    if (!/^[0-9a-f]{64}$/.test(body.workOrderHash as string)) {
      throw new HttpError(
        400,
        'BAD_REQUEST',
        'workOrderHash 必须是 64 位小写 hex（sha256）。',
      );
    }
    return {
      changeId: body.changeId,
      orderRevision: body.orderRevision,
      workOrderHash: body.workOrderHash,
    };
  };

  /**
   * 回执体只认 changeId / layer，layer=executor_started 还要 contentHash。
   *
   * 其余字段一律 400，尤其 attemptId / missionId / workItemId / role / claim /
   * claimGeneration / at / verified：它们全由牌与已持久的影响判断补齐，允许调用
   * 方补一个就是自己签自己的来源，回执链不再是事实。
   */
  const requireReceiptAckBody = (body: Record<string, unknown>): Record<string, unknown> => {
    const layer = body.layer;
    const known = new Set<string>(
      layer === 'executor_started' ? ['changeId', 'layer', 'contentHash'] : ['changeId', 'layer'],
    );
    for (const key of Object.keys(body)) {
      if (!known.has(key)) {
        throw new HttpError(
          400,
          'BAD_REQUEST',
          `回执只接受 changeId / layer${layer === 'executor_started' ? ' / contentHash' : ''}：${key} 不受理`,
        );
      }
    }
    if (typeof body.changeId !== 'string' || body.changeId.trim().length === 0) {
      throw new HttpError(400, 'BAD_REQUEST', 'changeId 必须是非空字符串。');
    }
    if (
      layer !== 'adapter_received' &&
      layer !== 'session_consumed' &&
      layer !== 'executor_started'
    ) {
      throw new HttpError(
        400,
        'BAD_REQUEST',
        `layer 必须是 adapter_received | session_consumed | executor_started 之一：${String(layer)}` +
          '（verified 不是可写层：回执只记收到，验收通过是另一件事）',
      );
    }
    if (layer === 'executor_started') {
      const hash = body.contentHash;
      if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) {
        throw new HttpError(
          400,
          'BAD_REQUEST',
          'executor_started 的 contentHash 必须是 64 位小写 hex（sha256）。',
        );
      }
    }
    return {
      changeId: body.changeId,
      layer,
      ...(layer === 'executor_started' ? { contentHash: body.contentHash as string } : {}),
    };
  };

  /**
   * 牌上钉死的目标工作项必须与这次要动的那条变更指向的工作项一致。
   *
   * Platform 核的是「变更 → 队列槽 → 目标执行」那一侧；这里补的是「牌 → 变更」
   * 这一侧。少了它，一张绑着 A 工单的 impact 牌可以读到并判断 B 工单的变更，
   * 而 Platform 只会看到「这条变更确实归这个 Mission」——它不知道牌上写的是谁。
   */
  const requireImpactTarget = (run: RunContext, workItemId: string): void => {
    if (run.workItemId !== workItemId) {
      throw new HttpError(
        403,
        'ACTION_DENIED',
        '这张 impact 牌绑的目标工作项不是这条变更指向的工作项，拒绝。',
      );
    }
  };

  /**
   * 业务体只认四个字段：多一个（尤其是任何 changeId / missionId / claim 之类的
   * 身份字段）就 400——身份来自牌与请求记录，调用方补一个就是自己签自己的来源。
   */
  const requireImpactDecisionBody = (body: Record<string, unknown>): Record<string, unknown> => {
    const known = new Set(['decision', 'workOrderDiff', 'affectedAcceptance', 'reason']);
    for (const key of Object.keys(body)) {
      if (!known.has(key)) {
        throw new HttpError(
          400,
          'BAD_REQUEST',
          `影响判断只接受 decision / workOrderDiff / affectedAcceptance / reason：${key} 不受理`,
        );
      }
    }
    return { ...body };
  };

  /** 每个工具一个 handler。handler 里没有规则，规则都在 Platform。 */
  const agentTools: Record<
    string,
    (run: RunContext, body: Record<string, never>) => Promise<unknown>
  > = {
    async coagent_get_mission(run) {
      return platform.getAgentMissionView(run.missionId);
    },

    async coagent_get_work_item(run, body) {
      const { workItemId } = body as unknown as { workItemId: unknown };
      if (typeof workItemId !== 'string' || workItemId.length === 0) {
        throw new HttpError(400, 'BAD_REQUEST', 'workItemId 必须是非空字符串。');
      }
      // 只有协调者能取精简详情：executor 在 enforceAgentPolicy 的旧兼容回退下会落到放行，
      // 故这里 fail-closed 明确挡住非协调者，避免详情被越权读取。
      if (run.role !== 'coordinator') {
        throw new HttpError(403, 'ACTION_DENIED', '只有协调者能读取工作项详情。');
      }
      return platform.getAgentWorkItem(run.missionId, workItemId);
    },

    async coagent_get_validation_report(run, body) {
      // 完整机器验证报告只给协调者：enforceAgentPolicy 对 coordinator 之外的角色保留
      // 「交回 Platform 抛 WRONG_ROLE」的旧兼容回退，那条回退在这里会落到放行，
      // 所以显式按 run.role 挡一次，fail-closed。
      if (run.role !== 'coordinator') {
        throw new HttpError(403, 'ACTION_DENIED', '只有协调者能读取完整验证报告。');
      }
      const { workItemId, reportId } = body as unknown as { workItemId: unknown; reportId?: unknown };
      if (typeof workItemId !== 'string' || workItemId.length === 0) {
        throw new HttpError(400, 'BAD_REQUEST', 'workItemId 必须是非空字符串。');
      }
      if (reportId !== undefined && (typeof reportId !== 'string' || reportId.length === 0)) {
        throw new HttpError(400, 'BAD_REQUEST', 'reportId 必须是非空字符串。');
      }
      // 身份只取 run.missionId：请求体里的 missionId / attemptId / role 一律不采信。
      // 采信的话，执行者只要在 body 里写一句 role: 'coordinator' 就能读别人的报告。
      const report = await platform.getAgentValidationReport(
        run.missionId,
        workItemId,
        reportId,
      );
      if (!report) {
        // 文案不提归属：说「这份属于别的 Mission / 工单」等于给了探测归属的接口。
        throw new HttpError(404, 'VALIDATION_REPORT_NOT_FOUND', '没有这份验证报告');
      }
      return report;
    },

    /**
     * 读这一次要判断的已确认变更。
     *
     * body 必须是空的：changeId 只来自牌上冻住的那一条。收 body changeId 等于
     * 让限权身份自己挑「我要判断哪条变更」，而它能挑的那批里有一条是别人的。
     */
    async coagent_get_change_request(run, body) {
      if (Object.keys(body).length > 0) {
        throw new HttpError(
          400,
          'BAD_REQUEST',
          'coagent_get_change_request 不接受请求体：变更身份只来自本次运行的凭据。',
        );
      }
      const changeId = requireImpactChangeId(run);
      const request = await platform.getChangeRequest(run.missionId, run.attemptId, changeId, run.claim);
      requireImpactTarget(run, request.workItemId);
      return request;
    },

    /**
     * 提交这一次的影响判断。
     *
     * body 只认四业务字段：decision / workOrderDiff / affectedAcceptance / reason。
     * 身份字段一个都不收——它们由 Platform 从请求记录与队列槽补齐，允许调用方补
     * 就等于允许自己签自己的来源。
     */
    async coagent_submit_change_impact(run, body) {
      const changeId = requireImpactChangeId(run);
      const business = requireImpactDecisionBody(body);
      // 先读一次核目标再写：只核 body 的话「判断的是哪条变更」全靠牌的 self-report，
      // 而牌上钉的目标是不是这条变更写的那个，只有仓储里的请求记录说了算。
      // 这次读也顺带把 Platform 的归属 / 代次 / claim 校核跑一遍——不通过就轮不到写。
      const request = await platform.getChangeRequest(run.missionId, run.attemptId, changeId, run.claim);
      requireImpactTarget(run, request.workItemId);
      return platform.submitChangeImpact(
        run.missionId,
        run.attemptId,
        changeId,
        business,
        run.claim,
      );
    },

    /**
     * 执行者读发给自己的差异。
     *
     * body 必须为空：目标工作项 / Attempt / 代次全在牌上，收 body 等于让调用方自己
     * 挑「我要读哪一趟执行的差异」。
     */
    async coagent_get_change_deliveries(run, body) {
      if (Object.keys(body).length > 0) {
        throw new HttpError(
          400,
          'BAD_REQUEST',
          'coagent_get_change_deliveries 不接受请求体：目标与代次只来自本次运行的凭据。',
        );
      }
      return {
        deliveries: await platform.listChangeDeliveries(
          run.missionId,
          run.workItemId!,
          run.attemptId,
          run.claim,
        )
      };
    },

    /**
     * 执行者按层回执。
     *
     * 只透传 changeId / layer /（executor_started 的 contentHash）；身份与 at 由
     * Platform 从围栏、已持久的影响判断与平台时钟现取。回执只记「我收到了」，
     * 不是已应用 / 已验收。
     */
    async coagent_ack_change_receipt(run, body) {
      const business = requireReceiptAckBody(body);
      return platform.ackChangeReceipt(
        run.missionId,
        run.workItemId!,
        run.attemptId,
        business,
        run.claim,
      );
    },

    /**
     * L2 声明「旧 Attempt 的那份差异已并入修订后的工单」。
     *
     * 只透传 changeId / orderRevision / workOrderHash；Mission / Attempt /
     * 代次 / at 全由 Platform 从牌与平台时钟现取。这是一条**声明**，平台核对
     * 属实才成立，本身既不是已应用、也不是已验证。
     */
    async coagent_record_change_coverage(run, body) {
      const workItemId = requireWorkItem(run);
      const business = requireCoverageBody(body);
      return platform.recordChangeCoverage(
        run.missionId,
        run.attemptId,
        workItemId,
        business,
        run.claim,
      );
    },

    /**
     * L2 写下「这一条验收口径这次怎么处置」。
     *
     * 只透传那五个业务键，其余字段一律 400；Mission / Attempt / claim 全由
     * Platform 从牌与平台侧已持久事实现取。
     *
     * 这是一条**判断记录**，不等于验收已通过、也不等于已验证：平台核对原文未变、
     * 报告按当前工单这套命令与范围跑出来之后才落库，落库也只说明「这条口径这次
     * 这么处置」。
     */
    async coagent_record_acceptance_disposition(run, body) {
      const business = requireDispositionBody(body);
      return platform.recordAcceptanceDisposition(
        run.missionId,
        run.attemptId,
        business,
        run.claim,
      );
    },

    async coagent_get_contract(run) {
      return platform.getContract(run.missionId);
    },

    async coagent_submit_contract_check(run, body) {
      // 请求体形状由契约固定（{verdict, summary, issues?}），这是 L3 侧读事件时
      // 依赖的字段名：改一个名字，核对结论就会在压缩后被读成空。
      // 领域校验（verdict 取值、summary / issues 非空）全在 Platform，
      // 这里只透传，重复校验只会让两处规则各自漂移。
      return platform.submitContractCheck(
        run.missionId,
        run.attemptId,
        body as unknown as { verdict: 'ok' | 'issues'; summary: string; issues?: string[] },
        run.claim,
      );
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
        // 经协调者 HTTP 工具创建：开启工单标准软警告审计，但不改变行为。
        { viaCoordinatorTool: true },
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

    async coagent_revise_work_order(run, body) {
      // 只有协调者能修订工单：S14.6 说 cancel-replace 是 L2 的判断。
      // 角色闸在入口 PolicyEngine（与 retire 同理由 WRONG_ROLE 文案一致）。
      // 身份只来自 Run Token 的 claim，body 里自述的工作项 / 角色一律不采信。
      // 这里只做透传，规则（PLAN 校验、WRONG_ROLE）都在 Platform.reviseWorkOrder。
      const { workItemId, ...order } = body as unknown as { workItemId: string };
      return platform.reviseWorkOrder(
        run.missionId,
        run.attemptId,
        workItemId,
        order as never,
        run.claim,
        // 经协调者 HTTP 工具修订：开启工单标准软警告审计，但不改变行为。
        { viaCoordinatorTool: true },
      );
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
    void handleWithReviewerFence(req, res)
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
      } else if (error instanceof ChangeImpactConflictError) {
        // 影响判断是 append-only 事实：同一个 changeId 上「结论不同」是业务冲突，
        // 不是服务端故障。落到下面那个 500 分支的话，调用方会以为是自己把服务打挂了，
        // 而真正该做的是换新 changeId 重算。
        writeJson(res, 409, { error: error.code, message: error.message }, identity);
      } else if (error instanceof ChangeReceiptConflictError) {
        // 回执与影响判断同构：同一 changeId + layer 上「内容不同」是 append-only
        // 事实冲突，不是服务端故障。落到 500 的话调用方会以为是自己把服务打挂了。
        writeJson(res, 409, { error: error.code, message: error.message }, identity);
      } else if (error instanceof Error && /^DOCUMENT_(?:PATH_FORBIDDEN|SYMLINK_FORBIDDEN|CHANGES_REQUIRED|CHANGE_INVALID|EMPTY_ANCHOR|ANCHOR_NOT_UNIQUE)$/.test(error.message)) {
        writeJson(res, 400, { error: error.message, message: '文档路径或精确差异无效，请刷新原文并重新提交' }, identity);
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

  async function handleWithReviewerFence(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // impact 牌的 fail-closed 门禁必须在**一切之前**：reviewer fence、beforeRead、
    // readJson、具体 handler、onMutation 都可能在拒绝之前就动到状态。
    // 身份只从 x-coagent-run 解析，绝不看请求体——否则 body 里写一句
    // purpose: 'impact' 就能自称只读、写一句 role: 'coordinator' 就能自称可写。
    rejectImpactRunOutsideAllowlist(req);
    if (req.method !== 'POST') return handle(req, res);
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const missionControl = /^\/api\/missions\/([^/]+)\/(?:budget\/raise|checkpoint\/approve|escalations\/answer|contract|park|parked-resume|cancel|pause|resume|finalize(?:\/reviewer)?|work-items\/[^/]+\/retire|rerun)$/.exec(path);
    const planControl = /^\/api\/plan-runs\/([^/]+)\/decide$/.exec(path);
    const projectControl = /^\/api\/projects\/([^/]+)\/(?:mission-queue|execution-config)$/.exec(path);
    if (!missionControl && !planControl && !projectControl) return handle(req, res);
    await requireControlAuth(req, POLICY_ACTION.missionPause);
    let projectId: string | undefined;
    if (projectControl) projectId = decodeURIComponent(projectControl[1]);
    else if (missionControl) projectId = (await platform.getMissionView(missionControl[1])).projectId;
    else {
      const record = readPlanRunById(planRunDirs(), planControl![1]);
      if (record.status === 'ok') projectId = record.snapshot.projectId;
    }
    if (!projectId) return handle(req, res);
    return platform.withReviewerControl(projectId, { owner: String(req.headers['x-coagent-reviewer'] ?? ''),
      generation: Number(req.headers['x-coagent-reviewer-generation']) }, () => handle(req, res));
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    if (method === 'GET' && beforeRead && path.startsWith('/api/')) await beforeRead();

    if (method === 'GET' && path === '/api/health') {
      return send(res, 200, { ok: true, api: API_VERSION });
    }

    // S12.1：客户端 API 带版本，所有客户端（Web / L3 CLI / 别的 Host）走同一套，没有谁是特权客户端。
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

    if (method === 'GET' && path === '/api/runtime/usage') {
      await requireControl(req, POLICY_ACTION.missionRead);
      // 用量页要的是「有没有额度」，不是「适配层好不好」。适配器抛错时这里只能
      // 降级成 unavailable 并说明原因：500 会让整页空白，人也分不清是平台挂了还是
      // 没额度。note 只用固定文案 —— 错误原文里可能带命令、路径、凭据片段。
      try {
        const usage = await readUsage();
        return send(res, 200, usage);
      } catch {
        return send(res, 200, { available: false, note: '读取用量失败' });
      }
    }

    if (method === 'GET' && path === '/api/projects') {
      await requireControl(req, POLICY_ACTION.missionRead);
      return send(res, 200, await platform.listProjects());
    }

    /* ---- 候选池（资源池页的原料）。列、追加，以及额度熔断的人工复位 ---- */

    // 没有 DELETE / PATCH / PUT，也没有播种：GET 只读且受 control-read 门禁；
    // 「打开界面看一眼」不会改写候选池配置。复位是唯一的写例外，走下面的 POST。

    // 人工复位额度熔断。quota 熔断「没人充值就永远不会自己好」，只能靠人复位，
    // 所以这条写路径必须存在；每一次复位都留下 actor/at/reason 的审计记录 ——
    // 谁在什么时候为什么解的，事后要有据可查。
    const resetMatch = /^\/api\/pools\/([^/]+)\/circuit\/reset$/.exec(path);
    if (method === 'POST' && resetMatch) {
      await requireControl(req, POLICY_ACTION.poolAdd);
      const profileId = decodeProfileId(resetMatch[1]);
      const body = await readJson(req);
      const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
      // 没写理由的复位是审计里一条空白：事后分不清是充值了还是手滑。
      if (!reason) throw new HttpError(400, 'RESET_REASON_REQUIRED', 'reason 必须是非空字符串');
      const circuits = deps.candidateCircuits;
      // 缺仓储要明说「不可用」：静默 200 会让运维以为复位成功了。
      if (!circuits) {
        throw new HttpError(503, 'CIRCUIT_UNAVAILABLE', '本服务没有候选熔断仓储，无法复位');
      }
      const pool = await agentPool.list();
      const known = [
        ...pool.coordinator,
        ...pool.executor,
        ...pool.independent_reviewer,
        ...(pool.classifier ?? []),
      ].some((row) => row.profileId === profileId);
      if (!known) throw new HttpError(404, 'CANDIDATE_NOT_FOUND', `候选池里没有：${profileId}`);
      // actor 只取受控主体：调用方自称是谁不作数，审计要由凭据说话。
      const actor = await controlActor(resolveControlPrincipal, req);
      const at = new Date(nowMs()).toISOString();
      const circuit = await circuits.reset({ profileId, actor, at, reason }).catch((error: unknown) => {
        throw circuitResetHttpError(error, profileId);
      });
      return send(res, 200, { profileId, circuit: circuitHealth(circuit) });
    }

    // 复位审计只读。查历史不该要求写权限，所以走 poolList 而不是 poolAdd。
    const resetEventsMatch = /^\/api\/pools\/([^/]+)\/circuit\/reset-events$/.exec(path);
    if (method === 'GET' && resetEventsMatch) {
      await requireControl(req, POLICY_ACTION.poolList);
      const profileId = decodeProfileId(resetEventsMatch[1]);
      const circuits = deps.candidateCircuits;
      if (!circuits) {
        throw new HttpError(503, 'CIRCUIT_UNAVAILABLE', '本服务没有候选熔断仓储，读不到复位记录');
      }
      return send(res, 200, { profileId, events: await circuits.listResetEvents(profileId) });
    }
    if (method === 'GET' && path === '/api/pools/config') {
      await requireControl(req, POLICY_ACTION.poolList);
      const snapshot = await agentPool.list();
      return send(res, 200, { revision: agentPoolSnapshotRevision(snapshot), ...snapshot });
    }
    const replacePoolMatch = /^\/api\/pools\/(coordinator|executor|independent_reviewer|classifier)\/configure$/.exec(path);
    if (method === 'POST' && replacePoolMatch) {
      await requireControl(req, POLICY_ACTION.poolAdd);
      const body = await readJson(req);
      const snapshot = await agentPool.replaceRole({ ...body, role: replacePoolMatch[1] } as Parameters<typeof agentPool.replaceRole>[0]);
      return send(res, 200, { revision: agentPoolSnapshotRevision(snapshot), ...snapshot });
    }
    if (method === 'GET' && path === '/api/pools') {
      await requireControl(req, POLICY_ACTION.poolList);
      const snapshot = await agentPool.list();
      // 用量是附加信息：它读不到（失败 / 适配层不在 / 抛异常）时资源池仍要原样
      // 返回。先取再拼，取失败就当没有 —— 一个页面的可选列不该让整个池 500。
      const usageRows = await readUsageRows();
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
            usageRows,
            deps.queryRuns,
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

    const missionQueueMatch = /^\/api\/projects\/([^/]+)\/mission-queue$/.exec(path);
    if (method === 'GET' && missionQueueMatch) {
      await requireControl(req, POLICY_ACTION.missionRead);
      return send(res, 200, await platform.getMissionQueue(decodeURIComponent(missionQueueMatch[1])));
    }
    if (method === 'POST' && missionQueueMatch) {
      await requireControl(req, POLICY_ACTION.missionCreate);
      const body = await readJson(req);
      return send(res, 201, await platform.enqueueMissions(decodeURIComponent(missionQueueMatch[1]), body as unknown as Parameters<Platform['enqueueMissions']>[1]));
    }
    const executionConfigMatch = /^\/api\/projects\/([^/]+)\/execution-config$/.exec(path);
    if (method === 'POST' && executionConfigMatch) {
      await requireControl(req, POLICY_ACTION.missionCreate);
      const body = await readJson(req);
      return send(res, 200, await platform.configureProjectExecution(decodeURIComponent(executionConfigMatch[1]), body as unknown as Parameters<Platform['configureProjectExecution']>[1]));
    }

    if (method === 'GET' && path === '/api/plan-runs') {
      await requireControl(req, POLICY_ACTION.missionRead);
      const project = url.searchParams.get('project');
      const listed = listPlanRuns(planRunDirs(), project === null ? undefined : project);
      return send(res, 200, listed.map((item) => withRuntimeState(item, planRuntime)));
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
      return send(res, 200, withRuntimeState(result.snapshot, planRuntime));
    }

    const planRunDecideMatch = /^\/api\/plan-runs\/([^/]+)\/decide$/.exec(path);
    if (method === 'POST' && planRunDecideMatch) {
      await requireControl(req, POLICY_ACTION.missionPause);
      const id = planRunDecideMatch[1];
      const record = readPlanRunById(planRunDirs(), id);
      if (record.status === 'missing') throw new HttpError(404, 'PLAN_RUN_NOT_FOUND', '没有方案运行记录');
      if (record.status === 'corrupt') throw new HttpError(409, 'PLAN_RUN_CORRUPT', record.error);
      const duty = await platform.getReviewerDuty(record.snapshot.projectId);
      if (duty?.active || req.headers['x-coagent-reviewer']) {
        await platform.requireReviewerDuty(record.snapshot.projectId, String(req.headers['x-coagent-reviewer'] ?? ''), Number(req.headers['x-coagent-reviewer-generation']));
      }
      const body = await readJson(req);
      if (typeof body.escalationId !== 'string' || typeof body.decidedBy !== 'string'
        || (body.reason !== undefined && typeof body.reason !== 'string')
        || (body.answer !== undefined && typeof body.answer !== 'string')) {
        throw new HttpError(400, 'INVALID_PLAN_DECISION', '需要 escalationId、decidedBy，reason 与 answer 须为字符串');
      }
      const decision = { action: body.action, decidedBy: body.decidedBy,
        reason: body.reason as string | undefined, answer: body.answer as string | undefined, dropFeatures: body.dropFeatures };
      const resolution = await updatePlanRunById(planRunDirs(), id, (run) => {
        if (!planRuntime?.activeRunIds().includes(id)) {
          throw new PlatformRuleError('PLAN_RUN_NOT_ACTIVE', '当前服务没有承载该 PlanRun；请核实实际 Mission 决策路径');
        }
        return run.choose(body.escalationId as string, decision, new Date().toISOString());
      });
      return send(res, 200, { resolution });
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
      // 两个 impact 专属工具在**普通 AGENT_TOOL_ACTION 流程之前**分流：
      // 它们故意不在策略矩阵里，走普通流程会落到 UNKNOWN_TOOL，而真正要说清的
      // 是「你这张牌不是 impact 牌」；放到前面，门禁就只由 requireImpactChangeId
      // 一处说了算，也不会被任何将来新增的宽泛写别名顺带放行。
      if (IMPACT_EXCLUSIVE_TOOLS.has(tool)) {
        requireImpactChangeId(run);
        const body = redactSecretsDeep(await readJson(req));
        return send(res, 200, await handler(run, body as Record<string, never>));
      }
      // 回执组同样在普通 AGENT_TOOL_ACTION 之前分流：它们不在策略矩阵里，走普通
      // 流程会落到 UNKNOWN_TOOL，而要说清的是「你这张牌不是这一趟执行自己的牌」。
      // 门禁必须在 readJson 之前：先读 body 就等于让对方填的东西参与身份判定。
      if (RECEIPT_EXCLUSIVE_TOOLS.has(tool)) {
        requireExecutorReceiptRun(run);
        const body = redactSecretsDeep(await readJson(req));
        return send(res, 200, await handler(run, body as Record<string, never>));
      }
      // 覆盖声明同样在普通 AGENT_TOOL_ACTION 之前分流：它不在策略矩阵里，走普通
      // 流程会落到 UNKNOWN_TOOL，而要说清的是「你这张牌不是普通协调者牌」。
      // 门禁必须在 readJson 之前：先读 body 就等于让对方填的东西参与身份判定。
      if (COVERAGE_EXCLUSIVE_TOOLS.has(tool)) {
        requireCoordinatorCoverageRun(run);
        const body = redactSecretsDeep(await readJson(req));
        return send(res, 200, await handler(run, body as Record<string, never>));
      }
      // 验收处置同样在普通 AGENT_TOOL_ACTION 之前分流：它不在策略矩阵里，走普通
      // 流程会落到 UNKNOWN_TOOL，而要说清的是「你这张牌不是普通协调者牌」。
      // 门禁必须在 readJson 之前：先读 body 就等于让对方填的东西参与身份判定，
      // 非法 JSON 也会先变成 400 而不是 403。
      if (DISPOSITION_EXCLUSIVE_TOOLS.has(tool)) {
        requireCoordinatorDispositionRun(run);
        const body = redactSecretsDeep(await readJson(req));
        return send(res, 200, await handler(run, body as Record<string, never>));
      }
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

    // Web 项目规范只读入口：复用 Platform.getProjectContext，不给浏览器直读文件系统。
    const projectContextMatch = /^\/api\/missions\/([^/]+)\/project-context$/.exec(path);
    if (method === 'GET' && projectContextMatch) {
      await requireControl(req, POLICY_ACTION.missionRead);
      const slug = url.searchParams.get('slug') ?? undefined;
      return send(res, 200, await platform.getProjectContext(projectContextMatch[1], slug));
    }

    const missionMatch = /^\/api\/missions\/([^/]+)$/.exec(path);
    if (method === 'GET' && missionMatch) {
      await requireControl(req, POLICY_ACTION.missionRead);
      return send(res, 200, await platform.getMissionView(missionMatch[1]));
    }

    // 完整 ValidationReport 按 id 另取：Mission 视图只带简版投影，报告正文的 checks 可能很长，
    // 列表页不该为了显示一行状态把它整个拉过来。取报告与取 Mission 同级只读，共用 missionRead；
    // 归属不符与不存在同样回 404：报告是 append-only 机器证据，说「这份属于别的 Mission」
    // 等于给了跨 Mission 探测报告 id 的接口。
    const validationReportMatch = /^\/api\/missions\/([^/]+)\/validation-reports\/([^/]+)$/.exec(path);
    if (method === 'GET' && validationReportMatch) {
      await requireControl(req, POLICY_ACTION.missionRead);
      const report = await platform.getValidationReport(
        validationReportMatch[1],
        validationReportMatch[2],
      );
      if (!report) {
        throw new HttpError(404, 'VALIDATION_REPORT_NOT_FOUND', '没有这份验证报告');
      }
      return send(res, 200, report);
    }

    /* ---- L3 面：最终检视 ---- */

    const diffMatch = /^\/api\/missions\/([^/]+)\/diff$/.exec(path);
    if (method === 'GET' && diffMatch) {
      await requireControl(req, POLICY_ACTION.missionRead);
      return send(res, 200, await platform.getMissionDiff(diffMatch[1]));
    }

    // 费用增额：权限沿用答复升级那一格（控制面 operator），不新增 policy 动作、也不给 agent 工具开口；
    // 增额规则（基数、溢出、解除门禁）只有 Platform 一份，这里只验输入形状。
    const budgetRaiseMatch = /^\/api\/missions\/([^/]+)\/budget\/raise$/.exec(path);
    if (method === 'POST' && budgetRaiseMatch) {
      await requireControl(req, POLICY_ACTION.missionAnswerEscalation);
      const body = await readJson(req);
      const by = body.by === undefined ? 10 : body.by;
      if (typeof by !== 'number' || !Number.isFinite(by) || by <= 0) throw new HttpError(400, 'INVALID_COST_CAP', 'by 必须是有限正数（美元）');
      return send(res, 200, await platform.raiseMissionCostCap(budgetRaiseMatch[1], by));
    }

    // 显式签名批准工作项检查点：权限沿用答复升级那一格（与 costCap 增额同一格），不新增 policy 动作。
    // 这里只验**输入形状**（threshold/reviewer/reason 的类型与取值区间）；业务规则（到达、
    // 历史门禁、禁止跳过/未来、幂等）只有 Platform 一份，重复一遍就会漂。
    const checkpointApproveMatch = /^\/api\/missions\/([^/]+)\/checkpoint\/approve$/.exec(path);
    if (method === 'POST' && checkpointApproveMatch) {
      await requireControl(req, POLICY_ACTION.missionAnswerEscalation);
      const body = await readJson(req);
      const reviewer = body.reviewer;
      const reason = body.reason;
      if (typeof reviewer !== 'string' || reviewer.trim().length === 0) {
        throw new HttpError(400, 'INVALID_CHECKPOINT_SIGNATURE', 'reviewer 必须是 trim 后非空字符串');
      }
      if (typeof reason !== 'string' || reason.trim().length === 0) {
        throw new HttpError(400, 'INVALID_CHECKPOINT_SIGNATURE', 'reason 必须是 trim 后非空字符串');
      }
      // 15 的正整数倍：非 15 倍数和 Platform 投出的检查点卡对不上，会永不恢复。
      const threshold = body.threshold;
      if (typeof threshold !== 'number' || !Number.isInteger(threshold) || threshold <= 0 || threshold % CHECKPOINT_THRESHOLD_INTERVAL !== 0) {
        throw new HttpError(400, 'INVALID_CHECKPOINT_THRESHOLD', `threshold 必须是 ${CHECKPOINT_THRESHOLD_INTERVAL} 的正整数倍`);
      }
      return send(res, 200, await platform.approveWorkItemCheckpoint(checkpointApproveMatch[1], { threshold, reviewer, reason }));
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

    const parkedControlMatch = /^\/api\/missions\/([^/]+)\/(park|parked-resume)$/.exec(path);
    if (method === 'POST' && parkedControlMatch) {
      const [, id, verb] = parkedControlMatch;
      await requireControl(req, verb === 'park' ? POLICY_ACTION.missionPause : POLICY_ACTION.missionResume);
      const body = await readJson(req);
      if (verb === 'park') return send(res, 200, await platform.parkMission(id, { reason: String(body.reason ?? ''), reviewer: String(body.reviewer ?? '') }));
      return send(res, 200, await platform.resumeParkedMission(id, {
        reason: String(body.reason ?? ''), reviewer: String(body.reviewer ?? ''),
        ...(typeof body.answer === 'string' ? { answer: body.answer } : {}),
      }));
    }

    const controlMatch = /^\/api\/missions\/([^/]+)\/(cancel|pause|resume)$/ .exec(path);
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

    const projectDocumentsMatch = /^\/api\/projects\/([^/]+)\/documents$/.exec(path);
    if (method === 'GET' && projectDocumentsMatch) {
      await requireControl(req, POLICY_ACTION.inboxRead);
      return send(res, 200, { proposals: await platform.listDocumentProposals(decodeURIComponent(projectDocumentsMatch[1])) });
    }
    if (method === 'POST' && projectDocumentsMatch) {
      await requireControl(req, POLICY_ACTION.missionRevise);
      const body = await readJson(req);
      const projectId = decodeURIComponent(projectDocumentsMatch[1]);
      if (typeof body.missionId !== 'string' || (await platform.getMissionView(body.missionId)).projectId !== projectId) {
        throw new HttpError(400, 'DOCUMENT_PROJECT_MISMATCH', '提议需绑定本项目的 Mission');
      }
      const result = await platform.withReviewerControl(projectId, { owner: body.generation === undefined ? '' : String(body.reviewer ?? ''),
        generation: Number(body.generation) }, () => platform.proposeDocument(body as never));
      return send(res, 201, result);
    }
    const documentDecisionMatch = /^\/api\/documents\/([^/]+)\/decide$/.exec(path);
    if (method === 'POST' && documentDecisionMatch) {
      await requireControl(req, POLICY_ACTION.missionRevise);
      const id = decodeURIComponent(documentDecisionMatch[1]);
      const row = (await platform.listDocumentProposals()).find((entry) => entry.id === id);
      if (!row) throw new HttpError(404, 'DOCUMENT_NOT_FOUND', '文档提议不存在');
      const body = await readJson(req);
      const result = await platform.withReviewerControl(row.projectId, { owner: body.generation === undefined ? '' : String(body.reviewer ?? ''),
        generation: Number(body.generation) }, () => platform.decideDocument(id, body as never, true));
      const queue = body.action === 'approve' ? await platform.flushDocumentQueue(row.projectId) : undefined;
      return send(res, 200, { ...(await platform.listDocumentProposals(row.projectId)).find((entry) => entry.id === result.id), queue });
    }
    const documentFlushMatch = /^\/api\/projects\/([^/]+)\/documents\/flush$/.exec(path);
    if (method === 'POST' && documentFlushMatch) {
      await requireControl(req, POLICY_ACTION.missionRevise);
      const body = await readJson(req);
      return send(res, 200, await platform.withReviewerControl(decodeURIComponent(documentFlushMatch[1]), {
        owner: body.generation === undefined ? '' : String(body.reviewer ?? ''), generation: Number(body.generation),
      }, () => platform.flushDocumentQueue(decodeURIComponent(documentFlushMatch[1]))));
    }

    if (method === 'GET' && path === '/api/reviewer/todos') {
      await requireControl(req, POLICY_ACTION.inboxRead);
      return send(res, 200, { todos: await reviewerTodoList(url.searchParams.get('projectId') ?? undefined) });
    }
    if (method === 'GET' && path === '/api/reviewer/wait') {
      await requireControl(req, POLICY_ACTION.inboxRead);
      const projectId = url.searchParams.get('projectId') ?? '';
      const owner = url.searchParams.get('owner') ?? '';
      const generation = Number(url.searchParams.get('generation'));
      const waitMs = Number(url.searchParams.get('waitMs') ?? 25000);
      if (!projectId || !owner || !Number.isSafeInteger(generation) || generation <= 0
          || !Number.isInteger(waitMs) || waitMs < 0 || waitMs > 25000) {
        throw new HttpError(400, 'INVALID_REVIEWER_WAIT', '需要 projectId、owner、正整数 generation；waitMs 为0–25000。');
      }
      const result = await waitForReviewerTodos({ platform, projectId, owner, generation, waitMs,
        cursor: url.searchParams.get('cursor') ?? undefined, disconnected: () => res.destroyed,
        list: () => reviewerTodoList(projectId) });
      if (!res.destroyed) return send(res, 200, result);
      return;
    }
    const masterBriefMatch = /^\/api\/projects\/([^/]+)\/master-brief$/.exec(path);
    if (method === 'GET' && masterBriefMatch) {
      await requireControl(req, POLICY_ACTION.missionRead);
      return send(res, 200, await platform.getMasterMergeBrief(decodeURIComponent(masterBriefMatch[1])));
    }
    const reviewerDutyMatch = /^\/api\/projects\/([^/]+)\/reviewer-duty$/.exec(path);
    if (method === 'GET' && reviewerDutyMatch) {
      await requireControl(req, POLICY_ACTION.inboxRead);
      return send(res, 200, { duty: await platform.getReviewerDuty(decodeURIComponent(reviewerDutyMatch[1])) ?? null });
    }
    if (method === 'POST' && reviewerDutyMatch) {
      await requireControl(req, POLICY_ACTION.missionPause);
      return send(res, 200, await platform.changeReviewerDuty(decodeURIComponent(reviewerDutyMatch[1]), await readJson(req) as never));
    }
    const reviewerTodoMatch = /^\/api\/reviewer\/todos\/([^/]+)$/.exec(path);
    if (method === 'POST' && reviewerTodoMatch) {
      await requireControl(req, POLICY_ACTION.missionPause);
      const body = await readJson(req);
      // 已领取值守的项目拒绝另一个会话，保留尚未采用值守协议的兼容入口。
      const todo = (await platform.listReviewerTodos()).find((entry) => entry.id === decodeURIComponent(reviewerTodoMatch[1]));
      const decide = () => platform.decideReviewerTodo(decodeURIComponent(reviewerTodoMatch[1]), body as never);
      const result = todo ? await platform.withReviewerControl(todo.projectId,
        { owner: body.generation === undefined ? '' : String(body.reviewer ?? ''), generation: Number(body.generation) }, decide) : await decide();
      return send(res, 200, result);
    }

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
        pool.independent_reviewer.filter((row) => row.enabled !== false).map((row) => ({
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
      await requireControl(req, POLICY_ACTION.missionCreate);
      if (!deps.runPlan) throw new HttpError(410, 'PLAN_RUN_RETIRED', '方案运行已退役，请确认 Mission 列表后提交项目 mission-queue。');
      return startHostedRun(req, res, deps.runPlan, 'run-plan');
    }

    throw new HttpError(404, 'NOT_FOUND', `${method} ${path}`);
  }
}

export { HttpError, RunTokenRegistry };
