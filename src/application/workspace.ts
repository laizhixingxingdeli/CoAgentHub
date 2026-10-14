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
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { canonicalPath } from './canonical-path.ts';
import {
  describeScopeIssues,
  exactFileScopeIssues,
  isJunkPath,
  normalizeScopePath,
  scopeMatches,
} from './scope-paths.ts';

const run = promisify(execFile);

interface WorktreeListEntry {
  path: string;
  head?: string;
  branch?: string;
}

/** 解析 `git worktree list --porcelain`。 */
function parseWorktreePorcelain(text: string): WorktreeListEntry[] {
  const entries: WorktreeListEntry[] = [];
  let current: WorktreeListEntry | undefined;
  for (const raw of text.split(/\r?\n/)) {
    if (raw === '') {
      if (current?.path) entries.push(current);
      current = undefined;
      continue;
    }
    if (raw.startsWith('worktree ')) {
      if (current?.path) entries.push(current);
      current = { path: raw.slice('worktree '.length) };
      continue;
    }
    if (!current) continue;
    if (raw.startsWith('HEAD ')) current.head = raw.slice('HEAD '.length).trim();
    else if (raw.startsWith('branch ')) current.branch = raw.slice('branch '.length).trim();
  }
  if (current?.path) entries.push(current);
  return entries;
}

function isDirectChild(root: string, absPath: string): boolean {
  const parent = resolve(dirname(absPath));
  const a = resolve(root);
  // Windows 路径大小写不敏感。
  if (process.platform === 'win32') {
    return parent.toLowerCase() === a.toLowerCase();
  }
  return parent === a;
}

function missionIdFromBranch(branch: string | undefined): string | undefined {
  if (!branch) return undefined;
  const prefix = 'refs/heads/mission/';
  if (!branch.startsWith(prefix)) return undefined;
  const id = branch.slice(prefix.length);
  return id.includes('/') || id.length === 0 ? undefined : id;
}

/**
 * DETECT-002 trusted fact：只读 `<revision>:package.json`（仓库根）。
 * 任意失败 / 缺失 → undefined，调用方不得据此得到 new_dependency=true。
 */
async function showRootPackageJsonAt(
  cwd: string,
  revision: string,
): Promise<string | undefined> {
  if (typeof revision !== 'string' || revision.length === 0) return undefined;
  try {
    const { stdout } = await run(
      'git',
      ['show', `${revision}:package.json`],
      { cwd: resolve(cwd), encoding: 'utf8' },
    );
    return typeof stdout === 'string' ? stdout : String(stdout);
  } catch {
    return undefined;
  }
}

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

export interface WorkspaceSettleInput {
  readonly missionId: string;
  readonly workItemId: string;
  readonly allowedPaths: readonly string[];
  /** 进提交信息，让人从 git log 就看得出这不是执行者的交付。 */
  readonly label: string;
}

export interface WorkspaceSettleOutcome {
  /** 已提交的路径（授权范围内的脏改动）。 */
  readonly committed: readonly string[];
  readonly commit?: string;
  /** 范围外、原样保留的脏路径。 */
  readonly left: readonly string[];
  /** 本次移出工作树存档的范围外 / 杂 / 被忽略路径（范围内可提交的不在此列）。 */
  readonly archived?: readonly ScopeArchiveRecord[];
}

/**
 * 一条被移出工作树存档的脏路径。`archivePath` 指向工作树之外的存档，
 * 已跟踪文件存的是补丁（可 `git apply` 找回），未跟踪文件是原样移走的那份。
 */
export interface ScopeArchiveRecord {
  readonly path: string;
  readonly archivePath: string;
  readonly tracked: boolean;
}

export type CheckpointRejectionCode =
  | 'unauthorized_paths'
  | 'ambiguous_scope'
  | 'index_outside_scope'
  | 'unparseable_status';

/** 对 dirtyPaths 的每条按同一份判据分类：杂文件 / 被忽略 / 范围内可提交 / 范围外存档。 */
type DirtyClass = 'committable' | 'junk' | 'ignored' | 'outside';

