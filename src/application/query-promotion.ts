/**
 * QueryRun → Lightweight Mutation Mission 的显式晋升。
 *
 * 与 runQuery 并列、**互不自动调用**：QueryRun 保持纯只读；只有本服务
 * 才把 needs_mutation 的记录转成可追溯 Mission，并通过 origin.queryRunId
 * 复用已持久化 findings（不把 output 大段抄进 Mission/contract）。
 */

import type {
  Mission,
  MissionContract,
  OriginChannel,
} from '../kernel/index.ts';
import { PlatformRuleError } from './platform.ts';
import type { ActivityLog, Clock, IdGenerator, ProjectRepository } from './ports.ts';
import type { QueryOutcome, QueryRunRecord, QueryRunRepository } from './query-run.ts';

/* ------------------------------ 输入 / 结果 ------------------------------ */

export interface PromoteQueryRunInput {
  readonly queryRunId: string;
  /** 必须显式传入；禁止从 prompt 自动生成 acceptance/constraints。 */
  readonly contract: MissionContract;
  readonly missionId?: string;
  /** 只认 clientType / conversationRef；queryRunId 由服务强制覆盖。 */
  readonly origin?: Pick<OriginChannel, 'clientType' | 'conversationRef'>;
}

/** source 只保留小摘要——不要 output / toolCalls / usage 全量复制。 */
export interface PromotedQueryRunSource {
  readonly queryRunId: string;
  readonly projectId: string;
  readonly source: string;
  readonly prompt: string;
  readonly outcome: QueryOutcome | undefined;
  readonly status: QueryRunRecord['status'];
}

export interface PromoteQueryRunResult {
  readonly mission: Mission;
  readonly created: boolean;
  readonly source: PromotedQueryRunSource;
}

export interface QueryPromotionDeps {
  queryRuns: QueryRunRepository;
  projects: ProjectRepository;
  activity: ActivityLog;
  clock: Clock;
  ids: IdGenerator;
}

/* ------------------------------ 错误码 ------------------------------ */

/** 稳定可测：NOT_FOUND / NOT_PROMOTABLE / PROMOTION_CONFLICT。 */
export type QueryPromotionErrorCode =
  | 'NOT_FOUND'
  | 'NOT_PROMOTABLE'
  | 'PROMOTION_CONFLICT';

export class QueryPromotionError extends PlatformRuleError {
  constructor(code: QueryPromotionErrorCode, message: string) {
    super(code, message);
    this.name = 'QueryPromotionError';
  }
}

/* ------------------------------ 服务 ------------------------------ */

export class QueryPromotionService {
  #queryRuns: QueryRunRepository;
  #projects: ProjectRepository;
  #activity: ActivityLog;
  #clock: Clock;
  #ids: IdGenerator;

  constructor(deps: QueryPromotionDeps) {
    this.#queryRuns = deps.queryRuns;
    this.#projects = deps.projects;
    this.#activity = deps.activity;
    this.#clock = deps.clock;
    this.#ids = deps.ids;
  }

