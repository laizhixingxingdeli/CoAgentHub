import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { verifyCommitClaim } from "../src/lib/executor-task/claim-verification";

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), "coagenthub-claim-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: dir,
  });
  execFileSync("git", ["commit", "--allow-empty", "-qm", "commit"], {
    cwd: dir,
  });
  return dir;
}

describe("执行器提交声称核实", () => {
  it("核实存在且落在首次执行窗口内", async () => {
    const dir = repo();
    try {
      const hash = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: dir,
        encoding: "utf8",
      }).trim();
      const startedAt = new Date(Date.now() - 1000).toISOString();
      await expect(
        verifyCommitClaim(hash, dir, [{ n: 1, startedAt, status: "running" }]),
      ).resolves.toMatchObject({ status: "verified" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("标记不存在与窗口外的 hash,仓库不可达则跳过", async () => {
    const dir = repo();
    try {
      await expect(
        verifyCommitClaim("0123456789abcdef", dir, [
          {
            n: 1,
            startedAt: new Date(Date.now() - 1000).toISOString(),
            status: "running",
          },
        ]),
      ).resolves.toMatchObject({ status: "not_found" });
      const hash = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: dir,
        encoding: "utf8",
      }).trim();
      await expect(
        verifyCommitClaim(hash, dir, [
          {
            n: 1,
            startedAt: new Date(Date.now() + 60_000).toISOString(),
            status: "running",
          },
        ]),
      ).resolves.toMatchObject({ status: "outside_window" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    await expect(
      verifyCommitClaim("0123456789abcdef", "/path/does/not/exist", []),
    ).resolves.toBeUndefined();
  });
});
