import { dbPool, getDb } from "@laizhixingxingdeli/database";

const connectionUrl = process.env.DATABASE_URL;
if (!connectionUrl) {
  throw new Error("DATABASE_URL is not set");
}

const db = getDb(dbPool(connectionUrl));

export default db;
export type DataBase = typeof db;
