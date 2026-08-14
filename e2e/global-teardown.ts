/**
 * E2E global teardown — drop 隔离数据库 coagenthub_e2e(尽力而为)。
 *
 * webServer 进程在 teardown 前已被 Playwright 停掉,库上无活动连接;
 * WITH (FORCE)(PG 13+)兜底强杀残留连接。drop 失败(无权限)时保留数据 —
 * 下一个 run 的 globalSetup 会重建 schema / TRUNCATE,不会污染真实库。
 */
import { Client } from "pg";
import {
  ADMIN_DATABASE_URL,
  E2E_DATABASE_URL,
  E2E_DB_NAME,
} from "../playwright.config";

export default async function globalTeardown(): Promise<void> {
  const admin = new Client({ connectionString: ADMIN_DATABASE_URL });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${E2E_DB_NAME}" WITH (FORCE)`);
    console.log(`[e2e] dropped database ${E2E_DB_NAME}`);
  } catch (err) {
    console.warn(
      `[e2e] 无法 drop ${E2E_DB_NAME}(数据保留,下次 run 会清场): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    // 验证连接串本身可达:避免「drop 失败」其实是 admin 连接配置错误。
    const db = new Client({ connectionString: E2E_DATABASE_URL });
    try {
      await db.connect();
      console.log(`[e2e] ${E2E_DB_NAME} 可达,数据保留`);
    } catch {
      console.warn(`[e2e] ${E2E_DB_NAME} 不可达,忽略`);
    } finally {
      await db.end().catch(() => undefined);
    }
  } finally {
    await admin.end();
  }
}
