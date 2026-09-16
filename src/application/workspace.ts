/**
 * Mission 工作区。
 *
 * 一 Mission 一个 git worktree + 一条分支。执行者**永远不碰用户当前的
 * checkout** —— 这不是洁癖：两个任务对同一棵树打快照会抢 `.git/index.lock`，
 * 而且任何在你工作区里跑的 agent 都可能把你正在写的东西一起提交掉。
 * 隔离掉之后这两类问题直接消失，不需要看门狗。
 *
 * Attempt 开始时记 HEAD，上游失败换候选前回到那一点（S06.3）：下一个候选
 * 应该从干净的起点开始，而不是接手半份改到一半的代码。
 *
 * ## 依赖怎么来的
 *
 * worktree 默认落在 `<项目根>/.coagent-worktrees/<mission>/`，**在项目内部**。
 * 于是 Node 沿父目录查找时自然就找到了项目根的 node_modules，不需要任何链接。
 *
 * 一度在这里给 worktree 建过 node_modules 的 junction，结果
 * `git worktree remove --force` 顺着链接把**项目根真实的依赖树删了**。
 * 教训不是"删之前先摘链接"，是**一开始就不该建**——把 worktree 放在项目内
 * 已经解决了问题，那个链接纯属多余，只是多带了一个破坏性的坑。
 *
 * 把 worktree 放到项目外面时，依赖得自己装。那是使用者的选择，不是平台该
 * 偷偷用文件系统链接替他决定的事。
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface PreparedWorkspace {
  /** agent 的 cwd。 */
  readonly cwd: string;
  /** 分出来时的基线版本。 */
  readonly baseRevision: string;
  readonly branch: string;
}

export interface MergeOutcome {
  readonly ok: boolean;
  /** 落到了哪个版本；失败时为 undefined。 */
  readonly mergedInto?: string;
  readonly reason?: string;
}

export interface WorkspaceManager {
  prepare(missionId: string, projectRoot: string): Promise<PreparedWorkspace>;
  head(cwd: string): Promise<string>;
  /** 目标分支现在的 HEAD。用来判断分叉基线是不是已经过期。 */
  targetHead(projectRoot: string): Promise<string>;
  /** 回到某个版本，并清掉未跟踪文件。仅在 Mission worktree 内使用。 */
  rollback(cwd: string, revision: string): Promise<void>;
  /**
   * 把 Mission 分支落到目标分支。
   *
   * **落地前先核对目标分支的 HEAD 还是不是分叉时那个**（S06.5）：不一致
   * 说明底下的代码变了，这时候合进去就是在拿一份过时的基线覆盖别人。
   * 遇到这种情况不合，回一个说得清的失败，交回上游重新同步。
   */
  mergeToTarget(input: {
    missionId: string;
    projectRoot: string;
    branch: string;
    expectedBaseRevision: string;
  }): Promise<MergeOutcome>;
  /** 给 L3 看的改动摘要：相对分叉基线的 diff --stat 与文件清单。 */
  diff(missionId: string, baseRevision: string): Promise<{ stat: string; files: string[] }>;
  release(missionId: string, projectRoot: string): Promise<void>;
  /** Mission worktree 的绝对路径。原地模式没有，返回 undefined。 */
  worktreePath?(missionId: string): string | undefined;
}

export class GitWorktreeManager implements WorkspaceManager {
  #root: string;

  /** worktree 落在哪。默认放 projectRoot 旁边，不污染仓库内部。 */
  constructor(root?: string) {
    this.#root = root ? resolve(root) : resolve('.coagent-worktrees');
  }

