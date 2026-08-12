import { defineWorkspace } from "vitest/config";

// 根目录 `pnpm run test`(= vitest run)需要显式声明子包项目,否则不会加载
// 各包的 vitest 配置(server 的 @server 别名、web 的 jsdom 环境),导致
// 收集期失败。这里只引用有测试的包;新增测试包时在此追加。
export default defineWorkspace([
  "packages/backend/server/vitest.config.ts",
  "packages/frontend/web/vitest.config.ts",
  "scripts/vitest.config.ts",
]);
