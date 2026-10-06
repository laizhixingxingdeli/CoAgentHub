import { randomUUID } from 'node:crypto';
import type { Mission, Project, WorkItem, Attempt, AttemptKind } from '../../kernel/index.ts';
import type { ProjectRepository, ActivityLog, IdGenerator, Clock, DecisionProvider, DecisionHook, PostExecutionEvaluator, CommandTransaction, FencedCommandTransaction } from '../ports.ts';
import type { DeliveryRepository } from '../delivery.ts';
import type { WorkspaceManager } from '../workspace.ts';
import { InlineArtifactStore, type ArtifactStore } from '../artifact-store.ts';
import type { LiveOutput } from '../live.ts';
import type { ClaimFence } from '../durable-scheduler.ts';
import type { QueuedHopRepository } from '../ports.ts';
import type { ChangeImpactRepository } from '../change-impact.ts';
import type { ChangeReceiptRepository } from '../change-receipt.ts';
import type { ChangeCoverageRepository } from '../change-coverage.ts';
import type { ChangeRequestRepository } from '../change-request.ts';
import type { QueueClaimIdentity, PlatformDeps, PlatformValidationDeps } from '../platform.ts';

export class PlatformRuleError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PlatformRuleError';
    this.code = code;
  }
}

export const PROTOCOL_VERSION = 'cdp/1';
export const ATTEMPT_STARTED_KIND = 'attempt.started';

function eventMarksQueuedAttempt(
  event: { readonly kind: string; readonly attemptId?: string; readonly data: unknown },
  attemptId: string,
): boolean {
  if (event.kind !== ATTEMPT_STARTED_KIND || event.attemptId !== attemptId) return false;
  if (event.data === null || typeof event.data !== 'object') return false;
  return (event.data as { queue?: unknown }).queue === true;
}

function isFencedCommandTransaction(
  tx: CommandTransaction | undefined,
): tx is FencedCommandTransaction {
  return typeof (tx as FencedCommandTransaction | undefined)?.runFenced === 'function';
}

function mapClaimFenceError(error: unknown): never {
  if (error instanceof Error && error.message === 'claim fence rejected') {
    throw new PlatformRuleError(
      'CLAIM_FENCE_REJECTED',
      '队列租约已失效或代次不匹配，拒绝写入。',
    );
  }
  throw error;
}

export class PlatformContext {
  projects: ProjectRepository;
  activity: ActivityLog;
  ids: IdGenerator;
  deliveries: DeliveryRepository;
  workspace: WorkspaceManager | undefined;
  artifacts: ArtifactStore;
  clock: Clock;
  decisionProvider: DecisionProvider | undefined;
  decisionHooks: ReadonlySet<DecisionHook>;
  postExecutionEvaluator: PostExecutionEvaluator | undefined;
  transaction: CommandTransaction | undefined;
  validation: PlatformValidationDeps | undefined;
  haAuthorityFile: string | undefined;
  live: LiveOutput | undefined;
  changeRequests: ChangeRequestRepository | undefined;
  changeImpacts: ChangeImpactRepository | undefined;
  changeReceipts: ChangeReceiptRepository | undefined;
  changeCoverages: ChangeCoverageRepository | undefined;
  queuedHops: QueuedHopRepository | undefined;
  onProjectIdle: ((projectId: string) => Promise<unknown>) | undefined;

  constructor(deps: PlatformDeps) {
    this.projects = deps.projects;
    this.activity = deps.activity;
    this.ids = deps.ids;
    this.deliveries = deps.deliveries;
    this.workspace = deps.workspace;
    this.artifacts = deps.artifacts ?? new InlineArtifactStore();
    this.clock = deps.clock;
    this.decisionProvider = deps.decisionProvider;
    this.decisionHooks = deps.decisionHooks ?? new Set<DecisionHook>(['POST_EXECUTION']);
    this.postExecutionEvaluator = deps.postExecutionEvaluator;
    this.transaction = deps.transaction;
    this.validation = deps.validation;
    this.haAuthorityFile = deps.haAuthorityFile;
    this.live = deps.live;
    this.changeRequests = deps.changeRequests;
    this.changeImpacts = deps.changeImpacts;
    this.changeReceipts = deps.changeReceipts;
    this.changeCoverages = deps.changeCoverages;
    this.queuedHops = deps.queuedHops;
  }

  tx<T>(fn: () => Promise<T>): Promise<T> {
    return this.transaction ? this.transaction.run(fn) : fn();
  }

  txFenced<T>(claim: QueueClaimIdentity | undefined, fn: () => Promise<T>): Promise<T> {
    if (!claim) return this.tx(fn);
    if (!isFencedCommandTransaction(this.transaction)) {
      throw new PlatformRuleError(
        'CLAIM_FENCE_UNAVAILABLE',
        '携带队列领取身份的写请求需要同一事务内的租约核对，但当前平台没有 FencedCommandTransaction。',
      );
    }
    const fence: ClaimFence = {
      id: claim.id,
      owner: claim.owner,
      claimGeneration: claim.claimGeneration,
      now: this.clock.now().toISOString(),
    };
    return this.transaction.runFenced(fence, fn).catch(mapClaimFenceError);
  }

