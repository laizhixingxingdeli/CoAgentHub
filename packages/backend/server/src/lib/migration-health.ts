import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type SQL, sql } from "drizzle-orm";

export interface MigrationJournal {
  entries: Array<{ tag: string; when: number }>;
}

interface MigrationLedgerDatabase {
  execute(query: SQL): Promise<unknown>;
}

const MIGRATION_COMMAND = "pnpm --filter @laizhixingxingdeli/database migrate";

/**
 * The server package runs with its own directory as cwd under pnpm. The second
 * path also supports invoking the built server from the repository root.
 */
function migrationJournalPath(): string {
  const candidates = [
    resolve(process.cwd(), "../database/drizzle/migrations/meta/_journal.json"),
    resolve(
      process.cwd(),
      "packages/backend/database/drizzle/migrations/meta/_journal.json",
    ),
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) {
    throw new Error(
      "无法找到 Drizzle 迁移清单，拒绝在无法验证迁移状态时启动。",
    );
  }
  return path;
}

export function loadMigrationJournal(): MigrationJournal {
  const parsed: unknown = JSON.parse(
    readFileSync(migrationJournalPath(), "utf8"),
  );
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { entries?: unknown }).entries)
  ) {
    throw new Error("Drizzle 迁移清单格式无效，拒绝启动。");
  }

  const entries = (parsed as { entries: unknown[] }).entries.map((entry) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof (entry as { tag?: unknown }).tag !== "string" ||
      typeof (entry as { when?: unknown }).when !== "number"
    ) {
      throw new Error("Drizzle 迁移清单包含无效条目，拒绝启动。");
    }
    return entry as { tag: string; when: number };
  });

  return { entries };
}

function rowsFrom(result: unknown): Array<{ created_at: unknown }> {
  if (Array.isArray(result)) return result as Array<{ created_at: unknown }>;
  if (result && typeof result === "object") {
    const rows = (result as { rows?: unknown }).rows;
    if (Array.isArray(rows)) return rows as Array<{ created_at: unknown }>;
  }
  throw new Error("迁移账本查询未返回行数据，拒绝启动。");
}

function hasMissingMigrationLedger(error: unknown): boolean {
  let current = error;
  while (current && typeof current === "object") {
    const code = (current as { code?: unknown }).code;
    // PostgreSQL: invalid_schema_name / undefined_table.
    if (code === "3F000" || code === "42P01") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

async function appliedMigrationTimes(
  db: MigrationLedgerDatabase,
): Promise<Set<number>> {
  try {
    const result = await db.execute(
      sql`SELECT created_at FROM drizzle.__drizzle_migrations`,
    );
    return new Set(
      rowsFrom(result)
        .map((row) => Number(row.created_at))
        .filter(Number.isFinite),
    );
  } catch (error) {
    // A database with no migration ledger has applied no migrations. Do not
    // create the schema/table here: startup verification must be read-only.
    if (hasMissingMigrationLedger(error)) return new Set();
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`无法读取 Drizzle 迁移账本，拒绝启动: ${detail}`);
  }
}

/**
 * Fail before the HTTP listener opens when the database is behind the checked
 * in Drizzle journal. This deliberately does not apply migrations.
 */
export async function assertNoPendingMigrations(
  db: MigrationLedgerDatabase,
  journal = loadMigrationJournal(),
): Promise<void> {
  const applied = await appliedMigrationTimes(db);
  // Match Drizzle's PostgreSQL migrator: it compares every journal entry with
  // the latest recorded `created_at`. Some historical journal timestamps are
  // out of sequence, so requiring one ledger row per entry would report a
  // migration that Drizzle itself would not run.
  const latestApplied = Math.max(0, ...applied);
  const pending = journal.entries.filter((entry) => entry.when > latestApplied);
  if (pending.length === 0) return;

  throw new Error(
    `检测到未应用的数据库迁移: ${pending.map((entry) => entry.tag).join(", ")}。` +
      `请先运行 \`${MIGRATION_COMMAND}\`，迁移完成后再启动 server。`,
  );
}
