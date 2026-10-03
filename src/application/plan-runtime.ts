/**
 * 由既有平台实例跑一份已筛选方案的内部入口。
 *
 * 调用方已经握着 Platform、独立 PlanRun 仓储、MissionRunner、可选 runQuery。
 * 这里不建第二份平台、不 listen、不拿主状态锁——那些是 CLI / 观测面的装配。
 * 不这么抽的话，常驻服务和 CLI 会各装一套规则，筛选口径和终审接线会分叉。
 *
 * 候选/HA/机器终审怎么判，全部交给 drivePlan；本文件只建记录并接线。
 */

import { join, resolve } from 'node:path';
import {
  loadRoleProfiles,
  type AgentPoolCandidate,
  type AgentPoolRepository,
} from './agent-pool.ts';
import { InMemoryQueryRunRepository, SequentialIds, SystemClock } from './in-memory.ts';
import type { LiveOutput, PlanRunLiveOutput } from './live.ts';
import {
  assertHostedHeldState,
  MissionRunner,
  parseMaxRounds,
  type HostedHeldState,
} from './mission-runner.ts';
import { renderPlanHandoff } from './plan-handoff.ts';
import { preflightPlanMissionSlots, preflightPlanRepo, slotHolders } from './plan-preflight.ts';
// slotHolders formatting remains owned by shared preflight for rejected missions.
import { drivePlan, runWithDeadline, type PlanDriverDeps } from './plan-driver.ts';
import type { QueuedHop } from './durable-scheduler.ts';
import { PlanRun, type PlanRunStop } from './plan-run.ts';
import { FilePlanRunStore } from './plan-run-store.ts';
import { buildRoutingPrompt, parseRoutingProposal } from './plan-routing.ts';
import {
  parsePlanSpec,
  selectPlanCandidates,
  type PlanCandidateSelection,
  type PlanSpec,
} from './plan-spec.ts';
import type { Platform } from './platform.ts';
import type {
  AgentRuntime,
  CandidateCircuitRepository,
  Clock,
  ExecutionProfile,
  IdGenerator,
  QueuedHopRepository,
} from './ports.ts';
import {
  type RoleCooldownCandidate,
  type RolePoolName,
} from './orchestrator.ts';
import { QueryRunner, type QueryRunRepository, type RunQueryInput, type RunQueryResult } from './query-run.ts';
import type { RunTokenIssuer } from './token-issuer.ts';
import type { WorkspaceManager } from './workspace.ts';
import {
  parseAgentEnvPassthrough,
  SPAWN_ENV_PASSTHROUGH_VAR,
  SPAWN_ENV_UNDECLARED_MESSAGE,
  SpawnRuntime,
} from '../runtime/spawn.ts';

/** 独立方案运行仓储：create / read / update。不绑文件实现，好让后续 CLI 直接接入。 */
export interface PlanRuntimeStore {
  create(run: PlanRun): Promise<void>;
  read(): PlanRun | undefined;
  update<T>(mutate: (run: PlanRun) => T): Promise<T>;
}

export interface PlanRuntimeDeps {
  readonly store: PlanRuntimeStore;
  readonly projectRoot: string;
  /** 方案驱动用到的那几面；入口不另包一层 Platform。 */
  readonly platform: PlanDriverDeps['platform'];
  /** 每条 Mission：`runner.run(missionId, { projectRoot })`，outcome 交给 drivePlan。 */
  readonly runMission: MissionRunner['run'];
  /** 外层已认证的恢复映射，由驱动用于续跑已有 Mission。 */
  readonly resumeMissions?: Readonly<Record<string, string>>;
  readonly runQuery?: (input: RunQueryInput) => Promise<RunQueryResult>;
  /** 分类员用的 profile；缺省走 query 自己的默认。 */
  readonly queryProfile?: ExecutionProfile;
  readonly persist: () => Promise<void>;
  /** 墙钟到点：暂停在途 Mission。入口不猜 platform.pauseMission 在不在。 */
  readonly pauseInFlight: (missionId: string) => Promise<void>;
  readonly now: () => string;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (line: string) => void;
  readonly runId: string;
  readonly startedAt?: string;
  readonly checkRepo?: () => Promise<readonly string[]>;
  readonly pollMs?: number;
  /**
   * 见 plan-driver 的 WaitEligibility：判一条 waiting 是不是本 Mission 在运行内等得到头。
   * 缺省不等待，照旧开升级单——没有结构性证明就等，等于把整晚押在一条猜出来的原因上。
   */
  readonly waitEligibility?: PlanDriverDeps['waitEligibility'];
}