async function classifyDirty(
  cwd: string,
  path: string,
  allowed: readonly string[],
): Promise<DirtyClass> {
  if (isJunkPath(path)) return 'junk';
  // 杂文件之外的被 .gitignore 忽略路径：即使写进了 allowedScope 也不 add -f、不报错。
  // git check-ignore 退出码 0 = 被忽略、1 = 未忽略，其余（仓库坏了等）是 git 真故障，向上抛。
  try {
    await run('git', ['check-ignore', '-q', '--', path], { cwd });
    return 'ignored';
  } catch (error) {
    const code = (error as { code?: number | string }).code;
    if (code !== 1 && code !== '1') throw error;
  }
  return allowed.some((entry) => scopeMatches(entry, path)) ? 'committable' : 'outside';
}

/** 未跟踪文件靠 rename 移出工作树，目标父目录先建好。 */
function archiveUntracked(cwd: string, path: string, archiveRoot: string): ScopeArchiveRecord {
  const dst = join(archiveRoot, path);
  mkdirSync(dirname(dst), { recursive: true });
  renameSync(join(resolve(cwd), path), dst);
  return { path, archivePath: dst.replace(/\\/g, '/'), tracked: false };
}

/**
 * 已跟踪文件先存补丁再还原（`git restore` 回到 HEAD，工作区与 index 一起干净）。
 * 不 rm、不 git clean：还原成 HEAD 内容，存档里的补丁能原样找回改动。
 */
async function archiveTracked(cwd: string, path: string, archiveRoot: string): Promise<ScopeArchiveRecord> {
  const patch = (await run('git', ['diff', 'HEAD', '--', path], { cwd })).stdout;
  const dst = join(archiveRoot, `${path}.patch`);
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, patch);
  await run('git', ['restore', '--source=HEAD', '--staged', '--worktree', '--', path], { cwd });
  return { path, archivePath: dst.replace(/\\/g, '/'), tracked: true };
}

/**
 * 检查点拒绝。除了人读的 message，还带结构化的原因码与路径：
 * 编排器据此写事件、标等待原因、查脏路径是谁留下的，不用对着一句话做字符串匹配。
 */
export class CheckpointRejectedError extends Error {
  readonly code: CheckpointRejectionCode;
  readonly paths: readonly string[];

  // 参数类型不写 `readonly string[]`：源码约束测试按正则找构造参数属性，会把它误认成 readonly 参数。
  constructor(code: CheckpointRejectionCode, message: string, paths: ReadonlyArray<string> = []) {
    super(message);
    this.name = 'CheckpointRejectedError';
    this.code = code;
    this.paths = paths;
  }
}

/** `git status --porcelain=v1 -z --no-renames` 的输出 → 路径集合。 */
function parseStatusPaths(status: string): string[] {
  const dirty = new Set<string>();
  for (const record of status.split('\0').filter(Boolean)) {
    if (record.length < 4) {
      throw new CheckpointRejectedError('unparseable_status', '无法解析 Git status，拒绝创建检查点');
    }
    dirty.add(record.slice(3).replace(/\\\\/g, '/'));
  }
  return [...dirty];
}

export interface MergeOutcome {
  readonly ok: boolean;
  /** 落到了哪个版本；失败时为 undefined。 */
  readonly mergedInto?: string;
  readonly reason?: string;
}

/** 启动时清理孤儿 worktree 时，为什么还留着。 */
export type WorktreeKeepReason =
  | 'protected'
  | 'dirty'
  | 'not_merged'
  | 'uncertain'
  | 'remove_failed';

export interface WorktreeReconcileResult {
  readonly removed: readonly { missionId: string; path: string }[];
  readonly kept: readonly { missionId: string; path: string; reason: WorktreeKeepReason }[];
  readonly warnings: readonly string[];
}

