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

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

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

export interface ExecutorRunOptions {
  bin: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
  /** 流式输出回调(边收边回传/写日志);未提供则仅累积到 stdout/stderr。 */
  onOutput?: (chunk: string) => void;
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

  let child: ChildProcess;
  try {
    // detached:独立进程组,停止时 process.kill(-pid, SIGTERM) 可整体终止。
    child = spawn(bin, args, {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    const err = e as Error;
    return {
      promise: Promise.reject(
        new Error(`无法启动 ${bin}: ${err.message}`, { cause: err }),
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
    onOutput?.(text);
  });
  child.stderr!.on("data", (d: Buffer) => {
    const text = d.toString();
    append(text, "err");
    onOutput?.(text);
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

/** 同步跑 git(回滚指令/快照用;与桥 gitSync 一致,纯 node:child_process)。 */
export function gitSync(
  args: string[],
  cwd?: string,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("git", args, {
    cwd: cwd ?? findRepoRoot(),
    encoding: "utf8",
    // 超时兜底:git 挂起(锁/网络盘)时 kill 并报失败,绝不无限阻塞事件循环。
    timeout: GIT_SYNC_TIMEOUT_MS,
  });
  const timedOut =
    (result.error as NodeJS.ErrnoException | null)?.code === "ETIMEDOUT";
  return {
    status: timedOut ? 1 : result.status,
    stdout: result.stdout ?? "",
    stderr: timedOut
      ? `git ${args.join(" ")} 超时(${GIT_SYNC_TIMEOUT_MS}ms)`
      : (result.stderr ?? ""),
  };
}

/** 异步跑 git(推荐):基于 spawn,不阻塞事件循环;超时 SIGKILL 并报失败。
 *  createCheckpoint / resetToCheckpoint 已改用此实现;gitSync 保留为同步兼容口
 *  (仅限测试/低频一次性调用),避免在请求路径上阻塞 server。 */
export function gitExec(
  args: string[],
  cwd?: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("git", args, {
        cwd: cwd ?? findRepoRoot(),
        stdio: ["ignore", "pipe", "pipe"],
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
 * 任务执行前打快照:git add -A → write-tree → commit-tree -p HEAD,把工作区
 * 树挂到隐藏 ref refs/coagenthub-cp/<taskId> 下,不动 HEAD/工作区(仅暂存 index)。
 * 失败抛错(调用方中止任务)。与桥 createCheckpoint 一致。
 */
export async function createCheckpoint(
  taskId: string,
  repoRoot: string,
): Promise<{ ref: string; sha: string }> {
  const ref = checkpointRef(taskId);
  const add = await gitExec(["add", "-A"], repoRoot);
  if (add.status !== 0) {
    throw new Error(`git add -A 失败: ${(add.stderr ?? "").trim()}`);
  }
  const tree = await gitExec(["write-tree"], repoRoot);
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
    throw new Error(`git update-ref ${ref} 失败: ${(upd.stderr ?? "").trim()}`);
  }
  return { ref, sha };
}

/**
 * 回滚工作区:git reset --hard 到 checkpoint ref(仅回滚指令显式调用,
 * 从不自动执行)。返回 {ok, message};ok=false 时 message 为失败原因。
 *
 * 与桥行为一致:reset --hard 只恢复已跟踪文件,任务新创建的未跟踪文件
 * 会残留(不跑 git clean,避免误删用户工作区里与任务无关的未跟踪文件)。
 */
export async function resetToCheckpoint(
  ref: string,
  repoRoot: string,
): Promise<{ ok: boolean; message: string }> {
  const verify = await gitExec(["rev-parse", "--verify", ref], repoRoot);
  if (verify.status !== 0) {
    return { ok: false, message: `快照不存在: ${ref}(任务 id 可能不对)` };
  }
  const sha = (verify.stdout ?? "").trim().slice(0, 12);
  const reset = await gitExec(["reset", "--hard", ref], repoRoot);
  if (reset.status !== 0) {
    return {
      ok: false,
      message: `git reset 失败: ${(reset.stderr ?? "").trim()}`,
    };
  }
  return { ok: true, message: `${ref}(${sha})` };
}