async function persistAfter<T>(persist: () => Promise<void>, work: Promise<T>): Promise<T> {
  const result = await work;
  await persist();
  return result;
}

export interface QueuedHopWaitEligibilityDeps {
  /** 读持久队列行。读不到（抛错）时探针返回 undefined，不猜。 */
  readonly list: () => Promise<readonly QueuedHop[]>;
  /** 当前时刻；capacity 的短轮询与 availableAt / leaseUntil 的比较都按它算。 */
  readonly now: () => string;
  /** 自己占着名额时多久复核一次。缺省 5 秒——占位只能短轮询，猜不出完工时刻。 */
  readonly capacityPollMs?: number;
}

/**
 * 生产用等待资格探针：只从持久 Hop 记录里认**本 Mission 自己**的退避 / 占位。
 *
 * 驱动的 WaitEligibility 刻意不接受「project_busy 就是自己占名额」这种从字样推出来的
 * 结论——同一个 reason 既可能是自己另一个在途工作项占着名额（该等），也可能是别的
 * Mission 在改代码（等不到头）。所以这里按 missionId 过滤队列行：
 *   - 本 Mission 有 retry_wait 且 availableAt 还没到 → own_backoff，睡到最早那刻重试；
 *   - 否则本 Mission 有 claimed 且租约还没到期 → capacity，短轮询复核；
 *   - 其余一律 undefined，交回驱动走原升级处置。
 *
 * detail 文案一个字都不看——它只分得出「发生了什么」，分不出归属。读库出错也返回
 * undefined：读不到就猜，等于没证据地空等一整晚。
 */
export function createQueuedHopWaitEligibility(
  deps: QueuedHopWaitEligibilityDeps,
): NonNullable<PlanDriverDeps['waitEligibility']> {
  return async ({ missionId, reason }) => {
    // 只有「名额被占」值得探一次；其余 reason 探队列也证明不了本 Mission 等得到头。
    if (reason !== 'project_busy') return undefined;
    let rows: readonly QueuedHop[];
    try {
      rows = await deps.list();
    } catch {
      return undefined;
    }
    const nowMs = Date.parse(deps.now());
    if (!Number.isFinite(nowMs)) return undefined;
    const mine = rows.filter((row) => row.missionId === missionId);

    // 自己的退避优先：最早到期的那个有效 availableAt 就是重试时刻。
    const backoffs = mine
      .filter((row) => row.status === 'retry_wait')
      .map((row) => Date.parse(row.availableAt))
      .filter((at) => Number.isFinite(at) && at > nowMs);
    if (backoffs.length > 0) {
      return { kind: 'own_backoff', availableAt: new Date(Math.min(...backoffs)).toISOString() };
    }

    // 自己另一个在途工作项占着名额：租约还没到期，只能短轮询复核。
    const holdsLease = mine.some((row) => {
      if (row.status !== 'claimed') return false;
      const until = Date.parse(row.leaseUntil ?? '');
      return Number.isFinite(until) && until > nowMs;
    });
    if (holdsLease) {
      const pollMs = deps.capacityPollMs ?? 5_000;
      return { kind: 'capacity', nextPollAt: new Date(nowMs + pollMs).toISOString() };
    }

    return undefined;
  };
}

