import type { Mission, WaitReason } from '../../kernel/index.ts';
import type { QueuedHop } from '../durable-scheduler.ts';
import { isAutoResumable } from './auto-resume.ts';

/**
 * 等待状态的统一投影（P1：可观测性）。HTTP、reviewer MCP、插件的 get_mission 和网页都读这一份，
 * 回答同样五个问题：为什么停着、有没有活动 Agent、下次什么时候重试、平台会不会自己恢复、谁来处理。
 *
 * 为什么要单列：案例里「退避等待被归成 project_busy」「检查点范围失败被归成 no_available_agent」，
 * 用户很难分清服务停止、暂时退避、权限门禁和设备阻塞。停机原因只回答第一个问题；
 * 后四个以前要翻事件流、猜 detail 文案才知道。
 *
 * 纯函数、只读：不改状态，不读时钟。
 */

export type WaitOwner = 'platform' | 'coordinator' | 'l3' | 'user';

export interface MissionWaitInfo {
  readonly reason: WaitReason;
  /** 谁来处理：platform = 平台自己会好；l3 = 检视者；user = 用户；coordinator = 协调者。 */
  readonly owner: WaitOwner;
  /** 平台会不会自动接着跑（有恢复时刻、没暂停 / 挂起 / 未决升级、不在门禁原因上）。 */
  readonly autoResume: boolean;
  /** 下次自动重试的时刻（ISO）。 */
  readonly nextRetryAt?: string;
  /** 失败后退避的重试计数（来自持久队列行）。 */
  readonly retry?: { readonly attempt: number; readonly max: number };
  /** 现在有没有活动 Agent（任何 in_progress 的 Attempt）。 */
  readonly activeAgent: boolean;
  /** 下一步该做什么，一句话。 */
  readonly action: string;
}

interface ReasonRule {
  /** 恢复时刻存在、且没被门禁挡住时由平台处理；否则由 `fallback` 处理。 */
  readonly owner: WaitOwner | 'auto';
  readonly fallback: WaitOwner;
  readonly action: (autoResume: boolean) => string;
}

/** 每一种停机原因谁处理、下一步做什么。新增 WaitReason 必须在这里补（测试按内核清单逐条核）。 */
export const WAIT_RULES: Readonly<Record<WaitReason, ReasonRule>> = {
  retry_backoff: {
    owner: 'auto',
    fallback: 'l3',
    action: (auto) =>
      auto
        ? '到点平台自动重试；服务停着时重启服务，重启后会自动继续'
        : '退避已记录，但平台不会自动重试（暂停 / 挂起 / 未决升级，或老记录没有重试时刻）：处理后 start_mission 接着跑',
  },
  model_unavailable: {
    owner: 'auto',
    fallback: 'l3',
    action: (auto) =>
      auto
        ? '指定的模型冷却到期后平台自动重试，不会改派别的模型'
        : '修好指定的模型、调整资源池，或改这条 Mission 的模型约束（POST /api/missions/:id/model-policy）',
  },
  no_available_agent: {
    owner: 'auto',
    fallback: 'l3',
    action: (auto) => (auto ? '候选冷却到期后平台自动重试' : '候选没有明确的恢复时刻：查候选健康，必要时复位熔断后 start_mission'),
  },
  project_busy: {
    owner: 'platform',
    fallback: 'platform',
    action: () => '同项目别的 Mission 占着改动名额或队列容量；不用升级，名额释放后平台自动接着派',
  },
  checkpoint_failed: {
    owner: 'l3',
    fallback: 'l3',
    action: () =>
      '看事件 workspace.checkpoint_failed 里的越界文件和来源：要保留就让协调者建一张 allowedScope 精确包含它们的恢复单，不要就清理工作区；处理后 start_mission',
  },
  waiting_l3: { owner: 'l3', fallback: 'l3', action: () => '等检视者答复升级或做最终检视' },
  attempt_limit_reached: {
    owner: 'auto',
    fallback: 'l3',
    action: (auto) =>
      auto
        ? '同一跳连续失败到顶，平台会在能续跑时自动接着跑；先看是不是工单本身有问题（拆单、改单或停）'
        : '同一跳连续失败到顶，继续换候选不会产生新信息：先看是不是工单本身有问题（拆单、改单或停）',
  },
  target_changed: { owner: 'l3', fallback: 'l3', action: () => '目标分支在检视期间变了：重新同步后再检视' },
  base_revision_stale: { owner: 'l3', fallback: 'l3', action: () => '分叉基线已过期：核对影响后加 --accept-stale-base 或重新同步' },
  cancelled_by_user: { owner: 'user', fallback: 'user', action: () => '被叫停或暂停了：resume 之后重跑' },
  platform_unreachable: {
    owner: 'auto',
    fallback: 'l3',
    action: (auto) =>
      auto
        ? 'agent 连不上平台自己（平台侧故障），平台会在能续跑时自动接着跑；先确认平台还活着'
        : 'agent 连不上平台自己（平台侧故障）：确认平台还活着，再重跑',
  },
  runaway_suspected: {
    owner: 'auto',
    fallback: 'l3',
    action: (auto) =>
      auto
        ? '一跳跑太久被掐断，平台会在能续跑时自动接着跑；也要看它这段时间在做什么，再决定拆单、继续或作废'
        : '一跳跑太久被掐断，改动没回滚：看它这段时间在做什么，再决定拆单、继续或作废',
  },
  execution_budget_exceeded: { owner: 'l3', fallback: 'l3', action: () => '执行预算硬上限已耗尽：由检视者决定是否追加预算' },
  mission_cost_cap_reached: { owner: 'l3', fallback: 'l3', action: () => '票级费用到上限：检视者批准追加预算后继续' },
  work_item_checkpoint: { owner: 'l3', fallback: 'l3', action: () => '工作项到检查点：检视者判断是否拆票并显式批准' },
};

