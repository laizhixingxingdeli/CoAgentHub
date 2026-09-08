/**
 * Server 内嵌执行器运行器:server 直接 spawn CLI 执行器(纯 node:child_process,
 * 不引入新依赖)。
 *
 * 职责:
 *  - repoRoot 推导:从 process.cwd() 上溯到 CoAgentHub 仓库根(最外层含
 *    package.json 的目录);可用 COAGENTHUB_REPO_ROOT 环境变量显式覆盖。
 *  - runExecutor:spawn(bin, args, { cwd: repoRoot }),流式收集 stdout/stderr,
 *    超时(默认 30 分钟,EXECUTOR_TIMEOUT_MS 可配)自动 SIGKILL。
 *  - kill:返回句柄上的 kill() 供停止指令终止整个进程组(detached 独立组,
 *    与桥的行为一致,子进程及孙进程一并终止)。
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize, resolve } from "node:path";

/** 默认执行超时:120 分钟(env EXECUTOR_TIMEOUT_MS 覆盖,单位毫秒)。 */
const DEFAULT_TIMEOUT_MS = 120 * 60 * 1000;

/**
 * 推导 CoAgentHub 仓库根:从 process.cwd() 开始逐级上溯,取「最外层」含
 * package.json 的目录(packages/backend/server 自身也有 package.json,所以
 * 不能停在第一级——上溯到父目录不再有 package.json 才是仓库根)。
 */
export function findRepoRoot(): string {
  const override = process.env.COAGENTHUB_REPO_ROOT;
  if (override && existsSync(override)) return override;
  let dir = process.cwd();
  let last = dir;
  for (;;) {
    if (existsSync(resolve(dir, "package.json"))) {
      last = dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return last;
}

/**
 * Windows 垫片解析(specs/windows-cmd-executor-spawn.md R1)。
 *
 * npm 安装的 CLI 在 Windows 上是 `.cmd` 垫片,而 Node 自 CVE-2024-27980 加固后
 * 拒绝在无 shell 时 spawn `.cmd`/`.bat`,直接抛 EINVAL —— 于是 Windows 主机上
 * 任何执行器都起不来。
 *
 * **不能用 `shell: true` 换取兼容**:那样 args 会被拼接进命令行且不转义
 * (Node DEP0190),而 `{ticketContent}` 会把整份多行任务书作为**一个** argv
 * 元素传入(queue.ts),经 cmd.exe 无法可靠还原。
 *
 * 因此在 spawn 前把垫片解析成可直接 spawn 的真实目标,argv 数组语义保持不变:
 * args 只做前缀追加,不做任何转义或重排。解析不出目标时**原样返回**,让 spawn
 * 抛出与配置一致的错误,不做兜底猜测。
 */
export function resolveWindowsLauncher(
  bin: string,
  args: string[],
  deps: {
    platform?: NodeJS.Platform;
    readShim?: (path: string) => string | undefined;
    exists?: (path: string) => boolean;
    nodeBin?: string;
  } = {},
): { bin: string; args: string[] } {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") return { bin, args };
  if (!/\.(cmd|bat)$/i.test(bin)) return { bin, args };

  const readShim =
    deps.readShim ??
    ((path: string) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    });
  const shim = readShim(bin);
  if (!shim) return { bin, args };

  // 垫片的启动行是最后一条含 `%*`(转发全部参数)的行;目标是该行里第一个
  // 含 `%dp0%` 的引号 token(`%_prog%` 是 node 自身,不是目标)。
  const launchLine = shim
    .split(/\r?\n/)
    .filter((line) => line.includes("%*"))
    .pop();
  if (!launchLine) return { bin, args };
  const target = [...launchLine.matchAll(/"([^"]*)"/g)]
    .map((m) => m[1])
    .find((token) => token.includes("%dp0%") && !token.includes("%_prog%"));
  if (!target) return { bin, args };

  // `%dp0%` 自带结尾反斜杠,替换后会出现双反斜杠,必须规范化。
  const resolved = normalize(target.replaceAll("%dp0%", `${dirname(bin)}\\`));
  const exists = deps.exists ?? existsSync;
  if (!exists(resolved)) return { bin, args };

  // `.exe` 直接起;`.js` 或无扩展名的 node 脚本(shebang)交给 node 起。
  return resolved.toLowerCase().endsWith(".exe")
    ? { bin: resolved, args }
    : { bin: deps.nodeBin ?? process.execPath, args: [resolved, ...args] };
}

export interface ExecutorRunOptions {
  bin: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
  /** 流式输出回调(边收边回传/写日志);未提供则仅累积到 stdout/stderr。 */
  onOutput?: (chunk: string, source: "stdout" | "stderr") => void;
  /**
   * 叠加到 process.env 的执行器配置 env(来源:resolveExecutorCliSpawn 唯一入口)。
   * 省略时不传 spawn env 选项 —— Node 默认继承父进程,与历史行为一致。
   * 传入时显式 `{...process.env, ...env}`,保证 CLI 仍有 PATH/HOME 等。
   */
  env?: Record<string, string>;
  /**
   * 若提供,stdin 管道写入该字符串后 end。
   * 省略/未用时 stdin 仍为 ignore(inputMode=stdin 未实现期间 resolve 恒不传)。
   */
  stdin?: string;
}

export interface ExecutorRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** A2A 执行器返回的新 contextId(跨任务延续上下文);CLI 执行器恒缺省。 */
  contextId?: string;
  /** 结果未确认(第2层):执行器可能已完成但结果无法确认(gateway 未回复 / 网络
   *  错误 / HTTP 5xx);仅 A2A 执行器可能携带,CLI 执行器恒缺省。 */
  unconfirmed?: boolean;
}

