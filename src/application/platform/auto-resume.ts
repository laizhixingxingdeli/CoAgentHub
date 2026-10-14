import type { Mission } from '../../kernel/index.ts';
import type { PlatformContext } from './context.ts';
import { blockStalledWorkItem } from './stalled-work-item.ts';

/**
 * 自动恢复（P0：退避到期自动继续）的持久事实与候选筛选。
 *
 * 托管运行在 Mission 进入退避或等冷却时就退出了（MiRing-V0-probe 的 W-619 / W-622：
 * `hop.backoff` 之后再没有人接着跑，退避早已过期，仍要 L3 手动 start_mission）。
 * 能让服务自己接着跑的前提是两份持久事实：
 *   - Mission.waitResumeAt：平台打算在哪一刻接着跑（退避到点、候选冷却到期）；
 *   - 这条 Mission 当初怎么被启动的（目录、适配器、轮次上限……）：只有托管入口知道，
 *     所以启动时记一条事件，服务重启后也读得回来。
 * 其余门禁（暂停、挂起、待 L3、预算、不可重试失败）一个都不绕过——候选筛选只挑「等时间」
 * 的 Mission，真正续跑时 runMission 开头的各道闸照常把关。
 */

export const RUN_REQUESTED_EVENT_KIND = 'mission.run_requested';
export const AUTO_RESUMED_EVENT_KIND = 'mission.auto_resumed';
/** 平台把「执行者死信 / 打转」收尾的事实留给下一张编排器单：原因、次数、候选。 */
export const COORDINATOR_HANDOFF_EVENT_KIND = 'mission.coordinator_handoff';
/** 托管运行过的 Mission 被 L3 / 平台解闸后，服务该续跑一次的请求。 */
export const RESUME_REQUESTED_EVENT_KIND = 'mission.resume_requested';

/**
 * 平台不可达的退避表：第 1 次等约 1 分钟，第 2 次约 5 分钟，第 3 次约 15 分钟，
 * 第 4 次不再自动续跑，停下来等人。
 */
export const PLATFORM_UNREACHABLE_BACKOFF_MS: readonly number[] = [60_000, 300_000, 900_000];

/** 托管启动时的参数里，续跑必须原样复用的那几项。不含环境变量值与任何凭据。 */
export interface HostedRunRequest {
  readonly cwd: string;
  readonly adapter: string;
  readonly maxRounds?: number;
  readonly acceptStaleBase: boolean;
  readonly origin?: string;
}

/** 记下这条 Mission 是怎么被托管启动的。与最近一条相同就不重复写，避免每次续跑多一行。 */
export async function recordHostedRunRequest(
  ctx: PlatformContext,
  missionId: string,
  request: HostedRunRequest,
): Promise<{ recorded: boolean }> {
  const { mission } = await ctx.locate(missionId);
  const events = await ctx.activity.list(missionId);
  const last = [...events].reverse().find((event) => event.kind === RUN_REQUESTED_EVENT_KIND);
  if (last && JSON.stringify(last.data) === JSON.stringify(normalizeRequest(request))) {
    return { recorded: false };
  }
  await ctx.event(mission, RUN_REQUESTED_EVENT_KIND, normalizeRequest(request));
  return { recorded: true };
}

function normalizeRequest(request: HostedRunRequest): HostedRunRequest {
  return {
    cwd: request.cwd,
    adapter: request.adapter,
    ...(request.maxRounds !== undefined ? { maxRounds: request.maxRounds } : {}),
    acceptStaleBase: request.acceptStaleBase,
    ...(request.origin !== undefined ? { origin: request.origin } : {}),
  };
}

function parseRequest(data: unknown): HostedRunRequest | undefined {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const row = data as Record<string, unknown>;
  if (typeof row.cwd !== 'string' || row.cwd === '' || typeof row.adapter !== 'string' || row.adapter === '') {
    return undefined;
  }
  const maxRounds = row.maxRounds;
  if (maxRounds !== undefined && (typeof maxRounds !== 'number' || !Number.isInteger(maxRounds) || maxRounds < 1)) {
    return undefined;
  }
  return {
    cwd: row.cwd,
    adapter: row.adapter,
    ...(typeof maxRounds === 'number' ? { maxRounds } : {}),
    acceptStaleBase: row.acceptStaleBase === true,
    ...(typeof row.origin === 'string' && row.origin !== '' ? { origin: row.origin } : {}),
  };
}

export interface RunDriverInfo {
  /** 入过 Mission 队列：由队列 worker 驱动，自动恢复不插手，免得两个驱动抢同一条。 */
  readonly queued: boolean;
  /** 最近一次托管启动参数；从没经托管启动过（直跑 CLI、历史 Mission）就没有。 */
  readonly request?: HostedRunRequest;
}

