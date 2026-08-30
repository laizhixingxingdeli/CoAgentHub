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

// 真实迁移目录:0000..0029(含本次新增的 0029)。
const realMigrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../database/drizzle/migrations",
);

// 0029 在 journal 里的 when 值(drizzle migrator 按它判定新旧)。
const MIGRATION_0029_WHEN = 1787991800000;
// 0028 的 when 值——老装机记录的最后一条迁移。
const MIGRATION_0028_WHEN = 1787991700000;

/**
 * 造一份「旧安装」迁移目录:只含 0000..0028 的 .sql 文件(0029 及其之后的
 * 迁移全部排除),与真实旧装机在 0029 存在前跑过的迁移状态一致。
 *
 * 必须排除**之后的所有**迁移而不只是 0029:老库只应用过 0028,若把 0030 的
 * SQL 也预先灌进去,迁移器随后重放 0030 会因约束已存在而失败。
 */
function makeOldInstallMigrationsDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "coagenthub-mig-old-"));
  for (const f of readdirSync(realMigrationsDir)) {
    if (!f.endsWith(".sql") || f >= "0029") continue;
    copyFileSync(path.join(realMigrationsDir, f), path.join(dir, f));
  }
  return dir;
}

/**
 * 逐文件按序执行某个迁移目录里的全部 .sql(PGlite 原生 exec 路径,
 * 与 test/setup.ts 同款做法——PGlite 无法经 drizzle prepared 路径执行
 * 多语句 SQL,而历史迁移文件含多语句)。
 */
async function applySqlFiles(client: PGlite, dir: string): Promise<void> {
  const sqlFiles = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of sqlFiles) {
    await client.exec(readFileSync(path.join(dir, file), "utf-8"));
  }
}

describe("0029 reviewer executor_key 清理(迁移投放方式修复)", () => {
  it("老库(已记录 0028)由迁移器发现并执行 0029,reviewer 绑定被清为 NULL", async () => {
    const oldDir = makeOldInstallMigrationsDir();
    const client = new PGlite();
    try {
      // 旧安装形态:0000..0028 的 schema 与数据落库(见 applySqlFiles 注释)。
      // 注意:这仅是「构造旧库状态」,本票要验证的 0029 发现与执行仍走下方
      // 真实迁移器,不用手工执行 0029 的 SQL 代替。
      await applySqlFiles(client, oldDir);
      // 模拟「已记录 0028」:按 drizzle migrator 的判定表写入最后一条
      // 已应用迁移(created_at = 0028 的 when)。迁移器只认
      // `order by created_at desc limit 1`,于是 0029(when 更大)被判定为待应用。
      await client.exec(
        `CREATE SCHEMA IF NOT EXISTS "drizzle";
         CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
           id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint
         );
         INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
         VALUES ('old-0028-hash', ${MIGRATION_0028_WHEN});`,
      );
      // 老安装遗留:一条 executor_key='reviewer' 的 participant 绑定。
      await client.exec(
        `INSERT INTO participant (id, name, executor_key, token_hash)
         VALUES (uuid_generate_v7(), 'reviewer', 'reviewer', '')`,
      );

      // 升级:真实 drizzle migrator 跑完整目录(含 0029)。这一步是判定路径
      // 本身——迁移器读 journal,发现 0029 的 when 严格晚于最后一条已应用
      // 迁移(0028),于是执行它并写入 __drizzle_migrations。
      const db = drizzle(client);
      await migrate(db, { migrationsFolder: realMigrationsDir });

      // 0029 已执行:reviewer 绑定被清为 NULL。
      const rows = await db.execute(
        sql`SELECT executor_key FROM participant WHERE name = 'reviewer'`,
      );
      expect(rows.rows[0]?.executor_key).toBeNull();
      // __drizzle_migrations 已记录 0029(证明是迁移器执行,而非手工 SQL)。
      const applied = await db.execute(
        sql`SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at`,
      );
      const times = applied.rows.map((r) => Number(r.created_at));
      expect(times).toContain(MIGRATION_0029_WHEN);
    } finally {
      await client.close();
      rmSync(oldDir, { recursive: true, force: true });
    }
  });

  it("全新库全部迁移(含 0029)可无错执行,reviewer 清理为 no-op", async () => {
    const client = new PGlite();
    try {
      // 全新库没有 reviewer 绑定,0029 的 UPDATE 是合法 no-op。
      // 逐文件 exec 跑完 0000..0029,验证新库场景不因新增迁移而失败。
      await applySqlFiles(client, realMigrationsDir);
      const db = drizzle(client);
      const rows = await db.execute(
        sql`SELECT count(*) AS n FROM participant WHERE executor_key = 'reviewer'`,
      );
      expect(Number(rows.rows[0]?.n)).toBe(0);
    } finally {
      await client.close();
    }
  });
});
