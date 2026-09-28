/**
 * 方案文件（`missions/PLAN-*.json`）的形状。
 *
 * 方案只写「做什么、为什么、范围、验收」，**不带** facts / assessment / workOrder：
 * 拆方案那一刻还不知道后面的功能会碰哪些文件，手写一百多个字段也不现实。
 * 路由推迟到功能真要开跑时现做（见 plan-routing.ts）——那时前面的改动已经
 * 在集成分支上，判得更准。
 *
 * 真实历史方案会带 skipped / split / pending 等状态和空范围。整份拒绝会让
 * run-plan 读不了用户真正要用的文件；把非 done 全当可跑又会重跑已合入的、
 * 接管人工流程中的条目。所以解析只识别状态，执行字段只对入选候选变硬，
 * 资格筛选在建运行记录 / 分类 / 建 Mission 之前单独做。
 */

import { resolve } from 'node:path';
import type { MissionContract } from '../kernel/index.ts';
import { fillStopConditions, isPositiveInt, isStopConditions, isText } from './plan-run.ts';
import type { PlanSourceExclusion, PlanStopConditions } from './plan-run.ts';
import { PlatformRuleError } from './platform.ts';

/** 源方案里认得的功能状态。未知值整份拒绝——不能静默当成 pending 或 done。 */
export const PLAN_FEATURE_SOURCE_STATUSES = Object.freeze([
  'done',
  'skipped',
  'split',
  'pending',
  'planned',
  'implementing',
  'review',
  'rework',
] as const);

export type PlanFeatureSourceStatus = (typeof PLAN_FEATURE_SOURCE_STATUSES)[number];

export interface PlanFeatureSpec {
  readonly id: string;
  readonly title: string;
  /**
   * 目标说明。只有候选必须有（建 Mission 契约要用）；历史条目可以没有——
   * 真实方案文件里手动流程记下的 done 条目就有缺它的，不能因此整份读不懂。
   */
  readonly why?: string;
  /** 方案声明的改动范围：文件写路径，目录以 `/` 结尾。Fast Lane 工单不得越出。 */
  readonly allowedScope: readonly string[];
  readonly acceptance: readonly string[];
  readonly constraints?: readonly string[];
  readonly nonGoals?: readonly string[];
  /** 源方案状态。缺省 = 旧格式待跑。 */
  readonly status?: PlanFeatureSourceStatus;
  /** 必须全部在源方案里明确标 done；不从 childrenDone 等叙述推断。 */
  readonly dependsOn?: readonly string[];
  /**
   * 条目声明的仓库。缺省 = 本次 --cwd。有值时必须能证明与 --cwd 是同一路径，
   * 不能从标题或路径片段猜。
   */
  readonly repo?: string;
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

export const PLAN_ELIGIBILITY_REASONS = Object.freeze({
  done: '本次未纳入：源方案标 done（已合入）。',
  skipped: '本次未纳入：源方案标 skipped；查看 skipReason，重新开工须由 L3 修订。',
  split: '本次未纳入：已拆分的父项；请处理子项并明确父项完成状态。',
  pendingCandidate: '候选：待跑；仍须通过范围、验收、仓库和依赖检查。',
  legacyCandidate: '候选：旧格式待跑；仍须通过全部资格检查。',
  planned: '本次未纳入：人工流程已规划；要移交平台请 L3 重新冻结并置 pending。',
  implementing: '本次未纳入：人工实现进行中；请先处置原任务。',
  review: '本次未纳入：人工检视中；请先完成或正式退回。',
  rework: '本次未纳入：人工返工中；L3 明确重划范围、验收并置 pending 后再跑。',
  missingContract: '本次未纳入：缺目标说明（why）、非空改动范围或逐条验收；请 L3 补冻结契约。',
  unmetDependency: (id: string) => `本次未纳入：依赖 ${id} 尚未在源方案明确标 done；请先完成或修订依赖。`,
  otherRepo: '本次未纳入：条目属其他仓库或仓库归属未能确认；请在目标仓库另行规划。',
});

export interface PlanCandidateSelection {
  readonly candidates: readonly PlanFeatureSpec[];
  readonly exclusions: readonly PlanSourceExclusion[];
}

function textList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isText);
}

function isSourceStatus(value: unknown): value is PlanFeatureSourceStatus {
  return (PLAN_FEATURE_SOURCE_STATUSES as readonly unknown[]).includes(value);
}

/**
 * 功能点上的字符串列表：缺或空表示「没有冻结契约」，不挡整份解析。
 * 不是数组、或元素不是非空字符串，才是类型错误——夜里没法解释它指什么。
 */