  /**
   * 把 needs_mutation 的 QueryRun 晋升为 lightweight/mutation Mission。
   *
   * **不做**的事：改 QueryRun、prepare worktree、启 Coordinator、抄 output。
   */
  async promote(input: PromoteQueryRunInput): Promise<PromoteQueryRunResult> {
    const record = await this.#queryRuns.get(input.queryRunId);
    if (!record) {
      throw new QueryPromotionError(
        'NOT_FOUND',
        `QueryRun ${input.queryRunId} 不存在，无法 promote。`,
      );
    }

    if (record.status !== 'ended' || record.outcome !== 'needs_mutation') {
      throw new QueryPromotionError(
        'NOT_PROMOTABLE',
        `QueryRun ${record.id} 不可 promote（status=${record.status}, outcome=${record.outcome ?? 'none'}）；` +
          `仅 ended + needs_mutation 可晋升。`,
      );
    }

    const source = summarizeSource(record);
    const project = await this.#projects.ensure(record.projectId);
    const existing = project.missions.find(
      (mission) => mission.origin?.queryRunId === record.id,
    );

    if (existing) {
      assertPromotionCompatible(existing, input);
      // 全部一致：返回已有，不再写 promotion event。
      return { mission: existing, created: false, source };
    }

    const missionId = input.missionId ?? this.#ids.next('M');
    const origin = buildTrustedOrigin(record, input.origin);
    const mission = project.createMission({
      id: missionId,
      contract: input.contract,
      origin,
      executionMode: 'lightweight',
      runKind: 'mutation',
    });

    // 先 touch 再 save：updatedAt 进 snapshot，可追溯。
    const at = this.#clock.now().toISOString();
    mission.touch(at);
    await this.#projects.save(project);

    await this.#activity.append({
      projectId: mission.projectId,
      missionId: mission.id,
      kind: 'mission.created',
      data: {
        promotedFromQueryRunId: record.id,
        executionMode: 'lightweight',
        runKind: 'mutation',
      },
      correlationId: mission.id,
      causationId: record.id,
      contractRevision: mission.contractRevision,
      planRevision: mission.planRevision,
    });

    return { mission, created: true, source };
  }
}

/** 便捷函数：无类实例时的一次性调用。 */
export async function promoteQueryRun(
  deps: QueryPromotionDeps,
  input: PromoteQueryRunInput,
): Promise<PromoteQueryRunResult> {
  return new QueryPromotionService(deps).promote(input);
}

/* ------------------------------ 内部 ------------------------------ */

function summarizeSource(record: QueryRunRecord): PromotedQueryRunSource {
  return {
    queryRunId: record.id,
    projectId: record.projectId,
    source: record.source,
    prompt: record.prompt,
    outcome: record.outcome,
    status: record.status,
  };
}

/**
 * origin.queryRunId **只**来自可信 record.id。
 * caller 的 queryRunId / rerunOf（即便 runtime cast 塞进来）一律丢掉。
 */
function buildTrustedOrigin(
  record: QueryRunRecord,
  caller?: Pick<OriginChannel, 'clientType' | 'conversationRef'>,
): OriginChannel {
  const origin: {
    clientType: string;
    conversationRef?: string;
    queryRunId: string;
  } = {
    clientType: caller?.clientType ?? record.source,
    queryRunId: record.id,
  };
  if (caller?.conversationRef !== undefined) {
    origin.conversationRef = caller.conversationRef;
  }
  return origin;
}

function structuralEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === undefined || b === undefined) return a === b;
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = canonicalize(obj[key]);
  }
  return out;
}

function assertPromotionCompatible(
  existing: Mission,
  input: PromoteQueryRunInput,
): void {
  if (existing.executionMode !== 'lightweight' || existing.runKind !== 'mutation') {
    throw new QueryPromotionError(
      'PROMOTION_CONFLICT',
      `QueryRun ${input.queryRunId} 已有 Mission ${existing.id}，` +
        `但 executionMode/runKind 不是 lightweight/mutation` +
        `（${existing.executionMode}/${existing.runKind}），拒绝覆盖。`,
    );
  }

  const existingContract = existing.contract;
  const requestedContract = input.contract;
  const contractMatches = structuralEqual(existingContract, requestedContract);
  if (!contractMatches) {
    throw new QueryPromotionError(
      'PROMOTION_CONFLICT',
      `QueryRun ${input.queryRunId} 已有 Mission ${existing.id}，` +
        `但 contract 与本次显式 contract 不一致，拒绝覆盖。`,
    );
  }

  if (input.missionId !== undefined && input.missionId !== existing.id) {
    throw new QueryPromotionError(
      'PROMOTION_CONFLICT',
      `QueryRun ${input.queryRunId} 已有 Mission ${existing.id}，` +
        `与请求 missionId=${input.missionId} 冲突。`,
    );
  }
}
