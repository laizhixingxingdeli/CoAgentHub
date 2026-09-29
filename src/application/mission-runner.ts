/**
 * 由既有平台实例跑一条 Mission 的内部编排入口。
 *
 * 调用方已经握着 Platform、发牌口、回环 API 的 baseUrl、工作区和候选。
 * 这里不建持久平台、不 listen、不拿锁——那些是 CLI / 观测面的装配。
 * 不这么抽的话，每个入口都会再起一套平台和 API，agent 回连到错的口，
 * 文件锁也会自己和自己打架。
 */

import { resolve } from 'node:path';
import type {
  ComplexityAssessment,
  MissionContract,
  WorkOrder,
} from '../kernel/index.ts';
import {
  loadPoolOrSeed,
  type AgentPoolCandidate,
  type AgentPoolRepository,
} from './agent-pool.ts';
import type { DeliveryRepository } from './delivery.ts';
import type { LiveOutput } from './live.ts';
import {
  Orchestrator,
  inRunBackoffWaitMs,
  type HopRecord,
  type MissionRunOutcome,
  type RolePool,
  type RunMissionOptions,
} from './orchestrator.ts';
import { hopCapacityLimits, type HopCapacityLimits } from './durable-scheduler.ts';
import type {
  ActivityLog,
  AgentRuntime,
  CandidateCircuitRepository,
  Clock,
  ExecutionProfile,
  IdGenerator,
  QueuedHopRepository,
} from './ports.ts';
import type { Platform } from './platform.ts';
import {
  parseAgentEnvPassthrough,
  SPAWN_ENV_PASSTHROUGH_VAR,
  SPAWN_ENV_UNDECLARED_MESSAGE,
  SpawnRuntime,
} from '../runtime/spawn.ts';
import type { TaskFacts } from './task-classifier.ts';
import type { RunTokenIssuer } from './token-issuer.ts';
import { InPlaceWorkspaceManager, type WorkspaceManager } from './workspace.ts';

/** Parse the optional CLI value while keeping omission distinct from a missing value. */
export function parseMaxRounds(raw: string | undefined, supplied: boolean): number | undefined {
  if (!supplied) return undefined;
  if (raw === undefined || raw.startsWith('--') || !/^\d+$/.test(raw)) {
    throw new Error('--max-rounds must be an integer in the range 1–100');
  }
  const value = Number(raw);
  if (value < 1 || value > 100) {
    throw new Error('--max-rounds must be an integer in the range 1–100');
  }
  return value;
}

export interface MissionRunnerDeps {
  readonly platform: Platform;
  readonly tokens: RunTokenIssuer;
  /** 已在听的回环 API。入口本身不 listen、不 createApi。 */
  readonly baseUrl: string;
  readonly workspace: WorkspaceManager;
  readonly coordinator: RolePool;
  readonly executor: RolePool;
  readonly independentReviewer?: RolePool;
  readonly live?: LiveOutput;
  readonly acceptStaleBase?: boolean;
  readonly attemptWallClockMs?: number;
  readonly owner?: string;
  readonly candidateCircuits?: CandidateCircuitRepository;
  /** Production wiring uses this name; omit to keep pre-queue behaviour. */
  readonly queuedHops?: QueuedHopRepository;
  readonly hopClock?: Clock;
  readonly hopLeaseMs?: number;
  readonly hopIds?: IdGenerator;
  /**
   * 五维并发上限。省略则用代码默认值。必须在构造时归一化：坏值若拖到
   * run() 才抛，队列可能已被领取、Agent 已经启动。
   */
  readonly hopCapacityLimits?: HopCapacityLimits;
  /**
   * 可换候选失败后同一次运行内等待退避的上限。缺省 0。
   * 与编排器同名，构造时校验，避免非法值活到第一跳失败。
   */
  readonly inRunBackoffWaitMs?: number;
}

export interface MissionRunnerResult {
  readonly outcome: MissionRunOutcome;
  readonly hops: readonly HopRecord[];
  readonly workspace: Orchestrator['workspace'];
}

export class MissionRunner {
  readonly #deps: MissionRunnerDeps;

