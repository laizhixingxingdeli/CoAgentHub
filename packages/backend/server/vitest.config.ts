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
    // setupFiles: "./test/setup.ts",
    setupFiles: ["./test/setup.ts"],
    globals: true, // 使测试环境支持 `describe`, `it`, `expect` 等全局函数
    environment: "node", // 使用 Node 环境进行测试
  },
});
