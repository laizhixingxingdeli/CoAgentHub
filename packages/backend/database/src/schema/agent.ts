import { sql } from "drizzle-orm";
import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { v7 as uuidv7 } from "uuid";
import { timeColumns } from "../utils/columns.js";

/**
 * Agent registry — the identity foundation for multi-agent collaboration
 * (agent-groups). Independent of the auth user/organization tables: any
 * device/CLI process can register itself as an agent and authenticate with
 * its per-agent token (SHA-256 hashed at rest; the plaintext token is shown
 * exactly once at registration).
 */
export const agent = pgTable("agent", {
  id: uuid("id").primaryKey().$defaultFn(uuidv7),
  name: text("name").notNull(),
  type: text("type").notNull(), // hermes | atomcode | openclaw | human | custom
  device: text("device"),
  tokenHash: text("token_hash").notNull(),
  // 心跳在线 (ticket 17): REST 心跳写 last_seen,与 WS 在线状态合并构成
  // 在线判定(T13 的 ws-hub 消费)。可空 = 从未上报过心跳。
  lastSeen: timestamp("last_seen", { withTimezone: true }),
  // 自由能力标签 (ticket 17): 注册时声明(如 ["text-generation","code-review"]),
  // 缺省空数组;仅做轻量提示性校验,不做硬性运行时强制。
  capabilities: jsonb("capabilities")
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  ...timeColumns("create-only"),
});
export const Agent = createSelectSchema(agent);
export type Agent = typeof agent.$inferSelect;
export const NewAgent = createInsertSchema(agent);
export type NewAgent = typeof agent.$inferInsert;
