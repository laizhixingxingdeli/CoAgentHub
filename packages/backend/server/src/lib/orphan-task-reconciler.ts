/**
 * 孤儿任务周期收敛(specs/orphan-tasks-only-reconcile-on-restart.md R1-R5)。
 *
 * 服务端运行期间周期扫描 running 任务,把「执行器进程确已退出」的孤儿收敛为
 * failed —— 解除孤儿与自动重建(rebuild-when-runtime-goes-stale R4)的互锁:
 * 此前孤儿只在后端重启时收敛,而 R4 要求没有在途任务才允许重启/重建。
 *
 * 判定复用 executor-task 的 pid 存活核验(isExecutorProcessAlive =
 * process.kill(pid, 0) 仅 ESRCH 视为死亡),不另写活性口径;写回复用
 * notifyTaskStatusChanged 出口,与 PATCH 推进状态一致。
 */

import { task as taskTable } from "@laizhixingxingdeli/database/schema";
import type { DataBase } from "@server/lib/database";
import { and, eq } from "drizzle-orm";
import {
  hasNonTerminalChildTask,
  isCoordinatorTask,
  isExecutorProcessAlive,
  isResumeTask,
  notifyTaskStatusChanged,
} from "./executor-task";

/** 孤儿收敛周期(默认 10s;测试可注入更短间隔)。 */
export const ORPHAN_RECONCILE_INTERVAL_MS = 10_000;

/** startOrphanReconciler 的显式开关:enabled=false 时不注册定时器(测试环境注入,避免后台收敛误判测试任务);缺省 = 生产默认路径自动启动。 */
export interface StartOrphanReconcilerOptions {
  enabled?: boolean;
}

/**
 * 单轮孤儿收敛:扫描全部 running 任务,把持有已退出 executorPid 的任务收敛为
 * failed,diffSummary 记录 reconciledReason(含 pid)与收敛时刻,供事后区分
 * 「执行器自己报的失败」与「平台收敛的孤儿」。返回本轮收敛的任务数。
 *
 * 判定要点(R2/R3/R5):
 * - 无 executorPid → 不收敛(无法核验进程存活,保持旧行为)。
 * - pid 存活(含静默超过 30 分钟)→ 不收敛;静默提示仍由读时
 *   livenessWarning 承担,绝不误杀正在干活的任务。
 * - pid 已退出(ESRCH)→ 收敛。pid 复用风险:本实现取「宁漏勿杀」取舍 ——
 *   被复用的新进程存活时表现为「pid 存在 → 不收敛」,方向安全;进程启动
 *   时间比对需平台相关系统调用,LAN 场景下不引入(取舍已在 spec R3 记录)。
 * - 条件更新:仅当任务状态仍为 running 时写回,绝不覆盖执行器并发写入的 done。
 */
export async function reconcileOrphanTasks(
  db: DataBase,
  now = new Date(),
): Promise<number> {
  const candidates = await db.query.task.findMany({
    where: (t, { eq: eqFn }) => eqFn(t.status, "running"),
    columns: {
      id: true,
      groupId: true,
      executorPid: true,
      executorParticipantId: true,
      diffSummary: true,
    },
  });

  let reconciled = 0;
  for (const task of candidates) {
    if (task.executorPid === null) continue;
    if (isExecutorProcessAlive(task.executorPid)) continue;
    // R1(本 spec):等待续跑的协调者根任务豁免收敛 —— 执行方是协调者
    // (isCoordinatorTask 同源判定)且名下存在非终态执行子任务
    // (hasNonTerminalChildTask,与 coordinator-resume 同源口径)时,pid 消失
    // 不判死,等子任务终态触发续跑。R3:resumeOf 标识的续跑任务自身不豁免。
    if (
      !isResumeTask(task) &&
      (await isCoordinatorTask(
        db,
        task.groupId,
        task.executorParticipantId ?? "",
      )) &&
      (await hasNonTerminalChildTask(db, task.id))
    ) {
      continue;
    }
    const reason = `executor pid ${task.executorPid} no longer exists`;
    const [updated] = await db
      .update(taskTable)
      .set({
        status: "failed",
        diffSummary: {
          error: reason,
          reconciledReason: reason,
          reconciledAt: now.toISOString(),
        },
      })
      // R5:以「仍为 running」为条件更新,并发写回 done 的任务不再匹配。
      .where(and(eq(taskTable.id, task.id), eq(taskTable.status, "running")))
      .returning();
    if (!updated) continue;
    reconciled += 1;
    console.log(
      `[orphan] 收敛孤儿任务 ${task.id}: ${reason} (${now.toISOString()})`,
    );
    await notifyTaskStatusChanged(db, task.id, task.groupId, "failed", updated);
  }
  return reconciled;
}

/** 周期性孤儿收敛(server 启动时注册);返回停止函数(测试用)。 */
export function startOrphanReconciler(
  db: DataBase,
  intervalMs = ORPHAN_RECONCILE_INTERVAL_MS,
  options: StartOrphanReconcilerOptions = {},
): () => void {
  // 显式开关:enabled=false 不注册定时器(测试环境注入,避免后台收敛在测试
  // 运行期间误判 running 任务为 failed);缺省 true = 生产创建 server/app 的
  // 默认路径(index.ts)仍自动启动。不用 NODE_ENV 隐式判断,开关显式可注入。
  if (options.enabled === false) {
    return () => {};
  }
  const timer = setInterval(() => {
    void reconcileOrphanTasks(db).catch((error) => {
      console.warn(`[orphan] 孤儿收敛失败: ${error}`);
    });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
