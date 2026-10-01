/**
 * QueryRun → Lightweight Mutation Mission 的显式晋升。
 *
 * 与 runQuery 并列、**互不自动调用**：QueryRun 保持纯只读；只有本服务
 * 才把 needs_mutation 的记录转成可追溯 Mission，并通过 origin.queryRunId
 * 复用已持久化 findings（不把 output 大段抄进 Mission/contract）。
 *
 * M3D-3：caller 必须显式提供 Frozen WorkOrder；晋升路径产出
 * lightweight/mutation Mission + 恰好一个 Frozen WorkItem。禁止从
 * QueryRun prompt/output/toolCalls/usage 自动生成或复制工单内容。
 */

import type {
  Mission,
  MissionContract,
  OriginChannel,
  WorkOrder,
} from '../kernel/index.ts';
import { PlatformRuleError } from './platform.ts';
import type { ActivityLog, Clock, IdGenerator, ProjectRepository } from './ports.ts';
import type { QueryOutcome, QueryRunRecord, QueryRunRepository } from './query-run.ts';

/* ------------------------------ 输入 / 结果 ------------------------------ */

export interface PromoteQueryRunInput {
  readonly queryRunId: string;
  /** 必须显式传入；禁止从 prompt 自动生成 acceptance/constraints。 */
  readonly contract: MissionContract;
  /**
   * 必须显式传入的 Frozen WorkOrder。
   * TypeScript required 之外，runtime 仍 fail-closed（见 WORK_ORDER_REQUIRED）。
   * 禁止从 QueryRun prompt/output/toolCalls/usage 自动生成。
   */
  readonly workOrder: WorkOrder;
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

/**
 * 稳定可测：
 * NOT_FOUND / NOT_PROMOTABLE / PROMOTION_CONFLICT / WORK_ORDER_REQUIRED。
 */
export type QueryPromotionErrorCode =
  | 'NOT_FOUND'
  | 'NOT_PROMOTABLE'
  | 'PROMOTION_CONFLICT'
  | 'WORK_ORDER_REQUIRED';

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
   * 把 needs_mutation 的 QueryRun 晋升为 lightweight/mutation Mission
   * + 恰好一个显式 Frozen WorkItem。
   *
   * **不做**的事：改 QueryRun、prepare worktree、启 Coordinator、抄 output、
   * 从 prompt 自动生成 WorkOrder。
   */
  async promote(input: PromoteQueryRunInput): Promise<PromoteQueryRunResult> {
    // 1-2) load + promotable check 优先于 workOrder runtime guard
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

    // 3) workOrder runtime guard 先于任何 Project side effect（ensure / create）
    const workOrder = normalizeOrderRevision(requireWorkOrder(input));

    const source = summarizeSource(record);
    const project = await this.#projects.ensure(record.projectId);
    const existing = project.missions.find(
      (mission) => mission.origin?.queryRunId === record.id,
    );

    if (existing) {
      assertPromotionCompatible(existing, input);
      return this.#handleExisting(existing, project, record, source, workOrder);
    }

    return this.#createPromoted(project, record, input, source, workOrder);
  }