  constructor(deps: MissionRunnerDeps) {
    // 同步校验并写入归一化副本，再交给 Orchestrator。未指定用 hopCapacityLimits()
    // 的默认值。不这么做的话，非法上限会活到第一跳领取。
    this.#deps = {
      ...deps,
      hopCapacityLimits: hopCapacityLimits(deps.hopCapacityLimits),
      inRunBackoffWaitMs: inRunBackoffWaitMs(deps.inRunBackoffWaitMs),
    };
  }

  async run(missionId: string, options: RunMissionOptions): Promise<MissionRunnerResult> {
    // 每条 Mission 新编排器：冷却表和「连续无提交」按上一跳计，跨 Mission 复用会误判。
    const orchestrator = new Orchestrator(this.#deps);
    const outcome = await orchestrator.runMission(missionId, options);
    return {
      outcome,
      hops: orchestrator.hops,
      workspace: orchestrator.workspace,
    };
  }
}

/** hosted run 进度。channel 必须可区分，调用方不能靠猜 stdout/stderr。 */
export type HostedMissionEmit = (channel: 'stdout' | 'stderr', line: string) => void;

/**
 * 服务真正持锁的状态。权威在这边，不在请求 body。
 * 单测直调可以省略（不假装握着文件锁）；PG 必须是 unsupported，不能冒充 file。
 */
export type HostedHeldState =
  | {
      readonly kind: 'file';
      readonly statePath: string;
      /** 口径由持锁方注入，与 stateIdFor（含 Windows 大小写）一致。 */
      readonly identityEquals: (submittedStatePath: string) => boolean;
    }
  | { readonly kind: 'unsupported' };

/**
 * 回环 body.state 必须对上持锁文件。失败发生在任何 create / seed / PlanRun 之前。
 * held 省略时不查——那是没有服务锁的直调；不能因此把 body.state 当成锁路径去开跑。
 */
export function assertHostedHeldState(
  bodyState: unknown,
  held: HostedHeldState | undefined,
  what: string,
): void {
  if (held === undefined) return;
  if (held.kind !== 'file') {
    throw new Error(
      `hosted ${what} 不支持当前服务存储：PG 不宣称跨主机唯一写者，拒绝冒充文件锁。未写入。`,
    );
  }
  if (typeof bodyState !== 'string' || bodyState.length === 0) {
    throw new Error(`hosted ${what} 缺少 state：必须指向服务持锁的同一状态文件。未写入。`);
  }
  if (!held.identityEquals(bodyState)) {
    throw new Error(`hosted ${what} 的 state 与服务持锁状态不是同一文件。未写入。`);
  }
}

/**
 * CLI 声明了额外透传名时，hosted 拿不到取值（回环禁止带变量值），
 * 也不能用服务 process.env 顶替。独立 CLI 路径不受这条限制。
 */
export const HOSTED_AGENT_ENV_UNPROVEN_MESSAGE =
  'hosted Mission 无法证明 CLI 声明的 agent 环境变量取值与独立 CLI 口径一致，且不得把变量值放入回环。将 COAGENT_AGENT_ENV_PASSTHROUGH 设为 - 后再转发，或在无常驻服务时运行。未写入。';

/**
 * 持锁服务已经装好的依赖。tokens 必须是 makeIssuer 之后的发牌口；
 * 若同时带 issuer，优先用 issuer——startServer 的 built.issuer 就是这份。
 * 不要在 hosted 入口里另建 platform / listen / 锁。
 */
export interface HostedMissionBuilt {
  readonly platform: Platform;
  readonly tokens: RunTokenIssuer;
  readonly agentPool: AgentPoolRepository;
  readonly activity: ActivityLog;
  readonly deliveries: DeliveryRepository;
  readonly persist: () => void | Promise<void>;
  readonly candidateCircuits?: CandidateCircuitRepository;
  readonly queuedHops?: QueuedHopRepository;
  readonly live?: LiveOutput;
  readonly issuer?: RunTokenIssuer;
}

/**
 * startServer 把本函数挂到 HTTP 面 runMission 回调时注入的上下文。
 *
 * 签名（给后续 main 工单）：
 *   runHostedMission(
 *     body: Record<string, unknown>,
 *     ctx: HostedMissionContext,
 *     emit: HostedMissionEmit,
 *   ): Promise<number>
 *
 * 接线：
 *   回调 (body, emit) => runHostedMission(body, ctx, emit)
 */
