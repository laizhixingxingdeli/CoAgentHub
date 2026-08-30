import type { TaskAttempt } from "@laizhixingxingdeli/database/schema";
import { gitExec } from "@server/lib/executor-runner";

export type ClaimVerificationStatus =
  | "verified"
  | "not_found"
  | "outside_window"
  | "skipped";

export interface ClaimVerification {
  status: ClaimVerificationStatus;
  hash: string;
  /** 仅 skipped:未核实的原因(如 a2a 执行器本地无对应仓库)。 */
  reason?: string;
  commitAt?: string;
  windowStartedAt?: string;
}

/** 核实入口的执行器类别:cli=本地有仓库可核实;a2a=远端执行,本地无仓库。 */
export type ClaimVerificationMode = "cli" | "a2a";

/** Timestamp precision tolerance shared by task and child execution windows. */
export const COMMIT_TIME_TOLERANCE_MS = 5_000;

export type CommitExistence = "verified" | "not_found";

/**
 * Best-effort existence check for a commit claim that is not tied to the
 * current task window (for example, an alreadySatisfied close claim).
 * Undefined means the repository or git was unavailable, matching the
 * lifecycle-preserving behavior of verifyCommitClaim.
 */
export async function verifyCommitExists(
  hash: string | undefined,
  repoRoot: string,
): Promise<CommitExistence | undefined> {
  if (!hash || !/^[0-9a-f]{7,40}$/i.test(hash)) return "not_found";
  try {
    const repository = await gitExec(
      ["rev-parse", "--is-inside-work-tree"],
      repoRoot,
    );
    if (repository.status !== 0 || repository.stdout.trim() !== "true") {
      return undefined;
    }
    const exists = await gitExec(
      ["cat-file", "-e", `${hash}^{commit}`],
      repoRoot,
    );
    return exists.status === 0 ? "verified" : "not_found";
  } catch {
    return undefined;
  }
}

/**
 * 三个写入 diffSummary.hash 的完成入口(CLI 完成 / detached 任务 PATCH /
 * a2a 完成)共用的核实入口(spec verify-agent-claims v1.1)。
 *
 * - hash 缺失/格式非法 → 无可核实,返回 undefined
 * - a2a 执行器本地没有对应仓库 → 留下显式「未核实」痕迹(status=skipped),
 *   而不是让 hash 看起来像是已核实过
 * - cli → 走仓库核实(verifyCommitClaim);仓库不可达/非 git/git 失败返回
 *   undefined(按 spec R4 跳过核实、不写核实字段)
 * 任何情况下都不抛错,不影响任务落终态。
 */
export async function verifyReportedCommit(
  hash: string | undefined,
  repoRoot: string | null,
  attempts: readonly TaskAttempt[],
  mode: ClaimVerificationMode,
): Promise<ClaimVerification | undefined> {
  if (!hash || !/^[0-9a-f]{7,40}$/i.test(hash)) return undefined;
  if (mode === "a2a") {
    return { status: "skipped", hash, reason: "a2a_no_local_repo" };
  }
  if (!repoRoot) return undefined;
  return verifyCommitClaim(hash, repoRoot, attempts);
}

/**
 * R6 主闸(quota-failure-on-clean-exit v1.1):本次运行在任务窗口内是否产生提交。
 *
 * 双探针,优先级从前到后:
 * 1. **执行前快照探针**(checkpointRef 存在时,CLI 主路径):`<checkpoint>..HEAD`
 *    的提交 = 本次运行在预运行快照之上新增的提交,与时钟完全无关。上一轮运行
 *    (同一工作树、可能几秒前刚提交过)的提交都是快照的祖先,严格排除;本轮提交
 *    无论是否与 startedAt 同秒都必然计入 —— 规避 git 提交时间为整秒精度、而
 *    attempts 窗口起点为毫秒精度的同秒歧义。
 * 2. **时间窗口探针**(无快照,如 detached/a2a 路径):窗口 = [首次 attempt 开始
 *    时刻, 当前时刻],提交时间取 committer date(与 verifyCommitClaim 的 %cI
 *    同口径)。git 的 `--since` 会截断毫秒 ISO 到整秒,故 git 侧只做带 60s 余量
 *    的粗过滤,窗口判定在 JS 侧按毫秒精确比较。
 *
 * 返回 true = 窗口内确有提交;false = 确认无提交;undefined = 仓库/git 不可达
 * 或无法判定 —— 调用方按「无提交证据」处理,保留既有额度语义。
 */
export async function hasCommitInTaskWindow(
  repoRoot: string | null,
  attempts: readonly TaskAttempt[],
  checkpointRef?: string | null,
): Promise<boolean | undefined> {
  if (!repoRoot) return undefined;
  if (checkpointRef) {
    try {
      const count = await gitExec(
        ["rev-list", "--count", `${checkpointRef}..HEAD`],
        repoRoot,
      );
      if (count.status !== 0) return undefined;
      const n = Number.parseInt(count.stdout.trim(), 10);
      if (Number.isFinite(n)) return n > 0;
    } catch {
      return undefined;
    }
  }
  const windowStart = attempts[0]?.startedAt;
  if (!windowStart) return undefined;
  const startMs = Date.parse(windowStart);
  if (!Number.isFinite(startMs)) return undefined;
  try {
    const coarse = new Date(startMs - 60_000).toISOString();
    const log = await gitExec(
      ["log", "--format=%cI", `--since=${coarse}`, "HEAD"],
      repoRoot,
    );
    if (log.status !== 0) return undefined;
    let inWindow = 0;
    for (const line of log.stdout.split("\n")) {
      const commitMs = Date.parse(line.trim());
      if (Number.isFinite(commitMs) && commitMs >= startMs) inWindow += 1;
    }
    return inWindow > 0;
  } catch {
    return undefined;
  }
}

/**
 * Best-effort verification of a reported commit in the same repository used
 * by the executor. Any repository/git failure is intentionally omitted from
 * the result so it cannot change task lifecycle state.
 */
export async function verifyCommitClaim(
  hash: string | undefined,
  repoRoot: string,
  attempts: readonly TaskAttempt[],
): Promise<ClaimVerification | undefined> {
  if (!hash || !/^[0-9a-f]{7,40}$/i.test(hash)) return undefined;
  try {
    const existence = await verifyCommitExists(hash, repoRoot);
    if (existence === undefined) return undefined;
    if (existence === "not_found") {
      return { status: "not_found", hash };
    }
    const shown = await gitExec(["show", "-s", "--format=%cI", hash], repoRoot);
    if (shown.status !== 0) return undefined;
    const commitAt = shown.stdout.trim();
    const windowStartedAt = attempts[0]?.startedAt;
    if (!commitAt || !windowStartedAt) return undefined;
    const commitMs = Date.parse(commitAt);
    const startMs = Date.parse(windowStartedAt);
    const nowMs = Date.now();
    if (
      !Number.isFinite(commitMs) ||
      !Number.isFinite(startMs) ||
      commitMs < startMs - COMMIT_TIME_TOLERANCE_MS ||
      commitMs > nowMs + COMMIT_TIME_TOLERANCE_MS
    ) {
      return { status: "outside_window", hash, commitAt, windowStartedAt };
    }
    return { status: "verified", hash, commitAt, windowStartedAt };
  } catch {
    return undefined;
  }
}