  async #createPromoted(
    project: Awaited<ReturnType<ProjectRepository['ensure']>>,
    record: QueryRunRecord,
    input: PromoteQueryRunInput,
    source: PromotedQueryRunSource,
    workOrder: WorkOrder,
  ): Promise<PromoteQueryRunResult> {
    const missionId = input.missionId ?? this.#ids.next('M');
    const workItemId = this.#ids.next('W');
    const origin = buildTrustedOrigin(record, input.origin);

    // 只走原子 seed；禁止先 createMission 再 createWorkItem
    const { mission, workItem } = project.createMissionWithInitialWorkItem({
      id: missionId,
      contract: input.contract,
      origin,
      executionMode: 'lightweight',
      runKind: 'mutation',
      initialWorkItem: {
        id: workItemId,
        title: workOrder.objective,
        order: workOrder,
      },
    });

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

    await this.#activity.append({
      projectId: mission.projectId,
      missionId: mission.id,
      workItemId: workItem.id,
      kind: 'work_item.created',
      data: {
        title: workOrder.objective,
        executionMode: 'lightweight',
        promotedFromQueryRunId: record.id,
      },
      correlationId: mission.id,
      causationId: record.id,
      contractRevision: mission.contractRevision,
      planRevision: mission.planRevision,
    });

    return { mission, created: true, source };
  }

  async #handleExisting(
    existing: Mission,
    project: Awaited<ReturnType<ProjectRepository['ensure']>>,
    record: QueryRunRecord,
    source: PromotedQueryRunSource,
    workOrder: WorkOrder,
  ): Promise<PromoteQueryRunResult> {
    const items = existing.workItems;

    if (items.length === 0) {
      // legacy backfill：同 Mission 补一张显式 Frozen WorkOrder，不重建
      const workItemId = this.#ids.next('W');
      // invalid WorkOrder → kernel validation error；0 WI 保持，不 save、不 event
      const workItem = existing.createWorkItem({
        id: workItemId,
        title: workOrder.objective,
        order: workOrder,
      });

      const at = this.#clock.now().toISOString();
      existing.touch(at);
      await this.#projects.save(project);

      await this.#activity.append({
        projectId: existing.projectId,
        missionId: existing.id,
        workItemId: workItem.id,
        kind: 'work_item.created',
        data: {
          title: workOrder.objective,
          executionMode: 'lightweight',
          promotedFromQueryRunId: record.id,
        },
        correlationId: existing.id,
        causationId: record.id,
        contractRevision: existing.contractRevision,
        planRevision: existing.planRevision,
      });

      return { mission: existing, created: false, source };
    }

    if (items.length === 1) {
      const item = items[0]!;
      if (
        item.order === undefined ||
        !structuralEqual(item.order, workOrder) ||
        item.title !== workOrder.objective
      ) {
        throw new QueryPromotionError(
          'PROMOTION_CONFLICT',
          `QueryRun ${record.id} 已有 Mission ${existing.id} 且已有 WorkItem，` +
            `但 order/title 与本次显式 workOrder 不一致，拒绝覆盖。`,
        );
      }
      // 幂等：不 save、不 event
      return { mission: existing, created: false, source };
    }

    // >1 WI：不选其中任何一个
    throw new QueryPromotionError(
      'PROMOTION_CONFLICT',
      `QueryRun ${record.id} 已有 Mission ${existing.id} 且 workItems.length=${items.length}，` +
        `拒绝覆盖。`,
    );
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

/**
 * Runtime fail-closed：Node 会 strip type，所以 required 不能只靠 TS。
 * undefined / null / 非普通 object（含数组）→ WORK_ORDER_REQUIRED。
 * 在任何新建 / backfill 之前调用。
 */
function requireWorkOrder(input: PromoteQueryRunInput): WorkOrder {
  const workOrder = (input as { workOrder?: unknown }).workOrder;
  if (
    workOrder === undefined ||
    workOrder === null ||
    typeof workOrder !== 'object' ||
    Array.isArray(workOrder)
  ) {
    throw new QueryPromotionError(
      'WORK_ORDER_REQUIRED',
      'PromoteQueryRunInput.workOrder is required and must be a plain object；' +
        '禁止从 QueryRun 自动生成 WorkOrder。',
    );
  }
  return workOrder as WorkOrder;
}

/**
 * 把「缺修订号」的显式入参规范化为 r1 后再比较 / 落库。
 *
 * kernel 冻结工单时本来就把缺省 orderRevision 补成 r1（work-item.ts
 * freezeWorkOrder），所以已冻结的工单**总是**带 r1。不规范化的话，同一张
 * 无修订号的工单第二次晋升就会深比较失败（undefined vs 'r1'），被误判成
 * PROMOTION_CONFLICT——legacy 调用方从此再也 promote 不了同一张工单。
 *
 * 返回浅拷贝：调用者传入的对象（以及它复用的 fixture）不得被改写。
 */
function normalizeOrderRevision(order: WorkOrder): WorkOrder {
  if (order.orderRevision !== undefined && order.orderRevision !== null) {
    return order;
  }
  return { ...order, orderRevision: 'r1' };
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
