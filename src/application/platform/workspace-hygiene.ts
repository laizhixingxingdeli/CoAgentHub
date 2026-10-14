import { PlatformRuleError, type PlatformContext } from './context.ts';
import { submittedAttemptReportId } from './standard-validation.ts';
import { PLATFORM_BLOCKED_EVENT_KIND } from './stalled-work-item.ts';

/**
 * 工作区卫生：验证命令的副作用收口、下一张工单开跑前的脏改动检查、检查点失败的记录。
 *
 * 为什么平台要管：验证命令在 Mission 的 worktree 里跑，会改文件（构建改写文档、安装脚本追加
 * 记录、测试留 .pyc）。这些改动发生在执行者的检查点之后，没人收口，也没人说得清是谁留的，
 * 于是下一张不相关的工单交卷时被检查点以「越界」拒掉（MiRing-V0-probe 的 W-612 → W-615、
 * W-620 → W-621）。这里只做三件事：授权范围内的收口提交（settle，在 workspace 层）、
 * 范围外的原样保留并记下来源、下一张工单开跑前对着来源核对——不自动提交未授权文件，
 * 不扩大 allowedScope，不删任何改动。
 */

export const VALIDATION_SETTLED_EVENT_KIND = 'workspace.validation_settled';
export const SCOPE_ARCHIVED_EVENT_KIND = 'workspace.scope_archived';
export const RESIDUE_ADOPTED_EVENT_KIND = 'workspace.residue_adopted';
export const CHECKPOINT_FAILED_EVENT_KIND = 'workspace.checkpoint_failed';

/** 一个脏路径是谁留下的：来自哪张工单的验证（及哪份报告）。 */
export interface ResidueOrigin {
  readonly workItemId: string;
  readonly reportId?: string;
  readonly at: string;
}

export interface ValidationSettlementInput {
  readonly missionId: string;
  readonly workItemId: string;
  /** 已作为「验证副作用检查点」提交的授权路径。 */
  readonly committed: readonly string[];
  readonly commit?: string;
  /** 范围外、原样保留的脏路径。 */
  readonly left: readonly string[];
  /** 收口本身失败时的原因；失败也要记，不能让脏改动无声无息地留在那里。 */
  readonly error?: string;
  /** 本次移出工作树存档的范围外 / 杂 / 被忽略路径。 */
  readonly archived?: readonly { path: string; archivePath: string; tracked: boolean }[];
  /** 这次存档发生在哪一道：记来源时区分验证命令 / 执行者 / 来源不明。 */
  readonly archiveWhen?: 'checkpoint' | 'settle' | 'preflight';
}

/** 一条存档路径的来源与位置；`source` 沿用现有归因：validation / executor / unknown。 */
type ArchiveEntry = {
  path: string;
  archivePath: string;
  tracked: boolean;
  source: 'validation' | 'executor' | 'unknown';
  originWorkItemId?: string;
  reportId?: string;
};

/**
 * 一次存档的每条路径该归给谁。协调者要看得出这是谁的验证、还是执行者自己带出来的：
 * settle 一定是本次验证命令；checkpoint 先查残留来源，命中就是那条验证，否则是执行者；
 * preflight / 其它查不到来源就老实写来源不明。
 */
async function archiveEntries(
  ctx: PlatformContext,
  input: ValidationSettlementInput,
  reportId: string | undefined,
): Promise<ArchiveEntry[]> {
  const archived = input.archived ?? [];
  const origins = await workspaceResidueOrigins(
    ctx,
    input.missionId,
    archived.map((record) => record.path),
  ).catch(() => ({} as Record<string, ResidueOrigin>));
  return archived.map((record) => {
    const origin = origins[record.path];
    if (input.archiveWhen === 'settle') {
      return {
        ...record,
        source: 'validation',
        originWorkItemId: input.workItemId,
        ...(reportId !== undefined ? { reportId } : {}),
      };
    }
    if (input.archiveWhen === 'checkpoint') {
      return origin
        ? { ...record, source: 'validation', originWorkItemId: origin.workItemId, ...(origin.reportId !== undefined ? { reportId: origin.reportId } : {}) }
        : { ...record, source: 'executor', originWorkItemId: input.workItemId };
    }
    return origin
      ? { ...record, source: 'validation', originWorkItemId: origin.workItemId, ...(origin.reportId !== undefined ? { reportId: origin.reportId } : {}) }
      : { ...record, source: 'unknown' };
  });
}