export interface ExecutorRunHandle {
  /** detached child 的进程组 id;A2A 或 spawn 失败时缺省。 */
  pid: number | undefined;
  /** 完成时 resolve;timeout/kill 也 resolve(带 timedOut/非零 code)。 */
  promise: Promise<ExecutorRunResult>;
  /** 终止整个进程组(停止指令用);幂等,可安全重复调用。 */
  kill: () => void;
}

/**
 * 启动执行器:spawn + 流式收集 stdout/stderr + 超时 kill。
 * 失败(spawn 抛错,如 bin 不存在)时 promise reject,由调用方回传 failed。
 */
export function runExecutor(opts: ExecutorRunOptions): ExecutorRunHandle {
  const { bin, args, onOutput } = opts;
  const cwd = opts.cwd ?? findRepoRoot();
  const timeoutMs = opts.timeoutMs ?? readTimeoutMs();
  const stdinPayload = opts.stdin;
  const useStdin = typeof stdinPayload === "string";

  // Windows 的 .cmd 垫片不能直接 spawn(EINVAL),先解析成真实目标;
  // 其他平台与非垫片 bin 原样返回。
  const launcher = resolveWindowsLauncher(bin, args);

  let child: ChildProcess;
  try {
    // detached:独立进程组,停止时 process.kill(-pid, SIGTERM) 可整体终止。
    // env/stdin 只由 resolveExecutorCliSpawn 决定是否传入(单一消费入口的下游)。
    child = spawn(launcher.bin, launcher.args, {
      cwd,
      detached: true,
      stdio: [useStdin ? "pipe" : "ignore", "pipe", "pipe"],
      ...(opts.env
        ? { env: { ...process.env, ...opts.env } }
        : {}),
    });
    if (useStdin && child.stdin) {
      child.stdin.end(stdinPayload);
    }
  } catch (e) {
    const err = e as Error;
    // 错误里同时给出配置里的 bin 与实际尝试的 bin:垫片被解析过时,只报其中
    // 一个会让排障看到一个与配置对不上的路径。
    const attempted =
      launcher.bin === bin ? bin : `${bin}(实际尝试 ${launcher.bin})`;
    return {
      pid: undefined,
      promise: Promise.reject(
        new Error(`无法启动 ${attempted}: ${err.message}`, { cause: err }),
      ),
      kill: () => {},
    };
  }

  let stdout = "";
  let stderr = "";
  const MAX_OUTPUT = 512 * 1024;
  const append = (buf: string, target: "out" | "err") => {
    const next = (target === "out" ? stdout : stderr) + buf;
    if (next.length > MAX_OUTPUT) {
      // 只保留尾部:内存不无限增长,回传时截断到最近的内容。
      if (target === "out") stdout = next.slice(-MAX_OUTPUT);
      else stderr = next.slice(-MAX_OUTPUT);
    } else if (target === "out") {
      stdout = next;
    } else {
      stderr = next;
    }
  };

  child.stdout!.on("data", (d: Buffer) => {
    const text = d.toString();
    append(text, "out");
    onOutput?.(text, "stdout");
  });
  child.stderr!.on("data", (d: Buffer) => {
    const text = d.toString();
    append(text, "err");
    onOutput?.(text, "stderr");
  });

  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  let settled = false;

  const promise = new Promise<ExecutorRunResult>((resolvePromise, reject) => {
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, timedOut });
    };

    timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      try {
        process.kill(-(child.pid ?? 0), "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* 已退出 */
        }
      }
    }, timeoutMs);

    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(new Error(`执行器进程错误(${bin}): ${e.message}`, { cause: e }));
    });
    child.on("close", (code) => {
      finish(code);
    });
  });

  return {
    pid: child.pid,
    promise,
    kill: () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGTERM"); // 整个进程组
      } catch {
        try {
          child.kill("SIGTERM");
        } catch {
          /* 已退出 */
        }
      }
    },
  };
}

