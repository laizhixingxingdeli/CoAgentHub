import { sql } from "drizzle-orm";
import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { v7 as uuidv7 } from "uuid";
import { timeColumns } from "../utils/columns.js";

/**
 * Participant registry — the identity foundation for multi-agent collaboration
 * (agent-groups). Independent of the auth user/organization tables: any
 * device/CLI process can register itself as a participant and declare its
 * identity via `X-Participant-Id` (LAN full-trust model). The `token_hash`
 * column is kept for now (Plan B drops it) — token authentication has been
 * removed, new rows insert a placeholder empty string.
 *
 * 术语说明:本表原名为 `agent`(历史名,见 git 提交),术语澄清后改名
 * participant(参与者)——「agent」易与「AI 智能体」混淆。旧表名/旧列名仅
 * 存在于历史迁移与 git 历史中。
 */
export const participant = pgTable("participant", {
  id: uuid("id").primaryKey().$defaultFn(uuidv7),
  name: text("name").notNull(),
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
export const Participant = createSelectSchema(participant);
export type Participant = typeof participant.$inferSelect;
export const NewParticipant = createInsertSchema(participant);
export type NewParticipant = typeof participant.$inferInsert;
