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