/** 记一次验证后收口。什么都没发生（干净）就不写事件，避免每张工单多一条空记录。 */
export async function recordValidationSettlement(
  ctx: PlatformContext,
  input: ValidationSettlementInput,
): Promise<{ recorded: boolean }> {
  const archived = input.archived ?? [];
  const hasSettlement =
    input.committed.length > 0 || input.left.length > 0 || input.error !== undefined;
  if (!hasSettlement && archived.length === 0) {
    return { recorded: false };
  }
  const { mission, item } = await ctx.locateItem(input.missionId, input.workItemId);
  const reportId = item.submittedAttemptId
    ? await submittedAttemptReportId(ctx, mission.id, item.id, item.submittedAttemptId)
    : undefined;
  if (hasSettlement) {
    await ctx.event(
      mission,
      VALIDATION_SETTLED_EVENT_KIND,
      {
        committed: [...input.committed],
        left: [...input.left],
        ...(input.commit !== undefined ? { commit: input.commit } : {}),
        ...(reportId !== undefined ? { reportId } : {}),
        ...(input.error !== undefined ? { error: input.error } : {}),
      },
      item.id,
    );
  }
  if (archived.length > 0) {
    await ctx.event(
      mission,
      SCOPE_ARCHIVED_EVENT_KIND,
      { entries: await archiveEntries(ctx, input, reportId) },
      item.id,
    );
  }
  return { recorded: true };
}

/**
 * 给定脏路径，查平台记下的来源。只认「验证后收口」事件里 left 列出的路径，
 * 取每个路径最近的一条；没记过的路径不在结果里——不凭空编来源。
 */
export async function workspaceResidueOrigins(
  ctx: PlatformContext,
  missionId: string,
  paths: readonly string[],
): Promise<Record<string, ResidueOrigin>> {
  const wanted = new Set(paths);
  const origins: Record<string, ResidueOrigin> = {};
  if (wanted.size === 0) return origins;
  const events = await ctx.activity.list(missionId);
  for (let i = events.length - 1; i >= 0 && Object.keys(origins).length < wanted.size; i -= 1) {
    const event = events[i]!;
    if (event.kind !== VALIDATION_SETTLED_EVENT_KIND || event.workItemId === undefined) continue;
    const data = event.data as { left?: unknown; reportId?: unknown } | null;
    if (!data || !Array.isArray(data.left)) continue;
    for (const path of data.left) {
      if (typeof path !== 'string' || !wanted.has(path) || origins[path] !== undefined) continue;
      origins[path] = {
        workItemId: event.workItemId,
        ...(typeof data.reportId === 'string' ? { reportId: data.reportId } : {}),
        at: event.at,
      };
    }
  }
  return origins;
}

/** 人读的来源：`docs/a.md（W-620 的验证 VR-338 留下）`。查不到来源就老实说来源未记录。 */
export function describeResidue(
  paths: readonly string[],
  origins: Readonly<Record<string, ResidueOrigin>>,
): string {
  return paths
    .map((path) => {
      const origin = origins[path];
      if (!origin) return `${path}（来源未记录）`;
      const report = origin.reportId ? ` ${origin.reportId}` : '';
      return `${path}（${origin.workItemId} 的验证${report} 留下）`;
    })
    .join('、');
}

/** 开跑前把范围内的脏路径并入这张工单，并记下它们原来是谁留的。 */
export async function recordResidueAdopted(
  ctx: PlatformContext,
  input: {
    readonly missionId: string;
    readonly workItemId: string;
    readonly paths: readonly string[];
    readonly origins: Readonly<Record<string, ResidueOrigin>>;
  },
): Promise<void> {
  const { mission, item } = await ctx.locateItem(input.missionId, input.workItemId);
  await ctx.event(
    mission,
    RESIDUE_ADOPTED_EVENT_KIND,
    { paths: [...input.paths], origins: { ...input.origins } },
    item.id,
  );
}

