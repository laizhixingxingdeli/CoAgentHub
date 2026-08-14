import { defineConfig, devices } from "@playwright/test";

/**
 * CoAgentHub E2E (真浏览器 + 真实 PostgreSQL + 真实 server + 真实 web SPA)。
 *
 * 隔离策略:
 * - E2E 使用独立端口(web 3010 / server 3011),不碰本机常驻的 :3000/:3001,
 *   且 webServer 一律自启(reuseExistingServer: false),保证连到的 server
 *   一定是指向 coagenthub_e2e 的隔离实例。
 * - globalSetup 创建 coagenthub_e2e 库并跑迁移(见 e2e/global-setup.ts);
 *   globalTeardown drop 该库。
 * - server 以 PORT=3011 + DATABASE_URL=coagenthub_e2e 启动;web 经
 *   serve.mjs 反代 /api 到 server,浏览器侧全部同源,无 CORS 参与。
 *
 * 前置条件:dist 产物已构建(pnpm build);本地首次跑 e2e 前先执行
 * `pnpm build`,CI 的 e2e job 会先 build。
 */

export const E2E_DB_NAME = "coagenthub_e2e";
export const ADMIN_DATABASE_URL =
  process.env.E2E_ADMIN_DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/postgres";
export const E2E_DATABASE_URL = `postgresql://postgres:postgres@localhost:5432/${E2E_DB_NAME}`;

export const WEB_PORT = 3010;
export const SERVER_PORT = 3011;

export default defineConfig({
  testDir: "./e2e",
  // 共享同一个真实 PostgreSQL + 单实例 server:串行执行,杜绝用例间互相干扰。
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    // 产品默认语言为中文:固定浏览器 locale,保证 i18n 渲染中文,
    // 与测试断言(中文文案)一致。
    locale: "zh-CN",
    trace: "on-first-retry",
  },
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  webServer: [
    {
      command: "node dist/server.mjs",
      cwd: "./packages/backend/server",
      url: `http://localhost:${SERVER_PORT}/api/system/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        ...process.env,
        PORT: String(SERVER_PORT),
        DATABASE_URL: E2E_DATABASE_URL,
      },
    },
    {
      command: `node serve.mjs ${WEB_PORT} http://localhost:${SERVER_PORT}`,
      cwd: ".",
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