export interface WorkspaceManager {
  /** 成功合入并释放 worktree 后才可安全删除本 Mission 分支。 */
  deleteMergedBranch?(missionId: string, projectRoot: string): Promise<void>;
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
  /**
   * 提交授权范围内的脏改动；范围外的（含杂文件、被 .gitignore 忽略的）移出工作树存档，
   * 不提交也不删除。返回本次存档清单，没有存档时为 `[]`。仅原地模式不提供。
   */
  checkpoint?(
    cwd: string,
    missionId: string,
    workItemId: string,
    allowedPaths: readonly string[],
  ): Promise<void | readonly ScopeArchiveRecord[]>;
  /**
   * 只把范围外 / 杂 / 被忽略的脏路径移出工作树存档，不提交任何东西。
   * 检查点与收口共用同一套分类与存档；仅原地模式不提供。
   */
  archiveDisallowed?(
    cwd: string,
    missionId: string,
    workItemId: string,
    allowedPaths: readonly string[],
  ): Promise<readonly ScopeArchiveRecord[]>;
  /**
   * 工作区里还没提交的路径（已修改、已暂存、未跟踪），相对路径、`/` 分隔。读不出来就抛错。
   * 验证命令的副作用、开跑前的工作区检查都靠它；原地模式没有隔离工作区，不提供。
   */
  dirtyPaths?(cwd: string): Promise<readonly string[]>;
  /**
   * 验证跑完后收口：提交落在 allowedPaths 里的脏路径，范围外的（含杂 / 被忽略）移出工作树
   * 存档，不提交也不删除，作为 `archived` 报告出来。和 checkpoint 的区别是它不因范围外的
   * 脏路径而失败——那是验证命令已经留下的事实，要由后面的门禁点名，而不是在这里再抛一次错。
   */
  settle?(cwd: string, input: WorkspaceSettleInput): Promise<WorkspaceSettleOutcome>;
  /** Read-only assertion that an isolated Mission worktree has no tracked, staged, or untracked changes. */
  assertMissionWorktreeClean?(missionId: string, projectRoot: string): Promise<void>;
  /** 目标分支现在的 HEAD。用来判断分叉基线是不是已经过期。 */
  targetHead(projectRoot: string): Promise<string>;
  /** 只读查询原 Mission worktree 中未解决的合并路径。 */
  getMissionConflictFiles?(missionId: string, projectRoot: string): Promise<string[]>;
  /** 将指定目标分支当前 HEAD 合入原 Mission worktree；冲突时保留冲突状态。 */
  syncMissionWithTarget?(input: {
    missionId: string;
    projectRoot: string;
    targetBranch: string;
  }): Promise<{ targetHead: string; conflictFiles: string[] }>;
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
    message?: string;
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
  /**
   * 收敛孤儿 Mission worktree：只动目标根下、分支为 mission/<id> 的直接子目录。
   * 不删分支、不用 --force。原地模式可不实现。
   */
  reconcile?(
    projectRoot: string,
    protectedMissionIds: ReadonlySet<string> | readonly string[],
  ): Promise<WorktreeReconcileResult>;
  /**
   * DETECT-002：只读仓库根在指定 revision 的 package.json 原文。
   *
   * 固定路径 `revision:package.json`，无任意 path、无 lockfile、不读当前工作区文件。
   * 缺失 / `git show` 非零 → undefined；其它失败同样 undefined（fail closed）。
   * 不经 HTTP / agent tool 暴露。
   */
  showRootPackageJson?(cwd: string, revision: string): Promise<string | undefined>;
  /**
   * 项目仓库当前在哪条分支上。detached HEAD → undefined。
   *
   * **为什么要暴露。** `prepare` 把「当时 checkout 的那条分支」记成合并目标，有人
   * 盯着时没问题；无人值守连跑多个 Mission 时就不是——中途要是有别的东西 checkout
   * 回 master，后续功能会**静默合进 master**，而那正是集成分支要防的事。机器放行
   * 前必须能自己核对一次，不能只依赖「开跑前是对的」。
   */
  currentBranch?(projectRoot: string): Promise<string | undefined>;
  /**
   * 把目标分支**硬退**回某个版本。只用于撤销平台自己刚做的那次合并。
   *
   * `expectedHead` 是防呆：只有目标分支仍停在我们合出来的那个 commit 上才退。
   * 不一致说明期间有别的东西提交过——这时 reset 会连别人的提交一起抹掉。
   * 宁可留一个没验过的合并让人来看，也不要悄悄删别人的东西。
   */
  resetTarget?(input: {
    projectRoot: string;
    toRevision: string;
    expectedHead: string;
  }): Promise<{ ok: boolean; reason?: string }>;
  /**
   * 本仓库已登记的全部 worktree 路径（含主工作区）。
   * 枚举失败必须抛错：HA 授权文件越界判定不能在名单不完整时放行。
   */
  listWorktreePaths?(projectRoot: string): Promise<readonly string[]>;
  /**
   * ancestorRef 是否为 descendantRef 的祖先。无法判定时抛错，由调用方 fail-closed。
   */
  revisionIsAncestor?(
    projectRoot: string,
    ancestorRef: string,
    descendantRef?: string,
  ): Promise<boolean>;
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
      // 调用方提供的集成基线必须先确认有效；否则旧调用继续使用分叉点。
      const target = await this.#currentBranch(repo);
      const baseRevision = pinnedBase
        ? await run('git', ['rev-parse', '--verify', `${pinnedBase}^{commit}`], { cwd: repo })
            .then((r) => r.stdout.trim())
            .catch(() => {
              throw new Error(
                `指定的分叉基线 ${pinnedBase} 在 ${repo} 里不存在。` +
                  '重跑要求两次运行从同一个版本起步，起点找不到就没法比。',
              );
            })
        : await run('git', ['merge-base', 'HEAD', target ?? 'HEAD'], { cwd })
            .then((r) => r.stdout.trim())
            .catch(() => this.head(cwd));
      return { cwd, branch, baseRevision, targetBranch: target };
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

