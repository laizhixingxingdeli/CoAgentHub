/**
 * E2E global setup — post-webServer safety check only.
 *
 * Playwright 1.x starts config.webServer during *plugin setup*, which runs
 * BEFORE this hook. Creating/migrating coagenthub_e2e therefore lives in
 * `e2e/ensure-db.mjs`, invoked from the webServer command so the DB exists
 * when `node dist/server.mjs` connects.
 *
 * This hook must NOT DROP SCHEMA / re-migrate: the server is already live and
 * holding connections against the schema ensure-db just built. We only verify
 * the e2e database is reachable so a misconfigured stack fails loudly.
 */
import { Client } from "pg";
import { E2E_DATABASE_URL, E2E_DB_NAME } from "../playwright.config";

export default async function globalSetup(): Promise<void> {
  const db = new Client({ connectionString: E2E_DATABASE_URL });
  try {
    await db.connect();
    const { rows } = await db.query(
      "SELECT 1 AS ok FROM information_schema.tables WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations' LIMIT 1",
    );
    if (rows.length === 0) {
      throw new Error(
        `e2e 库 ${E2E_DB_NAME} 可达但缺少 drizzle 迁移账本 — ensure-db.mjs 未在 webServer 启动前跑成功?`,
      );
    }
    console.log(`[e2e] globalSetup: ${E2E_DB_NAME} ready (migrations present)`);
  } catch (err) {
    throw new Error(
      `e2e 库 ${E2E_DB_NAME} 不可用(webServer 应已通过 e2e/ensure-db.mjs 建库+迁移): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  } finally {
    await db.end().catch(() => undefined);
  }
}
