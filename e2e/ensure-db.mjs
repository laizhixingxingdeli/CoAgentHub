/**
 * E2E DB bootstrap — create coagenthub_e2e, reset schema, run migrations.
 *
 * Playwright 1.x starts config.webServer during *plugin setup*, which runs
 * BEFORE globalSetup. The server therefore needs the e2e database already
 * present when `node dist/server.mjs` launches. Invoke this script from the
 * webServer command (globalSetup remains a second, post-start safety net that
 * no longer has to create the DB from scratch).
 *
 * Usage (from repo root): node e2e/ensure-db.mjs
 * Exit non-zero on failure so the webServer command aborts before spawn.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const E2E_DB_NAME = "coagenthub_e2e";
const ADMIN_DATABASE_URL =
  process.env.E2E_ADMIN_DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/postgres";
const E2E_DATABASE_URL = `postgresql://postgres:postgres@localhost:5432/${E2E_DB_NAME}`;

// webServer cwd is packages/backend/server; this file lives at <repo>/e2e/.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(resolve(REPO_ROOT, "pnpm-workspace.yaml"))) {
  throw new Error(`e2e ensure-db: cannot locate repo root from ${REPO_ROOT}`);
}

async function ensureDatabase() {
  const admin = new Client({ connectionString: ADMIN_DATABASE_URL });
  await admin.connect();
  try {
    const { rowCount } = await admin.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [E2E_DB_NAME],
    );
    if (rowCount === 0) {
      await admin.query(`CREATE DATABASE "${E2E_DB_NAME}"`);
      console.log(`[e2e] created database ${E2E_DB_NAME}`);
    }
  } finally {
    await admin.end();
  }
}

async function resetDatabase() {
  const db = new Client({ connectionString: E2E_DATABASE_URL });
  await db.connect();
  try {
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
    const { rows } = await db.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE '%drizzle%'",
    );
    if (rows.length > 0) {
      const tables = rows.map((r) => `"${r.tablename}"`).join(", ");
      await db.query(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
      console.log(`[e2e] truncated ${rows.length} tables in ${E2E_DB_NAME}`);
    }
  } finally {
    await db.end();
  }
}

function runMigrations() {
  console.log("[e2e] running drizzle migrations against", E2E_DB_NAME);
  execFileSync(
    "pnpm",
    ["--filter", "@laizhixingxingdeli/database", "migrate"],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: E2E_DATABASE_URL },
      stdio: "inherit",
      shell: true,
    },
  );
  console.log(`[e2e] migrations applied to ${E2E_DB_NAME}`);
}

await ensureDatabase();
await resetDatabase();
runMigrations();
