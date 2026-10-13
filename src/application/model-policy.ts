import type { ExecutionProfile } from './ports.ts';

/**
 * Mission 级模型约束（P1）：同一条 Mission 里，协调者 / 执行者允许用哪些模型，由平台在派发前强制。
 *
 * 为什么必须在平台里强制：案例（MiRing-V0-probe）契约写了「协调者必须是 xai/grok-4.7」，
 * Grok 上游故障进入冷却后，候选池自动把活派给了 gpt-6.1-sol；靠 Sol 自己读出「我不是 Grok」
 * 才升级停止——那一跳已经花了钱，而且只有模型恰好记得去核对身份才拦得住。
 *
 * 两种明确的策略，没有第三种：
 *   - preferred（优先，可替代）：匹配的候选排在前面，它们都不可用时才退到池里其余候选；
 *   - required（指定，不可替代）：只准派匹配的候选；它们不可用就等（冷却到期自动续跑）或
 *     升级给人，**绝不派发别的模型**。
 * 约束是 Mission 自己的：不改资源池配置，其它 Mission 的候选照旧；用户改了要求，下一次派发就按新的来。
 * 不从契约正文里猜：正文是给人和协调者读的叙述，可能是过期的（用户后来明确授权改用 Sol），
 * 只有显式设置的约束才有强制力。
 */

export type ModelPolicyMode = 'preferred' | 'required';

/** 一个选择器的各项条件都满足才算匹配；字段至少给一项。 */
export interface ModelSelector {
  /** 资源池里的候选 id，精确匹配。 */
  readonly profileId?: string;
  /** 以下三项对应候选 facts 里的同名键，精确匹配（不区分大小写）。 */
  readonly provider?: string;
  readonly model?: string;
  readonly reasoning?: string;
}

/** 一个角色的约束：任一选择器匹配即可。 */
export interface RoleModelPolicy {
  readonly mode: ModelPolicyMode;
  readonly selectors: readonly ModelSelector[];
}

export const POLICY_ROLES = ['coordinator', 'executor'] as const;
export type PolicyRole = (typeof POLICY_ROLES)[number];

export interface MissionModelPolicy {
  /** 每次设置 +1；派发记录引用它，事后能对上「当时按的是哪一版」。 */
  readonly revision: number;
  readonly coordinator?: RoleModelPolicy;
  readonly executor?: RoleModelPolicy;
  readonly setBy: string;
  readonly reason: string;
  readonly at: string;
}

export class ModelPolicyError extends Error {
  readonly code = 'INVALID_MODEL_POLICY';
}

const SELECTOR_KEYS = ['profileId', 'provider', 'model', 'reasoning'] as const;

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** 把外部输入规整成角色约束；任何一处不对都整份拒绝，不收一半。 */
export function parseRoleModelPolicy(raw: unknown, role: string): RoleModelPolicy {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ModelPolicyError(`${role} 约束必须是对象：{ mode, selectors }`);
  }
  const row = raw as Record<string, unknown>;
  if (row.mode !== 'preferred' && row.mode !== 'required') {
    throw new ModelPolicyError(`${role}.mode 只能是 preferred（优先，可替代）或 required（指定，不可替代）`);
  }
  if (!Array.isArray(row.selectors) || row.selectors.length === 0) {
    throw new ModelPolicyError(
      `${role}.selectors 至少一条，例如 [{"provider":"xai","model":"grok-4.7"}] 或 [{"profileId":"<资源池里的候选 id>"}]`,
    );
  }
  const selectors = row.selectors.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ModelPolicyError(`${role}.selectors[${index}] 必须是对象`);
    }
    const source = entry as Record<string, unknown>;
    const unknownKey = Object.keys(source).find((key) => !(SELECTOR_KEYS as readonly string[]).includes(key));
    if (unknownKey) {
      throw new ModelPolicyError(`${role}.selectors[${index}] 不认识字段 ${unknownKey}，只有 ${SELECTOR_KEYS.join(' / ')}`);
    }
    const selector: Record<string, string> = {};
    for (const key of SELECTOR_KEYS) {
      const value = source[key];
      if (value === undefined) continue;
      if (!nonEmpty(value)) throw new ModelPolicyError(`${role}.selectors[${index}].${key} 必须是非空字符串`);
      selector[key] = value.trim();
    }
    if (Object.keys(selector).length === 0) {
      throw new ModelPolicyError(`${role}.selectors[${index}] 至少给一项条件（${SELECTOR_KEYS.join(' / ')}），空选择器会匹配一切`);
    }
    return selector as ModelSelector;
  });
  return { mode: row.mode, selectors };
}

function factOf(profile: ExecutionProfile, key: string): string | undefined {
  if (key === 'reasoning' && profile.reasoning !== undefined) return profile.reasoning;
  return profile.facts?.find((fact) => fact.key === key)?.value;
}

function sameText(left: string | undefined, right: string): boolean {
  return left !== undefined && left.trim().toLowerCase() === right.trim().toLowerCase();
}

/** 候选是否满足这个选择器（每项给出的条件都要满足）。 */
export function selectorMatches(profile: ExecutionProfile, selector: ModelSelector): boolean {
  if (selector.profileId !== undefined && profile.profileId !== selector.profileId) return false;
  for (const key of ['provider', 'model', 'reasoning'] as const) {
    const wanted = selector[key];
    if (wanted !== undefined && !sameText(factOf(profile, key), wanted)) return false;
  }
  return true;
}

export function policyMatches(profile: ExecutionProfile, policy: RoleModelPolicy): boolean {
  return policy.selectors.some((selector) => selectorMatches(profile, selector));
}

export interface PolicySelection {
  /** 按约束处理后、允许依次尝试的候选。 */
  readonly candidates: readonly ExecutionProfile[];
  /** required 且没有任何匹配的可用候选：不得派发别的模型。 */
  readonly blocked: boolean;
}

/**
 * 对「现在可用的候选」应用约束。
 * required 只留匹配的；preferred 把匹配的排前面，其余照旧顺序跟在后面（保持原相对顺序）。
 */
export function applyRolePolicy(
  usable: readonly ExecutionProfile[],
  policy: RoleModelPolicy | undefined,
): PolicySelection {
  if (!policy) return { candidates: usable, blocked: false };
  const matched = usable.filter((profile) => policyMatches(profile, policy));
  if (policy.mode === 'required') return { candidates: matched, blocked: matched.length === 0 };
  const rest = usable.filter((profile) => !matched.includes(profile));
  return { candidates: [...matched, ...rest], blocked: false };
}

/** 一句人话：给等待说明、事件与界面用。 */
export function describeSelectors(selectors: readonly ModelSelector[]): string {
  return selectors
    .map((selector) =>
      SELECTOR_KEYS.filter((key) => selector[key] !== undefined)
        .map((key) => `${key}=${selector[key]}`)
        .join(' '),
    )
    .join(' 或 ');
}

export function describeRolePolicy(policy: RoleModelPolicy): string {
  return `${policy.mode === 'required' ? '指定（不可替代）' : '优先（可替代）'}：${describeSelectors(policy.selectors)}`;
}
