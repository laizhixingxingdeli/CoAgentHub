/**
 * 角色 Context Bundle：用一次显式输入钉死来源顺序和标识，再投影成旧简报字段。
 *
 * 不读盘、不取 contextRefs 正文。身份靠 Mission 上已有的 contract/plan revision，
 * 其余来源只对内容做 SHA-256——把原文或 Mission/Attempt id 写进 source/hash/revision
 * 会让日志索引直接泄漏红线和凭据。
 */

import { createHash } from 'node:crypto';
import type {
  AttemptKind,
  FinalReview,
  MissionContract,
  PlanBody,
  WorkOrder,
} from '../kernel/index.ts';

/** 固定来源名。顺序就是简报里该出现的顺序，不按调用方传入字段的顺序。 */
export const COORDINATOR_SOURCE_ORDER = [
  'project_rules',
  'environment_notes',
  'contract',
  'plan',
  'final_review',
] as const;

export const EXECUTOR_SOURCE_ORDER = [
  'project_rules',
  'environment_notes',
  'work_order',
] as const;

export type ContextBundleSource =
  | (typeof COORDINATOR_SOURCE_ORDER)[number]
  | (typeof EXECUTOR_SOURCE_ORDER)[number];

export type ContextBundleRole = Extract<AttemptKind, 'coordinator' | 'executor'>;

export interface BoundWorkItem {
  readonly id: string;
  readonly title: string;
  readonly order?: Readonly<WorkOrder>;
  /** 此工作项已答的升级原文。未答时缺省，避免把未决提问泄漏进工单视图。 */
  readonly question?: string;
  readonly answer?: string;
  readonly answeredAt?: string;
}

/**
 * 构造器唯一合法输入。调用方读完再喂进来——这里不接 Mission/Attempt 实体，
 * 否则标识字段会顺手带上 id。
 */
export interface ContextBuilderInput {
  readonly role: ContextBundleRole;
  readonly projectRules?: string;
  readonly environmentNotes: readonly string[];
  readonly contract?: Readonly<MissionContract>;
  readonly contractRevision?: number;
  readonly plan?: Readonly<PlanBody>;
  readonly planRevision?: number;
  readonly workItem?: BoundWorkItem;
  readonly finalReview?: Readonly<FinalReview>;
}

export interface ContextBundleEntry {
  readonly source: ContextBundleSource;
  readonly revision?: number;
  readonly hash?: string;
  readonly reason: string;
  readonly estimatedTokens: number;
  /** 投影旧简报字段用；不是来源标识的一部分。 */
  readonly content: unknown;
}

export interface ContextBundleBudgetReport {
  readonly budget: number;
  readonly estimatedBefore: number;
  readonly estimatedAfter: number;
  readonly omittedSources: readonly ContextBundleSource[];
  readonly overflow: boolean;
  readonly remainingOverBudget: number;
}

export interface ContextBundle {
  readonly role: ContextBundleRole;
  readonly entries: readonly ContextBundleEntry[];
  /** 仅在调用方传入预算时出现；后续平台工单靠 omittedSources / overflow 判断是否真裁过。 */
  readonly budgetReport?: ContextBundleBudgetReport;
}

export interface StartupBriefProjection {
  readonly projectRules?: string;
  readonly environmentNotes?: readonly string[];
  readonly contract?: Readonly<MissionContract>;
  readonly contractRevision?: number;
  readonly plan?: Readonly<PlanBody>;
  readonly planRevision?: number;
  readonly workItem?: BoundWorkItem;
  readonly finalReview?: Readonly<FinalReview>;
}

const REASON: Record<ContextBundleSource, string> = {
  project_rules:
    '项目层面不可协商的架构红线；两个角色都要，执行者没有取红线的工具。',
  environment_notes:
    '平台知道自己跑在什么系统上、agent 不知道；只提前说会静默出错的那几条。',
  contract: '协调者要按契约规划；不给执行者，避免它重新定义目标。',
  plan: '协调者接着上次的规划往下做。',
  final_review: '被打回之后重跑时，这是最该先看到的东西。',
  work_order:
    '执行者只拿冻结工单动手；contextRefs 保持引用，正文按需 getContext / read。',
};

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(String(value));
}

function identityPayload(content: unknown): string {
  if (typeof content === 'string') return content;
  return canonicalJson(content);
}

