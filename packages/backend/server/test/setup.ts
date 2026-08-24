import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, vi } from "vitest";
import { testClient } from "./db";

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
 */

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

beforeAll(async () => {
  const migrationsDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../database/drizzle/migrations",
  );
  // PGlite cannot run multi-statement SQL through drizzle's prepared query
  // path ("cannot insert multiple commands into a prepared statement"), so
  // execute the migration scripts with PGlite's own exec() instead — all
  // .sql files in order (0000, 0001, ...), mirroring the drizzle migrator.
  const sqlFiles = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of sqlFiles) {
    const sql = readFileSync(path.join(migrationsDir, file), "utf-8");
    await testClient.exec(sql);
  }
});

afterAll(async () => {
  // Message dispatch is intentionally fire-and-forget. Waiting only for the
  // in-memory queue misses the interval after a run leaves the queue but before
  // runOne finishes its final DB write; closing PGlite in that interval caused
  // the flaky suite failure (`PGlite is closed`, often after an earlier Git
  // index-lock error). Drain the queue and the complete runOne lifecycle before
  // closing the per-file database.
  const {
    activeExecutorTaskCount,
    currentRunningTask,
    queuedExecutorTaskCount,
  } = await import("../src/lib/executor-task");
  const deadline = Date.now() + 20_000;
  let idleSince: number | null = null;
  for (;;) {
    const inMemoryBusy =
      activeExecutorTaskCount() > 0 ||
      currentRunningTask() !== null ||
      queuedExecutorTaskCount() > 0;
    if (!inMemoryBusy) {
      // The route deliberately does not await maybeDispatchExecutorTask. Keep
      // the worker alive briefly after the first idle observation so its
      // microtask can enqueue a run before PGlite is closed.
      idleSince ??= Date.now();
      if (Date.now() - idleSince >= 1_000) break;
    } else {
      idleSince = null;
    }
    if (Date.now() >= deadline) {
      // Do not turn a stuck executor into an unbounded test hang. The bounded
      // wait still gives normal fire-and-forget work time to finish; the test
      // runner's worker isolation prevents a later file from reusing this DB.
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await testClient.close();
  rmSync(testFileDir, { recursive: true, force: true });
  rmSync(testRepoDir, { recursive: true, force: true });
});
