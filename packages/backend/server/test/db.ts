import { PGlite } from "@electric-sql/pglite";
import * as schema from "@laizhixingxingdeli/database/schema";
import { drizzle } from "drizzle-orm/pglite";

/**
 * In-memory Postgres (PGlite) used as the test database. The real
 * `@server/lib/database` module is replaced by a mock that re-exports these
 * instances (see test/setup.ts), so routes run against a real SQL engine with
 * the real schema — but no external DATABASE_URL is ever contacted.
 */
export const testClient = new PGlite();
export const testDb = drizzle(testClient, { schema });
