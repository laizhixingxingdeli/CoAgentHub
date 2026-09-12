import type { DataBase } from "@server/lib/database";
import {
  type ExecutorConfig,
  findExecutorByParticipant,
} from "@server/lib/executors";
import { markTaskCancelled } from "./notify";
import { activeRuns, clearRunTimers, groupQueues } from "./state";
import type { QueuedRun } from "./types";

/** 当前运行中的任务(停止指令回传用);并行时可能有多个,返回第一个;无则 null。
 *  groupId 缺省 = 跨全部组;指定 = 只看该群。 */
export function currentRunningTask(groupId?: string): {
  taskId: string;
  participantId: string;
  ex: ExecutorConfig;
  kill: () => void;
} | null {
  for (const g of groupQueues.values()) {
    const r = g.running.find(
      (rr) => rr?.kill && (!groupId || rr.groupId === groupId),
    );
    if (r?.kill) {
      return {
        taskId: r.taskId,
        participantId: r.participantId,
        ex: r.ex,
        kill: r.kill,
      };
    }
  }
  return null;
}

/**
 * 取消排队中的任务(停止指令专用):taskId 缺省 → 取消本群全部排队任务;指定 →
 * 仅取消本群匹配项。只处理排队中的任务(未 spawn,直接移出队列 + 置 cancelled)
 * 以及「已出队未 spawn」的过渡窗口任务(kill 句柄尚未就绪,置 stopped 后由
 * runOne 的 spawn 前 guard 取消);已真正运行的进程不受影响——进程组 kill 机制
 * (spawn detached + process.kill(-pid))保留给服务端自身的静默超时 / 执行超时
 * 兜底,不再由用户指令触发。返回所有被取消的任务信息(未命中 → 空数组)。
 */
export function cancelQueuedTasks(
  groupId: string,
  taskId?: string,
): Array<{
  taskId: string;
  participantId: string;
  ex: ExecutorConfig;
}> {
  const stopped: Array<{
    taskId: string;
    participantId: string;
    ex: ExecutorConfig;
  }> = [];

  for (const g of groupQueues.values()) {
    const remaining: QueuedRun[] = [];
    for (const q of g.queue) {
      if (q.groupId !== groupId) {
        remaining.push(q);
        continue;
      }
      if (taskId && q.taskId !== taskId) {
        remaining.push(q);
        continue;
      }
      stopped.push({
        taskId: q.taskId,
        participantId: q.participantId,
        ex: q.ex,
      });
      clearRunTimers(q);
      void markTaskCancelled(q.db, q.taskId, q.groupId, q.attempts);
    }
    g.queue.length = 0;
    g.queue.push(...remaining);

    // 已出队未 spawn 的过渡窗口(pump 已置 running、kill 句柄未就绪):
    // 置 stopped 标记,runOne 的 spawn 前 guard 会在真正启动前取消该任务——
    // 保证「停止指令已执行但任务照跑」不会发生在 spawn 前窗口。
    const r = g.running.find(
      (rr) =>
        !rr.kill && rr.groupId === groupId && (!taskId || rr.taskId === taskId),
    );
    if (r) {
      r.stopped = true;
      clearRunTimers(r);
      stopped.push({
        taskId: r.taskId,
        participantId: r.participantId,
        ex: r.ex,
      });
    }
  }
  return stopped;
}

/**
 * 取消本群运行中的任务(停止指令专用):运行态先置 stopped,再终止执行器进程组,
 * 最后立即落库 cancelled。进程可能已经退出(detached 协调任务尤其如此),kill
 * 失败不影响取消记账；仍在等待 promise 的 run 会在完成回调中复用同一 cancelled
 * 分支,不会再发 ❌/✅。
 */
export async function cancelRunningTasks(
  db: DataBase,
  groupId: string,
  taskId?: string,
): Promise<
  Array<{ taskId: string; participantId: string; ex: ExecutorConfig }>
> {
  const stopped: Array<{
    taskId: string;
    participantId: string;
    ex: ExecutorConfig;
  }> = [];
  const handled = new Set<string>();

  for (const g of groupQueues.values()) {
    for (const run of g.running) {
      if (run.groupId !== groupId || (taskId && run.taskId !== taskId))
        continue;
      run.stopped = true;
      clearRunTimers(run);
      run.kill?.();
      handled.add(run.taskId);
      stopped.push({
        taskId: run.taskId,
        participantId: run.participantId,
        ex: run.ex,
      });
      await markTaskCancelled(db, run.taskId, groupId, run.attempts);
    }
  }

  // detached CLI tasks release their queue slot after spawn, so their run is no
  // longer in groupQueues.running. The persisted pid remains the source of truth
  // for this narrow cancellation window; an exited pid is still a valid cancel.
  const rows = await db.query.task.findMany({
    where: (t, { and: andFn, eq: eqFn, isNotNull: isNotNullFn }) =>
      andFn(
        eqFn(t.groupId, groupId),
        eqFn(t.status, "running"),
        ...(taskId ? [eqFn(t.id, taskId)] : []),
        isNotNullFn(t.executorPid),
      ),
    columns: {
      id: true,
      executorParticipantId: true,
      executorKey: true,
      executorPid: true,
      attempts: true,
    },
  });
  for (const row of rows) {
    if (handled.has(row.id) || row.executorPid === null) continue;
    try {
      process.kill(-row.executorPid, "SIGTERM");
    } catch {
      // The detached process may have exited already; cancellation is still
      // required so the task cannot remain running until detached timeout.
    }
    const ex = await findExecutorByParticipant(db, {
      executorKey: row.executorKey,
    });
    if (ex) {
      stopped.push({
        taskId: row.id,
        participantId: row.executorParticipantId,
        ex,
      });
    }
    await markTaskCancelled(db, row.id, groupId, row.attempts ?? []);
  }
  return stopped;
}

/**
 * 同一 taskId 是否已有另一个活跃 run(specs/queued-task-never-picked-up-after-
 * chain-failure.md R1 的重复入队守卫)。
 *
 * 为什么需要它:回收扫描按 DB 的 queued 行补建内存 run,而正常派发是「先插
 * task 行(queued)、再入内存队列」两步 —— 扫描若正好落在这两步之间,同一个
 * task 会有两个 run。泵在调用 runOne 前已把 run 放进 activeRuns(同步),
 * 因此先到的那个一定先可见:后到的据此放弃本次执行,任务不会被 spawn 两次。
 *
 * 判据拿「activeRuns 里存在同 taskId 的另一个 run」代替「这个 task 正在被
 * 执行」;前提是 run 进入 activeRuns 早于 runOne 的任何 await(泵里同步 add)。
 * 不成立的情形是同一个 task 被两个**不同进程**各派一次 —— 本守卫只覆盖本
 * 进程内,跨进程仍需 DB 状态兜底(任务状态是 server 单一真相源)。
 */
export function hasDuplicateActiveRun(run: QueuedRun): boolean {
  for (const other of activeRuns) {
    if (other !== run && other.taskId === run.taskId) return true;
  }
  return false;
}
