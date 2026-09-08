import pg from "pg";

/**
 * Enforce a single CoAgentHub server process per DATABASE_URL via a
 * PostgreSQL session-level advisory lock (specs/enforce-single-server-with-advisory-lock).
 *
 * ## Why a dedicated Client (R2 — the technical core)
 *
 * `pg_try_advisory_lock` is bound to the **session** (backend connection) that
 * acquires it. If the lock were taken through the shared `pg.Pool` used by
 * Drizzle, any of these would silently drop the constraint:
 *   - pool idle-timeout closing that backend
 *   - pool `max` pressure destroying idle clients
 *   - a pool reset / `DISCARD ALL` on checkout
 *
 * This module therefore opens one **non-pooled** `pg.Client`, acquires the lock
 * on it, and keeps that client connected for the process lifetime. The app pool
 * never sees this connection, so pool churn cannot release the lock.
 *
 * ## Release (R3)
 *
 * Prefer explicit `release()` on graceful shutdown. If the process exits or is
 * killed (including `kill -9`), PostgreSQL drops the session when the TCP
 * connection closes and the lock is released automatically — no extra
 * mechanism required.
 *
 * ## Test environment (R5)
 *
 * When `process.env.VITEST` is set, acquisition is skipped unless `force: true`.
 *
 * Why this is a safe exception:
 * - Vitest injects `VITEST`; production entry (`src/index.ts`) never sets it.
 * - The unit suite mocks `@server/lib/database` onto in-memory PGlite and runs
 *   many files in one process; taking a real-DB advisory lock would make
 *   concurrent/serial files fight over one key and fail for reasons unrelated
 *   to the code under test.
 * - This skip cannot mask a production bug: production always goes through
 *   `acquireSingleServerLock` without `force`, and the lock's own tests call
 *   `force: true` against a real Postgres URL to assert exclusion, pool-churn
 *   survival, and release semantics.
 */

/** Fixed lock key — not configurable (R1). 'CAHB' + object 1. */
export const SINGLE_SERVER_LOCK_CLASSID = 0x43414842;
export const SINGLE_SERVER_LOCK_OBJID = 1;

const LOCK_HELD_MESSAGE =
  "Unable to start CoAgentHub server: another server instance is already running against this DATABASE_URL (PostgreSQL advisory lock held). Stop the other instance first, or point this process at a different database.";

export type SingleServerLockHandle = {
  /** Explicit unlock + close the dedicated session. Idempotent. */
  release: () => Promise<void>;
  /** True when a real session lock is held (false when VITEST skip path). */
  held: boolean;
};

export type AcquireSingleServerLockOptions = {
  connectionString: string;
  /**
   * Test-only: acquire even when `VITEST` is set. Production must never pass this.
   */
  force?: boolean;
  env?: NodeJS.ProcessEnv;
  /**
   * Optional Client factory — tests inject stubs; production uses `pg.Client`.
   * The returned client must already be connected, OR we connect if it exposes
   * the standard `connect()` used by node-postgres.
   */
  createClient?: (connectionString: string) => pg.Client;
};

/**
 * R5 gate. Exported so tests can assert the production path is NOT skipped
 * when VITEST is absent.
 */
export function shouldAcquireSingleServerLock(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // See module doc (R5): VITEST is the only skip signal; production never has it.
  return !env.VITEST;
}

function defaultCreateClient(connectionString: string): pg.Client {
  // Dedicated session — do NOT use dbPool() / pg.Pool here (R2).
  return new pg.Client({ connectionString });
}

/**
 * Acquire the single-server advisory lock on a dedicated non-pooled connection.
 * Throws a clear Error when the lock is already held (R1).
 */
export async function acquireSingleServerLock(
  options: AcquireSingleServerLockOptions,
): Promise<SingleServerLockHandle> {
  const env = options.env ?? process.env;
  if (!options.force && !shouldAcquireSingleServerLock(env)) {
    return {
      held: false,
      release: async () => {
        /* no-op: lock was not taken in this vitest process (R5) */
      },
    };
  }

  const createClient = options.createClient ?? defaultCreateClient;
  const client = createClient(options.connectionString);

  // node-postgres Client starts disconnected; allow pre-connected test doubles
  // that omit connect().
  if (typeof client.connect === "function") {
    await client.connect();
  }

  let got = false;
  try {
    const result = await client.query<{ got: boolean }>(
      "SELECT pg_try_advisory_lock($1, $2) AS got",
      [SINGLE_SERVER_LOCK_CLASSID, SINGLE_SERVER_LOCK_OBJID],
    );
    got = Boolean(result.rows[0]?.got);
  } catch (err) {
    try {
      await client.end();
    } catch {
      // Best-effort close after query failure.
    }
    throw err;
  }

  if (!got) {
    try {
      await client.end();
    } catch {
      // Best-effort close when lock is busy.
    }
    throw new Error(LOCK_HELD_MESSAGE);
  }

  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    try {
      // Explicit unlock for graceful paths (R3). If this fails, ending the
      // client still drops the session and PG releases the lock.
      await client.query("SELECT pg_advisory_unlock($1, $2)", [
        SINGLE_SERVER_LOCK_CLASSID,
        SINGLE_SERVER_LOCK_OBJID,
      ]);
    } catch {
      // Ignore unlock errors; connection teardown is the fallback.
    } finally {
      try {
        await client.end();
      } catch {
        // Already closed.
      }
    }
  };

  return { held: true, release };
}

/** Message used when the lock is busy — exported for assertion in tests. */
export const SINGLE_SERVER_LOCK_HELD_MESSAGE = LOCK_HELD_MESSAGE;
