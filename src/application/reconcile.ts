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

import type { MissionStatus, Project } from '../kernel/index.ts';
import type { LiveOutput } from './live.ts';
import type { ActivityLog } from './ports.ts';
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