/** 检查点失败的结构化记录：等待原因里只有一句话，事件里要有路径和原因码。 */
export async function recordCheckpointFailure(
  ctx: PlatformContext,
  input: {
    readonly missionId: string;
    readonly workItemId: string;
    readonly attemptId?: string;
    readonly code?: string;
    readonly message: string;
    readonly paths: readonly string[];
    readonly origins: Readonly<Record<string, ResidueOrigin>>;
  },
): Promise<void> {
  const { mission, item } = await ctx.locateItem(input.missionId, input.workItemId);
  await ctx.event(
    mission,
    CHECKPOINT_FAILED_EVENT_KIND,
    {
      ...(input.code !== undefined ? { code: input.code } : {}),
      message: input.message,
      paths: [...input.paths],
      origins: { ...input.origins },
    },
    item.id,
    input.attemptId,
  );
}

export interface WorkspaceBlockInput {
  readonly missionId: string;
  readonly workItemId: string;
  readonly paths: readonly string[];
  readonly origins: Readonly<Record<string, ResidueOrigin>>;
}

/**
 * 开跑前发现工作区里有不属于这张工单的脏改动：不启动执行者，把工单收成 blocked 交回协调者。
 *
 * 与 blockStalledWorkItem 的区别：这里工单可以一次尝试都没有（正是要在花钱之前拦），
 * 事件里**不带 orderRevision**——卡住的是工作区而不是工单正文，残留处理完（吸收进恢复单、
 * 或 L3 清理）原工单不改也能再派，不被「未修订不得原样重派」的门禁拦住。
 */
export async function blockWorkItemForWorkspace(
  ctx: PlatformContext,
  input: WorkspaceBlockInput,
): Promise<{ converted: boolean; reason: string }> {
  const { mission, item } = await ctx.locateItem(input.missionId, input.workItemId);
  const skip = (reason: string) => ({ converted: false, reason });
  if (mission.executionMode !== 'standard') {
    return skip(`Mission ${mission.id} 的 executionMode 是 ${mission.executionMode}，只有 Standard 才由平台收成卡住。`);
  }
  if (item.status !== 'dispatched') {
    return skip(`工作项 ${item.id} 当前是 ${item.status}，不是 dispatched，本次不动。`);
  }
  const live = item.attempts.find((attempt) => attempt.status === 'in_progress');
  if (live) {
    return skip(`尝试 ${live.id} 还是 in_progress：还有活执行者，不收尾。`);
  }
  if (input.paths.length === 0) {
    throw new PlatformRuleError('WORKSPACE_BLOCK_EMPTY', '没有任何脏路径，不能以工作区不干净为由收尾。');
  }
  const attemptIds = item.attempts.map((attempt) => attempt.id);
  const described = describeResidue(input.paths, input.origins);
  const reason =
    `开跑前拦下（没有启动执行者）：工作区里有 ${input.paths.length} 个不属于工单 ${item.id} 授权范围的未提交改动：${described}。` +
    '改动原样保留，平台不自动提交、不删除，也不替工单扩大 allowedScope。';
  item.recordBlocked({
    attemptId: attemptIds[attemptIds.length - 1] ?? 'platform',
    reason,
    whatWasTried: [`开跑前核对工作区：${input.paths.join('、')}`],
    needsFromUpstream:
      '先决定这些改动怎么处理再派发：要保留就新建一张恢复单，allowedScope 精确包含这些文件，由它的检查点提交；' +
      '确认不要的，请 L3 清理工作区。处理完之后这张工单不用修订也可以再派发。',
  });
  await ctx.event(
    mission,
    PLATFORM_BLOCKED_EVENT_KIND,
    { source: 'workspace_dirty', paths: [...input.paths], origins: { ...input.origins }, reason },
    item.id,
  );
  return { converted: true, reason };
}