  async currentBranch(projectRoot: string): Promise<string | undefined> {
    return this.#currentBranch(resolve(projectRoot));
  }

  async resetTarget(input: {
    projectRoot: string;
    toRevision: string;
    expectedHead: string;
  }): Promise<{ ok: boolean; reason?: string }> {
    const repo = resolve(input.projectRoot);
    const head = await this.targetHead(repo).catch(() => undefined);
    if (head === undefined) {
      return { ok: false, reason: `读不到 ${repo} 的 HEAD，不退。` };
    }
    if (head !== input.expectedHead) {
      // 期间有别的提交。退回去会把它们一起抹掉。
      return {
        ok: false,
        reason:
          `目标分支 HEAD 已经是 ${head.slice(0, 12)}，不是我们合出来的 ` +
          `${input.expectedHead.slice(0, 12)}；期间有别的提交，拒绝 reset。`,
      };
    }
    try {
      const reset = await run('git', ['reset', '--hard', input.toRevision], { cwd: repo });
      if ((reset as { failed?: boolean }).failed) {
        return { ok: false, reason: `reset 失败：${(reset as { stderr: string }).stderr.trim()}` };
      }
      return { ok: true };
    } catch (error) {
      // promisify(execFile) 在 git 非 0 时抛错，不会带 {failed}。抛出去的话
      // 平台当次写不进 ha_unsafe，重建后再放行会再走一遍自动合并。
      const detail = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: `reset 失败：${detail}` };
    }
  }

  async head(cwd: string): Promise<string> {
    return (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
  }

  async targetHead(projectRoot: string): Promise<string> {
    return (await run('git', ['rev-parse', 'HEAD'], { cwd: resolve(projectRoot) })).stdout.trim();
  }

  async assertMissionWorktreeClean(missionId: string, projectRoot: string): Promise<void> {
    const cwd = join(this.#rootFor(projectRoot), missionId);
    if (!existsSync(cwd)) throw new Error('Mission worktree 不存在');
    const branch = (await run('git', ['symbolic-ref', '-q', 'HEAD'], { cwd }).then((r) => r.stdout.trim()).catch(() => ''));
    if (branch !== `refs/heads/mission/${missionId}`) throw new Error('Mission worktree 分支不符');
    const status = (await run('git', ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all'], { cwd })).stdout;
    if (status.length > 0) throw new Error('Mission worktree 不干净');
  }

  async dirtyPaths(cwd: string): Promise<readonly string[]> {
    const status = (
      await run('git', ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all'], { cwd })
    ).stdout;
    return parseStatusPaths(status);
  }

  async settle(cwd: string, input: WorkspaceSettleInput): Promise<WorkspaceSettleOutcome> {
    const issues = exactFileScopeIssues(input.allowedPaths);
    if (issues.length > 0) {
      throw new CheckpointRejectedError(
        'ambiguous_scope',
        `验证后收口的授权路径不确定：${describeScopeIssues(issues)}`,
        issues.map((issue) => issue.entry),
      );
    }
    const allowed = input.allowedPaths.map((path) => normalizeScopePath(path));
    const dirty = await this.dirtyPaths(cwd);
    if (dirty.length === 0) return { committed: [], left: [], archived: [] };
    // 与 checkpoint 复用同一套分类 / 存档：杂文件、被忽略的、范围外的都不提交，
    // 移出工作树存档；范围内可提交的照常提交。
    const { committable, archived } = await this.#archiveDisallowed(cwd, input.missionId, input.workItemId, dirty, allowed);
    // left 只剩“未能移走”的路径；存档成功后为 []（存档不删不丢，已移出工作树）。
    const moved = new Set(archived.map((record) => record.path));
    const left = dirty.filter((path) => !moved.has(path) && !committable.includes(path));
    let commit: string | undefined;
    if (committable.length > 0) {
      commit = await this.#commitPaths(cwd, committable, `chore(mission): ${input.workItemId} ${input.label} ${input.missionId}`);
    }
    return { committed: committable, ...(commit !== undefined ? { commit } : {}), left, archived };
  }

  /** 把 dirty 分成可提交 / 需存档，并把需存档的移出工作树。返回分类结果与存档清单。 */
  async #archiveDisallowed(
    cwd: string,
    missionId: string,
    workItemId: string,
    dirty: readonly string[],
    allowed: readonly string[],
  ): Promise<{ committable: string[]; archived: ScopeArchiveRecord[] }> {
    const committable: string[] = [];
    const toArchive: string[] = [];
    for (const path of dirty) {
      const kind = await classifyDirty(cwd, path, allowed);
      if (kind === 'committable') committable.push(path);
      else toArchive.push(path);
    }
    return { committable, archived: await this.#archivePaths(cwd, missionId, workItemId, toArchive) };
  }

  /**
   * 把路径移出工作树存档。存档目录在工作树之外、仓库不跟踪：
   * `<cwd 的父目录>/.scope-archive/<missionId>/<workItemId>/<stamp>/`。
   * 已跟踪存补丁后还原，未跟踪原样 rename；不提交、不删除。
   */
  async #archivePaths(
    cwd: string,
    missionId: string,
    workItemId: string,
    paths: readonly string[],
  ): Promise<ScopeArchiveRecord[]> {
    if (paths.length === 0) return [];
    const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const archiveRoot = join(dirname(resolve(cwd)), '.scope-archive', missionId, workItemId, stamp);
    const trackedList = (await run('git', ['ls-files', '-z', '--', ...paths], { cwd })).stdout
      .split('\0').filter(Boolean).map((path) => path.replace(/\\/g, '/'));
    const isTracked = new Set(trackedList);
    const records: ScopeArchiveRecord[] = [];
    for (const path of paths) {
      records.push(
        isTracked.has(path)
          ? await archiveTracked(cwd, path, archiveRoot)
          : archiveUntracked(cwd, path, archiveRoot),
      );
    }
    return records;
  }

  /** 只存档、不提交。开跑前核对用它把范围外的脏改动从工作树里移走。 */
  async archiveDisallowed(
    cwd: string,
    missionId: string,
    workItemId: string,
    allowedPaths: readonly string[],
  ): Promise<readonly ScopeArchiveRecord[]> {
    const allowed = allowedPaths.map((path) => normalizeScopePath(path));
    const dirty = await this.dirtyPaths(cwd);
    if (dirty.length === 0) return [];
    const { archived } = await this.#archiveDisallowed(cwd, missionId, workItemId, dirty, allowed);
    return archived;
  }

  /**
   * pathspec 一律按字面量理解。已跟踪文件被 `git rm` 之后工作区里没有这个路径，
   * `--literal-pathspecs add -A` 会 exit 128（pathspec 不匹配任何文件），所以存在的
   * 路径走 literal `add -A`，已不存在的路径走 `git update-index --remove`（把删除记进 index；
   * `git add -u -- <缺失路径>` 同样会因 pathspec 不匹配而 exit 128，用不得）。
   * 只 add 分类为可提交的具体路径，不 add 目录条目本身。
   */
  async #commitPaths(cwd: string, paths: readonly string[], message: string): Promise<string> {
    const missing: string[] = [];
    const present: string[] = [];
    for (const path of paths) {
      (existsSync(join(resolve(cwd), path)) ? present : missing).push(path);
    }
    if (missing.length > 0) await run('git', ['update-index', '--remove', '--', ...missing], { cwd });
    if (present.length > 0) await run('git', ['--literal-pathspecs', 'add', '-A', '--', ...present], { cwd });
    // commit 不传 pathspec：对已删除路径 `--literal-pathspecs commit -- <path>` 同样 exit 128。
    // 先确认暂存区里的路径都在本次 paths 里，再无 pathspec 提交：index 里即便有别的暂存
    // 内容也不会被带进来，越界由调用方（checkpoint）显式判成故障。
    const wanted = new Set(paths);
    const staged = (await run('git', ['diff', '--cached', '--name-only', '-z'], { cwd })).stdout
      .split('\0').filter(Boolean).map((path) => path.replace(/\\/g, '/'));
    const extra = staged.filter((path) => !wanted.has(path));
    if (extra.length > 0) {
      throw new Error(`暂存区包含本次提交之外的路径：${extra.join(', ')}`);
    }
    await run(
      'git',
      ['-c', 'user.name=coagenthub', '-c', 'user.email=noreply@local', 'commit', '-m', message],
      { cwd },
    );
    return this.head(cwd);
  }

  async checkpoint(
    cwd: string,
    missionId: string,
    workItemId: string,
    allowedPaths: readonly string[],
  ): Promise<readonly ScopeArchiveRecord[]> {
    if (!Array.isArray(allowedPaths) || allowedPaths.length === 0) {
      throw new Error('检查点授权路径不能为空');
    }
    // 判据与建单时的前置校验是同一份（scope-paths.ts）：能收进来的范围，检查点一定认。
    const issues = exactFileScopeIssues(allowedPaths);
    if (issues.length > 0) {
      throw new CheckpointRejectedError(
        'ambiguous_scope',
        `检查点授权路径不确定：${describeScopeIssues(issues)}`,
        issues.map((issue) => issue.entry),
      );
    }
    const allowed = allowedPaths.map((path) => normalizeScopePath(path));
    const dirty = await this.dirtyPaths(cwd);
    if (dirty.length === 0) return [];
    // 范围外的脏文件不再抛 unauthorized_paths：存档后移出工作树，范围内的照常提交。
    const { committable, archived } = await this.#archiveDisallowed(cwd, missionId, workItemId, dirty, allowed);
    if (committable.length > 0) {
      await this.#commitPaths(cwd, committable, `chore(mission): ${workItemId} 检查点 ${missionId}`);
    }
    // 存档之后 index 里若仍有范围外的暂存，是真故障（不该由我们造成）。
    const staged = (await run('git', ['diff', '--cached', '--name-only', '-z'], { cwd })).stdout
      .split('\0').filter(Boolean).map((path) => path.replace(/\\/g, '/'));
    const stagedOutside = staged.filter((path) => !allowed.some((entry) => scopeMatches(entry, path)));
    if (stagedOutside.length) {
      throw new CheckpointRejectedError(
        'index_outside_scope',
        `Git index 包含未授权路径：${stagedOutside.join(', ')}`,
        stagedOutside,
      );
    }
    return archived;
  }

  async getMissionConflictFiles(missionId: string, projectRoot: string): Promise<string[]> {
    const cwd = join(this.#rootFor(projectRoot), missionId);
    if (!existsSync(cwd)) throw new Error('Mission worktree 不存在');
    const expectedBranch = `refs/heads/mission/${missionId}`;
    const actualBranch = (await run('git', ['symbolic-ref', '-q', 'HEAD'], { cwd })).stdout.trim();
    if (actualBranch !== expectedBranch) throw new Error('Mission worktree 分支不符');
    return (await run('git', ['diff', '--name-only', '--diff-filter=U', '-z'], { cwd })).stdout
      .split('\0').filter(Boolean);
  }

  async syncMissionWithTarget(input: {
    missionId: string;
    projectRoot: string;
    targetBranch: string;
  }): Promise<{ targetHead: string; conflictFiles: string[] }> {
    const repo = resolve(input.projectRoot);
    const cwd = join(this.#rootFor(input.projectRoot), input.missionId);
    if (!existsSync(cwd)) throw new Error('Mission worktree 不存在');
    if (!input.targetBranch || input.targetBranch.startsWith('-')) throw new Error('目标分支无效');
    const targetRef = `refs/heads/${input.targetBranch}`;
    const actualTargetBranch = await this.#currentBranch(repo);
    if (actualTargetBranch !== input.targetBranch) throw new Error('目标仓库不在预期目标分支');
    const targetHead = (await run('git', ['rev-parse', '--verify', `${targetRef}^{commit}`], { cwd: repo })).stdout.trim();
    const missionBranch = `refs/heads/mission/${input.missionId}`;
    const actualMissionBranch = (await run('git', ['symbolic-ref', '-q', 'HEAD'], { cwd })).stdout.trim();
    if (actualMissionBranch !== missionBranch) throw new Error('Mission worktree 分支不符');
    const existingConflicts = await this.getMissionConflictFiles(input.missionId, input.projectRoot);
    if (existingConflicts.length > 0) {
      const mergeHead = await run('git', ['rev-parse', '--verify', 'MERGE_HEAD'], { cwd })
        .then((result) => result.stdout.trim());
      return { targetHead: mergeHead || targetHead, conflictFiles: existingConflicts };
    }
    if ((await run('git', ['status', '--porcelain'], { cwd })).stdout.trim()) throw new Error('Mission worktree 不干净');
    if ((await run('git', ['status', '--porcelain'], { cwd: repo })).stdout.trim()) throw new Error('目标工作区不干净');
    const current = (await run('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
    if (current === targetHead || (await run('git', ['merge-base', '--is-ancestor', targetHead, 'HEAD'], { cwd }).then(() => true).catch(() => false))) {
      return { targetHead, conflictFiles: [] };
    }
    const merge = await run('git', ['merge', '--no-edit', targetHead], { cwd }).then(() => true).catch(() => false);
    if (merge) return { targetHead, conflictFiles: [] };
    const conflicts = (await run('git', ['diff', '--name-only', '--diff-filter=U', '-z'], { cwd })).stdout
      .split('\0').filter(Boolean);
    if (conflicts.length === 0) {
      throw new Error('目标合并失败但没有未合并路径；保留 Mission worktree 状态以供检查');
    }
    return { targetHead, conflictFiles: conflicts };
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
    message?: string;
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

    const merge = await run('git', ['merge', '--no-ff', '-m', input.message ?? `merge(mission): ${input.missionId}`, input.branch], {
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
   * 启动时清掉**已安全合入且无保护**的 Mission worktree 目录。
   *
   * 只看 `git worktree list --porcelain` 里、路径是 `#rootFor` **直接子目录**、
   * 且分支为 `refs/heads/mission/<missionId>` 的条目。主工作区、根外路径、
   * 非 mission 分支一律不动。不删分支；`worktree remove` **不带** `--force`。
   */
  async reconcile(
    projectRoot: string,
    protectedMissionIds: ReadonlySet<string> | readonly string[],
  ): Promise<WorktreeReconcileResult> {
    const repo = resolve(projectRoot);
    const targetRoot = await canonicalPath(this.#rootFor(projectRoot));
    const protectedIds =
      protectedMissionIds instanceof Set
        ? protectedMissionIds
        : new Set(protectedMissionIds);

    const removed: { missionId: string; path: string }[] = [];
    const kept: { missionId: string; path: string; reason: WorktreeKeepReason }[] = [];
    const warnings: string[] = [];

    let targetHead: string;
    try {
      targetHead = (await run('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
    } catch (error) {
      warnings.push(
        `无法读取 ${repo} 的 HEAD，跳过 worktree 收敛：${error instanceof Error ? error.message : String(error)}`,
      );
      return { removed, kept, warnings };
    }

    let porcelain: string;
    try {
      porcelain = (await run('git', ['worktree', 'list', '--porcelain'], { cwd: repo })).stdout;
    } catch (error) {
      warnings.push(
        `无法列出 worktree：${error instanceof Error ? error.message : String(error)}`,
      );
      return { removed, kept, warnings };
    }

    for (const entry of parseWorktreePorcelain(porcelain)) {
      const abs = await canonicalPath(entry.path);
      if (!isDirectChild(targetRoot, abs)) continue;
      const missionId = missionIdFromBranch(entry.branch);
      if (!missionId) continue;

      // 目录名与分支 missionId 必须一致，否则身份不确定，绝不删除。
      const dirName = basename(abs);
      const nameMatches =
        process.platform === 'win32'
          ? dirName.toLowerCase() === missionId.toLowerCase()
          : dirName === missionId;
      if (!nameMatches) {
        warnings.push(
          `worktree 目录名 ${dirName} 与分支 missionId ${missionId} 不一致，保留`,
        );
        kept.push({ missionId, path: abs, reason: 'uncertain' });
        continue;
      }

      if (protectedIds.has(missionId)) {
        kept.push({ missionId, path: abs, reason: 'protected' });
        continue;
      }

      let dirty = false;
      try {
        const status = (await run('git', ['status', '--porcelain'], { cwd: abs })).stdout.trim();
        dirty = status.length > 0;
      } catch (error) {
        warnings.push(
          `无法读 ${abs} 的 status，保留 worktree：${error instanceof Error ? error.message : String(error)}`,
        );
        kept.push({ missionId, path: abs, reason: 'uncertain' });
        continue;
      }
      if (dirty) {
        kept.push({ missionId, path: abs, reason: 'dirty' });
        continue;
      }

      const worktreeHead = entry.head;
      if (!worktreeHead) {
        warnings.push(`worktree ${abs} 缺少 HEAD，保留`);
        kept.push({ missionId, path: abs, reason: 'uncertain' });
        continue;
      }

      let merged: boolean | undefined;
      try {
        await run('git', ['merge-base', '--is-ancestor', worktreeHead, targetHead], {
          cwd: repo,
        });
        merged = true;
      } catch (error: unknown) {
        const code =
          error && typeof error === 'object' && 'code' in error
            ? (error as { code?: number | string }).code
            : undefined;
        // git 约定：非祖先时 exit 1；其它码当不确定。
        if (code === 1 || code === '1') {
          merged = false;
        } else {
          warnings.push(
            `无法判断 ${missionId} (${worktreeHead.slice(0, 8)}) 是否已合入目标：${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          kept.push({ missionId, path: abs, reason: 'uncertain' });
          continue;
        }
      }
      if (!merged) {
        kept.push({ missionId, path: abs, reason: 'not_merged' });
        continue;
      }

      try {
        await run('git', ['worktree', 'remove', abs], { cwd: repo });
        removed.push({ missionId, path: abs });
      } catch (error) {
        warnings.push(
          `移除 worktree ${abs} 失败（未强制）：${error instanceof Error ? error.message : String(error)}`,
        );
        kept.push({ missionId, path: abs, reason: 'remove_failed' });
      }
    }

    await run('git', ['worktree', 'prune'], { cwd: repo }).catch(() => undefined);
    return { removed, kept, warnings };
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
        `chore(mission): ${what} ${missionId}`,
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

  async deleteMergedBranch(missionId: string, projectRoot: string): Promise<void> {
    const cwd = join(this.#rootFor(projectRoot), missionId);
    if (existsSync(cwd)) throw new Error('Mission worktree 尚未释放，保留分支');
    const branch = `mission/${missionId}`;
    // 显式核对相对当前集成 HEAD 已合入，再用 -d，避免 upstream 改变安全判断。
    await run('git', ['merge-base', '--is-ancestor', branch, 'HEAD'], { cwd: projectRoot });
    await run('git', ['branch', '-d', '--', branch], { cwd: projectRoot });
  }

  /**
   * 仅 `git show <revision>:package.json`。路径字面量固定，调用方不能选文件。
   */
  async showRootPackageJson(cwd: string, revision: string): Promise<string | undefined> {
    return showRootPackageJsonAt(cwd, revision);
  }

  async listWorktreePaths(projectRoot: string): Promise<readonly string[]> {
    const repo = resolve(projectRoot);
    let porcelain: string;
    try {
      porcelain = (await run('git', ['worktree', 'list', '--porcelain'], { cwd: repo })).stdout;
    } catch (error) {
      throw new Error(
        `无法列出 worktree：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const paths = parseWorktreePorcelain(porcelain)
      .map((entry) => entry.path)
      .filter((path) => typeof path === 'string' && path.trim() !== '')
      .map((path) => resolve(path));
    if (paths.length === 0) {
      throw new Error(`git worktree list 没有返回任何路径：${repo}`);
    }
    return paths;
  }

  async revisionIsAncestor(
    projectRoot: string,
    ancestorRef: string,
    descendantRef = 'HEAD',
  ): Promise<boolean> {
    const repo = resolve(projectRoot);
    try {
      await run('git', ['merge-base', '--is-ancestor', ancestorRef, descendantRef], { cwd: repo });
      return true;
    } catch {
      return false;
    }
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

  /** 与 Git 实现同契约；原地模式同样只允许根 package.json。 */
  async showRootPackageJson(cwd: string, revision: string): Promise<string | undefined> {
    return showRootPackageJsonAt(cwd, revision);
  }
}