/**
 * 服务级的自动恢复调度没在工作（`COAGENT_AUTO_RESUME=0`，或 PG 部署根本没装配）时，Mission 自己的状态
 * 再「可恢复」，平台也不会去恢复：把投影改成如实的样子。HTTP 层知道调度器在不在，Mission 内核不知道，
 * 所以这一步放在出口，不放进 {@link deriveWaitInfo}。
 */
export function withAutoResumeSwitch(
  info: MissionWaitInfo | undefined,
  schedulerWorking: boolean,
): MissionWaitInfo | undefined {
  if (!info || schedulerWorking || !info.autoResume) return info;
  const { nextRetryAt: _dropped, ...rest } = info;
  return {
    ...rest,
    autoResume: false,
    owner: info.owner === 'platform' ? 'l3' : info.owner,
    action: '服务的自动恢复没有在工作（COAGENT_AUTO_RESUME=0，或此部署未装配），平台不会自动重试：处理后 start_mission 接着跑',
  };
}

function hasActiveAgent(mission: Mission): boolean {
  return [
    ...mission.coordinatorAttempts,
    ...mission.independentReviewerAttempts,
    ...mission.workItems.flatMap((item) => item.attempts),
  ].some((attempt) => attempt.status === 'in_progress');
}

/** 失败后退避的那一行队列：本 Mission 里最早到期的 retry_wait。 */
function pendingBackoff(mission: Mission, hops: readonly QueuedHop[] | undefined): QueuedHop | undefined {
  return (hops ?? [])
    .filter((hop) => hop.missionId === mission.id && hop.status === 'retry_wait')
    .sort((a, b) => Date.parse(a.availableAt) - Date.parse(b.availableAt))[0];
}

/** 没有停机原因就没有等待信息（暂停 / 挂起另有 paused / parked 字段）。 */
export function deriveWaitInfo(mission: Mission, hops?: readonly QueuedHop[]): MissionWaitInfo | undefined {
  const reason = mission.waitReason;
  if (reason === undefined) return undefined;
  const rule = WAIT_RULES[reason] ?? { owner: 'l3', fallback: 'l3', action: () => '' };
  const autoResume = isAutoResumable(mission);
  const owner: WaitOwner = rule.owner === 'auto' ? (autoResume ? 'platform' : rule.fallback) : rule.owner;
  const backoff = reason === 'retry_backoff' ? pendingBackoff(mission, hops) : undefined;
  // 只有平台真会自动恢复时才给「下次重试」：暂停 / 挂起 / 有未决升级时这个时刻不会触发任何东西。
  const nextRetryAt = autoResume ? mission.waitResumeAt : undefined;
  return {
    reason,
    owner,
    autoResume,
    ...(nextRetryAt !== undefined ? { nextRetryAt } : {}),
    ...(backoff ? { retry: { attempt: backoff.attemptCount, max: backoff.maxAttempts } } : {}),
    activeAgent: hasActiveAgent(mission),
    action: rule.action(autoResume),
  };
}
