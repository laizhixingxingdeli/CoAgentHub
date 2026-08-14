import { sql } from "drizzle-orm";
import { integer, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
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

/** 单次执行尝试(attempt 时间线,任务执行历史)。 */
export interface TaskAttempt {
  /** 尝试序号(1 起)。 */
  n: number;
  /** 本次 spawn 开始时间(ISO)。 */
  startedAt: string;
  /** 任务结束时间(ISO);running 中缺省。 */
  endedAt?: string;
  /** running/done/failed/cancelled。 */
  status: TaskStatus;
  /** 失败原因(仅 failed)。 */
  error?: string;
  /** 成功回传摘要(仅 done)。 */
  summary?: string;
  /** 提交 hash(仅 done)。 */
  hash?: string;
}

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
  // 任务书快照:任务触发时消息 body 的完整复制(可空 = 无原文可快照,如桥直发)。
  // 消息后续被编辑/软删除不影响已触发任务语义 —— 任务面板显示这份原文。
  brief: text("brief"),
  status: text("status", { enum: TASK_STATUSES }).notNull().default("running"),
  // 执行前 git 快照 ref(refs/coagenthub-cp/<taskId>);可空 = 尚未打快照。
  checkpointRef: text("checkpoint_ref"),
  // 失败自动重试计数:任务因 exit≠0/超时/静默失败后按 dispatch-policy 重试的次数。
  retryCount: integer("retry_count").notNull().default(0),
  // 执行历史(attempt 时间线):每次 spawn 执行器前 append 一条
  // {n, startedAt, status:"running"},任务结束(done/failed/cancelled)时补
  // endedAt/status/error/summary/hash。重试 = 多条;不重试也有一条。
  attempts: jsonb("attempts")
    .$type<TaskAttempt[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  // 完成后回传的 diff 摘要(改动文件数/行数等,由执行器侧计算)。
  diffSummary: jsonb("diff_summary"),
  ...timeColumns("both"),
});

export const Task = createSelectSchema(task);
export type Task = typeof task.$inferSelect;
export const NewTask = createInsertSchema(task);
export type NewTask = typeof task.$inferInsert;