export interface HostedMissionContext {
  readonly built: HostedMissionBuilt;
  readonly baseUrl: string;
  readonly workspace: WorkspaceManager;
  /**
   * 服务 options.env，只作子进程 env **源**。
   * agent 透传名单只解析 body.env.COAGENT_AGENT_ENV_PASSTHROUGH，
   * 读这里的同名键等于偷偷用服务自己的名单。
   */
  readonly env?: NodeJS.ProcessEnv;
  /** 测试注入；生产省略，按 body.adapter 构造 SpawnRuntime。 */
  readonly runtime?: AgentRuntime;
  /**
   * 服务启动时拿到的持锁状态。缺省 = 直调、不做跨请求身份门。
   * startServer 必须注入；不能从 body.state 回填。
   */
  readonly heldState?: HostedHeldState;
}

export interface HostedMissionSpec {
  readonly projectId: string;
  readonly missionId: string;
  readonly contract: MissionContract;
  readonly routing?: {
    readonly facts: TaskFacts;
    readonly assessment?: ComplexityAssessment;
    readonly workOrder?: WorkOrder;
  };
}

function hostedIssuer(built: HostedMissionBuilt): RunTokenIssuer {
  if (built.issuer && typeof built.issuer.startCoordinator === 'function') {
    return built.issuer;
  }
  return built.tokens;
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error('参数必须是字符串');
  return value;
}

function toProfile(candidate: AgentPoolCandidate): ExecutionProfile {
  return {
    endpoint: candidate.endpoint,
    profileId: candidate.profileId,
    ...(candidate.facts.length > 0 ? { facts: candidate.facts } : {}),
  };
}

function pickHostedCandidates(
  pool: readonly AgentPoolCandidate[],
  role: 'coordinator' | 'executor' | 'independent_reviewer',
  flag: string,
  wanted: string | undefined,
): AgentPoolCandidate[] {
  if (!wanted) return [...pool];
  const ids = wanted.split(',').map((s) => s.trim()).filter(Boolean);
  return ids.map((id) => {
    const found = pool.find((c) => c.profileId === id);
    if (!found) {
      throw new Error(
        `${flag} 指定的候选 ${id} 不在${role}池里。可选：${pool.map((c) => c.profileId).join('、')}`,
      );
    }
    return found;
  });
}

/**
 * 校验 CLI 回环过来的 body。失败必须发生在任何 createMission / persist / 开跑之前。
 * 透传名单只看 body 里 CLI 提交的声明，不看服务 process.env。
 * 持锁身份以 heldState 为准，不把 body.state 当权威路径。
 */
