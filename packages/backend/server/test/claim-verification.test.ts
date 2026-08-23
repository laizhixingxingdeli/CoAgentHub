import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TaskAttempt } from "@laizhixingxingdeli/database/schema";
import { describe, expect, it } from "vitest";
import {
  verifyCommitClaim,
  verifyReportedCommit,
} from "../src/lib/executor-task/claim-verification";

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

function headHash(dir: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
  }).trim();
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

  it("共用入口:a2a 模式留下明确的未核实标记(skipped),不碰仓库", async () => {
    const dir = repo();
    try {
      const hash = headHash(dir);
      const attempts: TaskAttempt[] = [
        {
          n: 1,
          startedAt: new Date(Date.now() - 1000).toISOString(),
          status: "running",
        },
      ];
      // 故意传一个不可达仓库:即使仓库不存在,a2a 也走标记分支而非报错。
      await expect(
        verifyReportedCommit(hash, "/path/does/not/exist", attempts, "a2a"),
      ).resolves.toEqual({
        status: "skipped",
        hash,
        reason: "a2a_no_local_repo",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("共用入口:cli 模式透传仓库核实;hash 非法/仓库不可达 → undefined", async () => {
    const dir = repo();
    try {
      const hash = headHash(dir);
      const attempts: TaskAttempt[] = [
        {
          n: 1,
          startedAt: new Date(Date.now() - 1000).toISOString(),
          status: "running",
        },
      ];
      await expect(
        verifyReportedCommit(hash, dir, attempts, "cli"),
      ).resolves.toMatchObject({ status: "verified" });
      await expect(
        verifyReportedCommit("garbage!", dir, attempts, "cli"),
      ).resolves.toBeUndefined();
      await expect(
        verifyReportedCommit(hash, null, attempts, "cli"),
      ).resolves.toBeUndefined();
      await expect(
        verifyReportedCommit(hash, "/path/does/not/exist", attempts, "cli"),
      ).resolves.toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
