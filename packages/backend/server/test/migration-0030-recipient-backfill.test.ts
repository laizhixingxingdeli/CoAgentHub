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
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";

/**
 * 0030 完成事件收件人(specs/l3-request-delivery-and-scope.md R1/R2):
 *
 * - 新列 `task_completion_event.recipient_participant_id` 必须**回填**为
 *   `dispatcher_participant_id` —— 既有事件的投递关系逐字不变(验收 4);
 * - 迁移必须走**真实 drizzle migrator**(老库已记录 0029 时由它发现并执行
 *   0030),不得手工执行 SQL 代替;
 * - trigger 只搬运应用层裁定的 `task.recipient_participant_ids`:多个收件人
 *   各得一条事件,未裁定时回落下发者。
 */

// 真实迁移目录:0000..0030(含本次新增的 0030)。
const realMigrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../database/drizzle/migrations",
);

const MIGRATION_0029_WHEN = 1787991800000;
const MIGRATION_0030_WHEN = 1787992000000;

/** 回填取样规模:验收要求至少 5 条历史事件。 */
const HISTORICAL_EVENT_COUNT = 6;

/** 造一份「旧安装」迁移目录:只含 0000..0029 的 .sql(去掉 0030)。 */
function makeOldInstallMigrationsDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "coagenthub-mig-0030-old-"));
  for (const f of readdirSync(realMigrationsDir)) {
    // ⚠️ 排除 0030 **及其之后的一切**,而不是只排除 0030 —— 按字符串前缀
    // 排除的写法在新增 0031 时漏掉了它,「老库」里因此提前建好了
    // dispatch_intent,迁移器再跑一次就撞重复约束。按序号比较才稳。
    const seq = Number.parseInt(f.slice(0, 4), 10);
    if (!f.endsWith(".sql") || Number.isNaN(seq) || seq >= 30) continue;
    copyFileSync(path.join(realMigrationsDir, f), path.join(dir, f));
  }
  return dir;
}

/**
 * 逐文件按序执行某个迁移目录里的全部 .sql(PGlite 原生 exec 路径,与
 * test/setup.ts 同款 —— PGlite 无法经 drizzle prepared 路径执行多语句 SQL)。
 */
async function applySqlFiles(client: PGlite, dir: string): Promise<void> {
  const sqlFiles = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of sqlFiles) {
    await client.exec(readFileSync(path.join(dir, file), "utf-8"));
  }
}

/**
 * 造历史事件:3 个 participant、1 个群、6 条 queued 任务(下发者轮换),
 * 再统一 UPDATE 到 done —— 由**旧** trigger 创建 6 条不含收件人列的事件。
 */
async function seedHistoricalEvents(client: PGlite): Promise<void> {
  const participantIds = [1, 2, 3].map(() => crypto.randomUUID());
  const groupId = crypto.randomUUID();
  await client.exec(
    `INSERT INTO participant (id, name, token_hash) VALUES ${participantIds
      .map((id, i) => `('${id}', 'hist-0030-p${i}', '')`)
      .join(", ")};
     INSERT INTO groups (id, title, status, created_by)
     VALUES ('${groupId}', 'hist-0030-g', 'active', '${participantIds[0]}');`,
  );
  const values = Array.from({ length: HISTORICAL_EVENT_COUNT }, (_, i) => {
    const dispatcher = participantIds[i % participantIds.length];
    return `('${crypto.randomUUID()}', '${groupId}', '${crypto.randomUUID()}', '${participantIds[0]}', 'queued', '${dispatcher}')`;
  });
  await client.exec(
    `INSERT INTO task (id, group_id, message_id, executor_participant_id, status, dispatcher_participant_id)
     VALUES ${values.join(", ")};
     UPDATE task SET status = 'done' WHERE group_id = '${groupId}';`,
  );
}

