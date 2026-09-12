import { task as taskTable } from "@laizhixingxingdeli/database/schema";
import type { DataBase } from "@server/lib/database";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { mergeDiffSummary } from "./diff-summary";
import { notifyTaskStatusChanged } from "./notify";
import { isExecutorProcessAlive } from "./state";
import { writeTaskStatus } from "./task-transitions";
import { asDiffSummaryRecord, OWNER_SERVER_PID_KEY } from "./types";

/**
 * R1(specs/second-server-instance-sweeps-production-tasks.md):把「本 server
 * 进程 pid」登记进 task.diffSummary.platform,作为启动兜底的实例归属判据。
 *
 * 只在 CLI spawn 前写一次(a2a 不本地 spawn、无实例可归属;桥任务 executorKey
 * 为空,本就豁免兜底)。读现有 diffSummary 作底合并,保留 platform 其余键
 * (resumeOf 等)与执行器已写字段 —— 与 writeQueuedDiffSummary 同款口径,不
 * 整体替换。落库失败只告警:兜底对无主任务保持保守语义(见 recoverInterruptedTasks)。
 */
export async function registerTaskOwnerServer(
  db: DataBase,
  taskId: string,
  groupId: string,
): Promise<void> {
  const row = await db.query.task.findFirst({
    where: and(eq(taskTable.id, taskId), eq(taskTable.groupId, groupId)),
    columns: { diffSummary: true },
  });
  const merged = mergeDiffSummary(
    row?.diffSummary,
    { platform: { [OWNER_SERVER_PID_KEY]: process.pid } },
    "relation",
  );
  await db
    .update(taskTable)
    .set({ diffSummary: merged })
    .where(and(eq(taskTable.id, taskId), eq(taskTable.groupId, groupId)))
    .catch((error) =>
      console.warn(`[executor] 登记任务属主实例失败(${taskId}): ${error}`),
    );
}

/** 取任务登记的属主 server pid(diffSummary.platform.ownerServerPid);无 = null。 */
export function ownerServerPidOf(task: {
  diffSummary: unknown;
}): number | null {
  const summary = asDiffSummaryRecord(task.diffSummary);
  const platform =
    summary && typeof summary.platform === "object" && summary.platform !== null
      ? (summary.platform as Record<string, unknown>)
      : undefined;
  const pid = platform?.[OWNER_SERVER_PID_KEY];
  return typeof pid === "number" && Number.isInteger(pid) ? pid : null;
}

/**
 * 重启兜底(server 启动时调用):只把确认已经死亡的**本实例**任务恢复为
 * failed,不自动重跑。
 *
 * 三条判据(specs/second-server-instance-sweeps-production-tasks.md R1/R2/R3):
 * - R2:queued 且 executorPid === null 的任务从未 spawn,不构成「被重启打断」
 *   —— **原样留在 queued**,由 queued-task-reclaim(54be31ef)按有界时延重新
 *   入队;判死它既与事实不符,也是 2026-09-06 沙箱清场的路径之一。
 * - R1:running 且 executorPid 已消失,但登记了**属主实例**(platform.
 *   ownerServerPid)且该属主仍存活 → **跳过**:那是另一个指向同一 DATABASE_URL
 *   的活实例在跑的任务,本实例启动不是它被打断的原因。判据只取数据本身
 *   (属主进程是否存活),不依赖端口/环境变量猜「沙箱」。
 * - R3:其余「有 pid 但进程不在」(属主缺失/属主已死,即本实例真正重启或任务
 *   进程异常退出)才判 server-restart —— 该原因从此与事实一致。
 *
 * 只检查本 server 直接 spawn 的任务:双跑期桥也会建 running 任务
 * (executor_key 为空),仍不参与回收。
 */