export async function readRunDriver(ctx: PlatformContext, missionId: string): Promise<RunDriverInfo> {
  const events = await ctx.activity.list(missionId);
  const queued = events.some((event) => event.kind === 'mission.queued');
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.kind !== RUN_REQUESTED_EVENT_KIND) continue;
    const request = parseRequest(event.data);
    return request ? { queued, request } : { queued };
  }
  return { queued };
}

/**
 * 不能自动继续的停机原因：每一个都在等人的决定或一个不会自己消失的条件。
 * 自动恢复只挑「等时间」的，这些即使带着旧的恢复时刻也一律不动——
 * 暂停 / 取消 / 待 L3 / 预算 / 检查点 / 不可重试的失败都在这里。
 */
const MANUAL_WAIT_REASONS: ReadonlySet<string> = new Set([
  'cancelled_by_user',
  'waiting_l3',
  'target_changed',
  'base_revision_stale',
  'execution_budget_exceeded',
  'mission_cost_cap_reached',
  'work_item_checkpoint',
  'checkpoint_failed',
]);

/**
 * 托管续跑请求的硬门禁原因：这些即使被平台记了续跑请求也不自动接着跑。
 * 与上面手动表的重叠部分是刻意的——续跑的筛选也要挡，而不是只靠 isAutoResumable。
 */
const RESUME_HARD_GATES: ReadonlySet<string> = new Set([
  'mission_cost_cap_reached',
  'work_item_checkpoint',
  'cancelled_by_user',
  'checkpoint_failed',
  'execution_budget_exceeded',
  'base_revision_stale',
  'target_changed',
]);

export interface AutoResumeDue {
  readonly missionId: string;
  readonly projectId: string;
  readonly resumeAt: string;
  readonly reason: string;
}

/**
 * 平台不可达要等多久再自动续跑。consecutive 是连续第几次 platform_unreachable：
 * 1/2/3 返回 now+1/5/15 分钟，>=4 或 now 非法返回 undefined（停下来等人）。
 */
export function platformUnreachableResumeAt(nowIso: string, consecutive: number): string | undefined {
  const now = Date.parse(nowIso);
  if (!Number.isFinite(now)) return undefined;
  if (!Number.isInteger(consecutive) || consecutive < 1) return undefined;
  const backoff = PLATFORM_UNREACHABLE_BACKOFF_MS[consecutive - 1];
  if (backoff === undefined) return undefined;
  return new Date(now + backoff).toISOString();
}

interface StreakEvent {
  readonly kind: string;
  readonly workItemId?: string;
  readonly data: unknown;
}

function endedByOf(event: StreakEvent): unknown {
  const data = event.data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined;
  return (data as { endedBy?: unknown }).endedBy;
}

/** 从尾部数连续 attempt.ended 且 data.endedBy==='platform_unreachable'，遇到别的 attempt.ended 停。 */
export function consecutivePlatformUnreachable(events: readonly StreakEvent[]): number {
  let count = 0;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.kind !== 'attempt.ended') continue;
    if (endedByOf(event) !== 'platform_unreachable') break;
    count += 1;
  }
  return count;
}

/**
 * 协调者连续打转的次数：从尾部数 attempt.ended 且 workItemId===undefined 且
 * endedBy==='killed_wall_clock'。有 workItemId 的事件忽略（执行者的不算）；
 * 遇到无 workItemId 且 endedBy 不是 killed_wall_clock 的 attempt.ended 停。
 */
export function coordinatorRunawayStreak(events: readonly StreakEvent[]): number {
  let count = 0;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.kind !== 'attempt.ended') continue;
    if (event.workItemId !== undefined) continue;
    if (endedByOf(event) !== 'killed_wall_clock') break;
    count += 1;
  }
  return count;
}

/** 这条 Mission 现在能不能被平台自动接着跑（不看时间）。纯函数，门禁判断集中在这一处。 */
export function isAutoResumable(mission: Mission): boolean {
  if (mission.waitResumeAt === undefined || mission.waitReason === undefined) return false;
  if (MANUAL_WAIT_REASONS.has(mission.waitReason)) return false;
  if (mission.isPaused || mission.isParked) return false;
  if (mission.openEscalations.length > 0) return false;
  return mission.status === 'investigating' || mission.status === 'planning' || mission.status === 'executing';
}

