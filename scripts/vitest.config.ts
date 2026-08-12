import { defineConfig } from "vitest/config";

// scripts/ 下的零依赖 Node 脚本(助手/桥)测试:mock 全局 fetch 覆盖
// 会话记忆等纯逻辑,不依赖外部 server 或 DeepSeek 服务。
// 注:workspace 项目 root 为配置所在目录(scripts/),include 相对该目录。
export default defineConfig({
  test: {
    include: ["**/*.test.mjs"],
    environment: "node",
  },
});
