import type { Mission } from '../../kernel/index.ts';
import type { PlatformContext } from './context.ts';

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
  'attempt_limit_reached',
  'target_changed',
  'base_revision_stale',
  'platform_unreachable',
  'runaway_suspected',
  'execution_budget_exceeded',
  'mission_cost_cap_reached',
  'work_item_checkpoint',
  'checkpoint_failed',
]);

export interface AutoResumeDue {
  readonly missionId: string;
  readonly projectId: string;
  readonly resumeAt: string;
  readonly reason: string;
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
      due.push({ missionId: mission.id, projectId: project.id, resumeAt, reason: mission.waitReason! });
    }
  }
  return due.sort((a, b) => Date.parse(a.resumeAt) - Date.parse(b.resumeAt));
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
