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
    // `pnpm test`(vitest.workspace.ts),那条路径下子项目里的它**会被忽略**。
    // 所以根 package.json 的 test 脚本显式带了 `--no-file-parallelism`。
    // **两处都要有**:本包直跑靠这里,CI 靠那里。
    //
    // 2026-09-09 实测(--reporter=json 比对各文件 startTime/endTime 是否重叠,
    // 这是唯一可靠的判据 —— stdout 顺序不算数,多进程的缓冲输出本来就会
    // 看起来交错):
    //   默认(workspace)      三个文件都在 0.01s 内开始、时间窗重叠 → 并发
    //   --no-file-parallelism  0→162.8s / 167.0→168.2s / 175.5→175.7s → 串行
    //   poolOptions.maxForks:1 仍然重叠 → **不做串行,别用它**
    //   poolOptions.singleFork 也串行,但把全部文件塞进同一进程,
    //                          状态与负载跨文件累积,不如上面那条。
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
