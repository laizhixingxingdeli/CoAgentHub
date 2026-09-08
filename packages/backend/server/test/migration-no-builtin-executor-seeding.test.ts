import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";

/**
 * specs/no-builtin-executor-seeding.md:
 *  - R1 全新安装:executor_config 0 行
 *  - R2 既有安装:已有行逐字不动
 *  - R5 Local User 可预建,但不由本迁移播种执行器
 */

const realMigrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../database/drizzle/migrations",
);

const MIGRATION_0030_WHEN = 1787992000000;

/** 逐文件按序 exec 全部 .sql(PGlite 多语句路径,与 0029 测试同款)。 */
async function applySqlFiles(client: PGlite, dir: string): Promise<void> {
  const sqlFiles = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of sqlFiles) {
    await client.exec(readFileSync(path.join(dir, file), "utf-8"));
  }
}

describe("no-builtin-executor-seeding (0028 no-op)", () => {
  it("全新库跑完全部迁移后 executor_config 为 0 行(R1)", async () => {
    const client = new PGlite();
    try {
      await applySqlFiles(client, realMigrationsDir);
      const db = drizzle(client);
      const rows = await db.execute(
        sql`SELECT count(*) AS n FROM executor_config`,
      );
      expect(Number(rows.rows[0]?.n)).toBe(0);
    } finally {
      await client.close();
    }
  });

  it("既有库升级:用户改写过的 executor_config 行逐字保留(R2)", async () => {
    // 构造「旧安装」:schema 到 0030 已齐,但模拟用户手改过的 3 行配置
    // (bin 指向真实路径)——与生产机现状同形。升级路径不得改它们。
    const dir = mkdtempSync(path.join(tmpdir(), "coagenthub-mig-noseed-"));
    try {
      for (const f of readdirSync(realMigrationsDir)) {
        if (!f.endsWith(".sql")) continue;
        copyFileSync(path.join(realMigrationsDir, f), path.join(dir, f));
      }
      const client = new PGlite();
      try {
        await applySqlFiles(client, dir);
        // 用户数据:3 行出身播种但 bin 已改写 + 1 行用户自建
        await client.exec(`
          INSERT INTO executor_config
            (id, key, agent_name, type, kind, bin, url, args, label, model, memory, max_concurrency)
          VALUES
            (uuid_generate_v7(), 'executor', 'atomcode', 'participant', 'cli',
             'C:\\\\Users\\\\echo\\\\AppData\\\\Roaming\\\\npm\\\\atomcode.cmd', NULL,
             '["-y","-v","-p","{ticket}"]'::jsonb, 'atomcode', NULL, NULL, 1),
            (uuid_generate_v7(), 'codebuddy', 'codebuddy', 'participant', 'cli',
             'C:\\\\Users\\\\echo\\\\AppData\\\\Roaming\\\\npm\\\\codebuddy.cmd', NULL,
             '["-y","-p","{ticket}","--output-format","stream-json"]'::jsonb,
             'codebuddy', NULL, NULL, NULL),
            (uuid_generate_v7(), 'codex', 'codex', 'participant', 'cli',
             'C:\\\\Users\\\\echo\\\\AppData\\\\Roaming\\\\npm\\\\codex.cmd', NULL,
             '["exec","--approve-for-me","--ephemeral","--json","-c","sandbox_workspace_write.network_access=true","{ticket}"]'::jsonb,
             'codex', NULL, NULL, 1),
            (uuid_generate_v7(), 'pi', 'pi', 'custom', 'cli',
             'C:\\\\Users\\\\echo\\\\AppData\\\\Roaming\\\\npm\\\\pi.cmd', NULL,
             '["-p","--no-session","@{ticket}"]'::jsonb, 'pi', NULL, NULL, 1);
        `);

        const before = await client.query(
          `SELECT key, agent_name, type, kind, bin, url, args::text AS args, label, model, memory, max_concurrency
           FROM executor_config ORDER BY key`,
        );

        // 记录「已应用到 0030」后,再跑一次真实 migrator(无更新迁移可应用)。
        await client.exec(`
          CREATE SCHEMA IF NOT EXISTS "drizzle";
          CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
            id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint
          );
          INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
          VALUES ('already-at-0030', ${MIGRATION_0030_WHEN});
        `);

        const db = drizzle(client);
        await migrate(db, { migrationsFolder: realMigrationsDir });

        const after = await db.execute(
          sql`SELECT key, agent_name, type, kind, bin, url, args::text AS args, label, model, memory, max_concurrency
              FROM executor_config ORDER BY key`,
        );

        expect(after.rows).toEqual(before.rows);
        expect(after.rows).toHaveLength(4);
        // 用户改写的 bin 必须原样(证明不是「按播种值匹配才删」误伤)。
        const executor = after.rows.find((r) => r.key === "executor");
        expect(String(executor?.bin)).toContain("atomcode.cmd");
        expect(String(executor?.bin)).not.toBe("atomcode");
      } finally {
        await client.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