export function readTimeoutMs(): number {
  const raw = process.env.EXECUTOR_TIMEOUT_MS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

/* ---------------- 执行前 git 快照 / 回滚(票2 控制指令用) ---------------- */

const CHECKPOINT_REF_PREFIX = "refs/coagenthub-cp/";

/** taskId → 隐藏 ref;git ref 不允许的字符替换成 "-",防御异常 id。 */
export function checkpointRef(taskId: string): string {
  const safe = String(taskId ?? "")
    .replace(/[^0-9a-zA-Z._-]/g, "-")
    .replace(/^\./, "-")
    .slice(0, 120);
  return `${CHECKPOINT_REF_PREFIX}${safe || "unknown"}`;
}

/** 同步 git 调用超时:挂起的 git 不能冻结 server 事件循环。 */
const GIT_SYNC_TIMEOUT_MS = 30_000;

/** 同步跑 git 的兼容入口已移除(不再被源码/测试使用;gitExec 为唯一实现,
 *  基于 spawn,不阻塞事件循环)。 */

/** 异步跑 git(推荐):基于 spawn,不阻塞事件循环;超时 SIGKILL 并报失败。
 *  createCheckpoint / resetToCheckpoint 均使用此实现。
 *  extraEnv 与 process.env 合并后传给子进程(例如用 GIT_INDEX_FILE 把 git 指到
 *  另一个 index);省略时行为与两参调用一致。 */
export function gitExec(
  args: string[],
  cwd?: string,
  extraEnv?: Record<string, string>,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("git", args, {
        cwd: cwd ?? findRepoRoot(),
        stdio: ["ignore", "pipe", "pipe"],
        ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
      });
    } catch (e) {
      const err = e as Error;
      resolve({ status: 1, stdout: "", stderr: err.message });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // 已退出,忽略。
      }
    }, GIT_SYNC_TIMEOUT_MS);

    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status: 1, stdout, stderr: stderr || e.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status: timedOut ? 1 : code,
        stdout,
        stderr: timedOut
          ? `git ${args.join(" ")} 超时(${GIT_SYNC_TIMEOUT_MS}ms)`
          : stderr,
      });
    });
  });
}

/**
 * 任务执行前打快照:在**独立临时 index** 上 read-tree HEAD → add -A →
 * write-tree,再 commit-tree -p HEAD,把工作区树挂到隐藏 ref
 * refs/coagenthub-cp/<taskId> 下。不动 HEAD、不动工作区,**也不动用户的真实
 * 暂存区**(specs/checkpoint-must-not-touch-real-index.md)。
 * 失败抛错(调用方中止任务)。与桥 createCheckpoint 一致。
 */