  async prepare(missionId: string, projectRoot: string): Promise<PreparedWorkspace> {
    const repo = resolve(projectRoot);
    const branch = `mission/${missionId}`;
    const cwd = join(this.#root, missionId);

    if (existsSync(cwd)) {
      // 续跑同一个 Mission：沿用已有 worktree，不要重开一份。
      return { cwd, branch, baseRevision: await this.head(cwd) };
    }

    const baseRevision = (await run('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
    // 分支可能因为上一次异常退出而残留；先清掉再建，失败不致命。
    await run('git', ['worktree', 'prune'], { cwd: repo }).catch(() => undefined);
    await run('git', ['branch', '-D', branch], { cwd: repo }).catch(() => undefined);
    await run('git', ['worktree', 'add', '-b', branch, cwd, baseRevision], { cwd: repo });
    return { cwd, branch, baseRevision };
  }

  async head(cwd: string): Promise<string> {
    return (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
  }

  async targetHead(projectRoot: string): Promise<string> {
    return (await run('git', ['rev-parse', 'HEAD'], { cwd: resolve(projectRoot) })).stdout.trim();
  }

  async rollback(cwd: string, revision: string): Promise<void> {
    await run('git', ['reset', '--hard', revision], { cwd });
    // 清未跟踪文件。只在 Mission worktree 里做——这也是为什么隔离是前提：
    // 在用户工作区跑 clean 会删掉与任务无关的东西。
    await run('git', ['clean', '-fd'], { cwd });
  }

  async mergeToTarget(input: {
    missionId: string;
    projectRoot: string;
    branch: string;
    expectedBaseRevision: string;
  }): Promise<MergeOutcome> {
    const repo = resolve(input.projectRoot);

    const current = (await run('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
    if (current !== input.expectedBaseRevision) {
      return {
        ok: false,
        reason:
          `目标分支的 HEAD 变了：分叉时是 ${input.expectedBaseRevision.slice(0, 8)}，` +
          `现在是 ${current.slice(0, 8)}。不能直接合——先让协调者基于新基线重新同步验证。`,
      };
    }

    // 工作区不干净就别动：合并会把调用方未提交的改动卷进来。
    const dirty = (await run('git', ['status', '--porcelain'], { cwd: repo })).stdout.trim();
    if (dirty) {
      return { ok: false, reason: `目标工作区有未提交的改动，拒绝合并：
${dirty}` };
    }

    // Mission worktree 里的改动可能还没提交，先替它提交到自己的分支上。
    const missionCwd = join(this.#root, input.missionId);
    if (existsSync(missionCwd)) {
      const missionDirty = (
        await run('git', ['status', '--porcelain'], { cwd: missionCwd })
      ).stdout.trim();
      if (missionDirty) {
        await run('git', ['add', '-A'], { cwd: missionCwd });
        await run(
          'git',
          [
            '-c',
            'user.name=coagenthub',
            '-c',
            'user.email=noreply@local',
            'commit',
            '-m',
            `mission(${input.missionId}): 执行者交付`,
          ],
          { cwd: missionCwd },
        );
      }
    }

    const merge = await run('git', ['merge', '--no-ff', '--no-edit', input.branch], {
      cwd: repo,
    }).catch((error: { stderr?: string; stdout?: string }) => ({
      stdout: '',
      stderr: error.stderr ?? error.stdout ?? String(error),
      failed: true,
    }));
    if ((merge as { failed?: boolean }).failed) {
      // 合不上就退回去，不要把仓库留在冲突中间态。
      await run('git', ['merge', '--abort'], { cwd: repo }).catch(() => undefined);
      return { ok: false, reason: `合并失败：${(merge as { stderr: string }).stderr.trim()}` };
    }

    const mergedInto = (await run('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
    return { ok: true, mergedInto };
  }

  /**
   * 给 L3 看的改动摘要。
   *
   * **必须把未跟踪的新文件也算进去。** `git diff` 只看已跟踪文件——执行者
   * 新建的文件在它眼里根本不存在。落地时 `git add -A` 会把它们一起提交，
   * 于是 L3 看到的 diff 和实际合进去的东西对不上：检视者会在没看过的
   * 内容上签字。
   */
  async diff(missionId: string, baseRevision: string): Promise<{ stat: string; files: string[] }> {
    const cwd = join(this.#root, missionId);
    if (!existsSync(cwd)) return { stat: '（工作区已回收）', files: [] };

    const lines = (text: string) =>
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

    const changed = lines(
      (await run('git', ['diff', '--name-only', baseRevision], { cwd })).stdout,
    );
    const added = lines(
      (await run('git', ['ls-files', '--others', '--exclude-standard'], { cwd })).stdout,
    );

    const stat = (await run('git', ['diff', '--stat', baseRevision], { cwd })).stdout.trim();
    const parts = [stat, ...added.map((file) => ` ${file} | 新建`)].filter(Boolean);
    return {
      stat: parts.length > 0 ? parts.join('\n') : '（无改动）',
      files: [...changed, ...added],
    };
  }

  worktreePath(missionId: string): string {
    return join(this.#root, missionId);
  }

  async release(missionId: string, projectRoot: string): Promise<void> {
    const repo = resolve(projectRoot);
    const cwd = join(this.#root, missionId);
    if (!existsSync(cwd)) return;
    // 只摘掉 worktree，**不删分支**：改动是 Mission 的产出，要留给 L3 检视。
    await run('git', ['worktree', 'remove', '--force', cwd], { cwd: repo }).catch(() => undefined);
    await run('git', ['worktree', 'prune'], { cwd: repo }).catch(() => undefined);
  }
}

/** 不隔离，直接在给定目录里干活。只该在测试或明确接受风险时使用。 */
export class InPlaceWorkspaceManager implements WorkspaceManager {
  async prepare(_missionId: string, projectRoot: string): Promise<PreparedWorkspace> {
    return { cwd: resolve(projectRoot), branch: '(in-place)', baseRevision: 'unknown' };
  }

  async head(): Promise<string> {
    return 'unknown';
  }

  async targetHead(): Promise<string> {
    // 原地模式没有分叉，基线永远不会过期。
    return 'unknown';
  }

  async rollback(): Promise<void> {
    /* 原地模式不回滚：那会动到调用方自己的工作区。 */
  }

  async mergeToTarget(): Promise<MergeOutcome> {
    // 原地模式下改动本来就在目标上，没有"合并"这一步。
    return { ok: true, mergedInto: 'in-place' };
  }

  async diff(): Promise<{ stat: string; files: string[] }> {
    return { stat: '（原地模式，无隔离工作区）', files: [] };
  }

  async release(): Promise<void> {
    /* 无事可做 */
  }
}