/** 恢复时刻已到、且满足全部前置条件的 Mission。 */
export async function listAutoResumeDue(ctx: PlatformContext, nowIso: string): Promise<AutoResumeDue[]> {
  const now = Date.parse(nowIso);
  const due: AutoResumeDue[] = [];
  for (const project of await ctx.projects.list()) {
    for (const mission of project.missions) {
      if (!isAutoResumable(mission)) continue;
      const resumeAt = mission.waitResumeAt!;
      if (Date.parse(resumeAt) > now) continue;
      // 名额还在就不要叫醒 project_busy：同项目另有一条 Mission 正占着改动名额。
      if (mission.waitReason === 'project_busy') {
        if (project.missions.some((other) => other.id !== mission.id && other.isMutating)) continue;
      }
      const events = await ctx.activity.list(mission.id);
      // 协调者已经打转两次：这次不再自动续跑，停下来等人。
      if (mission.waitReason === 'runaway_suspected' && coordinatorRunawayStreak(events) >= 2) continue;
      due.push({ missionId: mission.id, projectId: project.id, resumeAt, reason: mission.waitReason! });
    }
    // 另扫托管续跑请求：最近一条 resume_requested 晚于最近一条 auto_resumed，
    // 且各道门禁都放行时纳入。
    for (const mission of project.missions) {
      if (due.some((row) => row.missionId === mission.id)) continue;
      const requested = await hostedContinuationDue(ctx, mission, nowIso);
      if (requested !== undefined) due.push(requested);
    }
  }
  return due.sort((a, b) => Date.parse(a.resumeAt) - Date.parse(b.resumeAt));
}

/**
 * 一次托管续跑请求是否到点：最近一条 resume_requested 的位置晚于最近一条
 * auto_resumed，且不再受任何硬门禁限制时给出候选行，否则 undefined。
 */
async function hostedContinuationDue(
  ctx: PlatformContext,
  mission: Mission,
  nowIso: string,
): Promise<AutoResumeDue | undefined> {
  if (mission.isPaused || mission.isParked) return undefined;
  if (mission.openEscalations.length > 0) return undefined;
  if (
    mission.status !== 'investigating' &&
    mission.status !== 'planning' &&
    mission.status !== 'executing'
  ) {
    return undefined;
  }
  if (mission.waitReason !== undefined && RESUME_HARD_GATES.has(mission.waitReason)) return undefined;
  const events = await ctx.activity.list(mission.id);
  const lastRequested = lastIndexOf(events, RESUME_REQUESTED_EVENT_KIND);
  if (lastRequested < 0) return undefined;
  const lastResumed = lastIndexOf(events, AUTO_RESUMED_EVENT_KIND);
  if (lastResumed > lastRequested) return undefined;
  const requested = events[lastRequested]!;
  const driver = readRunDriverFromEvents(events);
  if (driver.queued || driver.request === undefined) return undefined;
  const resumeAt =
    typeof requested.at === 'string' && Number.isFinite(Date.parse(requested.at))
      ? requested.at
      : nowIso;
  return {
    missionId: mission.id,
    projectId: mission.projectId,
    resumeAt,
    reason: mission.waitReason ?? 'retry_backoff',
  };
}

function lastIndexOf(events: readonly { readonly kind: string }[], kind: string): number {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]!.kind === kind) return i;
  }
  return -1;
}

/** 与 {@link readRunDriver} 同源，但从已读到的活动原序里判定，不再多读一遍。 */
function readRunDriverFromEvents(events: readonly { readonly kind: string; readonly data: unknown }[]): RunDriverInfo {
  const queued = events.some((event) => event.kind === 'mission.queued');
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.kind !== RUN_REQUESTED_EVENT_KIND) continue;
    const request = parseRequest(event.data);
    return request ? { queued, request } : { queued };
  }
  return { queued };
}

/**
 * 托管运行过的 Mission 被解闸后，请服务续跑一次。门禁与 listAutoResumeDue 一致：
 * 暂停 / 挂起 / 未答复升级 / status 不在 investigating|planning|executing /
 * 硬门禁原因，任一成立就不写；已经写过同 cause 且其后没有 auto_resumed 也不重复写。
 */