/**
 * 同一仓库的快照必须串行(2026-09-07 定位)。
 *
 * `git add -A` / `write-tree` 都要拿 `.git/index.lock`,两个任务同时对同一棵树
 * 做快照必然有一个拿不到锁:
 * `fatal: Unable to create '…/.git/index.lock': File exists`。
 * 生产里 `maxConcurrentPerWorkspace` 通常挡住同树并发,但它按 project_path 分组 ——
 * **不同 project_path 落在同一个仓库**时(测试里的共享临时仓库、生产里多群指向
 * 同一棵树)就挡不住,快照直接失败、任务被判死且永远到不了 running。
 *
 * 这里按 repoRoot 串行化:同一仓库的快照排队,不同仓库互不影响。
 * 只影响并发时序,不改任何快照语义。
 */
const checkpointLocks = new Map<string, Promise<unknown>>();

async function withRepoCheckpointLock<T>(
  repoRoot: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = checkpointLocks.get(repoRoot) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  // 链上保留「已结算」的尾巴,失败不阻断后续排队者。
  checkpointLocks.set(
    repoRoot,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  try {
    return await run;
  } finally {
    if (checkpointLocks.get(repoRoot) === undefined) {
      checkpointLocks.delete(repoRoot);
    }
  }
}

export async function createCheckpoint(
  taskId: string,
  repoRoot: string,
): Promise<{ ref: string; sha: string }> {
  return withRepoCheckpointLock(repoRoot, () =>
    createCheckpointUnlocked(taskId, repoRoot),
  );
}

async function createCheckpointUnlocked(
  taskId: string,
  repoRoot: string,
): Promise<{ ref: string; sha: string }> {
  const ref = checkpointRef(taskId);
  // 快照对真实 index 只读:全部在独立临时 index 上构造
  // (specs/checkpoint-must-not-touch-real-index.md R2)。
  // 路径唯一 → 并发快照各用各的;放系统临时目录 → 不会被下一次 add -A 看见;
  // 不预创建文件 → 由 git 自己建,失败时错误信息来自 git 而非 fs。
  const tmpIndexPath = join(
    tmpdir(),
    `coagenthub-cp-index-${randomUUID()}.index`,
  );
  const indexEnv = { GIT_INDEX_FILE: tmpIndexPath };
  try {
    // 先按 HEAD 铺底,再把工作区叠上去:工作区里删掉的文件才会从树里消失。
    const base = await gitExec(["read-tree", "HEAD"], repoRoot, indexEnv);
    if (base.status !== 0) {
      throw new Error(`git read-tree HEAD 失败: ${(base.stderr ?? "").trim()}`);
    }
    const add = await gitExec(["add", "-A"], repoRoot, indexEnv);
    if (add.status !== 0) {
      throw new Error(`git add -A 失败: ${(add.stderr ?? "").trim()}`);
    }
    const tree = await gitExec(["write-tree"], repoRoot, indexEnv);
    if (tree.status !== 0) {
      throw new Error(`git write-tree 失败: ${(tree.stderr ?? "").trim()}`);
    }
    // commit-tree 需要作者身份;CI 全新 runner 无 git user.name/email 配置会报
    // "Author identity unknown"。用 -c 显式提供兜底身份,只影响该次命令,
    // 不污染机器全局配置;本机已有全局身份时行为一致(同样用兜底身份)。
    const commit = await gitExec(
      [
        "-c",
        "user.name=CoAgentHub",
        "-c",
        "user.email=coagenthub@localhost",
        "commit-tree",
        tree.stdout.trim(),
        "-p",
        "HEAD",
        "-m",
        `coagenthub checkpoint ${taskId}`,
      ],
      repoRoot,
    );
    if (commit.status !== 0) {
      throw new Error(`git commit-tree 失败: ${(commit.stderr ?? "").trim()}`);
    }
    const sha = commit.stdout.trim();
    const upd = await gitExec(["update-ref", ref, sha], repoRoot);
    if (upd.status !== 0) {
      throw new Error(
        `git update-ref ${ref} 失败: ${(upd.stderr ?? "").trim()}`,
      );
    }
    return { ref, sha };
  } finally {
    // 清理失败只记日志:临时文件残留不该改变快照的结果。
    try {
      rmSync(tmpIndexPath, { force: true });
      rmSync(`${tmpIndexPath}.lock`, { force: true });
    } catch (e) {
      console.log(
        `[executor] 清理临时 index 失败(可忽略): ${tmpIndexPath} ${
          (e as Error).message
        }`,
      );
    }
  }
}

/**
 * 回滚工作区到 checkpoint 快照(仅回滚指令与重试路径调用)。
 * 返回 {ok, message};ok=false 时 message 为失败原因。
 *
 * 快照提交 C 由 `commit-tree <tree> -p HEAD` 合成,**C 是机器生成的产物,不是
 * 用户的提交**,所以不能直接 `reset --hard C` —— 那会把 HEAD 停在 C 上,把整棵
 * 工作树快照(含与之无关的在途改动、有意未跟踪的本机文件)变成分支上的一个
 * `coagenthub checkpoint` 提交(specs/rollback-puts-checkpoint-commit-on-head.md)。
 *
 * 正确语义是两件事(R1):
 *   1. HEAD 与索引回到 C^(打快照那一刻的真实 HEAD)—— 撤销本次尝试的提交;
 *   2. 工作树恢复成 C 的树 —— 快照时的未提交改动重新以**未提交**形式出现,
 *      未跟踪文件仍是 `??`。
 * 因此这里 `reset --hard C^` 再用 `restore --worktree` 只回写工作树
 * (不带 --staged:索引留在 C^,改动才是未提交的)。
 *
 * 与桥行为一致:只恢复已跟踪文件,任务新创建的未跟踪文件会残留
 * (不跑 git clean,避免误删用户工作区里与任务无关的未跟踪文件)。
 */
export async function resetToCheckpoint(
  ref: string,
  repoRoot: string,
): Promise<{ ok: boolean; message: string }> {
  const verify = await gitExec(["rev-parse", "--verify", ref], repoRoot);
  if (verify.status !== 0) {
    return { ok: false, message: `快照不存在: ${ref}(任务 id 可能不对)` };
  }
  const sha = (verify.stdout ?? "").trim();
  const short = sha.slice(0, 12);
  // C^ 即打快照那一刻的真实 HEAD,是回滚的基线。
  const parent = await gitExec(["rev-parse", "--verify", `${sha}^`], repoRoot);
  if (parent.status !== 0) {
    return {
      ok: false,
      message: `快照 ${ref}(${short}) 没有父提交,无法确定回滚基线`,
    };
  }
  // 1) HEAD + 索引 + 工作树回到基线;已在 C^ 中跟踪、被本次尝试删除的文件
  //    也在这一步恢复。
  const base = parent.stdout.trim();
  const reset = await gitExec(["reset", "--hard", base], repoRoot);
  if (reset.status !== 0) {
    return {
      ok: false,
      message: `git reset 失败: ${(reset.stderr ?? "").trim()}`,
    };
  }
  // 2) 只把工作树回写成 C 的树;索引不动,所以改动是「未提交」的。
  // 空树时 `git restore --source C --worktree -- .` 会因 pathspec '.'
  // 匹配不到任何路径而失败;但「树为空 = 无需恢复」,第 1 步已完成全部
  // 工作,不能把这种失败当成回滚失败(会误终止重试)。
  // 判据:正面查 C 的树是否为空(ls-tree 列名),不靠 stderr 文案。
  const treeList = await gitExec(
    ["ls-tree", "-r", "--name-only", sha],
    repoRoot,
  );
  if (treeList.status !== 0) {
    return {
      ok: false,
      message: `git ls-tree 失败: ${(treeList.stderr ?? "").trim()}`,
    };
  }
  const treeHasEntries = (treeList.stdout ?? "").trim().length > 0;
  if (!treeHasEntries) {
    return { ok: true, message: `${ref}(${short})` };
  }
  const restore = await gitExec(
    ["restore", "--source", sha, "--worktree", "--", "."],
    repoRoot,
  );
  if (restore.status !== 0) {
    return {
      ok: false,
      message: `git restore 失败: ${(restore.stderr ?? "").trim()}`,
    };
  }
  return { ok: true, message: `${ref}(${short})` };
}