/**
 * 共享资格工厂：把「本 Mission 在运行内等得到头」的两种证明并到一个探针里。
 *
 * 为什么合并：hosted 入口要在 runner 构造后同时启用「自己的退避/占位」和
 * 「指定角色候选全冷却」两类等待，而不是各装各的探针导致逻辑分叉。这里把
 * project_busy 委托给 createQueuedHopWaitEligibility（那条已验收的队列探针），
 * 把 no_available_agent 接上 runner.roleCooldownSnapshot 的权威快照。
 *
 * 冷却资格的三条不许违反的口径（与 orchestrator.roleCooldownSnapshot 同源）：
 *   - 只有 reason==='no_available_agent' 且本次 waiting 确由该角色候选拿不出人
 *     （candidateRole 明确存在）才去查那个角色的冷却快照；绝不按 reason/detail
 *     字样猜角色。
 *   - 快照非空、每位 availability==='cooldown' 且 until 都是有效未来时间，才取
 *     最早 until 且距当前不超过 15 分钟——否则（空池、有 unknown、有 available、
 *     超长冷却、读异常）一律 undefined。读异常 fail closed，绝不解析 detail。
 *   - unknown 不是 cooldown：探针在跑或到期值非法时只能说「不可证明可用」，
 *     不能编一个冷却时长出来。
 */
export interface PlanWaitEligibilityDeps {
  /** 可选：持久 Hop 队列，project_busy 委托给它认本 Mission 的退避/占位。无则 undefined。 */
  readonly queuedHops?: { readonly list: () => Promise<readonly QueuedHop[]> };
  /** 必需：MissionRunner 的角色冷却快照桥，只读读出某角色候选池的权威冷却状态。 */
  readonly roleCooldownSnapshot: (
    role: RolePoolName,
    now?: number,
  ) => Promise<readonly RoleCooldownCandidate[]>;
  /** 当前时刻（数值毫秒），冷却到期的比较与 15 分钟上限都按它算。 */
  readonly now: () => number;
}

/** 冷却资格的上限：超出这一刻钟的冷却不是「马上就好」，不拿运行去等。 */
const MAX_ROLE_COOLDOWN_WAIT_MS = 15 * 60_000;

