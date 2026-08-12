import { jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { v7 as uuidv7 } from "uuid";
import { timeColumns } from "../utils/columns";
import { agent } from "./agent";
import { groups } from "./group";

/**
 * Task — first-class execution entity (bridge demoted to a pure executor
 * client). Single source of truth for task lifecycle: the bridge creates a
 * row before spawning its CLI and patches status/diffSummary when the run
 * finishes, so .bridge-state.json no longer carries task state.
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
  executorAgentId: uuid("executor_agent_id")
    .notNull()
    .references(() => agent.id),
  // 哪个执行器配置(executors.json 的 key)在跑这个任务:双跑期用于区分
  // 桥跑的(executor_key 为空)与 server 直接跑的(executor_key=codebuddy 等)。
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