export async function requestHostedContinuation(
  ctx: PlatformContext,
  missionId: string,
  cause: string,
): Promise<void> {
  const { mission } = await ctx.locate(missionId);
  const events = await ctx.activity.list(mission.id);
  const driver = readRunDriverFromEvents(events);
  if (driver.queued || driver.request === undefined) return;
  if (mission.isPaused || mission.isParked) return;
  if (mission.openEscalations.length > 0) return;
  if (
    mission.status !== 'investigating' &&
    mission.status !== 'planning' &&
    mission.status !== 'executing'
  ) {
    return;
  }
  if (mission.waitReason !== undefined && RESUME_HARD_GATES.has(mission.waitReason)) return;
  const lastRequested = lastIndexOf(events, RESUME_REQUESTED_EVENT_KIND);
  const lastResumed = lastIndexOf(events, AUTO_RESUMED_EVENT_KIND);
  if (lastRequested >= 0 && lastRequested > lastResumed) {
    const prior = events[lastRequested]!;
    const data = prior.data;
    const priorCause =
      data !== null && typeof data === 'object' && !Array.isArray(data)
        ? (data as { cause?: unknown }).cause
        : undefined;
    if (priorCause === cause) return;
  }
  await ctx.event(mission, RESUME_REQUESTED_EVENT_KIND, { cause });
}

/** 服务替 Mission 自动接着跑之前留一条记录：谁、因为什么、第几次。 */
export async function recordAutoResume(
  ctx: PlatformContext,
  missionId: string,
  data: { readonly reason: string; readonly resumeAt: string; readonly streak: number },
): Promise<void> {
  const { mission } = await ctx.locate(missionId);
  await ctx.event(mission, AUTO_RESUMED_EVENT_KIND, { ...data });
}

/** 死信 / 打转这两个原因，收尾时把事实写进 coordinator_handoff 交回协调者。 */
function handoffReason(waitReason: string): 'attempt_limit_reached' | 'runaway_suspected' | undefined {
  if (waitReason === 'attempt_limit_reached') return 'attempt_limit_reached';
  if (waitReason === 'runaway_suspected') return 'runaway_suspected';
  return undefined;
}

/** 写一条 mission.coordinator_handoff：原因、次数、候选，供下一张编排器单读。 */
async function recordCoordinatorHandoff(
  ctx: PlatformContext,
  mission: Mission,
  reason: 'attempt_limit_reached' | 'runaway_suspected',
  workItemId: string,
  item: { readonly attempts: readonly { readonly profile?: { readonly profileId?: string } }[] },
): Promise<void> {
  const profiles = item.attempts
    .map((attempt) => attempt.profile?.profileId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  await ctx.event(mission, COORDINATOR_HANDOFF_EVENT_KIND, {
    reason,
    role: 'executor',
    workItemId,
    count: item.attempts.length,
    candidates: [...new Set(profiles)],
    detail: mission.waitDetail ?? '',
  });
}

/**
 * 自动续跑前的收尾：执行者的死信与打转要在续跑前收成 blocked，并留下原因 / 次数 /
 * 候选。返回 'skip' 表示不能 start（否则会再次死信空转），'start' 表示可以续跑。
 */
export async function prepareAutoResume(
  ctx: PlatformContext,
  missionId: string,
): Promise<'start' | 'skip'> {
  const { mission } = await ctx.locate(missionId);
  const reason = mission.waitReason === undefined ? undefined : handoffReason(mission.waitReason);

  // 打转第二次：不再自动续跑，停下来等人。
  if (reason === 'runaway_suspected') {
    const events = await ctx.activity.list(mission.id);
    if (coordinatorRunawayStreak(events) >= 2) return 'skip';
  }

  if (reason === undefined) return 'start';

  let handoffWritten = false;
  let stillDispatched = false;
  for (const item of mission.workItems) {
    if (item.status !== 'dispatched') continue;
    if (mission.executionMode !== 'standard') continue;
    if (item.attempts.length === 0) continue;
    const latest = item.attempts[item.attempts.length - 1]!;
    const orderRevision = item.order?.orderRevision ?? 'r1';
    const blocked = await blockStalledWorkItem(ctx, {
      missionId,
      workItemId: item.id,
      source: reason === 'attempt_limit_reached' ? 'dead_letter' : 'runaway',
      expectedAttemptId: latest.id,
      orderRevision,
      consecutive: item.attempts.length,
    });
    if (!blocked.converted && item.status === 'dispatched') stillDispatched = true;
    await recordCoordinatorHandoff(ctx, mission, reason, item.id, item);
    handoffWritten = true;
  }

  // 即使这一轮没有 dispatched 的执行者工单（多半已经收过），也要把最后一次的执行者
  // 尝试事实交回协调者——「无论是否刚收尾」的语义。
  if (!handoffWritten) {
    const withAttempts = [...mission.workItems].reverse().find((item) => item.attempts.length > 0);
    if (withAttempts !== undefined) {
      await recordCoordinatorHandoff(ctx, mission, reason, withAttempts.id, withAttempts);
    }
  }

  // 死信收尾失败、工单仍 dispatched：不能 start，否则会再次死信空转。
  if (reason === 'attempt_limit_reached' && stillDispatched) return 'skip';
  return 'start';
}
