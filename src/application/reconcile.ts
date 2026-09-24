/**
 * 启动时收敛。
 *
 * 平台重启（或崩溃后被拉起）时，磁盘上可能留着若干还是 `in_progress` 的
 * Attempt。它们跑在已经消失的进程里，**再也不会有人替它们收尾**。
 *
 * 不收敛的后果是硬卡死：
 *   - 协调者侧：不变量 B 认为已经有一个在跑，这个 Mission 永远开不了新的
 *     协调者尝试；
 *   - 执行者侧：那个工作项永远开不了下一次尝试；
 *   - 顺带把用量质量拖成 estimated —— 一条永远不会上报的记录挂在那里。
 *
 * 这不是「Recovery Reconciler」那种大机制（那个明确推迟了）。判成
 * `interrupted` 而不是失败：它没交出任何技术结论，属于可重试的那一类，
 * 和「跑完却没提交」要分开。
 *
 * ## 前提，以及它什么时候不成立
 *
 * 原本的判据是「我自己刚起来，所以没有任何 attempt 可能还活着」。**这条
 * 只在单写者下成立。** 文件版有进程锁，所以成立；换成 Postgres 之后多个
 * 进程共用一份状态，它就塌了——实测：Mission 正跑着，我重启了一下只读的
 * 观测面，它开机一收敛就把在途 attempt 判死并写回库，把那条 Mission 搞坏了。
 *
 * 所以现在：
 *   - **只读进程不要调它。** 收敛是写操作，属于推进状态的那个进程。
 *   - 推进状态的进程要用 `missionId` 限定范围：它只对自己接手的这条
 *     Mission 有「没有别人在跑」这个认知，对别的 Mission 没有。
 *
 * 还没解决的：两个 runner 同时接手**同一条** Mission。那需要租约/心跳
 * （attempt 上带一个会过期的时间戳），不是这里能补的。目前靠不变量 B
 * 加写冲突检测挡住大部分，但不是完备的。
 */

import type { Mission, MissionStatus, Project } from '../kernel/index.ts';
import type { LiveOutput } from './live.ts';
import type { ActivityEvent, ActivityLog, Clock, CommandTransaction, ProjectRepository } from './ports.ts';
import {
  escalationDeliveryKey,
  resultDeliveryKey,
  type Delivery,
  type DeliveryRepository,
} from './delivery.ts';
import type { WorkspaceManager, WorktreeReconcileResult } from './workspace.ts';

/** Mission 终态：与 kernel 流转表一致——completed / blocked 无出边。 */
const TERMINAL_MISSION_STATUS: ReadonlySet<MissionStatus> = new Set([
  'completed',
  'blocked',
]);

export interface ReconcileResult {
  readonly interrupted: { missionId: string; attemptId: string; kind: string }[];
  /** 心跳还新鲜、因而**没被动**的那些。看得见才知道收敛为什么没收它。 */
  readonly alive: { missionId: string; attemptId: string; owner?: string }[];
  /** 收敛时补裁了实时输出的那些跳。没传 live 就恒为空。 */
  readonly liveTrimmed: { missionId: string; attemptId: string }[];
  /**
   * 裁剪失败的那些。**不吞掉**：裁不动意味着那一跳的行还在无限留着，
   * 是个要人看的事实，不是可以静默的细节。
   */
  readonly liveTrimFailed: { missionId: string; attemptId: string; message: string }[];
}

/** 心跳多久没来就算没人管了。默认 90 秒 —— 心跳间隔的若干倍，容得下一次卡顿。 */
export const DEFAULT_LEASE_TOLERANCE_MS = 90_000;