export function parseHostedMissionBody(
  body: Record<string, unknown>,
  heldState?: HostedHeldState,
): {
  readonly spec: HostedMissionSpec;
  readonly cwd: string;
  readonly adapter: string;
  readonly envPassthrough: readonly string[];
  readonly coordinator?: string;
  readonly executor?: string;
  readonly independentReviewer?: string;
  readonly maxRounds?: number;
  readonly acceptStaleBase: boolean;
  readonly origin?: string;
  readonly inPlace: boolean;
  readonly worktrees?: string;
  readonly store?: string;
} {
  assertHostedHeldState(body.state, heldState, 'Mission');
  const specRaw = asObject(body.spec, 'spec');
  const projectId = specRaw.projectId;
  const missionId = specRaw.missionId;
  if (typeof projectId !== 'string' || projectId.length === 0) {
    throw new Error('spec.projectId 必填');
  }
  if (typeof missionId !== 'string' || missionId.length === 0) {
    throw new Error('spec.missionId 必填');
  }
  if (typeof specRaw.contract !== 'object' || specRaw.contract === null) {
    throw new Error('spec.contract 必填');
  }
  const spec: HostedMissionSpec = {
    projectId,
    missionId,
    contract: specRaw.contract as MissionContract,
    ...(specRaw.routing !== undefined
      ? { routing: specRaw.routing as HostedMissionSpec['routing'] }
      : {}),
  };

  const cwd = optionalString(body.cwd);
  if (!cwd) throw new Error('cwd 必填');
  const adapter = optionalString(body.adapter);
  if (!adapter) throw new Error('adapter 必填');

  const envBag = body.env;
  const rawPass =
    typeof envBag === 'object' && envBag !== null && !Array.isArray(envBag)
      ? (envBag as Record<string, unknown>)[SPAWN_ENV_PASSTHROUGH_VAR]
      : undefined;
  if (typeof rawPass !== 'string') {
    throw new Error(SPAWN_ENV_UNDECLARED_MESSAGE);
  }
  const envPassthrough = parseAgentEnvPassthrough(rawPass);
  if (envPassthrough === undefined) {
    throw new Error(SPAWN_ENV_UNDECLARED_MESSAGE);
  }
  if (envPassthrough.length > 0) {
    throw new Error(HOSTED_AGENT_ENV_UNPROVEN_MESSAGE);
  }

  let maxRounds: number | undefined;
  if (body.maxRounds !== undefined && body.maxRounds !== null) {
    if (typeof body.maxRounds === 'number') {
      maxRounds = parseMaxRounds(String(body.maxRounds), true);
    } else if (typeof body.maxRounds === 'string') {
      maxRounds = parseMaxRounds(body.maxRounds, true);
    } else {
      throw new Error('--max-rounds must be an integer in the range 1–100');
    }
  }

  const store = optionalString(body.store);
  if (store === 'pg') {
    throw new Error('hosted Mission 不接受 --store pg：PG 保持单实例 CLI 路径。未写入。');
  }

  const worktrees = optionalString(body.worktrees);
  if (worktrees !== undefined && worktrees.length > 0) {
    throw new Error('hosted Mission 不支持改 --worktrees：须使用服务已装配的工作区。未写入。');
  }

  return {
    spec,
    cwd: resolve(cwd),
    adapter: resolve(adapter),
    envPassthrough,
    coordinator: optionalString(body.coordinator),
    executor: optionalString(body.executor),
    independentReviewer: optionalString(body.independentReviewer),
    ...(maxRounds === undefined ? {} : { maxRounds }),
    acceptStaleBase: body.acceptStaleBase === true,
    origin: optionalString(body.origin),
    inPlace: body.inPlace === true,
    ...(worktrees ? { worktrees } : {}),
    ...(store ? { store } : {}),
  };
}

/**
 * 在已持锁服务上跑一条 Mission。复用 MissionRunner，不另建平台、不 listen。
 * 工作区必须是服务装配 Platform 校验器的那一份。
 */
