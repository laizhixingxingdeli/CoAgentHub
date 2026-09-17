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
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface PreparedWorkspace {
  /** agent 的 cwd。 */
  readonly cwd: string;
  /** 分出来时的基线版本。 */
  readonly baseRevision: string;
  /** 本 Mission 自己的分支。 */
  readonly branch: string;
  /** 要合回去的那条。和 branch 是两回事。 */
  readonly targetBranch?: string;
}

export interface MergeOutcome {
  readonly ok: boolean;
  /** 落到了哪个版本；失败时为 undefined。 */
  readonly mergedInto?: string;
  readonly reason?: string;
}

export interface WorkspaceManager {
  /**
   * @param pinnedBase 指定从哪个版本分叉。不给就用目标分支当前的 HEAD。
   *
   * **给了才谈得上比较。** 重跑一条任务时，若两次运行各自从"当时的 HEAD"
   * 分叉，起点就不是同一个——第二次可能从"第一次的产出已经合进去之后"开始，
   * 那时活儿都干完了，比出来的成本毫无意义。
   */
  prepare(
    missionId: string,
    projectRoot: string,
    pinnedBase?: string,
  ): Promise<PreparedWorkspace>;
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
  /**
   * 给 L3 看的改动摘要：相对分叉基线的 diff --stat 与文件清单。
   *
   * projectRoot 是必须的：worktree 落在哪由项目决定（见 #rootFor），
   * 而这个方法常常在**另一个进程**里被调用（`l3 show`），那边没 prepare 过。
   */
  diff(
    missionId: string,
    baseRevision: string,
    projectRoot: string,
  ): Promise<{ stat: string; files: string[] }>;
  release(missionId: string, projectRoot: string): Promise<void>;
  /** Mission worktree 的绝对路径。原地模式没有，返回 undefined。 */
  worktreePath?(missionId: string, projectRoot: string): string | undefined;
}

export class GitWorktreeManager implements WorkspaceManager {
  /** 显式指定的落点。不指定就跟着项目走。 */
  #explicitRoot: string | undefined;

  constructor(root?: string) {
    this.#explicitRoot = root ? resolve(root) : undefined;
  }