export async function recoverInterruptedTasks(db: DataBase): Promise<number> {
  const candidates = await db.query.task.findMany({
    where: and(
      inArray(taskTable.status, ["queued", "running"]),
      isNotNull(taskTable.executorKey),
    ),
  });
  // 单遍归类,四桶互斥,优先级从高到低 —— 避免多个 filter 各自计数导致
  // 同一任务重复落桶(2026-09-06 前正是「谁都能判死」的重灾区)。
  const deadTaskIds: string[] = [];
  let neverStarted = 0;
  let ownedByLiveForeign = 0;
  let retainedCount = 0;
  for (const row of candidates) {
    // R1(最高优先):属主实例仍存活 = 另一个活实例在跑这棵树,本实例**不碰**
    // —— 无论该任务 pid 存活与否。这是本票的核心修复:第二个实例启动不等于
    // 打断了它。属主缺失/属主已死不在此列,继续往下判。
    if (isOwnedByLiveForeignInstance(row)) {
      ownedByLiveForeign += 1;
      continue;
    }
    // R2:queued 且 executorPid === null —— 从未 spawn,不构成「被重启打断」,
    // 原样留队,交给 queued-task-reclaim 有界重入。
    if (row.executorPid === null) {
      neverStarted += 1;
      continue;
    }
    // R3:有 pid 但进程已消失(属主缺失/属主已死)—— 真正的失联,判
    // server-restart,原因从此与事实一致。
    if (!isExecutorProcessAlive(row.executorPid)) {
      deadTaskIds.push(row.id);
      continue;
    }
    retainedCount += 1;
  }
  const rows =
    deadTaskIds.length === 0
      ? []
      : await (async () => {
          const toFail = candidates.filter((row) =>
            deadTaskIds.includes(row.id),
          );
          const updated: typeof candidates = [];
          for (const row of toFail) {
            // R3:失败原因与事实一致。走到这里的只剩「属主缺失/属主已死且
            // executor 进程不在」—— 本实例重启(或任务进程异常退出)后接管,
            // server-restart 是唯一如实的原因。
            const next = mergeDiffSummary(
              row.diffSummary,
              { error: "server-restart" },
              "terminal",
            );
            // 原路径 where 仅 id(无 groupId);notify:false —— 批量收集后统一通知。
            const u = await writeTaskStatus(db, {
              taskId: row.id,
              status: "failed",
              diffSummary: next,
              notify: false,
            });
            if (u) updated.push(u as unknown as (typeof candidates)[number]);
          }
          return updated;
        })();

  if (candidates.length > 0) {
    console.log(
      `[executor] 重启兜底:保留 ${retainedCount} 个仍存活的任务,${neverStarted} 个未启动的 queued 原样留队(R2),${ownedByLiveForeign} 个属主实例存活的任务跳过(R1)`,
    );
  }
  if (rows.length > 0) {
    console.log(
      `[executor] 重启兜底:${rows.length} 个任务置为 failed (server-restart)`,
    );
    for (const row of rows) {
      await notifyTaskStatusChanged(db, row.id, row.groupId, "failed", row);
    }
  }
  return rows.length;
}

/**
 * R1 判据:任务登记了属主 server 实例(非本进程)且该属主进程仍存活。
 *
 * ADR-0009:本判据拿「属主实例进程存活」代替「这个任务不该被本实例回收」。
 * 成立条件:任务行上的 ownerServerPid 是 spawn 它的那个 server 的 pid,且该
 * pid 仍活着 = 那个实例还在负责这棵任务树。不成立(→ 保守判死)的情形:
 * (a) 属主缺失 —— 历史任务/登记失败,无数据可依,宁可按既有语义交回本实例
 *     处理,也不放走一个确实失联的任务;(b) 属主已死 —— 那个实例已经退出,
 *     任务真正处于失联状态,本实例(通常正是重启后的同一部署)接管收敛;
 * (c) pid 复用 —— 属主 pid 被无关进程占用,此时会**跳过**该任务,方向是「宁漏
 *     勿杀」(与孤儿收敛同款取舍:漏判的任务仍由孤儿收敛/queued 回收周期兜底,
 *     误杀则会再次酿成 2026-09-06 式事故)。
 *
 * 判据刻意**与任务状态解耦**:本函数只回答「登记过属主、且属主仍存活?」,不关心
 * 该任务当前是 running 还是 queued —— 由调用方(启动兜底)决定命中后做什么。
 */
export function isOwnedByLiveForeignInstance(task: {
  id: string;
  status: string;
  diffSummary: unknown;
}): boolean {
  const ownerPid = ownerServerPidOf(task);
  if (ownerPid === null || ownerPid === process.pid) return false;
  return isExecutorProcessAlive(ownerPid);
}
