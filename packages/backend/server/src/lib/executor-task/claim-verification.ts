import type { TaskAttempt } from "@laizhixingxingdeli/database/schema";
import { gitExec } from "@server/lib/executor-runner";

export interface ClaimVerification {
  status: "verified" | "not_found" | "outside_window";
  hash: string;
  commitAt?: string;
  windowStartedAt?: string;
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
    if (exists.status !== 0) {
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
      commitMs < startMs ||
      commitMs > nowMs
    ) {
      return { status: "outside_window", hash, commitAt, windowStartedAt };
    }
    return { status: "verified", hash, commitAt, windowStartedAt };
  } catch {
    return undefined;
  }
}