  /**
   * worktree 落在哪。**默认跟着项目走**：`<projectRoot>/.coagent-worktrees/`。
   *
   * 早先默认是 `resolve('.coagent-worktrees')` —— 相对**进程 cwd**。在平台
   * 自己的仓库里跑自己，两者恰好重合，所以一直没露馅；换一个项目就立刻错：
   * worktree 落在平台仓库下面，而 Node 沿父目录找依赖会找到**平台的**
   * node_modules。实测 coagent-pi 依赖 pi-coding-agent / typebox / undici，
   * 平台这边只有 pg —— 执行者在那种 worktree 里根本跑不动目标项目的代码。
   *
   * 而且它**不报错**，只是莫名其妙地跑不起来。靠使用者每次记得传
   * `--worktrees` 是不成立的：忘了没有任何声音。
   *
   * 放在项目内部还顺带解决了依赖：父目录查找自然命中项目自己的 node_modules，
   * 不需要任何链接（那条路踩过，见文件顶部）。
   */
  #rootFor(projectRoot: string): string {
    return this.#explicitRoot ?? join(resolve(projectRoot), '.coagent-worktrees');
  }

  /**
   * 让 git 别把平台自己的 worktree 目录当成项目的改动。
   *
   * worktree 落在项目内部之后（见 #rootFor），`.coagent-worktrees/` 就成了一个
   * 未跟踪目录，于是项目**永远是脏的**——而落地那道闸要求目标工作区干净。
   * 结果是平台在别人仓库里创建了一个目录，然后因为这个目录拒绝落地。实测
   * 第一次拿真实新项目试流程就撞上了。
   *
   * 写 `.git/info/exclude` 而不是项目的 `.gitignore`：**这是别人的仓库。**
   * info/exclude 是本地的、不进版本库、不会出现在他的 diff 里——正是为这种
   * "我这台机器上的工具产生的东西"准备的。往 .gitignore 里塞一行，就成了
   * 平台擅自改了一个会被提交的文件。
   *
   * 用 --git-common-dir 而不是拼 `.git/`：projectRoot 本身也可能是一个
   * worktree，那时 `.git` 是文件不是目录。
   */
  async #excludeSelf(repo: string, root: string): Promise<void> {
    // 落点在项目外面时不用管：那本来就不会弄脏项目。
    const inside = resolve(root).startsWith(resolve(repo));
    if (!inside) return;
    try {
      const common = (
        await run('git', ['rev-parse', '--git-common-dir'], { cwd: repo })
      ).stdout.trim();
      const excludeFile = join(resolve(repo, common), 'info', 'exclude');
      const rel = resolve(root).slice(resolve(repo).length + 1).replace(/\\/g, '/');
      const line = `/${rel}/`;
      const current = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : '';
      if (current.split(/\r?\n/).some((l) => l.trim() === line)) return;
      mkdirSync(dirname(excludeFile), { recursive: true });
      appendFileSync(
        excludeFile,
        `${current.endsWith('\n') || current === '' ? '' : '\n'}# CoAgentHub 的 Mission 工作区（本地忽略，不进版本库）\n${line}\n`,
      );
    } catch {
      // 忽略失败不致命：最坏的结果是项目看起来是脏的，人能自己处理。
      // 为这个让整条 Mission 起不来才是真的坏。
    }
  }

  async prepare(
    missionId: string,
    projectRoot: string,
    pinnedBase?: string,
  ): Promise<PreparedWorkspace> {
    const repo = resolve(projectRoot);
    const branch = `mission/${missionId}`;
    const root = this.#rootFor(projectRoot);
    const cwd = join(root, missionId);
    await this.#excludeSelf(repo, root);

    if (existsSync(cwd)) {
      // 续跑同一个 Mission：沿用已有 worktree，不要重开一份。
      //
      // 基线必须是**分叉点**，不是 worktree 当前的 HEAD。执行者一旦提交过，
      // HEAD 就走到 Mission 自己的提交上；拿它跟目标分支比永远不相等，
      // 于是每次续跑都被报成"基线过期"——而真正的分叉点可能好好的。
      const target = await this.#currentBranch(repo);
      const forkPoint = await run('git', ['merge-base', 'HEAD', target ?? 'HEAD'], { cwd })
        .then((r) => r.stdout.trim())
        .catch(() => undefined);
      return {
        cwd,
        branch,
        baseRevision: forkPoint ?? (await this.head(cwd)),
        targetBranch: target,
      };
    }

    // 指定了就用指定的；没指定才用目标分支当前的 HEAD。
    // 指定的那个要先核一下真的存在——传一个不存在的版本，`worktree add` 会
    // 用一句 git 的原文报错，而调用方（比如重跑）看不出是自己传错了。
    const baseRevision = pinnedBase
      ? (await run('git', ['rev-parse', '--verify', `${pinnedBase}^{commit}`], { cwd: repo })
          .then((r) => r.stdout.trim())
          .catch(() => {
            throw new Error(
              `指定的分叉基线 ${pinnedBase} 在 ${repo} 里不存在。` +
                '重跑要求两次运行从同一个版本起步，起点找不到就没法比。',
            );
          }))
      : (await run('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
    // 分支可能因为上一次异常退出而残留；先清掉再建，失败不致命。
    await run('git', ['worktree', 'prune'], { cwd: repo }).catch(() => undefined);
    await run('git', ['branch', '-D', branch], { cwd: repo }).catch(() => undefined);
    // 分叉之前先问清楚要合回哪条分支。之后目标分支被切换也不影响这条记录。
    const targetBranch = await this.#currentBranch(repo);
    await run('git', ['worktree', 'add', '-b', branch, cwd, baseRevision], { cwd: repo });
    return { cwd, branch, baseRevision, targetBranch };
  }

  /** 目标仓库当前 checkout 的分支名。detached HEAD 时返回 undefined。 */
  async #currentBranch(repo: string): Promise<string | undefined> {
    const name = (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo })
      .then((r) => r.stdout.trim())
      .catch(() => ''));
    return name && name !== 'HEAD' ? name : undefined;
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
    await this.#commitPending(
      join(this.#rootFor(input.projectRoot), input.missionId),
      input.missionId,
      '执行者交付',
    );

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
  async diff(
    missionId: string,
    baseRevision: string,
    projectRoot: string,
  ): Promise<{ stat: string; files: string[] }> {
    const cwd = join(this.#rootFor(projectRoot), missionId);
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

  worktreePath(missionId: string, projectRoot: string): string {
    return join(this.#rootFor(projectRoot), missionId);
  }

  /**
   * 把 worktree 里还没提交的东西提交到 Mission 自己的分支上。
   *
   * 平台只在落地那一刻提交，而**执行者从来不自己提交**。所以在摘掉 worktree
   * 之前不做这一步，未提交的产出就跟着 `worktree remove --force` 一起没了。
   *
   * 实测代价：一条跑完、独立验过（14 条用例绿、命令端到端通）的 Mission 被
   * 叫停之后，产出整个消失——而 release 的注释还写着"改动是 Mission 的产出，
   * 要留给 L3 检视"。**那句话当时是假的**：它只保住了已提交的东西，而那是空的。
   */
  async #commitPending(cwd: string, missionId: string, what: string): Promise<void> {
    if (!existsSync(cwd)) return;
    const dirty = (await run('git', ['status', '--porcelain'], { cwd })
      .then((r) => r.stdout.trim())
      .catch(() => ''));
    if (!dirty) return;
    await run('git', ['add', '-A'], { cwd }).catch(() => undefined);
    await run(
      'git',
      [
        '-c',
        'user.name=coagenthub',
        '-c',
        'user.email=noreply@local',
        'commit',
        '-m',
        `mission(${missionId}): ${what}`,
      ],
      { cwd },
    ).catch(() => undefined);
  }

  async release(missionId: string, projectRoot: string): Promise<void> {
    const repo = resolve(projectRoot);
    const cwd = join(this.#rootFor(projectRoot), missionId);
    if (!existsSync(cwd)) return;
    // **先把未提交的产出落到分支上，再摘目录。** 顺序反了就等于销毁证据：
    // remove --force 不会问，也不会留下任何痕迹。
    await this.#commitPending(cwd, missionId, '回收工作区前保存未提交的产出');
    // 只摘掉 worktree，**不删分支**：改动是 Mission 的产出，要留给 L3 检视。
    await run('git', ['worktree', 'remove', '--force', cwd], { cwd: repo }).catch(() => undefined);
    await run('git', ['worktree', 'prune'], { cwd: repo }).catch(() => undefined);
  }
}

/** 不隔离，直接在给定目录里干活。只该在测试或明确接受风险时使用。 */
export class InPlaceWorkspaceManager implements WorkspaceManager {
  async prepare(_missionId: string, projectRoot: string): Promise<PreparedWorkspace> {
    return {
      cwd: resolve(projectRoot),
      branch: '(in-place)',
      targetBranch: '(in-place)',
      baseRevision: 'unknown',
    };
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

