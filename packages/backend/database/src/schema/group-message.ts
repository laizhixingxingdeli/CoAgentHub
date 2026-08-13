import {
  type AnyPgColumn,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
// drizzle-zod 0.8.2 的 refine 类型基于 zod/v4;运行时仍是 v3 的 schema 对象,
// 仅作类型适配转换。
import type { z as zodV4 } from "zod/v4";
import { timeColumns } from "../utils/columns.js";
import { groups } from "./group.js";
import { participant } from "./participant.js";

/**
 * Group messages — the routed bus inside a group (agent-groups spec:
 * "Groups & messages"). Each message carries a sender, an optional parentId
 * (thread tree), and a target audience so a participant only receives the
 * messages relevant to it:
 *
 *   broadcast   — every group member
 *   role        — members holding audienceRef's role in this group
 *   participant — only the member identified by audienceRef
 *
 * `human` members bypass the audience rule and see everything (the user
 * watches the whole collaboration process). createdAt is the server receive
 * time, the ordering source for incremental pulls (multi-device clock skew
 * must not scramble the thread).
 */
export const groupMessage = pgTable("group_message", {
  id: uuid("id").primaryKey().$defaultFn(uuidv7),
  groupId: uuid("group_id")
    .notNull()
    .references(() => groups.id),
  senderId: uuid("sender_id")
    .notNull()
    .references(() => participant.id),
  parentId: uuid("parent_id").references((): AnyPgColumn => groupMessage.id),
  audience: text("audience", {
    enum: ["broadcast", "role", "participant"],
  })
    .notNull()
    .default("broadcast"),
  // role 值时=角色名;participant 值时=participantId;broadcast 时为空。
  // (audience 旧值 "agent" 已由迁移归一为 "participant",服务端也接受旧值。)
  audienceRef: text("audience_ref"),
  body: text("body").notNull(),
  // 内容类型 (ticket 17): 默认 text/plain,可传 application/json 等 — 仅存储
  // 不校验(值不白名单、不解析),GET/WS/webhook 行形状原样带上。
  contentType: text("content_type").notNull().default("text/plain"),
  // P2P 文件信令 (ticket 05): fileRef 只携带文件元数据与发送方设备上的
  // 局域网拉取地址,CoAgentHub 服务器绝不读写/代理文件字节本身。
  fileRef: jsonb("file_ref"),
  ...timeColumns("both"),
});

/**
 * Group message closure — adjacency list materializing the thread tree,
 * mirroring the legacy message_closure table but scoped to group messages.
 * A self row (ancestor = descendant, depth 0) is written for every message;
 * a child message additionally gets one row per ancestor chain (parent at
 * depth 1, grandparent at depth 2, ...).
 */
export const groupMessageClosure = pgTable(
  "group_message_closure",
  {
    groupId: uuid("group_id")
      .references(() => groups.id)
      .notNull(),
    ancestorId: uuid("ancestor_id")
      .references(() => groupMessage.id, { onDelete: "cascade" })
      .notNull(),
    descendantId: uuid("descendant_id")
      .references(() => groupMessage.id, { onDelete: "cascade" })
      .notNull(),
    depth: integer("depth").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.ancestorId, t.descendantId] }),
    index().on(t.groupId),
    index().on(t.ancestorId),
    index().on(t.descendantId),
  ],
);

export const GroupMessageAudience = z.enum([
  "broadcast",
  "role",
  "participant",
]);
export type GroupMessageAudience = z.infer<typeof GroupMessageAudience>;

/**
 * 服务端接受的历史 audience 值:术语改名前的 `"agent"`(外部执行器 CLI 可能
 * 仍发旧值)。接受后归一为 "participant" 存储,库中永远只存新值。
 */
export const GroupMessageAudienceInput = z
  .union([
    z.literal("agent"),
    z.literal("broadcast"),
    z.literal("role"),
    z.literal("participant"),
  ])
  .transform((v) => (v === "agent" ? "participant" : v));

/**
 * P2P 文件信令 (ticket 05): 文件元数据 + 发送方设备上的局域网拉取地址。
 * fetchUrl 指向发送方自己的 LAN HTTP 端点,接收方直连拉取;CoAgentHub 只做信令,
 * 不校验也不代理文件内容(SHA256 由发送方声明)。
 *
 * 存储形状 (ticket 17): expiresAt 必填 — 客户端未传时由服务端默认
 * now + 7d 补全,落库/返回的 fileRef 永远带有效期。历史 fileRef 元信息随
 * 消息永久可见,过期只影响取文件,不影响消息展示。
 */
export const FileRef = z.object({
  name: z.string().min(1),
  size: z.number().int().nonnegative(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/i, "sha256 must be a 64-char hex digest"),
  fetchUrl: z.string().url(),
  expiresAt: z.string().datetime(),
});
export type FileRef = z.infer<typeof FileRef>;

/**
 * 客户端输入形状 (ticket 17): 与存储形状的唯一区别是 expiresAt 可选 —
 * 服务端在写入前补默认值(now + 7d),不再视为可缺省存储。
 */
export const FileRefInput = FileRef.extend({
  expiresAt: z.string().datetime().optional(),
});
export type FileRefInput = z.infer<typeof FileRefInput>;

export const GroupMessage = createSelectSchema(groupMessage);
export type GroupMessage = typeof groupMessage.$inferSelect;
export const NewGroupMessage = createInsertSchema(groupMessage, {
  audience: (s) => s.default("broadcast"),
  // drizzle-zod 0.8.2 的 refine 类型基于 zod/v4,而 FileRef 是 zod v3 schema
  // 对象(server 路由的 zValidator 也用 v3)。运行时原样使用 v3 对象,仅类型
  // 上适配为 v4 的 ZodType。
  fileRef: FileRef.optional() as unknown as zodV4.ZodType<FileRef | undefined>,
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type NewGroupMessage = (typeof NewGroupMessage)["_output"];

export const GroupMessageClosure = createSelectSchema(groupMessageClosure);
export type GroupMessageClosure = typeof groupMessageClosure.$inferSelect;
export const NewGroupMessageClosure = createInsertSchema(groupMessageClosure);
export type NewGroupMessageClosure = typeof groupMessageClosure.$inferInsert;
