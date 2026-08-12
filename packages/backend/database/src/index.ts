import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

/** Create a PostgreSQL connection pool for the given connection string. */
export function dbPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString });
}

/** Wrap a pool with the Drizzle query builder bound to this schema. */
export function getDb(pool: pg.Pool) {
  return drizzle(pool, { schema });
}

export type DataBase = ReturnType<typeof getDb>;
