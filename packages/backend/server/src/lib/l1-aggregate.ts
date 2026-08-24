import type { task as taskTable } from "@laizhixingxingdeli/database/schema";
import type { DataBase } from "@server/lib/database";
import { isTerminalTaskStatus } from "./coordination-activity";

/**
 * 协调任务详情透出的 L1 聚合(specs/reviewer-needs-no-executor-visibility.md
 * R1):只回答「L1 层发生了没有、结果如何」,不含任何执行器身份。
 *
 * 聚合口径必须与前端 group-tasks-by-spec.ts 的 L1 步(aggregateTaskStatuses)
 * 完全一致 —— 前端已经在用这套口径,后端不能另写一套(两份会各自演化)。
 * 因前端文件依赖前端别名,后端在 lib 内镜像同一规则,并由测试
 * test/l1-aggregate.test.ts 做「同输入同结论」对照。
 */

export type StepStatus = "done" | "failed" | "running" | "pending";

/** 与前端 group-tasks-by-spec.ts 的 aggregateTaskStatuses 逐字一致。 */
export function aggregateTaskStatuses(statuses: string[]): StepStatus {
  if (statuses.length === 0) return "pending";
  if (statuses.some((status) => status === "running")) return "running";
  if (statuses.every((status) => status === "done")) return "done";

  let lastFailed = -1;
  let lastDone = -1;
  for (let index = 0; index < statuses.length; index += 1) {
    if (statuses[index] === "failed") lastFailed = index;
    if (statuses[index] === "done") lastDone = index;
  }
  if (lastFailed >= 0 && lastDone <= lastFailed) return "failed";
  return "pending";
}

export interface L1Aggregate {
  childCount: number;
  status: StepStatus;
  allTerminal: boolean;
}

type Task = typeof taskTable.$inferSelect;

/**
 * 派生子任务的 L1 聚合。子任务 = parentTaskId 指向本协调任务的任务,按
 * createdAt 升序(与前端 L1 步的入参顺序一致)。
 *
 * allTerminal = 子任务非空且全部已到终态(done/failed/cancelled);零子任务时
 * 为 false —— 零子任务意味着 L1 层未发生(与 coordination-close-integrity 的
 * 「L1 层未发生」判定一致),不能对空集做「全终态」的虚真解读。
 */
export async function deriveL1Aggregate(
  db: DataBase,
  task: Task,
): Promise<L1Aggregate> {
  const children = await db.query.task.findMany({
    where: (t, { eq }) => eq(t.parentTaskId, task.id),
    columns: { status: true },
    orderBy: (t, { asc }) => asc(t.createdAt),
  });
  const statuses = children.map((child) => child.status);
  return {
    childCount: children.length,
    status: aggregateTaskStatuses(statuses),
    allTerminal:
      children.length > 0 &&
      children.every((child) => isTerminalTaskStatus(child.status)),
  };
}