describe("0030 完成事件收件人(回填 + trigger 搬运)", () => {
  it("老库(已记录 0029)由迁移器发现并执行 0030,历史事件收件人回填为下发者", async () => {
    const oldDir = makeOldInstallMigrationsDir();
    const client = new PGlite();
    try {
      await applySqlFiles(client, oldDir);
      // 模拟「已记录 0029」:drizzle migrator 只认 `order by created_at desc
      // limit 1`,于是 0030(when 更大)被判定为待应用。
      await client.exec(
        `CREATE SCHEMA IF NOT EXISTS "drizzle";
         CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
           id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint
         );
         INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at")
         VALUES ('old-0029-hash', ${MIGRATION_0029_WHEN});`,
      );
      await seedHistoricalEvents(client);
      const before = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM task_completion_event`,
      );
      expect(before.rows[0]?.n).toBe(HISTORICAL_EVENT_COUNT);

      // 升级:真实 drizzle migrator 跑完整目录(含 0030)。
      const db = drizzle(client);
      await migrate(db, { migrationsFolder: realMigrationsDir });

      // 0030 由迁移器执行(而非手工 SQL)。
      // ⚠️ 这里只断言「0030 被应用了」,不断言它是 journal 里最新的一条 ——
      // 「最新」是个会随每次新增迁移而失效的假设(0031 落地当天就把它打红了)。
      // 本用例要验的是「老库能被迁移器发现并推进到 0030」,与之后有多少迁移无关。
      const applied = await client.query<{ created_at: number }>(
        `SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at`,
      );
      const times = applied.rows.map((r) => Number(r.created_at));
      expect(times).toContain(MIGRATION_0030_WHEN);
      // 0029 之前的都不该被重跑(迁移器按 created_at 判定)。
      expect(Math.min(...times)).toBe(MIGRATION_0029_WHEN);

      // 验收 4:取样全部历史事件,收件人 == 下发者(投递关系逐字不变)。
      const sampled = await client.query<{
        recipient_participant_id: string | null;
        dispatcher_participant_id: string | null;
      }>(
        `SELECT recipient_participant_id, dispatcher_participant_id
         FROM task_completion_event ORDER BY created_at, task_id`,
      );
      expect(sampled.rows.length).toBe(HISTORICAL_EVENT_COUNT);
      for (const row of sampled.rows) {
        expect(row.recipient_participant_id).toBe(
          row.dispatcher_participant_id,
        );
      }
    } finally {
      await client.close();
      rmSync(oldDir, { recursive: true, force: true });
    }
  });

  it("新库跑完 0000..0030 后,trigger 按裁定收件人搬运:多收件人各一条,未裁定回落下发者", async () => {
    const client = new PGlite();
    try {
      await applySqlFiles(client, realMigrationsDir);
      const dispatcherId = crypto.randomUUID();
      const reviewerA = crypto.randomUUID();
      const reviewerB = crypto.randomUUID();
      const groupId = crypto.randomUUID();
      await client.exec(
        `INSERT INTO participant (id, name, token_hash)
         VALUES ('${dispatcherId}', 'new-0030-dispatcher', ''),
                ('${reviewerA}', 'new-0030-reviewer-a', ''),
                ('${reviewerB}', 'new-0030-reviewer-b', '');
         INSERT INTO groups (id, title, status, created_by)
         VALUES ('${groupId}', 'new-0030-g', 'active', '${dispatcherId}');`,
      );
      // 1) 未裁定(recipient_participant_ids 为 null)→ 回落下发者。
      const plainTask = crypto.randomUUID();
      await client.exec(
        `INSERT INTO task (id, group_id, message_id, executor_participant_id, status, dispatcher_participant_id)
         VALUES ('${plainTask}', '${groupId}', '${crypto.randomUUID()}', '${dispatcherId}', 'queued', '${dispatcherId}');
         UPDATE task SET status = 'done' WHERE id = '${plainTask}';`,
      );
      const plain = await client.query<{
        recipient_participant_id: string | null;
        dispatcher_participant_id: string | null;
      }>(
        `SELECT recipient_participant_id, dispatcher_participant_id
         FROM task_completion_event WHERE task_id = '${plainTask}'`,
      );
      expect(plain.rows.length).toBe(1);
      expect(plain.rows[0]?.recipient_participant_id).toBe(dispatcherId);
      expect(plain.rows[0]?.dispatcher_participant_id).toBe(dispatcherId);

      // 2) 已裁定两个收件人 → 每人一条事件,dispatcher 仍是下发者。
      const reviewTask = crypto.randomUUID();
      await client.exec(
        `INSERT INTO task (id, group_id, message_id, executor_participant_id, status, dispatcher_participant_id)
         VALUES ('${reviewTask}', '${groupId}', '${crypto.randomUUID()}', '${dispatcherId}', 'queued', '${dispatcherId}');
         UPDATE task
         SET status = 'done', recipient_participant_ids = ARRAY['${reviewerA}','${reviewerB}']::text[]
         WHERE id = '${reviewTask}';`,
      );
      const rows = await client.query<{
        recipient_participant_id: string | null;
        dispatcher_participant_id: string | null;
      }>(
        `SELECT recipient_participant_id, dispatcher_participant_id
         FROM task_completion_event WHERE task_id = '${reviewTask}'
         ORDER BY recipient_participant_id`,
      );
      expect(
        rows.rows
          .map((r) => r.recipient_participant_id)
          .sort((a, b) => String(a).localeCompare(String(b))),
      ).toEqual([reviewerA, reviewerB].sort((a, b) => a.localeCompare(b)));
      expect(
        rows.rows.every((r) => r.dispatcher_participant_id === dispatcherId),
      ).toBe(true);
    } finally {
      await client.close();
    }
  });
});