export async function runHostedMission(
  body: Record<string, unknown>,
  ctx: HostedMissionContext,
  emit: HostedMissionEmit,
): Promise<number> {
  const parsed = parseHostedMissionBody(body, ctx.heldState);
  if (parsed.inPlace && !(ctx.workspace instanceof InPlaceWorkspaceManager)) {
    throw new Error('hosted Mission 不支持 --in-place：服务工作区不是原地工作区。未写入。');
  }

  const { platform, agentPool, activity, deliveries, persist, candidateCircuits, queuedHops, live } =
    ctx.built;
  const tokens = hostedIssuer(ctx.built);
  const origin = {
    clientType: 'cli',
    conversationRef: parsed.origin ?? 'local-cli',
  };

  // 非法 --coordinator/--executor/--independent-reviewer 必须在 createMission 之前抛：
  // 否则会留下半截 Mission，独立 CLI 路径也不会在开跑前写入。
  const pool = await loadPoolOrSeed(agentPool);
  const coordinatorPool = pickHostedCandidates(
    pool.coordinator,
    'coordinator',
    '--coordinator',
    parsed.coordinator,
  );
  const executorPool = pickHostedCandidates(pool.executor, 'executor', '--executor', parsed.executor);
  const independentReviewerPool = pickHostedCandidates(
    pool.independent_reviewer,
    'independent_reviewer',
    '--independent-reviewer',
    parsed.independentReviewer,
  );

  const existing = await platform.getMissionView(parsed.spec.missionId).catch(() => undefined);
  if (existing) {
    emit('stdout', `Mission ${parsed.spec.missionId} 已存在（${existing.status}），接着往下跑`);
  } else if (parsed.spec.routing) {
    await platform.createClassifiedMission({
      projectId: parsed.spec.projectId,
      missionId: parsed.spec.missionId,
      contract: parsed.spec.contract,
      origin,
      facts: parsed.spec.routing.facts,
      assessment: parsed.spec.routing.assessment,
      workOrder: parsed.spec.routing.workOrder,
    });
  } else {
    await platform.createMission({
      projectId: parsed.spec.projectId,
      missionId: parsed.spec.missionId,
      contract: parsed.spec.contract,
      origin,
    });
  }
  emit('stdout', `Mission ${parsed.spec.missionId}；平台监听 ${ctx.baseUrl}`);
  emit('stdout', `worktree: ${parsed.cwd}`);
  emit('stdout', `适配器  : ${parsed.adapter}`);

  const runtime =
    ctx.runtime ??
    new SpawnRuntime({
      kind: 'pi',
      command: 'npx',
      args: ['tsx', parsed.adapter],
      cwd: resolve(parsed.adapter, '../..'),
      timeoutMs: 5 * 60 * 1000,
      stream: true,
      envPassthrough: parsed.envPassthrough,
      ...(ctx.env ? { env: ctx.env } : {}),
    });
  if (parsed.coordinator || parsed.executor || parsed.independentReviewer) {
    emit(
      'stdout',
      `本次候选：协调者 ${coordinatorPool.map((c) => c.profileId).join('、')} / ` +
        `执行者 ${executorPool.map((c) => c.profileId).join('、')} / ` +
        `独立检视 ${independentReviewerPool.map((c) => c.profileId).join('、') || '（无）'}`,
    );
  }

  const runner = new MissionRunner({
    platform,
    // 同一条通道：编排器流式 append；Platform.finishAttempt 在落地前取本跳 200 行尾。
    // 漏传的话任务页「输出末尾」重启后仍是空的——hosted 不能另开一套 live。
    live,
    tokens,
    baseUrl: ctx.baseUrl,
    workspace: ctx.workspace,
    candidateCircuits,
    queuedHops,
    inRunBackoffWaitMs: 120_000,
    acceptStaleBase: parsed.acceptStaleBase,
    coordinator: {
      runtime,
      candidates: coordinatorPool.map(toProfile),
    },
    executor: {
      runtime,
      candidates: executorPool.map(toProfile),
    },
    independentReviewer: {
      runtime,
      candidates: independentReviewerPool.map(toProfile),
    },
  });

  const ran = await runner.run(
    parsed.spec.missionId,
    {
      projectRoot: parsed.cwd,
      ...(parsed.maxRounds === undefined ? {} : { maxRounds: parsed.maxRounds }),
    },
  );
  const result = ran.outcome;
  const detail =
    'detail' in result
      ? ` —— ${result.detail}`
      : 'reason' in result
        ? ` —— ${result.reason}`
        : 'question' in result
          ? ` —— ${result.question}`
          : '';
  emit('stdout', `${'='.repeat(72)}`);
  emit('stdout', `Mission 结果：${result.kind}${detail}`);
  emit('stdout', `${'='.repeat(72)}`);
  for (const hop of ran.hops) {
    emit(
      'stdout',
      `  ${hop.role.padEnd(12)}${(hop.workItemId ?? '-').padEnd(6)}${hop.profile.profileId.padEnd(18)}` +
        `${hop.endedBy}${hop.failureMessage ? ` —— ${hop.failureMessage.slice(0, 80)}` : ''}`,
    );
  }

  const view = await platform.getMissionView(parsed.spec.missionId);
  emit('stdout', '工作项：');
  for (const item of view.workItems) {
    emit(
      'stdout',
      `  ${item.id.padEnd(6)}${item.status.padEnd(11)}${item.attempts} 次尝试  ${item.title}`,
    );
  }
  const usage = view.usage;
  emit(
    'stdout',
    `用量（${usage.quality}）：in=${usage.input} out=${usage.output} cacheRead=${usage.cacheRead} ` +
      `total=${usage.total} cost=$${(usage.cost ?? 0).toFixed(4)}`,
  );
  emit('stdout', `事件：${(await activity.list(parsed.spec.missionId)).length} 条`);
  if (ran.workspace) {
    emit(
      'stdout',
      `工作区：${ran.workspace.cwd}（分支 ${ran.workspace.branch}，基线 ${ran.workspace.baseRevision.slice(0, 8)}）`,
    );
  }
  const inbox = await deliveries.pending(origin.conversationRef);
  emit(
    'stdout',
    `收件箱：${inbox.length} 条待取${inbox.length ? `（${inbox.map((d) => d.id).join(', ')}）` : ''}`,
  );
  await persist();
  if (view.result) {
    emit('stdout', `Mission Result：
${JSON.stringify(view.result, null, 2)}`);
  }
  return 0;
}
