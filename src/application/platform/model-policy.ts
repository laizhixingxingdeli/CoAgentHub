import { PlatformRuleError, type PlatformContext } from './context.ts';
import {
  ModelPolicyError,
  POLICY_ROLES,
  parseRoleModelPolicy,
  type MissionModelPolicy,
  type ModelPolicyMode,
  type PolicyRole,
  type RoleModelPolicy,
} from '../model-policy.ts';

/**
 * Mission 级模型约束的持久化与审计：存成事件，最新一条生效，历史全留。
 *
 * 为什么用事件而不是内核 Mission 的字段：内核不认识 model / provider 这些词（kernel-imports
 * 测试钉着），约束又天然要有「谁在什么时候为什么改的」的历史——append-only 的事件正好；
 * 用户后来明确授权改用 Sol 这类变更，旧的限制留在历史里，但不会被当成当前要求。
 */

export const MODEL_POLICY_EVENT_KIND = 'mission.model_policy_set';
export const PROFILE_SELECTED_EVENT_KIND = 'attempt.profile_selected';

export interface SetModelPolicyInput {
  /** 省略 = 不约束该角色。整份替换，不做局部合并：审计里每一版都是完整的。 */
  readonly coordinator?: unknown;
  readonly executor?: unknown;
  /** 清除全部约束（与上面两项互斥）。 */
  readonly clear?: boolean;
  readonly reviewer: string;
  readonly reason: string;
  /** 调用方看到的当前版本号（没有约束时为 0）。给了就必须一致，防止覆盖别人刚改的。 */
  readonly expectedRevision?: number;
}

interface PolicyEventData {
  readonly revision: number;
  readonly cleared?: true;
  readonly coordinator?: RoleModelPolicy;
  readonly executor?: RoleModelPolicy;
  readonly setBy: string;
  readonly reason: string;
}

async function latestPolicyEvent(
  ctx: PlatformContext,
  missionId: string,
): Promise<{ data: PolicyEventData; at: string } | undefined> {
  const events = await ctx.activity.list(missionId);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.kind !== MODEL_POLICY_EVENT_KIND) continue;
    const data = event.data as PolicyEventData | null;
    if (data === null || typeof data !== 'object' || !Number.isInteger(data.revision)) continue;
    return { data, at: event.at };
  }
  return undefined;
}

/** 当前生效的约束；没设过、或最近一次是「清除」就是 undefined。 */
export async function readMissionModelPolicy(
  ctx: PlatformContext,
  missionId: string,
): Promise<MissionModelPolicy | undefined> {
  const latest = await latestPolicyEvent(ctx, missionId);
  if (!latest || latest.data.cleared === true) return undefined;
  const { data } = latest;
  return {
    revision: data.revision,
    ...(data.coordinator ? { coordinator: data.coordinator } : {}),
    ...(data.executor ? { executor: data.executor } : {}),
    setBy: data.setBy,
    reason: data.reason,
    at: latest.at,
  };
}

export async function setMissionModelPolicy(
  ctx: PlatformContext,
  missionId: string,
  input: SetModelPolicyInput,
): Promise<{ revision: number; policy: MissionModelPolicy | undefined }> {
  if (!input.reviewer?.trim() || !input.reason?.trim()) {
    throw new PlatformRuleError(
      'MODEL_POLICY_SIGNATURE_REQUIRED',
      '修改模型约束需要署名与理由：reviewer 说明是谁改的，reason 说明凭什么（用户的哪条要求）。',
    );
  }
  const parsed: Partial<Record<PolicyRole, RoleModelPolicy>> = {};
  try {
    if (input.clear === true) {
      if (input.coordinator !== undefined || input.executor !== undefined) {
        throw new ModelPolicyError('clear 与 coordinator / executor 互斥：要清除就只传 clear，要改就传新的完整约束');
      }
    } else {
      for (const role of POLICY_ROLES) {
        if (input[role] !== undefined) parsed[role] = parseRoleModelPolicy(input[role], role);
      }
      if (Object.keys(parsed).length === 0) {
        throw new ModelPolicyError('至少给 coordinator 或 executor 之一；要取消全部约束请传 clear:true');
      }
    }
  } catch (error) {
    if (error instanceof ModelPolicyError) throw new PlatformRuleError(error.code, error.message);
    throw error;
  }
  const { mission } = await ctx.locate(missionId);
  if (mission.status === 'completed' || mission.status === 'blocked') {
    throw new PlatformRuleError('MISSION_TERMINAL', `Mission ${missionId} 已经是终态（${mission.status}），不再改模型约束。`);
  }
  const latest = await latestPolicyEvent(ctx, missionId);
  const currentRevision = latest && latest.data.cleared !== true ? latest.data.revision : 0;
  if (input.expectedRevision !== undefined && input.expectedRevision !== currentRevision) {
    throw new PlatformRuleError(
      'MODEL_POLICY_STALE',
      `模型约束已经变了：你看到的是 r${input.expectedRevision}，现在是 r${currentRevision}。先刷新再改。`,
    );
  }
  const revision = (latest?.data.revision ?? 0) + 1;
  const data: PolicyEventData = {
    revision,
    ...(input.clear === true ? { cleared: true as const } : parsed),
    setBy: input.reviewer.trim(),
    reason: input.reason.trim(),
  };
  await ctx.event(mission, MODEL_POLICY_EVENT_KIND, data);
  return { revision, policy: await readMissionModelPolicy(ctx, missionId) };
}

/**
 * 派发时留下「这一跳实际用了谁、按哪一版约束、是不是替代」。
 * 只有设了约束才写：没约束的 Mission 行为与事件流都和以前一样。
 */
export async function recordProfileSelection(
  ctx: PlatformContext,
  missionId: string,
  attemptId: string,
  data: {
    readonly role: PolicyRole;
    readonly profileId: string;
    readonly mode: ModelPolicyMode;
    readonly policyRevision: number;
    /** 这位候选是否满足约束的选择器。 */
    readonly matched: boolean;
  },
): Promise<void> {
  const { mission } = await ctx.locate(missionId);
  await ctx.event(
    mission,
    PROFILE_SELECTED_EVENT_KIND,
    {
      ...data,
      // 优先模式下派了不匹配的候选 = 发生了替代；指定模式从不替代。
      substituted: data.mode === 'preferred' && !data.matched,
    },
    undefined,
    attemptId,
  );
}
