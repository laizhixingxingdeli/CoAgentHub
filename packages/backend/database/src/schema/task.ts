import { jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { v7 as uuidv7 } from "uuid";
import { timeColumns } from "../utils/columns.js";
import { groups } from "./group.js";
import { participant } from "./participant.js";

/**
 * Task — first-class execution entity (bridge demoted to a pure executor
 * client). Single source of truth for task lifecycle: the bridge creates a
 * row before spawning its CLI and patches status/diffSummary when the run
 * finishes; the server is the single scheduler.
 *
 * Idempotency: message_id is UNIQUE — the same group message can only ever
 * create one task row, so duplicated webhook/pull delivery cannot double-run.
 */
export const TASK_STATUSES = [
  "queued",
  "running",
  "done",
  "failed",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const task = pgTable("task", {
  id: uuid("id").primaryKey().$defaultFn(uuidv7),
  groupId: uuid("group_id")
    .notNull()
    .references(() => groups.id),
  // 唯一约束 → 幂等:同一消息只建一次任务(重复 POST 返回既有行)。
  messageId: uuid("message_id").notNull().unique(),
  executorParticipantId: uuid("executor_participant_id")
    .notNull()
    .references(() => participant.id),
  // 哪个执行器(key)在跑这个任务;桥退役后一律由 server 写入,用于审计与重放。
  executorKey: text("executor_key"),
  status: text("status", { enum: TASK_STATUSES }).notNull().default("running"),
  // 执行前 git 快照 ref(refs/coagenthub-cp/<taskId>);可空 = 尚未打快照。
  checkpointRef: text("checkpoint_ref"),
  // 完成后回传的 diff 摘要(改动文件数/行数等,由执行器侧计算)。
  diffSummary: jsonb("diff_summary"),
  ...timeColumns("both"),
});

export const Task = createSelectSchema(task);
export type Task = typeof task.$inferSelect;
export const NewTask = createInsertSchema(task);
export type NewTask = typeof task.$inferInsert;
