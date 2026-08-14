/**
 * E2E global setup — 隔离数据库生命周期(创建 + 迁移)。
 *
 * 流程(在 webServer 启动前执行):
 * 1. 连 admin(postgres 库)检查 coagenthub_e2e 是否存在,不存在则创建;
 * 2. 对 e2e 库做一次「清场」:能 DROP SCHEMA public CASCADE 就重建
 *    (连迁移 journal 一起清,迁移重跑最干净);无权限则退回逐表 TRUNCATE
 *    (保留 drizzle journal 表,迁移跳过、schema 已存在,测试数据清零);
 * 3. 对 e2e 库跑迁移(`pnpm --filter @laizhixingxingdeli/database migrate`,
 *    与生产/本机同一套 drizzle migrations)。
 *
 * 失败语义:建库被拒(无 createdb 权限且库不存在)→ 直接抛错,测试不跑;
 * 清场被拒 → 降级 TRUNCATE,保证每个用例从空表开始。
 */
import { execFileSync } from "node:child_process";
import { Client } from "pg";
import {
  ADMIN_DATABASE_URL,
  E2E_DATABASE_URL,
  E2E_DB_NAME,
} from "../playwright.config";

async function ensureDatabase(): Promise<void> {
  const admin = new Client({ connectionString: ADMIN_DATABASE_URL });
  await admin.connect();
  try {
    const { rowCount } = await admin.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [E2E_DB_NAME],
    );
    if (rowCount === 0) {
      try {
        await admin.query(`CREATE DATABASE "${E2E_DB_NAME}"`);
        console.log(`[e2e] created database ${E2E_DB_NAME}`);
      } catch (err) {
        throw new Error(
          `无法创建 e2e 数据库 ${E2E_DB_NAME}(缺 createdb 权限?): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  } finally {
    await admin.end();
  }
}

async function resetDatabase(): Promise<void> {
  const db = new Client({ connectionString: E2E_DATABASE_URL });
  await db.connect();
  try {
    // 首选:重建 public schema。注意 drizzle 的迁移 journal 独立放在
    // `drizzle` schema(drizzle.__drizzle_migrations)—— 必须一并删除,
    // 否则 journal 仍在会让迁移被判定「已应用」而跳过,public 表却已清空。
    try {
      await db.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
      await db.query("DROP SCHEMA public CASCADE");
      await db.query("CREATE SCHEMA public");
      console.log(`[e2e] reset schemas of ${E2E_DB_NAME} (drop+create)`);
      return;
    } catch (err) {
      console.warn(
        `[e2e] drop schema 失败,降级为逐表 TRUNCATE: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    // 降级:逐表 TRUNCATE。保留 drizzle journal 表(名字含 drizzle),
    // 否则迁移重跑会因表已存在而失败。
    const { rows } = await db.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE '%drizzle%'",
    );
    if (rows.length > 0) {
      const tables = rows
        .map((r: { tablename: string }) => `"${r.tablename}"`)
        .join(", ");
      await db.query(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
      console.log(`[e2e] truncated ${rows.length} tables in ${E2E_DB_NAME}`);
    }
  } finally {
    await db.end();
  }
}

function runMigrations(): void {
  console.log("[e2e] running drizzle migrations against", E2E_DB_NAME);
  execFileSync(
    "pnpm",
    ["--filter", "@laizhixingxingdeli/database", "migrate"],
    {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: E2E_DATABASE_URL },
      stdio: "inherit",
    },
  );
  console.log(`[e2e] migrations applied to ${E2E_DB_NAME}`);
}

export default async function globalSetup(): Promise<void> {
  await ensureDatabase();
  await resetDatabase();
  runMigrations();
}
