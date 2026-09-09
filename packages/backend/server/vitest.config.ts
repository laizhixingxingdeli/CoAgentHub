import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // The server sources use the `@server/*` tsconfig alias.
    alias: {
      "@server": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    // Never collect compiled output under dist/ — stale .js tests there
    // double-run and fail against the current schema.
    exclude: ["dist/**", "node_modules/**", "**/node_modules/**"],
    // Executor tests mutate process-wide queue state, environment-backed fake
    // executors, and temporary Git repositories. Running files in parallel lets
    // a fire-and-forget task from one file observe another file's fixtures and
    // can leave the next file's PGlite closed underneath it. Reproduction:
    // `pnpm --filter @laizhixingxingdeli/server test` intermittently reports
    // `PGlite is closed`/Git index-lock errors; `--no-file-parallelism` removes
    // the cross-file overlap. Keep the isolation explicit until those fixtures
    // no longer share process-wide state.
    fileParallelism: false,
    // ⚠️ `fileParallelism` 是 vitest 的 **root-only** 选项:直接在本包里跑
    // (`cd packages/backend/server && vitest`)时它生效,但 CI 跑的是仓库根的
    // `pnpm test`(vitest.workspace.ts),那条路径下子项目里的它**会被忽略** ——
    // 2026-09-09 的 CI 日志里 executor-queue 与 executor-queued-reclaim 的
    // stdout 交错,就是这个的证据,几条 CI-only 红与 flaky 都指向它。
    // 项目级要串行必须用 poolOptions:把本项目的全部测试文件塞进同一个 fork。
    poolOptions: {
      forks: { singleFork: true },
      threads: { singleThread: true },
    },
    // Always include the complete test name and assertion diff on failures;
    // the compact summary alone is not actionable for this suite.
    reporters: ["verbose"],
    hookTimeout: 30_000,
    // setupFiles: "./test/setup.ts",
    setupFiles: ["./test/setup.ts"],
    globals: true, // 使测试环境支持 `describe`, `it`, `expect` 等全局函数
    environment: "node", // 使用 Node 环境进行测试
  },
});
