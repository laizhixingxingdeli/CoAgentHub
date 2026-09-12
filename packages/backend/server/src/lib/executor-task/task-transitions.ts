/**
 * 任务状态写入唯一入口(S1 第 1 阶段:纯收敛)。
 *
 * 各调用点把已算好的 status / diffSummary / 其它列交给本原语落库;
 * 本函数不做 diffSummary 合并、不加默认 status 前置条件(第 2 阶段再做
 * 乐观并发)。调用点原先的 where / notify 口径必须逐条对齐传入。
 */

import {
  type Task,
  type TaskStatus,
  task as taskTable,
} from "@laizhixingxingdeli/database/schema";
import type { DataBase } from "@server/lib/database";
import { and, eq, inArray, type SQL } from "drizzle-orm";
import { notifyTaskStatusChanged } from "./notify";

export type WriteTaskStatusParams = {
  taskId: string;
  /** 给了就进 where(与现状逐条对齐;跨群边界情形不要多传)。 */
  groupId?: string;
  status: TaskStatus;
  /** 已算好的最终值;本函数不做合并。undefined 表示不写该列。 */
  diffSummary?: unknown;
  /** checkpointRef / brief / recipientParticipantIds 等顺带写入的列。 */
  extra?: Record<string, unknown>;
  /** 默认 true;原先不通知的调用点传 false。 */
  notify?: boolean;
  /**
   * 第 2 阶段用:期望的当前 status 集合(乐观并发前置条件)。
   * 本阶段仅在调用方**已经**带 status where 时原样迁入,以保持行为不变;
   * 未传则不加任何 status 前置条件。
   */
  expectedStatuses?: string[];
};

/**
 * 落库 task.status(及可选 diffSummary / extra),returning 第一行;
 * 无匹配行返回 null。notify !== false 且有行时推 task_status_changed。
 */
export async function writeTaskStatus(
  db: DataBase,
  params: WriteTaskStatusParams,
): Promise<Task | null> {
  const {
    taskId,
    groupId,
    status,
    diffSummary,
    extra,
    notify = true,
    expectedStatuses,
  } = params;

  const conditions: SQL[] = [eq(taskTable.id, taskId)];
  if (groupId !== undefined) {
    conditions.push(eq(taskTable.groupId, groupId));
  }
  // expectedStatuses:仅当调用方传入时进 where(迁就既有 status=running 等条件)。
  if (expectedStatuses !== undefined && expectedStatuses.length > 0) {
    conditions.push(
      inArray(taskTable.status, expectedStatuses as TaskStatus[]),
    );
  }

  // biome-ignore format: single-line set keeps S1 grep `set({...status:` on task-transitions only
  const [row] = await db.update(taskTable).set({ status: status, ...(diffSummary !== undefined ? { diffSummary } : {}), ...(extra ?? {}) }).where(and(...conditions)).returning();

  if (!row) return null;

  if (notify !== false) {
    await notifyTaskStatusChanged(db, taskId, row.groupId, status, row as Task);
  }
  return row as Task;
}