export function createPlanWaitEligibility(
  deps: PlanWaitEligibilityDeps,
): NonNullable<PlanDriverDeps['waitEligibility']> {
  const queued = deps.queuedHops
    ? createQueuedHopWaitEligibility({ list: () => deps.queuedHops!.list(), now: () => new Date(deps.now()).toISOString() })
    : undefined;
  return async ({ missionId, reason, detail, candidateRole }) => {
    // project_busy 交给队列探针：只认本 Mission 自己的退避/占位。
    if (reason === 'project_busy') {
      return queued ? queued({ missionId, reason, detail }) : undefined;
    }
    // 只有「指定角色候选全冷却」才值得探：缺角色或别的 reason 查快照也证明不了。
    if (reason !== 'no_available_agent' || candidateRole === undefined) return undefined;
    const now = deps.now();
    let snapshot: readonly RoleCooldownCandidate[];
    try {
      snapshot = await deps.roleCooldownSnapshot(candidateRole, now);
    } catch {
      // 读异常 fail closed：读不到就猜等于空等一整晚，交回驱动走原升级处置。
      return undefined;
    }
    if (snapshot.length === 0) return undefined;
    let earliest = Number.POSITIVE_INFINITY;
    for (const candidate of snapshot) {
      if (candidate.availability !== 'cooldown') return undefined;
      const until = Date.parse(candidate.until ?? '');
      // 到期值非法或不是有效未来时间：不可证明，不编冷却时长。
      if (!Number.isFinite(until) || until <= now) return undefined;
      earliest = Math.min(earliest, until);
    }
    // 距当前超过 15 分钟的不是「马上就好」，不拿运行去等。
    if (earliest - now > MAX_ROLE_COOLDOWN_WAIT_MS) return undefined;
    return { kind: 'role_cooldown', earliestUntil: new Date(earliest).toISOString() };
  };
}
export async function runPlanOnPlatform(
  plan: PlanSpec,
  selection: PlanCandidateSelection,
  deps: PlanRuntimeDeps,
): Promise<PlanRunStop> {
  const remaining = selection.candidates;
  const startedAt = deps.startedAt ?? deps.now();
  await deps.store.create(
    PlanRun.start({
      id: deps.runId,
      planId: plan.planId,
      projectId: plan.projectId,
      integrationBranch: plan.integrationBranch,
      reviewer: plan.reviewer,
      stopConditions: plan.stopConditions,
      featureIds: remaining.map((feature) => feature.id),
      // 标题抄进记录：早上看交接面不用回头翻方案文件（它到早上可能已经改了）。
      titles: Object.fromEntries(remaining.map((feature) => [feature.id, feature.title])),
      startedAt,
      ...(selection.exclusions.length > 0 ? { sourceExclusions: selection.exclusions } : {}),
    }),
  );

  return drivePlan(plan, {
    store: deps.store,
    projectRoot: deps.projectRoot,
    ...(deps.resumeMissions ? { resumeMissions: deps.resumeMissions } : {}),
    now: deps.now,
    sleep: deps.sleep,
    log: deps.log,
    ...(deps.checkRepo ? { checkRepo: deps.checkRepo } : {}),
    ...(deps.pollMs !== undefined ? { pollMs: deps.pollMs } : {}),
    ...(deps.waitEligibility ? { waitEligibility: deps.waitEligibility } : {}),
    platform: {
      resumeMission: (missionId) =>
        persistAfter(deps.persist, deps.platform.resumeMission!(missionId)),
      createMission: (input) => persistAfter(deps.persist, deps.platform.createMission(input)),
      recordStandardFallbackRoute: (missionId, input) =>
        persistAfter(deps.persist, deps.platform.recordStandardFallbackRoute(missionId, input)),
      createClassifiedMission: (input) =>
        persistAfter(deps.persist, deps.platform.createClassifiedMission(input)),
      getMissionView: (missionId) => deps.platform.getMissionView(missionId),
      effectiveIndependentReviewPass: (missionId) => deps.platform.effectiveIndependentReviewPass(missionId),
      finalizeMissionByHaAuthority: (missionId, input) =>
        persistAfter(deps.persist, deps.platform.finalizeMissionByHaAuthority(missionId, input)),
      finalizeMissionByMachine: (missionId, input) =>
        persistAfter(deps.persist, deps.platform.finalizeMissionByMachine(missionId, input)),
      abandonMissionForPlan: (missionId, input) =>
        persistAfter(deps.persist, deps.platform.abandonMissionForPlan(missionId, input)),
      answerEscalation: (missionId, answer) =>
        persistAfter(deps.persist, deps.platform.answerEscalation(missionId, answer)),
    },
    proposeRoute: async (feature) => {
      if (!deps.runQuery) return { ok: false, reason: '分类员不可用（query runtime 没装上）。' };
      const result = await deps.runQuery({
        projectId: plan.projectId,
        source: `plan-run:${deps.runId}:${feature.id}`,
        prompt: buildRoutingPrompt(plan, feature),
        cwd: deps.projectRoot,
        ...(deps.queryProfile ? { profile: deps.queryProfile } : {}),
      });
      await deps.persist();
      if (result.outcome !== 'answered') {
        return { ok: false, reason: `分类员没答上来（${result.outcome}，QueryRun ${result.queryRunId}）。` };
      }
      const parsed = parseRoutingProposal(result.record.output ?? '', new Date().toISOString());
      return parsed.ok ? parsed : {
        ok: false,
        reason: `${parsed.reason}（QueryRun ${result.queryRunId}）`,
        ...(parsed.haForbiddenUnproven ? { haForbiddenUnproven: parsed.haForbiddenUnproven } : {}),
      };
    },
    runMission: async (missionId, { wallClockDeadline }) => {
      try {
        return await runWithDeadline(
          async () => {
            const ran = await deps.runMission(missionId, { projectRoot: deps.projectRoot });
            return ran.outcome;
          },
          Date.parse(wallClockDeadline) - Date.now(),
          async () => {
            deps.log(`墙钟到点：暂停在途的 ${missionId}，下一轮开头停下。`);
            await deps.pauseInFlight(missionId);
            await deps.persist();
          },
        );
      } finally {
        await deps.persist();
      }
    },
  });
}