function readStringList(value: unknown, label: string, bad: (detail: string) => never): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw bad(`${label} 必须是字符串列表。`);
  }
  if (value.some((item) => !isText(item))) {
    throw bad(`${label} 的每一项都必须是非空字符串。`);
  }
  return value;
}

function sameRepoPath(left: string, right: string): boolean {
  // Windows 上盘符和路径大小写不改变身份；Unix 上大小写不同就是另一个路径。
  if (process.platform === 'win32') return left.toLowerCase() === right.toLowerCase();
  return left === right;
}

/**
 * 条目有 repo 时，必须能证明它就是本次 --cwd。resolve 成绝对路径再比；
 * 比不成相等就排除——描述性字符串（「coagent-pi（少量）」）绝不当本仓。
 */
function repoBelongsHere(repo: string | undefined, projectRoot: string): boolean {
  if (repo === undefined) return true;
  if (repo.trim() === '') return false;
  return sameRepoPath(resolve(repo), resolve(projectRoot));
}

function exclusion(
  feature: PlanFeatureSpec,
  reason: string,
): PlanSourceExclusion {
  return Object.freeze({
    featureId: feature.id,
    title: feature.title,
    reason,
    ...(feature.status !== undefined ? { sourceStatus: feature.status } : {}),
  });
}

function candidateReason(feature: PlanFeatureSpec): string {
  return feature.status === 'pending' ? PLAN_ELIGIBILITY_REASONS.pendingCandidate : PLAN_ELIGIBILITY_REASONS.legacyCandidate;
}

function statusExclusionReason(status: PlanFeatureSourceStatus): string | undefined {
  switch (status) {
    case 'done':
      return PLAN_ELIGIBILITY_REASONS.done;
    case 'skipped':
      return PLAN_ELIGIBILITY_REASONS.skipped;
    case 'split':
      return PLAN_ELIGIBILITY_REASONS.split;
    case 'planned':
      return PLAN_ELIGIBILITY_REASONS.planned;
    case 'implementing':
      return PLAN_ELIGIBILITY_REASONS.implementing;
    case 'review':
      return PLAN_ELIGIBILITY_REASONS.review;
    case 'rework':
      return PLAN_ELIGIBILITY_REASONS.rework;
    case 'pending':
      return undefined;
  }
}

/**
 * 按源文件顺序筛出本仓可跑候选。必须在分类、建 Mission、建运行记录之前调用：
 * 否则排除原因和实际派发会对不上。不读 routing / workOrder / childrenDone。
 */
export function selectPlanCandidates(plan: PlanSpec, options: { projectRoot: string }): PlanCandidateSelection {
  const byId = new Map(plan.features.map((feature) => [feature.id, feature]));
  const candidates: PlanFeatureSpec[] = [];
  const exclusions: PlanSourceExclusion[] = [];

  for (const feature of plan.features) {
    if (feature.status !== undefined && feature.status !== 'pending') {
      const reason = statusExclusionReason(feature.status);
      if (reason) exclusions.push(exclusion(feature, reason));
      continue;
    }
    if (!feature.why || !textList(feature.allowedScope) || !textList(feature.acceptance)) {
      exclusions.push(exclusion(feature, PLAN_ELIGIBILITY_REASONS.missingContract));
      continue;
    }
    if (!repoBelongsHere(feature.repo, options.projectRoot)) {
      exclusions.push(exclusion(feature, PLAN_ELIGIBILITY_REASONS.otherRepo));
      continue;
    }
    const unmet = (feature.dependsOn ?? []).find((depId) => byId.get(depId)?.status !== 'done');
    if (unmet !== undefined) {
      exclusions.push(exclusion(feature, PLAN_ELIGIBILITY_REASONS.unmetDependency(unmet)));
      continue;
    }
    candidates.push(feature);
  }

  return Object.freeze({
    candidates: Object.freeze(candidates),
    exclusions: Object.freeze(exclusions),
  });
}

export function candidateHandoffText(feature: PlanFeatureSpec): string {
  return candidateReason(feature);
}

/**
 * 严格读方案文件。**读不懂就在开跑前停下**：夜里没人看着，缺一项停止条件或
 * 集成验证，就是一路无闸跑到天亮。备注、演进记录之类的额外键照留，不挡。
 *
 * 检视者可由命令行指定（`options.reviewer` 优先于文件里的 `reviewer`）；两边都
 * 没有就拒绝——升级单得有人定。不能从 decisions 历史里猜一个。
 */
