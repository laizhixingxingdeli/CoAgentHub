import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, vi } from "vitest";
import { dbCreated } from "./db-state";

/**
 * Test setup for @laizhixingxingdeli/server.
 *
 * - Swaps the real pg-backed `@server/lib/database` for an in-memory PGlite
 *   instance and applies the real SQL migrations to it.
 * - Points FILE_DIR at a throwaway temp directory so the file routes never
 *   touch real disk stores.
 * - Points COAGENTHUB_REPO_ROOT at a throwaway temp git repo (ticket 2): pumpQueue
 *   snapshots the workspace (createCheckpoint) before every executor spawn, so
 *   executor tests must NOT run git against the real CoAgentHub checkout — that
 *   would stage the working tree and write refs/coagenthub-cp/* into the real repo.
 *
 * PGlite + migrations live in test/db.ts module init and only run when a file
 * (or the lazy vi.mock factory below) imports `./db`. Pure-logic files skip them.
 */

// vi.mock stays at setup.ts top level, before any SUT module load. The factory
// is lazy: await import("./db") only runs when @server/lib/database is first
// required by a test file — that is what triggers PGlite + migrations.
vi.mock("@server/lib/database", async () => {
  const { testClient, testDb } = await import("./db");
  return { default: testDb, client: testClient };
});

// Throwaway dir for the LAN file store; the file route reads FILE_DIR at
// module load, so it must be set before any route module is imported.
const testFileDir = mkdtempSync(path.join(tmpdir(), "coagenthub-test-files-"));
process.env.FILE_DIR = testFileDir;

// 模拟文件上传上限为 1KB(P0 输入上限):file.ts 在模块加载时读
// MAX_FILE_UPLOAD_BYTES,同样必须在导入路由模块之前设置。
process.env.MAX_FILE_UPLOAD_BYTES = "1024";

// Throwaway git repo for executor checkpoint/rollback tests (ticket 2).
const testRepoDir = mkdtempSync(path.join(tmpdir(), "coagenthub-test-repo-"));
const gitInit = spawnSync("git", ["init", "-q"], { cwd: testRepoDir });
if (gitInit.status === 0) {
  // createCheckpoint 用 commit-tree -p HEAD,仓库必须有首个 commit 才有 HEAD。
  spawnSync(
    "git",
    [
      "-c",
      "user.name=coagenthub-test",
      "-c",
      "user.email=coagenthub-test@example.com",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    ],
    { cwd: testRepoDir },
  );
  process.env.COAGENTHUB_REPO_ROOT = testRepoDir;
} else {
  console.warn(
    "[test] git 不可用,executor 快照/回滚相关测试将失败:",
    gitInit.stderr?.toString(),
  );
}

afterAll(async () => {
  if (dbCreated) {
    // 历史背景(PGlite is closed 竞态):消息派发是 fire-and-forget。只等内存
    // 队列变空会漏掉两个窗口——(1) 消息返回后尚未入队;(2) run 离开内存队列
    // 后仍在写终态。在那些窗口关 PGlite 就会抛 `PGlite is closed`(常跟在更
    // 早的 Git index-lock 错误之后),表现为 suite 末尾的 flaky 失败。
    //
    // 为何改用 drain(T3):activeExecutorTaskCount / currentRunningTask /
    // queuedExecutorTaskCount 只描述「当前 Map 看起来为空」,不是「已接收的
    // 工作都做完了」。固定「连续 1 秒空闲 + 100ms 轮询 + 20s 直接 break 当
    // 通过」既会让无后台工作的文件白等 1 秒,又会在有残留时隐式放过。
    // trackBackgroundWork 在三个 fire-and-forget 入口同步登记,drain 等到登记
    // 清零(或超时显式失败并打印残留 label)。定时重试/冷却 timer 先取消——
    // 不能把几小时后的计划泵送当成必须自然跑完。
    const { __cancelScheduledPumpsForTests, drainBackgroundWork } =
      await import("../src/lib/executor-task");
    __cancelScheduledPumpsForTests();
    const drained = await drainBackgroundWork({ timeoutMs: 20_000 });
    if (!drained.ok) {
      const residual = drained.pending
        .map((p) => `${p.label} (since ${p.sinceMs}ms)`)
        .join("; ");
      console.error(
        `[test] drainBackgroundWork timed out; residual work: ${residual || "(none listed)"}`,
      );
      // 尽量关库、清目录,再让本文件失败 —— 不许再「到 20 秒直接关库当通过」。
      try {
        const { testClient } = await import("./db");
        await testClient.close();
      } catch (err) {
        console.warn("[test] close PGlite after drain timeout:", err);
      }
      rmSync(testFileDir, { recursive: true, force: true });
      rmSync(testRepoDir, { recursive: true, force: true });
      throw new Error(
        `drainBackgroundWork timed out with residual work: ${residual || "(none listed)"}`,
      );
    }
    const { testClient } = await import("./db");
    await testClient.close();
  }
  rmSync(testFileDir, { recursive: true, force: true });
  rmSync(testRepoDir, { recursive: true, force: true });
});
