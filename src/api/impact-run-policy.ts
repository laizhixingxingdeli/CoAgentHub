/**
 * impact Run 的 HTTP 权限边界。
 *
 * impact 牌只给「判断这一次变更的影响」用，所以它在 HTTP 面**只有一张只读
 * 白名单**，不在名单上的一律拒绝（fail closed）。这张表按 scope/name 写死，
 * 不做「看着像读就放行」的推断——推断会随着新工具漂移，白名单不会。
 *
 * 白名单之外的动作依然会走 evaluatePolicy，但本模块的判断发生在那之前：
 * 协调者的通用矩阵里全是写动作，让 impact 牌落进去只会拿到旧的兼容放行。
 */

import { POLICY_ACTION, type PolicyAction } from '../application/policy-engine.ts';
import type { RunContext } from './run-tokens.ts';

/**
 * impact Run 允许的动作。全部是既有读动作，没有为 impact 新增任何动作：
 * 新增动作等于给一个「只许看」的身份开一条写路径。
 */
const IMPACT_ALLOWED_ACTIONS: readonly PolicyAction[] = [
  POLICY_ACTION.missionRead,
  POLICY_ACTION.attemptGetBrief,
  POLICY_ACTION.attemptGetContext,
  POLICY_ACTION.workItemGetAgentDetail,
];

export const IMPACT_RUN_PURPOSE = 'impact';

export function isImpactRun(run: RunContext | undefined): boolean {
  return run?.purpose === IMPACT_RUN_PURPOSE;
}

/** 未知动作同样拒绝：新工具上线时默认不可读，等显式加进白名单。 */
export function isImpactAllowedAction(action: PolicyAction | undefined): boolean {
  if (!action) return false;
  return IMPACT_ALLOWED_ACTIONS.some(
    (allowed) => allowed.scope === action.scope && allowed.name === action.name,
  );
}

export const IMPACT_READ_ONLY_MESSAGE =
  'impact Run 是只读的：只允许读取 Mission / 简报 / 工单上下文。';