export async function reconcileInterruptedAttempts(
  projects: readonly Project[],
  activity?: ActivityLog,
  options?: {
    /** 只收敛这一条 Mission。共用存储时**必须**传——理由见文件头。 */
    missionId?: string;
    /** "现在"由调用方给，测试才能确定性地跑。 */
    now?: Date;
    /** 心跳多久没来算没人管。 */
    toleranceMs?: number;
    /**
     * 补裁实时输出用。
     *
     * 正常收尾走 Orchestrator 的 `finally`，那里已经裁过了。**跑不到 finally
     * 的只有一种情况：编排进程自己死了**——而那恰好就是这里正在收的这些跳。
     * 于是留存策略又反了一次：正常结束的留 500 行尾巴，被进程猝死带走的反而
     * 整跳几万行全留着，且再也没人来收。
     *
     * 只读进程不传它——和不传 activity 同理，收敛是写操作。
     */
    live?: LiveOutput;
  },
): Promise<ReconcileResult> {
  const interrupted: ReconcileResult['interrupted'] = [];
  const alive: ReconcileResult['alive'] = [];
  const liveTrimmed: ReconcileResult['liveTrimmed'] = [];
  const liveTrimFailed: ReconcileResult['liveTrimFailed'] = [];
  const nowIso = (options?.now ?? new Date()).toISOString();
  const tolerance = options?.toleranceMs ?? DEFAULT_LEASE_TOLERANCE_MS;

  for (const project of projects) {
    for (const mission of project.missions) {
      if (options?.missionId && mission.id !== options.missionId) continue;
      const all = [
        ...mission.coordinatorAttempts,
        ...mission.workItems.flatMap((item) => item.attempts),
      ];
      for (const attempt of all) {
        if (attempt.status !== 'in_progress') continue;
        // 心跳还新鲜 = 有人正在跑它。判死它就是杀掉一个活着的 Mission——
        // 这正是加租约要解决的那件事，所以这里必须先问租约再动手。
        if (!attempt.isAbandoned(nowIso, tolerance)) {
          alive.push({
            missionId: mission.id,
            attemptId: attempt.id,
            owner: attempt.leaseOwner,
          });
          continue;
        }
        attempt.recordEndReason('interrupted');
        attempt.fail('接手时它仍在进行中，跑它的进程已经不在了');
        interrupted.push({
          missionId: mission.id,
          attemptId: attempt.id,
          kind: attempt.kind,
        });
        await activity?.append({
          projectId: mission.projectId,
          missionId: mission.id,
          workItemId: attempt.workItemId,
          attemptId: attempt.id,
          kind: 'attempt.ended',
          data: {
            endedBy: 'interrupted',
            failureMessage: '平台重启时它仍在进行中，无人收尾',
            retriable: true,
          },
        });

        // 裁剪放在状态与事件之后：收敛的本职是把卡死的 Mission 解开，裁不动
        // 实时输出不该让这件事失败。但失败要记下来，不能静默。
        if (options?.live?.finish) {
          try {
            await options.live.finish(mission.id, attempt.id);
            liveTrimmed.push({ missionId: mission.id, attemptId: attempt.id });
          } catch (error) {
            liveTrimFailed.push({
              missionId: mission.id,
              attemptId: attempt.id,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    }
  }

  return { interrupted, alive, liveTrimmed, liveTrimFailed };
}

export interface OrphanWorktreeReconcileResult extends WorktreeReconcileResult {
  /** 实际调用过 workspace.reconcile 的 projectRoot 数。 */
  readonly roots: number;
}

/**
 * 按各 Mission 的 workspaceRef.projectRoot 收敛孤儿 worktree。
 *
 * 同一根下，**非终态** Mission 的 id 作为 protected：它们的目录不能在启动时摘掉。
 * 终态是 completed / blocked（与 kernel 一致；没有 cancelled）。
 *
 * 不发 ActivityEvent——这是磁盘卫生，不是领域事件。
 */
export async function reconcileOrphanedWorktrees(
  projects: readonly Project[],
  workspace: WorkspaceManager,
): Promise<OrphanWorktreeReconcileResult> {
  if (!workspace.reconcile) {
    return { removed: [], kept: [], warnings: [], roots: 0 };
  }

  const byRoot = new Map<string, Set<string>>();
  for (const project of projects) {
    for (const mission of project.missions) {
      const root = mission.workspaceRef?.projectRoot;
      if (!root) continue;
      const key = root;
      let protectedIds = byRoot.get(key);
      if (!protectedIds) {
        protectedIds = new Set();
        byRoot.set(key, protectedIds);
      }
      if (!TERMINAL_MISSION_STATUS.has(mission.status)) {
        protectedIds.add(mission.id);
      }
    }
  }

  const removed: WorktreeReconcileResult['removed'][number][] = [];
  const kept: WorktreeReconcileResult['kept'][number][] = [];
  const warnings: string[] = [];

  for (const [projectRoot, protectedIds] of byRoot) {
    try {
      const result = await workspace.reconcile(projectRoot, protectedIds);
      removed.push(...result.removed);
      kept.push(...result.kept);
      warnings.push(...result.warnings);
    } catch (error) {
      warnings.push(
        `worktree 收敛失败 (${projectRoot})：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return { removed, kept, warnings, roots: byRoot.size };
}

/* ------------------------------ 缺失投递补建 ------------------------------ */

/** 只有这些状态下当前 result 才对应一次已经交卷的结局，执行中的正文不算。 */
const RESULT_REPAIR_STATUSES: ReadonlySet<MissionStatus> = new Set([
  'awaiting_review',
  'completed',
  'blocked',
]);

export interface RepairMissingDeliveriesDeps {
  readonly projects: ProjectRepository;
  readonly activity: ActivityLog;
  readonly deliveries: DeliveryRepository;
  readonly transaction: CommandTransaction;
  readonly clock: Clock;
  /**
   * 文件版才有归档。不传（PG / 内存）就不当归档处理。
   * 必须在读投递/事件之前判断：归档包有 hash 钉着，不能等写失败再靠文案跳过。
   */
  readonly isArchivedMission?: (missionId: string) => boolean;
}

export interface RepairMissingDeliveriesOptions {
  readonly missionId?: string;
}

export interface DeliveryRepairRef {
  readonly missionId: string;
  readonly idempotencyKey: string;
  readonly deliveryId?: string;
}

export interface DeliveryRepairSkip {
  readonly missionId: string;
  readonly reason: string;
}

export interface DeliveryRepairUncertain {
  readonly missionId: string;
  readonly reason: string;
  readonly idempotencyKey?: string;
}

export interface DeliveryRepairError {
  readonly missionId: string;
  readonly message: string;
}

export interface RepairMissingDeliveriesResult {
  readonly created: readonly DeliveryRepairRef[];
  readonly existing: readonly DeliveryRepairRef[];
  readonly skipped: readonly DeliveryRepairSkip[];
  readonly uncertain: readonly DeliveryRepairUncertain[];
  readonly errors: readonly DeliveryRepairError[];
}

type SubmissionIdentityIssue = 'ok' | 'missing' | 'conflict' | 'wrong_source';

interface ResultSubmission {
  readonly event: ActivityEvent;
  readonly identity: string | undefined;
  readonly outcome: unknown;
  readonly identityIssue: SubmissionIdentityIssue;
}

interface PlannedCreate {
  readonly key: string;
  readonly outcome: Delivery['outcome'];
  readonly summary: string;
  readonly source: 'escalation' | 'result';
  readonly reason: string;
  readonly attemptId?: string;
}

/**
 * 幂等补建可从现存状态可靠重建的缺失投递：全部升级，以及当前结果对应的
 * 最后一次可核实交卷。不改 Mission / Attempt 状态，不重放交卷或升级命令。
 */
export async function repairMissingDeliveries(
  deps: RepairMissingDeliveriesDeps,
  options?: RepairMissingDeliveriesOptions,
): Promise<RepairMissingDeliveriesResult> {
  void deps.clock;
  const created: DeliveryRepairRef[] = [];
  const existing: DeliveryRepairRef[] = [];
  const skipped: DeliveryRepairSkip[] = [];
  const uncertain: DeliveryRepairUncertain[] = [];
  const errors: DeliveryRepairError[] = [];

  const projects = await deps.projects.list();
  for (const project of projects) {
    for (const mission of project.missions) {
      if (options?.missionId && mission.id !== options.missionId) continue;
      if (deps.isArchivedMission?.(mission.id)) {
        skipped.push({ missionId: mission.id, reason: '已归档，跳过补建' });
        continue;
      }
      try {
        const outcome = await repairOneMission(deps, mission);
        created.push(...outcome.created);
        existing.push(...outcome.existing);
        skipped.push(...outcome.skipped);
        uncertain.push(...outcome.uncertain);
        errors.push(...outcome.errors);
      } catch (error) {
        errors.push({
          missionId: mission.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return { created, existing, skipped, uncertain, errors };
}

async function repairOneMission(
  deps: RepairMissingDeliveriesDeps,
  mission: Mission,
): Promise<RepairMissingDeliveriesResult> {
  const created: DeliveryRepairRef[] = [];
  const existing: DeliveryRepairRef[] = [];
  const skipped: DeliveryRepairSkip[] = [];
  const uncertain: DeliveryRepairUncertain[] = [];
  const errors: DeliveryRepairError[] = [];

  const rows = await deps.deliveries.listForMission(mission.id);
  const byKey = new Map(rows.map((row) => [row.idempotencyKey, row]));
  const events = await deps.activity.list(mission.id);
  const planned: PlannedCreate[] = [];

  for (let index = 0; index < mission.escalations.length; index += 1) {
    const escalation = mission.escalations[index]!;
    const key = escalationDeliveryKey(index);
    const found = byKey.get(key);
    if (found) {
      existing.push({ missionId: mission.id, idempotencyKey: key, deliveryId: found.id });
      continue;
    }
    planned.push({
      key,
      outcome: 'escalated',
      summary: escalationDeliverySummary(escalation.question, escalation.why),
      source: 'escalation',
      reason: '补建缺失的升级投递',
      attemptId: escalation.attemptId,
    });
  }

  const resultPlan = planCurrentResultRepair(mission, events, byKey);
  existing.push(...resultPlan.existing);
  uncertain.push(...resultPlan.uncertain);
  if (resultPlan.create) planned.push(resultPlan.create);

  for (const item of planned) {
    try {
      const applied = await applyMissingDelivery(deps, mission, item);
      if (applied.kind === 'created') {
        created.push(applied.ref);
        byKey.set(item.key, {
          id: applied.ref.deliveryId ?? '',
          missionId: mission.id,
          projectId: mission.projectId,
          recipient: deliveryRecipient(mission),
          outcome: item.outcome,
          idempotencyKey: item.key,
          summary: item.summary,
          createdAt: '',
          status: 'pending',
        });
      } else {
        existing.push(applied.ref);
      }
    } catch (error) {
      if (isArchivedWriteError(error)) {
        // 归档包不能改：整条 Mission 跳过，已经列入的 existing/uncertain 也不算这次的结论。
        return {
          created: [],
          existing: [],
          skipped: [{ missionId: mission.id, reason: '已归档，跳过补建' }],
          uncertain: [],
          errors: [],
        };
      }
      errors.push({
        missionId: mission.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { created, existing, skipped, uncertain, errors };
}

function planCurrentResultRepair(
  mission: Mission,
  events: readonly ActivityEvent[],
  byKey: ReadonlyMap<string, Delivery>,
): {
  create?: PlannedCreate;
  existing: DeliveryRepairRef[];
  uncertain: DeliveryRepairUncertain[];
} {
  const existing: DeliveryRepairRef[] = [];
  const uncertain: DeliveryRepairUncertain[] = [];
  if (!RESULT_REPAIR_STATUSES.has(mission.status) || !mission.result) {
    return { existing, uncertain };
  }

  const submissions = listResultSubmissions(events, mission.executionMode);
  if (submissions.length === 0) {
    uncertain.push({ missionId: mission.id, reason: '没有可核实的交卷事件' });
    return { existing, uncertain };
  }

  const last = submissions[submissions.length - 1]!;
  const currentOutcome = mission.result.outcome;

  for (const earlier of submissions.slice(0, -1)) {
    if (submissionAlreadyDelivered(earlier, byKey, events, submissions, currentOutcome)) continue;
    uncertain.push({
      missionId: mission.id,
      reason: '较早交卷缺少正文，无法补投',
      idempotencyKey: earlier.identity ? resultDeliveryKey(earlier.identity) : undefined,
    });
  }

  if (last.identityIssue !== 'ok' || !last.identity) {
    uncertain.push({
      missionId: mission.id,
      reason:
        last.identityIssue === 'conflict'
          ? '最后一次交卷身份字段冲突，无法核实'
          : last.identityIssue === 'wrong_source'
            ? '最后一次交卷身份来源与当前交卷模式不符'
            : '最后一次交卷缺少身份',
    });
    return { existing, uncertain };
  }
  if (last.outcome !== currentOutcome) {
    uncertain.push({
      missionId: mission.id,
      reason: '最后一次交卷 outcome 与当前 result 不一致',
      idempotencyKey: resultDeliveryKey(last.identity),
    });
    return { existing, uncertain };
  }

  const key = resultDeliveryKey(last.identity);
  const found = byKey.get(key);
  if (found) {
    existing.push({ missionId: mission.id, idempotencyKey: key, deliveryId: found.id });
    return { existing, uncertain };
  }

  const legacyKey = `result:legacy:${currentOutcome}`;
  const legacy = byKey.get(legacyKey);
  if (legacy) {
    const attributed = attributeLegacyResult(legacy, events, submissions);
    if (!attributed) {
      uncertain.push({
        missionId: mission.id,
        reason: '旧 result:legacy 行无法归属到某次提交',
        idempotencyKey: legacyKey,
      });
      return { existing, uncertain };
    }
    if (attributed.event === last.event) {
      existing.push({
        missionId: mission.id,
        idempotencyKey: legacy.idempotencyKey,
        deliveryId: legacy.id,
      });
      return { existing, uncertain };
    }
    // 旧行属于先前提交：当前这次交卷仍缺投递，可以补最新键。
  }

  return {
    existing,
    uncertain,
    create: {
      key,
      outcome: currentOutcome,
      summary: mission.result.summary,
      source: 'result',
      reason: '补建当前交卷的缺失投递',
      attemptId: last.event.attemptId,
    },
  };
}

function listResultSubmissions(
  events: readonly ActivityEvent[],
  executionMode: Mission['executionMode'],
): ResultSubmission[] {
  const rows: ResultSubmission[] = [];
  for (const event of events) {
    if (event.kind !== 'mission_result.submitted') continue;
    const data = eventData(event);
    const fromAttempt =
      typeof event.attemptId === 'string' && event.attemptId !== '' ? event.attemptId : undefined;
    const fromReport =
      typeof data.reportId === 'string' && data.reportId !== '' ? data.reportId : undefined;
    const resolved = resolveSubmissionIdentity(executionMode, fromAttempt, fromReport);
    rows.push({
      event,
      identity: resolved.identity,
      outcome: data.outcome,
      identityIssue: resolved.identityIssue,
    });
  }
  return rows;
}

/**
 * 按 Mission 当前交卷模式取身份。混用 attemptId / reportId 会把 Lightweight
 * 的报告当成 Standard 的 attempt；升级后的 Mission 尤其会猜错。
 */
function resolveSubmissionIdentity(
  executionMode: Mission['executionMode'],
  fromAttempt: string | undefined,
  fromReport: string | undefined,
): { identity: string | undefined; identityIssue: SubmissionIdentityIssue } {
  if (executionMode === 'lightweight') {
    if (fromAttempt && fromReport) return { identity: undefined, identityIssue: 'conflict' };
    if (fromAttempt && !fromReport) return { identity: undefined, identityIssue: 'wrong_source' };
    if (!fromReport) return { identity: undefined, identityIssue: 'missing' };
    return { identity: fromReport, identityIssue: 'ok' };
  }
  // standard / high_assurance：身份只能是协调者 attemptId
  if (fromAttempt && fromReport) return { identity: undefined, identityIssue: 'conflict' };
  if (fromReport && !fromAttempt) return { identity: undefined, identityIssue: 'wrong_source' };
  if (!fromAttempt) return { identity: undefined, identityIssue: 'missing' };
  return { identity: fromAttempt, identityIssue: 'ok' };
}

function submissionAlreadyDelivered(
  submission: ResultSubmission,
  byKey: ReadonlyMap<string, Delivery>,
  events: readonly ActivityEvent[],
  submissions: readonly ResultSubmission[],
  currentOutcome: string,
): boolean {
  if (submission.identity && byKey.get(resultDeliveryKey(submission.identity))) return true;
  const legacy = byKey.get(`result:legacy:${submission.outcome === currentOutcome ? currentOutcome : String(submission.outcome)}`);
  if (!legacy) return false;
  const attributed = attributeLegacyResult(legacy, events, submissions);
  return attributed?.event === submission.event;
}

function attributeLegacyResult(
  legacy: Delivery,
  events: readonly ActivityEvent[],
  submissions: readonly ResultSubmission[],
): ResultSubmission | undefined {
  const createdIndex = events.findIndex((event) => {
    if (event.kind !== 'delivery.created') return false;
    return eventData(event).deliveryId === legacy.id;
  });
  if (createdIndex >= 0) {
    for (let i = createdIndex - 1; i >= 0; i -= 1) {
      const prior = events[i]!;
      if (prior.kind === 'mission_result.submitted') {
        const found = submissions.find((row) => row.event === prior);
        // 有 delivery.created 只说明「这条投递当时为某次提交而建」，还要 outcome 对得上。
        if (!found || found.outcome !== legacy.outcome) return undefined;
        return found;
      }
    }
    // 有 delivery.created 但前面没有交卷：不能退回「唯一提交」猜测。
    return undefined;
  }
  // 没有可信链时不能在多次提交里挑：必须全局只交过一次，且 outcome 与 legacy 行相同。
  if (submissions.length !== 1) return undefined;
  const only = submissions[0]!;
  return only.outcome === legacy.outcome ? only : undefined;
}

async function applyMissingDelivery(
  deps: RepairMissingDeliveriesDeps,
  mission: Mission,
  item: PlannedCreate,
): Promise<{ kind: 'created' | 'existing'; ref: DeliveryRepairRef }> {
  return deps.transaction.run(async () => {
    const current = await deps.deliveries.listForMission(mission.id);
    const found = current.find((row) => row.idempotencyKey === item.key);
    if (found) {
      return {
        kind: 'existing',
        ref: { missionId: mission.id, idempotencyKey: item.key, deliveryId: found.id },
      };
    }
    const delivery = await deps.deliveries.create({
      missionId: mission.id,
      projectId: mission.projectId,
      recipient: deliveryRecipient(mission),
      outcome: item.outcome,
      idempotencyKey: item.key,
      summary: item.summary,
    });
    // create 对同键幂等：拿回已有行就不记审计，避免重复通知。
    if (current.some((row) => row.id === delivery.id)) {
      return {
        kind: 'existing',
        ref: { missionId: mission.id, idempotencyKey: item.key, deliveryId: delivery.id },
      };
    }
    await deps.activity.append({
      projectId: mission.projectId,
      missionId: mission.id,
      attemptId: item.attemptId,
      kind: 'delivery.created',
      data: { deliveryId: delivery.id },
    });
    await deps.activity.append({
      projectId: mission.projectId,
      missionId: mission.id,
      attemptId: item.attemptId,
      kind: 'recovery.applied',
      data: {
        missionId: mission.id,
        idempotencyKey: item.key,
        deliveryId: delivery.id,
        source: item.source,
        reason: item.reason,
      },
    });
    return {
      kind: 'created',
      ref: { missionId: mission.id, idempotencyKey: item.key, deliveryId: delivery.id },
    };
  });
}

function deliveryRecipient(mission: Mission): string {
  return mission.origin?.conversationRef ?? mission.origin?.clientType ?? 'unknown';
}

function escalationDeliverySummary(question: string, why: string): string {
  return `${question}\n\n为什么需要 L3：${why}`;
}

function eventData(event: ActivityEvent): Record<string, unknown> {
  return event.data !== null && typeof event.data === 'object' && !Array.isArray(event.data)
    ? (event.data as Record<string, unknown>)
    : {};
}

function isArchivedWriteError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('已归档 Mission');
}

/* ------------------------------ 周期投递修复调度 ------------------------------ */

/** 未设 COAGENT_RECONCILE_INTERVAL_MS 时的间隔。0 才是关闭。 */
export const DEFAULT_RECONCILE_INTERVAL_MS = 60_000;

/**
 * 解析周期间隔。必须在开状态 / 拿锁 / listen / 建 worktree 之前调用：
 * 非法值要失败在副作用前，不留半截进程。
 *
 * 未设 → 60000；`0` → 关闭；其余必须是正整数（禁止符号、小数、前导零）。
 */
export function parseReconcileIntervalMs(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_RECONCILE_INTERVAL_MS;
  if (!/^(0|[1-9]\d*)$/.test(raw)) {
    throw new Error(
      `COAGENT_RECONCILE_INTERVAL_MS 必须是 0（关闭）或正整数毫秒，收到：${JSON.stringify(raw)}`,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(
      `COAGENT_RECONCILE_INTERVAL_MS 必须是 0（关闭）或正整数毫秒，收到：${JSON.stringify(raw)}`,
    );
  }
  return value;
}

export interface StartPeriodicReconcileInput {
  readonly intervalMs: number;
  readonly tick: () => Promise<void>;
  readonly warn: (message: string, error?: unknown) => void;
}

export interface PeriodicReconcileHandle {
  stop(): Promise<void>;
}

/**
 * 按间隔、不重叠地跑 tick。用 setTimeout 链而不是 setInterval：上一轮没结束
 * 下一轮不开始。stop() 会等在途那一轮结束，之后不再排下一轮。
 *
 * intervalMs <= 0 视为关闭，连第一轮都不排。单次 tick 抛错只 warn，后续照跑。
 * warn 自己抛错也接住：告警通道不该拖垮调度，否则 stop() 会拒绝、在途 tick 的
 * 锁和独立连接就收不回来。
 */
export function startPeriodicReconcile(input: StartPeriodicReconcileInput): PeriodicReconcileHandle {
  const { intervalMs, tick, warn } = input;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;

  const notify = (message: string, error?: unknown) => {
    try {
      warn(message, error);
    } catch (warnError) {
      // 告警通道出错不该变成未处理拒绝：退回 console.warn，循环继续。
      console.warn(message, error);
      console.warn(
        `周期投递修复 warn 回调失败：${warnError instanceof Error ? warnError.message : String(warnError)}`,
        warnError,
      );
    }
  };

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      wake = resolve;
      timer = setTimeout(() => {
        timer = undefined;
        wake = undefined;
        resolve();
      }, ms);
    });

  const loop = (async () => {
    if (intervalMs <= 0) return;
    while (!stopped) {
      await sleep(intervalMs);
      if (stopped) return;
      try {
        await tick();
      } catch (error) {
        notify(
          `周期投递修复失败：${error instanceof Error ? error.message : String(error)}`,
          error,
        );
      }
    }
  })();

  return {
    async stop() {
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      wake?.();
      wake = undefined;
      await loop;
    },
  };
}

export interface IndependentCleanupStep {
  readonly name: string;
  readonly run: () => void | Promise<void>;
}

/**
 * 退出清理每一步独立尝试。stop 失败如果直接 await，persist 和 releaseLock
 * 都跑不到，排他锁就留在盘上；所以一步失败只记下来，后面的照跑，全部结束
 * 再把失败抛出去（多个用 AggregateError）。
 */
export async function runIndependentCleanup(input: {
  steps: IndependentCleanupStep[];
  report: (message: string, error?: unknown) => void;
}): Promise<void> {
  const failures: Error[] = [];
  for (const step of input.steps) {
    try {
      await step.run();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      failures.push(err);
      const message = `退出清理失败（${step.name}）：${err.message}`;
      try {
        input.report(message, error);
      } catch {
        // report 自己抛也不该跳过后续步骤（尤其是释锁）。
        console.error(message, error);
      }
    }
  }
  if (failures.length === 1) {
    const only = failures[0];
    if (only) throw only;
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, `退出清理有 ${failures.length} 步失败`);
  }
}