/** hosted run 进度。channel 必须可区分，调用方不能靠猜 stdout/stderr。 */
export type HostedPlanEmit = (channel: 'stdout' | 'stderr', line: string) => void;

/**
 * CLI 声明了额外透传名时，hosted 拿不到取值（回环禁止带变量值），
 * 也不能用服务 process.env 顶替。独立 CLI 路径不受这条限制。
 */
export const HOSTED_AGENT_ENV_UNPROVEN_MESSAGE =
  'hosted Plan 无法证明 CLI 声明的 agent 环境变量取值与独立 CLI 口径一致，且不得把变量值放入回环。将 COAGENT_AGENT_ENV_PASSTHROUGH 设为 - 后再转发，或在无常驻服务时运行。未写入。';

/**
 * 持锁服务已经装好的依赖。tokens 必须是 makeIssuer 之后的发牌口；
 * 若同时带 issuer，优先用 issuer——startServer 的 built.issuer 就是这份。
 * 不要在 hosted 入口里另建 platform / listen / 主锁。
 */
export interface HostedPlanBuilt {
  readonly platform: Platform;
  readonly tokens: RunTokenIssuer;
  readonly agentPool: AgentPoolRepository;
  readonly persist: () => void | Promise<void>;
  readonly candidateCircuits?: CandidateCircuitRepository;
  readonly queuedHops?: QueuedHopRepository;
  readonly live?: LiveOutput;
  readonly issuer?: RunTokenIssuer;
  readonly queryRuns?: QueryRunRepository;
  readonly clock?: Clock;
  readonly ids?: IdGenerator;
}

/**
 * startServer 把本函数挂到 HTTP 面 runPlan 回调时注入的上下文。
 *
 * 签名（给后续 main 工单）：
 *   runHostedPlan(
 *     body: Record<string, unknown>,
 *     ctx: HostedPlanContext,
 *     emit: HostedPlanEmit,
 *   ): Promise<number>
 *
 * 接线：
 *   回调 (body, emit) => runHostedPlan(body, ctx, emit)
 */
export interface HostedPlanContext {
  readonly built: HostedPlanBuilt;
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
  readonly queryRuntime?: AgentRuntime;
  /**
   * 服务启动时拿到的持锁状态。缺省 = 直调、不做跨请求身份门。
   * startServer 必须注入；不能从 body.state 回填。
   */
  readonly heldState?: HostedHeldState;
  /**
   * 托管 CLI 行的内存游标。缺省不写——直调 / 测试不必为观测面装配缓冲。
   * 只在 runId 确定之后包装 emit，预检失败的行不能挂到一个还不存在的 id 上。
   */
  readonly planLive?: PlanRunLiveOutput;
  /**
   * 成功托管并算出 runId 之后登记本次 runDir。自定义 --run-dir 才能进列表/详情；
   * 预检失败或独立 CLI 的任意目录不要从这里扩进去。
   */
  readonly registerPlanRunDir?: (runDir: string) => void;
  /** 同步通知宿主可信的运行身份；只在预检阶段完成后、方案驱动启动前调用。 */
  readonly onStarted?: (identity: {
    readonly runId: string;
    readonly runPath: string;
    readonly reviewer: string;
  }) => void;
}