function sha256(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

function estimateTokens(content: unknown): number {
  if (content === undefined) return 0;
  const text = typeof content === 'string' ? content : canonicalJson(content);
  // JS 的 string.length 把非 ASCII 算成 1；按 UTF-8 字节才和落盘/传输一致，否则中文会被低估。
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}

function totalEstimatedTokens(entries: readonly ContextBundleEntry[]): number {
  let total = 0;
  for (const entry of entries) total += entry.estimatedTokens;
  return total;
}

/** 超预算时整条去掉的可选来源，plan 先于 environment_notes。不截断、不把内容挪进必需来源。 */
const OPTIONAL_DROP_ORDER = ['plan', 'environment_notes'] as const;

function applyBudget(
  entries: readonly ContextBundleEntry[],
  budget: number,
): { entries: ContextBundleEntry[]; report: ContextBundleBudgetReport } {
  const estimatedBefore = totalEstimatedTokens(entries);
  const omittedSources: ContextBundleSource[] = [];
  let remaining = entries as ContextBundleEntry[];
  let estimatedAfter = estimatedBefore;

  if (estimatedBefore > budget) {
    for (const source of OPTIONAL_DROP_ORDER) {
      if (estimatedAfter <= budget) break;
      const hit = remaining.find((entry) => entry.source === source);
      if (!hit) continue;
      omittedSources.push(source);
      remaining = remaining.filter((entry) => entry.source !== source);
      estimatedAfter -= hit.estimatedTokens;
    }
  }

  const overflow = estimatedAfter > budget;
  return {
    entries: remaining,
    report: {
      budget,
      estimatedBefore,
      estimatedAfter,
      omittedSources,
      overflow,
      remainingOverBudget: overflow ? estimatedAfter - budget : 0,
    },
  };
}

function hashedEntry(source: ContextBundleSource, content: unknown): ContextBundleEntry {
  return {
    source,
    hash: sha256(identityPayload(content)),
    reason: REASON[source],
    estimatedTokens: estimateTokens(content),
    content,
  };
}

function revisionEntry(
  source: 'contract' | 'plan',
  content: unknown,
  revision: number,
): ContextBundleEntry {
  return {
    source,
    revision,
    reason: REASON[source],
    estimatedTokens: estimateTokens(content),
    content,
  };
}

/**
 * 单次调用、显式值 → 固定顺序的 Bundle。
 *
 * 多喂的字段按角色丢掉（执行者即便传入契约也不会进条目），少喂的仍占位：
 * 协调者始终是红线/环境/契约/规划/打回，执行者始终是红线/环境/工单。
 * 不占位的话「缺省」和「没这个来源」会混成同一种形状。
 */
export function buildContextBundle(input: ContextBuilderInput, budget?: number): ContextBundle {
  if (budget !== undefined && (!Number.isSafeInteger(budget) || budget < 0)) {
    throw new Error('budget must be a non-negative safe integer');
  }

  const entries: ContextBundleEntry[] =
    input.role === 'executor'
      ? [
          hashedEntry('project_rules', input.projectRules),
          hashedEntry('environment_notes', input.environmentNotes),
          hashedEntry('work_order', input.workItem),
        ]
      : [
          hashedEntry('project_rules', input.projectRules),
          hashedEntry('environment_notes', input.environmentNotes),
          revisionEntry('contract', input.contract, input.contractRevision ?? 0),
          revisionEntry('plan', input.plan, input.planRevision ?? 0),
          hashedEntry('final_review', input.finalReview),
        ];

  if (budget === undefined) {
    return { role: input.role, entries };
  }

  const trimmed = applyBudget(entries, budget);
  return { role: input.role, entries: trimmed.entries, budgetReport: trimmed.report };
}

/**
 * 从 Bundle 投影旧简报字段。角色决定有哪些键——执行者不能冒出契约键，
 * 否则旧客户端会以为可以改目标。
 */
export function projectStartupBriefFields(bundle: ContextBundle): StartupBriefProjection {
  const bySource = new Map(bundle.entries.map((entry) => [entry.source, entry]));
  const projectRules = bySource.get('project_rules')?.content as string | undefined;
  const environmentNotes = bySource.get('environment_notes')?.content as
    | readonly string[]
    | undefined;

  if (bundle.role === 'executor') {
    return {
      projectRules,
      environmentNotes,
      workItem: bySource.get('work_order')?.content as BoundWorkItem | undefined,
    };
  }

  const contract = bySource.get('contract');
  const plan = bySource.get('plan');
  return {
    projectRules,
    environmentNotes,
    contract: contract?.content as Readonly<MissionContract> | undefined,
    contractRevision: contract?.revision,
    plan: plan?.content as Readonly<PlanBody> | undefined,
    planRevision: plan?.revision,
    finalReview: bySource.get('final_review')?.content as Readonly<FinalReview> | undefined,
  };
}
