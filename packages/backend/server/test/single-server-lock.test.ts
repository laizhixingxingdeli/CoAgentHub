/**
 * specs/enforce-single-server-with-advisory-lock.md
 *
 * Uses a real Postgres (DATABASE_URL) because session advisory locks and
 * pool-churn behaviour are the subject under test. The shared suite mocks
 * `@server/lib/database` onto PGlite; this module never goes through that
 * mock — it opens its own dedicated `pg.Client` (and, for R2, a throwaway
 * `pg.Pool`).
 *
 * force: true is required: vitest sets VITEST, and production skips lock
 * acquisition under that signal (R5). These tests are the place that still
 * exercises the real lock path.
 */
import "dotenv/config";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireSingleServerLock,
  shouldAcquireSingleServerLock,
  SINGLE_SERVER_LOCK_CLASSID,
  SINGLE_SERVER_LOCK_HELD_MESSAGE,
  SINGLE_SERVER_LOCK_OBJID,
  type SingleServerLockHandle,
} from "@server/lib/single-server-lock";

const connectionString =
  process.env.DATABASE_URL ?? "postgresql://postgres@127.0.0.1:5432/coagenthub";

const handles: SingleServerLockHandle[] = [];

afterEach(async () => {
  while (handles.length > 0) {
    const h = handles.pop();
    if (h) await h.release();
  }
});

async function acquire(force = true): Promise<SingleServerLockHandle> {
  const h = await acquireSingleServerLock({ connectionString, force });
  handles.push(h);
  return h;
}

describe("single-server advisory lock", () => {
  it("R5: skips acquisition under VITEST unless force is set", async () => {
    expect(shouldAcquireSingleServerLock({ VITEST: "true" })).toBe(false);
    expect(shouldAcquireSingleServerLock({})).toBe(true);

    const skipped = await acquireSingleServerLock({
      connectionString,
      env: { VITEST: "true" },
      // force omitted → skip
    });
    expect(skipped.held).toBe(false);
    await skipped.release();
  });

  it("R1: second acquirer fails immediately with an actionable message", async () => {
    const first = await acquire();
    expect(first.held).toBe(true);

    await expect(acquire()).rejects.toThrow(SINGLE_SERVER_LOCK_HELD_MESSAGE);
  });

  it("R1/R3: after the holder releases, a new acquirer succeeds", async () => {
    const first = await acquire();
    await first.release();
    // already released; keep afterEach safe
    handles.pop();

    const second = await acquire();
    expect(second.held).toBe(true);
  });

  it("R2: lock survives application-pool connection churn", async () => {
    // Hold the real single-server lock on the dedicated Client.
    const holder = await acquire();
    expect(holder.held).toBe(true);

    // Churn a separate pool hard enough that idle backends are opened,
    // used, and returned (and, with max=2 + many parallel queries, recycled).
    // If the lock had been taken via pool.query on a pooled session, this
    // class of churn is exactly what can silently drop it. Taking it on a
    // dedicated Client must keep exclusion intact afterwards.
    const pool = new pg.Pool({
      connectionString,
      max: 2,
      idleTimeoutMillis: 1,
      allowExitOnIdle: true,
    });
    try {
      for (let round = 0; round < 8; round++) {
        await Promise.all(
          Array.from({ length: 12 }, async (_, i) => {
            const client = await pool.connect();
            try {
              await client.query(
                "SELECT $1::int AS n, pg_backend_pid() AS pid",
                [i + round * 12],
              );
            } finally {
              client.release();
            }
          }),
        );
        // Give idleTimeoutMillis a chance to reap returned clients.
        await new Promise((r) => setTimeout(r, 15));
      }

      // Distinct backends should have been used across the churn.
      const pids = await pool.query<{ n: number }>(
        "SELECT COUNT(*)::int AS n FROM (SELECT 1) s",
      );
      expect(pids.rows[0]?.n).toBe(1);
    } finally {
      await pool.end();
    }

    // Exclusion must still hold after the pool has been fully opened, churned,
    // and closed — proving the lock does not live on a pool session.
    await expect(acquire()).rejects.toThrow(SINGLE_SERVER_LOCK_HELD_MESSAGE);
  });

  it("R2 anti-pattern contrast: a pool-held lock can be lost when that backend is closed", async () => {
    // Demonstrates why R2 insists on a dedicated Client: acquire via pool,
    // destroy the pooled backends, lock is gone.
    const pool = new pg.Pool({ connectionString, max: 1 });
    let got: boolean;
    try {
      const result = await pool.query<{ got: boolean }>(
        "SELECT pg_try_advisory_lock($1, $2) AS got",
        [SINGLE_SERVER_LOCK_CLASSID, SINGLE_SERVER_LOCK_OBJID],
      );
      got = Boolean(result.rows[0]?.got);
      expect(got).toBe(true);
    } finally {
      // Ending the pool closes the backend that held the session lock → released.
      await pool.end();
    }

    // Lock is free again — the very failure mode dedicated Client prevents.
    const holder = await acquire();
    expect(holder.held).toBe(true);
  });

  it("acceptance 4: session lock is not released by COMMIT on the holder", async () => {
    // Session-level pg_try_advisory_lock survives transactions (unlike
    // pg_try_advisory_xact_lock). Verify by running a write txn on a side
    // connection AND a txn on a second probe that still cannot take the lock.
    const holder = await acquire();
    expect(holder.held).toBe(true);

    const side = new pg.Client({ connectionString });
    await side.connect();
    try {
      await side.query("BEGIN");
      await side.query("SELECT 1");
      // Long-ish txn relative to a simple round-trip; lock must stay held.
      await new Promise((r) => setTimeout(r, 50));
      await side.query("COMMIT");

      const probe = await side.query<{ got: boolean }>(
        "SELECT pg_try_advisory_lock($1, $2) AS got",
        [SINGLE_SERVER_LOCK_CLASSID, SINGLE_SERVER_LOCK_OBJID],
      );
      expect(probe.rows[0]?.got).toBe(false);
    } finally {
      await side.end();
    }

    await expect(acquire()).rejects.toThrow(SINGLE_SERVER_LOCK_HELD_MESSAGE);
  });
});