export function parsePlanSpec(raw: unknown, options?: { reviewer?: string }): PlanSpec {
  const bad = (detail: string) => new PlatformRuleError('PLAN_SPEC_INVALID', `方案文件读不懂：${detail}`);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw bad('不是对象。');
  const plan = raw as Record<string, unknown>;
  for (const key of ['planId', 'projectId', 'integrationBranch', 'intent'] as const) {
    if (!isText(plan[key])) throw bad(`${key} 缺失。`);
  }
  const reviewer = options?.reviewer ?? plan.reviewer;
  if (!isText(reviewer)) throw bad('没有指定检视者（文件里的 reviewer 或命令行 --reviewer）。');

  const stop = plan.stopConditions;
  if (!isStopConditions(stop)) {
    throw bad(
      'stopConditions 的 unresolvedEscalations / wallClockMs / escalationTimeoutMs 必须都是正整数；' +
        'maxEscalations / maxRerunsPerFeature 缺省放行，出现了也必须是正整数。',
    );
  }

  const verification = plan.integrationVerification;
  if (
    !Array.isArray(verification) ||
    verification.length === 0 ||
    !verification.every(
      (c) => c !== null && typeof c === 'object' && textList((c as { argv?: unknown }).argv) &&
        isPositiveInt((c as { timeoutMs?: unknown }).timeoutMs),
    )
  ) {
    // 没有集成验证，机器 L3 就没有新证据可凭——那只是把 validator 的报告又数一遍。
    throw bad('integrationVerification 至少一条，每条 argv 非空、timeoutMs 为正整数。');
  }

  if (!Array.isArray(plan.features) || plan.features.length === 0) throw bad('features 为空。');
  const features = plan.features.map((value, index): PlanFeatureSpec => {
    const f = (value ?? {}) as Record<string, unknown>;
    for (const key of ['id', 'title'] as const) {
      if (!isText(f[key])) throw bad(`features[${index}].${key} 缺失。`);
    }
    // why 只对候选是必需的（在资格筛选里查）；这里只挡类型写错的。
    if (f.why !== undefined && typeof f.why !== 'string') {
      throw bad(`features[${index}].why 必须是字符串。`);
    }
    if (f.status !== undefined && !isSourceStatus(f.status)) {
      throw bad(`features[${index}]（${String(f.id)}）status 不认识：${String(f.status)}。`);
    }
    const allowedScope = readStringList(f.allowedScope, `features[${index}].allowedScope`, bad);
    const acceptance = readStringList(f.acceptance, `features[${index}].acceptance`, bad);
    const dependsOn = readStringList(f.dependsOn, `features[${index}].dependsOn`, bad);
    const itemLabel = `features[${index}]（${String(f.id)}）`;
    const constraints = readStringList(f.constraints, `${itemLabel}.constraints`, bad);
    const nonGoals = readStringList(f.nonGoals, `${itemLabel}.nonGoals`, bad);
    if (f.repo !== undefined && typeof f.repo !== 'string') {
      throw bad(`features[${index}].repo 必须是字符串。`);
    }
    return Object.freeze({
      id: f.id as string,
      title: f.title as string,
      ...(isText(f.why) ? { why: f.why as string } : {}),
      allowedScope: Object.freeze([...allowedScope]),
      acceptance: Object.freeze([...acceptance]),
      ...(f.constraints !== undefined ? { constraints: Object.freeze([...constraints]) } : {}),
      ...(f.nonGoals !== undefined ? { nonGoals: Object.freeze([...nonGoals]) } : {}),
      ...(f.status !== undefined ? { status: f.status } : {}),
      ...(dependsOn.length > 0 ? { dependsOn: Object.freeze([...dependsOn]) } : {}),
      ...(typeof f.repo === 'string' ? { repo: f.repo } : {}),
    });
  });
  if (new Set(features.map((f) => f.id)).size !== features.length) throw bad('功能点 id 重名。');

  return Object.freeze({
    planId: plan.planId as string,
    projectId: plan.projectId as string,
    intent: plan.intent as string,
    integrationBranch: plan.integrationBranch as string,
    reviewer,
    stopConditions: fillStopConditions(stop),
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
    // 只有候选会走到这里，候选一定有 why；万一没有也不拼出「标题：」这种半句。
    intent: feature.why ? `${feature.title}：${feature.why}` : feature.title,
    acceptance: Object.freeze([...feature.acceptance]),
    constraints: Object.freeze([
      `只改方案为它声明的范围：${feature.allowedScope.join('、')}。`,
      ...(feature.constraints ?? []),
    ]),
    nonGoals: Object.freeze([
      ...(feature.nonGoals ?? []),
      ...(others.length > 0
        ? [`方案 ${plan.planId} 里的其他功能点（${others.join('、')}）不在本 Mission 范围内。`]
        : []),
    ]),
    guardrails: Object.freeze([
      `这是方案 ${plan.planId} 的无人值守运行：合并由平台在集成分支 ${plan.integrationBranch} 上` +
        '验证后放行。不要自己合并、不要切换分支。',
    ]),
  });
}