  /** 事务是否支持租约核对：没有它，「带着队列身份」就无从校验。 */
  hasFencedTransaction(): boolean {
    return isFencedCommandTransaction(this.transaction);
  }

  async attemptHasQueueMark(missionId: string, attemptId: string): Promise<boolean> {
    const events = await this.activity.list(missionId);
    return events.some((event) => eventMarksQueuedAttempt(event, attemptId));
  }

  attemptWrite<T>(
    missionId: string,
    attemptId: string,
    claim: QueueClaimIdentity | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (claim) return this.txFenced(claim, fn);
    return this.tx(async () => {
      if (await this.attemptHasQueueMark(missionId, attemptId)) {
        throw new PlatformRuleError(
          'QUEUE_CLAIM_REQUIRED',
          '该 Attempt 由队列领取启动，写入必须携带当前租约身份。',
        );
      }
      return fn();
    });
  }

  async releaseWorkspace(missionId: string, projectRoot?: string): Promise<void> {
    if (this.workspace && projectRoot) await this.workspace.release(missionId, projectRoot).catch(() => undefined);
    const { mission } = await this.locate(missionId);
    if (mission.status === 'completed' && mission.finalReview?.mergedInto && this.workspace?.deleteMergedBranch && projectRoot) {
      try {
        await this.workspace.deleteMergedBranch(missionId, projectRoot);
      } catch (error) {
        await this.event(mission, 'workspace.branch_cleanup_failed', { reason: String(error) }).catch(() => undefined);
      }
    }
    await this.onProjectIdle?.(mission.projectId);
  }

  async ensureProject(projectId: string) {
    return this.projects.ensure(projectId);
  }

  async locate(missionId: string): Promise<{ mission: Mission; project: Project }> {
    for (const project of await this.projects.list()) {
      const mission = project.missions.find((m) => m.id === missionId);
      // 也把 Project 带出来：不变量 C 的报错要点名"被谁占着"，
      // 那个信息只有在兄弟 Mission 里找得到。
      if (mission) return { mission, project };
    }
    throw new PlatformRuleError('UNKNOWN_MISSION', `mission ${missionId} 不存在`);
  }

  async locateItem(
    missionId: string,
    workItemId: string,
  ): Promise<{ mission: Mission; item: WorkItem }> {
    const { mission } = await this.locate(missionId);
    const item = mission.workItem(workItemId);
    if (!item) {
      throw new PlatformRuleError('UNKNOWN_WORK_ITEM', `工作项 ${workItemId} 不存在`);
    }
    return { mission, item };
  }

  async requireAttempt(
    missionId: string,
    attemptId: string,
    kind: AttemptKind,
  ): Promise<{ mission: Mission; project: Project; attempt: Attempt }> {
    const { mission, project } = await this.locate(missionId);
    const attempt = mission.attempt(attemptId);
    if (!attempt) {
      throw new PlatformRuleError('UNKNOWN_ATTEMPT', `attempt ${attemptId} 不存在`);
    }
    if (attempt.kind !== kind) {
      throw new PlatformRuleError(
        'WRONG_ROLE',
        `这个动作只允许 ${kind} 调用，attempt ${attemptId} 是 ${attempt.kind}。`,
      );
    }
    if (attempt.status !== 'in_progress') {
      throw new PlatformRuleError(
        'ATTEMPT_NOT_ACTIVE',
        `attempt ${attemptId} 已经是 ${attempt.status}，不能再提交。`,
      );
    }
    return { mission, project, attempt };
  }

  async event(
    mission: Mission,
    kind: string,
    data: unknown,
    workItemId?: string,
    attemptId?: string,
  ): Promise<void> {
    // 每记一条事件就顺手更新"最后动过"。放在这一个地方，
    // 而不是散在十几个用例里——散着写一定会漏，而漏掉的那条在界面上
    // 表现成"这个 Mission 好像停了"。
    const at = this.clock.now().toISOString();
    mission.touch(at);
    await this.activity.append({
      projectId: mission.projectId,
      missionId: mission.id,
      workItemId,
      attemptId,
      kind,
      data,
      // ---- Envelope 公共语义（S10.3）----
      protocolVersion: PROTOCOL_VERSION,
      // 用 UUID 而不是发号器：messageId 只需要唯一，不需要连续。
      // 走发号器的话，每记一条事件都要占一个号段位——号段用尽时
      // 一次**记日志**会把正经操作顶失败，代价和收益完全不成比例。
      messageId: randomUUID(),
      // 因果链：同一条 Mission 的事件串在一起，而每条事件由哪一跳引发
      // 则看 causationId。没有这两个，"为什么会有这一步"只能靠时间戳猜。
      correlationId: mission.id,
      causationId: attemptId,
      contractRevision: mission.contractRevision,
      planRevision: mission.planRevision,
    });
  }
}
