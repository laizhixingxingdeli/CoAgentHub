import type { MissionView } from './platform/types.ts';
import { describeResidue, type Platform } from './platform.ts';
import { isJunkPath, normalizeScopePath, scopeMatches } from './scope-paths.ts';
import { CheckpointRejectedError, type WorkspaceManager } from './workspace.ts';

/**
 * 编排器在每一跳前后的守卫：验证后的工作区收口、工单开跑前的工作区核对、检查点失败的记录、
 * 叫协调者之前的状态恢复。
 *
 * 从 Orchestrator 里拆出来：它们都只依赖 Platform 与 WorkspaceManager，不碰候选、队列与租约，
 * 单独成类才守得住「编排器文件不明显变大」（工程规范），也方便单测。
 * 所有方法对平台的写都经 Platform 公开方法，不直接改状态。
 */

type WorkItemView = MissionView['workItems'][number];

export class HopGuards {
  readonly #platform: Platform;
  readonly #workspace: WorkspaceManager;

  constructor(platform: Platform, workspace: WorkspaceManager) {
    this.#platform = platform;
    this.#workspace = workspace;
  }

  /**
   * 验证命令跑完后收口工作区（P0：验证与检查点闭环）。
   *
   * 验证命令在 Mission 的 worktree 里跑，发生在执行者的检查点**之后**，改动没有人收口：
   * 授权范围内的（比如安装脚本追加的记录）会被下一张工单的检查点当成越界拒掉。
   * 这里把授权范围内的脏改动用「验证副作用检查点」提交；范围外的原样保留、不删不提交，
   * 记下来源，让下一张工单开跑前能对着核对。收口本身失败也要留记录——工作区里的改动还在，
   * 只是不能无声无息。
   */
  async settleValidationResidue(missionId: string, item: WorkItemView, cwd: string): Promise<void> {
    const scope = item.order?.allowedScope;
    if (!this.#workspace.settle || !Array.isArray(scope) || scope.length === 0) return;
    try {
      const outcome = await this.#workspace.settle(cwd, {
        missionId,
        workItemId: item.id,
        allowedPaths: scope,
        label: '验证副作用检查点',
      });
      await this.#platform.recordValidationSettlement({
        missionId,
        workItemId: item.id,
        committed: outcome.committed,
        left: outcome.left,
        ...(outcome.commit !== undefined ? { commit: outcome.commit } : {}),
        ...((outcome.archived?.length ?? 0) > 0
          ? { archived: outcome.archived, archiveWhen: 'settle' as const }
          : {}),
      });
    } catch (error) {
      await this.#platform
        .recordValidationSettlement({
          missionId,
          workItemId: item.id,
          committed: [],
          left: [],
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
    }
  }

  /**
   * 工单开跑前核对工作区。
   *
   * - 范围内的残留：并入（恢复单正是这样收口残留的），记下原来的来源；
   * - 范围内的杂文件：不算越界，移出工作树存档（与检查点同一套分类）；
   * - 其余不属于本工单的脏改动：交给 workspace.archiveDisallowed 移出工作树存档，
   *   不再把工单收成 blocked。改动不提交也不删除，存档在工作树之外，有事件记下来源。
   *
   * 读不出工作区状态、或核对本身出错（读来源事件、存档、写事件失败）时放行：
   * 后面的检查点是最终防线，这一道不许反过来让整次运行崩掉。
   */
  async preflightWorkspace(missionId: string, item: WorkItemView, cwd: string): Promise<'ok' | 'blocked'> {
    const scope = item.order?.allowedScope;
    if (!this.#workspace.dirtyPaths || !Array.isArray(scope)) return 'ok';
    try {
      const dirty = await this.#workspace.dirtyPaths(cwd);
      if (dirty.length === 0) return 'ok';
      return await this.#screenDirtyPaths(missionId, item, scope, dirty, cwd);
    } catch {
      return 'ok';
    }
  }

  async #screenDirtyPaths(
    missionId: string,
    item: WorkItemView,
    scope: readonly string[],
    dirty: readonly string[],
    cwd: string,
  ): Promise<'ok' | 'blocked'> {
    const allowed = scope.map((entry) => normalizeScopePath(entry));
    const inScope = (path: string): boolean =>
      !isJunkPath(path) && allowed.some((entry) => scopeMatches(entry, path));
    const foreign = dirty.filter((path) => !inScope(path));
    // 范围外（含杂文件、被忽略的）一律移出工作树存档，不再拦下执行者。
    let archived: readonly { path: string; archivePath: string; tracked: boolean }[] = [];
    if (foreign.length > 0 && this.#workspace.archiveDisallowed) {
      archived = await this.#workspace.archiveDisallowed(cwd, missionId, item.id, scope);
    }
    if (archived.length > 0) {
      // 记事件失败不能让开跑崩掉；存档已经完成，工作树已经干净了。
      await this.#platform
        .recordValidationSettlement({
          missionId,
          workItemId: item.id,
          committed: [],
          left: [],
          archived,
          archiveWhen: 'preflight',
        })
        .catch(() => undefined);
    }
    const moved = new Set(archived.map((record) => record.path));
    const adopted = dirty.filter((path) => inScope(path) && !moved.has(path));
    if (adopted.length > 0) {
      const origins = await this.#platform.attributeWorkspacePaths(missionId, adopted);
      await this.#platform
        .recordResidueAdopted({ missionId, workItemId: item.id, paths: adopted, origins })
        .catch(() => undefined);
    }
    return 'ok';
  }

  /**
   * 检查点拒绝了执行者的成果：写结构化事件（原因码、路径、来源），返回给等待原因用的那句话。
   * 记录失败不能盖住真正的原因，所以事件尽力而为。
   */
  async checkpointFailureDetail(
    missionId: string,
    workItemId: string | undefined,
    attemptId: string,
    error: unknown,
  ): Promise<string> {
    const message = error instanceof Error ? error.message : String(error);
    const paths = error instanceof CheckpointRejectedError ? [...error.paths] : [];
    let origins: Awaited<ReturnType<Platform['attributeWorkspacePaths']>> = {};
    try {
      origins = paths.length > 0 ? await this.#platform.attributeWorkspacePaths(missionId, paths) : {};
      if (workItemId !== undefined) {
        await this.#platform.recordCheckpointFailure({
          missionId,
          workItemId,
          attemptId,
          ...(error instanceof CheckpointRejectedError ? { code: error.code } : {}),
          message,
          paths,
          origins,
        });
      }
    } catch {
      // 见上：只丢记录，不丢原因。
    }
    const provenance =
      paths.length > 0 && Object.keys(origins).length > 0 ? `（来源：${describeResidue(paths, origins)}）` : '';
    return `执行者已交回成果，但冻结范围检查点失败：${message}${provenance}。改动保留在工作区，已停止后续执行。`;
  }

  /**
   * 叫协调者之前的状态恢复（P0：状态一致性）。只处理一类可证明的残留：Mission 不在 executing，
   * 工单带着上一次的结果停在 dispatched，且是被机器续派留下的。其余情形平台判不了，不动。
   * 平台一侧会再核实尝试、租约与修订号；拒绝或失败都不改变「交给协调者」的语义，所以尽力而为。
   * 返回是否真的转换了至少一张，调用方据此重取视图。
   */
  async recoverStrandedDispatches(
    missionId: string,
    view: Pick<MissionView, 'status' | 'workItems'>,
  ): Promise<boolean> {
    if (view.status === 'executing') return false;
    let converted = false;
    for (const item of view.workItems) {
      const latestAttemptId = item.attemptIds.at(-1);
      if (item.status !== 'dispatched' || !item.hasResult || latestAttemptId === undefined) continue;
      try {
        const result = await this.#platform.recoverStrandedWorkItem({
          missionId,
          workItemId: item.id,
          source: 'stranded_dispatch',
          expectedAttemptId: latestAttemptId,
          orderRevision: item.order?.orderRevision ?? 'r1',
        });
        converted = converted || result.converted;
      } catch {
        // 见上：恢复失败时工单维持原样，协调者照旧收到它的真实状态。
      }
    }
    return converted;
  }
}
