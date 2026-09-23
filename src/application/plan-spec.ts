/**
 * 方案文件（`missions/PLAN-*.json`）的形状。
 *
 * 方案只写「做什么、为什么、范围、验收」，**不带** facts / assessment / workOrder：
 * 拆方案那一刻还不知道后面的功能会碰哪些文件，手写一百多个字段也不现实。
 * 路由推迟到功能真要开跑时现做（见 plan-routing.ts）——那时前面的改动已经
 * 在集成分支上，判得更准。
 */

import type { MissionContract } from '../kernel/index.ts';
import type { PlanStopConditions } from './plan-run.ts';
import { PlatformRuleError } from './platform.ts';

export interface PlanFeatureSpec {
  readonly id: string;
  readonly title: string;
  readonly why: string;
  /** 方案声明的改动范围：文件写路径，目录以 `/` 结尾。Fast Lane 工单不得越出。 */
  readonly allowedScope: readonly string[];
  readonly acceptance: readonly string[];
  /** 以前的运行里已经合进集成分支的，标 done，本次不再跑。 */
  readonly status?: 'done';
}

export interface PlanVerificationCommand {
  readonly argv: readonly string[];
  readonly timeoutMs: number;
}

export interface PlanSpec {
  readonly planId: string;
  readonly projectId: string;
  readonly intent: string;
  readonly integrationBranch: string;
  /** 夜里谁来定升级单。只有它的决定作数。 */
  readonly reviewer: string;
  readonly stopConditions: PlanStopConditions;
  /** 机器 L3 合并**之后**在集成分支上跑的命令：有没有打坏别人。 */
  readonly integrationVerification: readonly PlanVerificationCommand[];
  readonly features: readonly PlanFeatureSpec[];
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function textList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(text);
}

function positiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * 严格读方案文件。**读不懂就在开跑前停下**：夜里没人看着，缺一项停止条件或
 * 集成验证，就是一路无闸跑到天亮。备注、演进记录之类的额外键照留，不挡。
 *
 * 检视者可由命令行指定（`options.reviewer` 优先于文件里的 `reviewer`）；两边都
 * 没有就拒绝——升级单得有人定。
 */
export function parsePlanSpec(raw: unknown, options?: { reviewer?: string }): PlanSpec {
  const bad = (detail: string) => new PlatformRuleError('PLAN_SPEC_INVALID', `方案文件读不懂：${detail}`);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw bad('不是对象。');
  const plan = raw as Record<string, unknown>;
  for (const key of ['planId', 'projectId', 'integrationBranch', 'intent'] as const) {
    if (!text(plan[key])) throw bad(`${key} 缺失。`);
  }
  const reviewer = options?.reviewer ?? plan.reviewer;
  if (!text(reviewer)) throw bad('没有指定检视者（文件里的 reviewer 或命令行 --reviewer）。');

  const stop = plan.stopConditions as Record<string, unknown> | undefined;
  if (
    !stop ||
    !positiveInt(stop.unresolvedEscalations) ||
    !positiveInt(stop.wallClockMs) ||
    !positiveInt(stop.escalationTimeoutMs)
  ) {
    throw bad('stopConditions 的三项都必须是正整数。');
  }

  const verification = plan.integrationVerification;
  if (
    !Array.isArray(verification) ||
    verification.length === 0 ||
    !verification.every(
      (c) => c !== null && typeof c === 'object' && textList((c as { argv?: unknown }).argv) &&
        positiveInt((c as { timeoutMs?: unknown }).timeoutMs),
    )
  ) {
    // 没有集成验证，机器 L3 就没有新证据可凭——那只是把 validator 的报告又数一遍。
    throw bad('integrationVerification 至少一条，每条 argv 非空、timeoutMs 为正整数。');
  }

  if (!Array.isArray(plan.features) || plan.features.length === 0) throw bad('features 为空。');
  const features = plan.features.map((value, index): PlanFeatureSpec => {
    const f = (value ?? {}) as Record<string, unknown>;
    for (const key of ['id', 'title', 'why'] as const) {
      if (!text(f[key])) throw bad(`features[${index}].${key} 缺失。`);
    }
    if (!textList(f.allowedScope)) throw bad(`features[${index}].allowedScope 必须非空。`);
    if (!textList(f.acceptance)) throw bad(`features[${index}].acceptance 必须非空。`);
    if (f.status !== undefined && f.status !== 'done') {
      throw bad(`features[${index}].status 只认 done，收到 ${String(f.status)}。`);
    }
    return Object.freeze({
      id: f.id as string,
      title: f.title as string,
      why: f.why as string,
      allowedScope: Object.freeze([...(f.allowedScope as string[])]),
      acceptance: Object.freeze([...(f.acceptance as string[])]),
      ...(f.status === 'done' ? { status: 'done' as const } : {}),
    });
  });
  if (new Set(features.map((f) => f.id)).size !== features.length) throw bad('功能点 id 重名。');

  return Object.freeze({
    planId: plan.planId as string,
    projectId: plan.projectId as string,
    intent: plan.intent as string,
    integrationBranch: plan.integrationBranch as string,
    reviewer,
    stopConditions: Object.freeze({
      unresolvedEscalations: stop.unresolvedEscalations as number,
      wallClockMs: stop.wallClockMs as number,
      escalationTimeoutMs: stop.escalationTimeoutMs as number,
    }),
    integrationVerification: Object.freeze(
      (verification as { argv: string[]; timeoutMs: number }[]).map((c) =>
        Object.freeze({ argv: Object.freeze([...c.argv]), timeoutMs: c.timeoutMs }),
      ),
    ),
    features: Object.freeze(features),
  });
}

/**
 * 一个功能点交给 Mission 时的契约。
 *
 * 范围写成约束、别的功能点写成非目标：协调者看不到整份方案，不说清楚它就会
 * 顺手把隔壁功能也做了——那会让后面那个功能的分支和它撞车。合并归平台，
 * 协调者不要自己切分支或合并。
 */
export function featureContract(plan: PlanSpec, feature: PlanFeatureSpec): MissionContract {
  const others = plan.features.filter((f) => f.id !== feature.id).map((f) => `${f.id}「${f.title}」`);
  return Object.freeze({
    intent: `${feature.title}：${feature.why}`,
    acceptance: Object.freeze([...feature.acceptance]),
    constraints: Object.freeze([`只改方案为它声明的范围：${feature.allowedScope.join('、')}。`]),
    nonGoals: Object.freeze(
      others.length > 0
        ? [`方案 ${plan.planId} 里的其他功能点（${others.join('、')}）不在本 Mission 范围内。`]
        : [],
    ),
    guardrails: Object.freeze([
      `这是方案 ${plan.planId} 的无人值守运行：合并由平台在集成分支 ${plan.integrationBranch} 上` +
        '验证后放行。不要自己合并、不要切换分支。',
    ]),
  });
}