function hostedIssuer(built: HostedPlanBuilt): RunTokenIssuer {
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

function toHostedProfile(candidate: AgentPoolCandidate): ExecutionProfile {
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

function hostedPlanRunOptions<
  T extends { readonly projectRoot: string },
>(options: T, maxRounds: number | undefined): T | (T & { readonly maxRounds: number }) {
  return maxRounds === undefined ? options : { ...options, maxRounds };
}

/** 运行 id 的时间戳：本地时间到分钟，文件名里好认。 */
function stamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}`
  );
}

function wrapLiveForEmit(base: LiveOutput | undefined, emit: HostedPlanEmit): LiveOutput {
  return {
    async append(chunk) {
      if ((chunk.kind === 'tool' || chunk.kind === 'text') && chunk.text) {
        emit('stdout', chunk.kind === 'tool' ? `  · ${chunk.text}` : chunk.text);
      }
      if (base) await base.append(chunk);
    },
    since(missionId, cursor, limit) {
      return base ? base.since(missionId, cursor, limit) : Promise.resolve([]);
    },
    ...(base?.finish ? { finish: (missionId: string, attemptId: string) => base.finish!(missionId, attemptId) } : {}),
  };
}

function readSelection(
  raw: unknown,
  plan: PlanSpec,
  projectRoot: string,
): PlanCandidateSelection {
  if (raw === undefined || raw === null) {
    return selectPlanCandidates(plan, { projectRoot });
  }
  const rec = asObject(raw, 'selection');
  if (!Array.isArray(rec.candidates)) {
    return selectPlanCandidates(plan, { projectRoot });
  }
  return {
    candidates: rec.candidates as PlanCandidateSelection['candidates'],
    exclusions: Array.isArray(rec.exclusions)
      ? (rec.exclusions as PlanCandidateSelection['exclusions'])
      : [],
    warnings: Array.isArray(rec.warnings) ? rec.warnings.map((row) => String(row)) : [],
  };
}

/**
 * 校验 CLI 回环过来的 body。失败必须发生在任何 create PlanRun / persist / 开跑之前。
 * 透传名单只看 body 里 CLI 提交的声明，不看服务 process.env。
 * 持锁身份以 heldState 为准，不把 body.state 当权威路径。
 */
export function parseHostedPlanBody(
  body: Record<string, unknown>,
  heldState?: HostedHeldState,
): {
  readonly plan: PlanSpec;
  readonly selection: PlanCandidateSelection;
  readonly cwd: string;
  readonly adapter: string;
  readonly envPassthrough: readonly string[];
  readonly coordinator?: string;
  readonly executor?: string;
  readonly independentReviewer?: string;
  readonly maxRounds?: number;
  readonly runDir: string;
  readonly worktrees?: string;
  readonly store?: string;
} {
  assertHostedHeldState(body.state, heldState, 'Plan');
  const planRaw = body.plan;
  if (planRaw === undefined || planRaw === null) {
    throw new Error('plan 必填');
  }
  const reviewer = optionalString(body.reviewer);
  const plan = parsePlanSpec(planRaw, reviewer ? { reviewer } : undefined);

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
    throw new Error('hosted Plan 不接受 --store pg：PG 保持单实例 CLI 路径。未写入。');
  }

  const worktrees = optionalString(body.worktrees);
  if (worktrees !== undefined && worktrees.length > 0) {
    throw new Error('hosted Plan 不支持改 --worktrees：须使用服务已装配的工作区。未写入。');
  }

  const cwdResolved = resolve(cwd);
  const runDirRaw = optionalString(body.runDir);
  if (!runDirRaw) throw new Error('runDir 必填');

  return {
    plan,
    selection: readSelection(body.selection, plan, cwdResolved),
    cwd: cwdResolved,
    adapter: resolve(adapter),
    envPassthrough,
    coordinator: optionalString(body.coordinator),
    executor: optionalString(body.executor),
    independentReviewer: optionalString(body.independentReviewer),
    ...(maxRounds === undefined ? {} : { maxRounds }),
    runDir: resolve(runDirRaw),
    ...(worktrees ? { worktrees } : {}),
    ...(store ? { store } : {}),
  };
}

/**
 * 在已持锁服务上跑一份方案。复用 runPlanOnPlatform / FilePlanRunStore / MissionRunner，
 * 不另建平台、不 listen、不拿主锁。分类员与 agent runtime 只用 CLI body 声明。
 * 建 PlanRun 之前再做一次 git 预检和名额检查。
 */
export async function runHostedPlan(
  body: Record<string, unknown>,
  ctx: HostedPlanContext,
  emit: HostedPlanEmit,
): Promise<number> {
  const parsed = parseHostedPlanBody(body, ctx.heldState);
  const remaining = parsed.selection.candidates;
  if (remaining.length === 0) {
    emit('stdout', `方案 ${parsed.plan.planId} 没有可跑的候选。`);
    return 0;
  }

  const problems = await preflightPlanRepo(parsed.cwd, parsed.plan.integrationBranch);
  if (problems.length > 0) {
    emit(
      'stderr',
      `拿到状态锁之后项目仓变脏了（状态文件多半就在仓库里且没被忽略）：\n${problems.join('\n')}`,
    );
    return 2;
  }
  const slotPreflight = preflightPlanMissionSlots({
    selection: parsed.selection,
    plan: parsed.plan,
    runDir: parsed.runDir,
    missions: await ctx.built.platform.listMissions(),
  });
  if (slotPreflight.problems.length > 0) {
    emit(
      'stderr',
      `开跑前检查没过，一个功能都没跑：\n${slotPreflight.problems.map((h) => `  ✗ ${h}`).join('\n')}`,
    );
    return 2;
  }
  const resumeMissions = Object.fromEntries(
    slotPreflight.resume.map(({ featureId, missionId }) => [featureId, missionId]),
  );

  const { platform, agentPool, persist, candidateCircuits, queuedHops } = ctx.built;
  const tokens = hostedIssuer(ctx.built);

  // 指定了 --coordinator/--executor/--independent-reviewer 就只读现有池：
  // 先 seed 再发现非法 id 会把缺省候选写进仓储，留下半截配置。
  const hasRoleFlags =
    parsed.coordinator !== undefined ||
    parsed.executor !== undefined ||
    parsed.independentReviewer !== undefined;
  const pool = await agentPool.list();
  const coordinators = pickHostedCandidates(
    pool.coordinator,
    'coordinator',
    '--coordinator',
    parsed.coordinator,
  ).map(toHostedProfile);
  const executors = pickHostedCandidates(pool.executor, 'executor', '--executor', parsed.executor).map(
    toHostedProfile,
  );
  const independentReviewers = pickHostedCandidates(
    pool.independent_reviewer,
    'independent_reviewer',
    '--independent-reviewer',
    parsed.independentReviewer,
  ).map(toHostedProfile);

  const started = new Date();
  const runId = `${parsed.plan.planId}-${stamp(started)}`;
  const store = new FilePlanRunStore(join(parsed.runDir, `${runId}.json`));
  ctx.registerPlanRunDir?.(parsed.runDir);
  const emitLive: HostedPlanEmit = (channel, line) => {
    emit(channel, line);
    ctx.planLive?.append({ runId, channel, line });
  };

  const runtime =
    ctx.runtime ??
    new SpawnRuntime({
      kind: 'pi',
      command: 'npx',
      args: ['tsx', parsed.adapter],
      cwd: resolve(parsed.adapter, '../..'),
      timeoutMs: 5 * 60 * 1000,
      stream: false,
      envPassthrough: parsed.envPassthrough,
      ...(ctx.env ? { env: ctx.env } : {}),
    });
  const queryRuntime =
    ctx.queryRuntime ??
    (ctx.runtime
      ? undefined
      : new SpawnRuntime({
          kind: 'pi',
          command: 'npx',
          args: ['tsx', parsed.adapter],
          cwd: resolve(parsed.adapter, '../..'),
          timeoutMs: 5 * 60 * 1000,
          stream: false,
          supportsQuery: true,
          envPassthrough: parsed.envPassthrough,
          ...(ctx.env ? { env: ctx.env } : {}),
        }));

  emitLive('stdout', `方案 ${parsed.plan.planId} 开跑：${remaining.map((f) => f.id).join(' → ')}`);
  emitLive('stdout', `集成分支 ${parsed.plan.integrationBranch}，项目仓 ${parsed.cwd}`);
  emitLive('stdout', `方案运行记录：${store.path}`);
  emitLive(
    'stdout',
    `检视者 ${parsed.plan.reviewer} 每 ${Math.round(parsed.plan.stopConditions.escalationTimeoutMs / 60_000)} 分钟醒一次：` +
      `node src/l3.ts plan --run "${store.path}"`,
  );

  let runQuery: ((input: RunQueryInput) => Promise<RunQueryResult>) | undefined;
  if (queryRuntime?.supportsQuery === true) {
    const queryRunner = new QueryRunner({
      runtime: queryRuntime,
      loadCandidates: () => loadRoleProfiles(agentPool, 'classifier'),
      candidateCircuits,
      queryRuns: ctx.built.queryRuns ?? new InMemoryQueryRunRepository(),
      clock: ctx.built.clock ?? new SystemClock(),
      ids: ctx.built.ids ?? new SequentialIds(),
    });
    runQuery = (input) => queryRunner.runQuery(input);
  }

  const runner = new MissionRunner({
    platform,
    live: wrapLiveForEmit(ctx.built.live, emitLive),
    tokens,
    baseUrl: ctx.baseUrl,
    workspace: ctx.workspace,
    candidateCircuits,
    queuedHops,
    inRunBackoffWaitMs: 120_000,
    coordinator: { runtime, candidates: coordinators, loadCandidates: () => loadRoleProfiles(agentPool, 'coordinator') },
    executor: { runtime, candidates: executors, loadCandidates: () => loadRoleProfiles(agentPool, 'executor') },
    independentReviewer: { runtime, candidates: independentReviewers, loadCandidates: () => loadRoleProfiles(agentPool, 'independent_reviewer') },
  });

  ctx.onStarted?.({ runId, runPath: store.path, reviewer: parsed.plan.reviewer });

  // 共享资格工厂：project_busy 委托队列探针认本 Mission 的退避/占位，
  // no_available_agent 接上 runner 的同池角色快照认全部候选短冷却。
  // 即使没装队列也启用冷却判断——指定角色候选全在 15 分钟内冷却时就在运行内等待续跑，
  // 不把未知或非候选失败误当冷却、也不开升级单。
  const waitEligibility = createPlanWaitEligibility({
    ...(queuedHops ? { queuedHops } : {}),
    roleCooldownSnapshot: (role, now) => runner.roleCooldownSnapshot(role, now),
    now: () => Date.now(),
  });

  const stop = await runPlanOnPlatform(parsed.plan, parsed.selection, {
    store,
    projectRoot: parsed.cwd,
    platform,
    ...(waitEligibility ? { waitEligibility } : {}),
    runMission: (missionId, options) => runner.run(missionId, hostedPlanRunOptions(options, parsed.maxRounds)),
    ...(runQuery ? { runQuery } : {}),
    ...(Object.keys(resumeMissions).length > 0 ? { resumeMissions } : {}),

    persist: async () => {
      await persist();
    },
    pauseInFlight: async (missionId) => {
      await platform.pauseMission(missionId);
    },
    now: () => new Date().toISOString(),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    log: (line) => emitLive('stdout', `[${new Date().toLocaleTimeString()}] ${line}`),
    runId,
    startedAt: started.toISOString(),
    checkRepo: () => preflightPlanRepo(parsed.cwd, parsed.plan.integrationBranch),
  });

  const run = store.read();
  emitLive('stdout', '');
  emitLive('stdout', `${'='.repeat(72)}`);
  emitLive('stdout', `方案 ${parsed.plan.planId} 停了：${stop.reason} —— ${stop.detail}`);
  emitLive('stdout', '='.repeat(72));
  if (run) {
    for (const text of renderPlanHandoff(run, { now: new Date().toISOString() })) emitLive('stdout', text);
  }
  emitLive('stdout', '');
  emitLive('stdout', `早上看（带花销）：node src/l3.ts plan --run "${store.path}"`);
  await persist();
  return 0;
}
