import { task as taskTable } from "@laizhixingxingdeli/database/schema";
import { wsHub } from "@server/lib/ws-hub";
import { and, eq } from "drizzle-orm";
import { endAttempt } from "./attempt-accounting";
import { mergeDiffSummary } from "./diff-summary";
import { workspaceGateBlocked } from "./dispatchability";
import { failTask } from "./failure";
import { postStatus } from "./notify";
import { releaseTaskOutput } from "./output-buffer";
import {
  clearRunTimers,
  getA2ASilenceTimeoutMs,
  getClaimTimeoutMs,
  getStallAlertMs,
  groupQueues,
  isInCooldown,
} from "./state";
import type { QueuedRun } from "./types";

/**
 * 为 queued run 装上认领超时定时器(入队与重排队共用)。
 *
 * 延迟 = max(claimTimeoutMs, concurrencyRetryAt + claimTimeoutMs - now):
 * concurrencyRetryAt 是 isRunDispatchable / runBlockReason 判定「per-run 退避
 * 窗口未过」的**同一事实**(ADR-0009),不是第二套豁免判据。窗口内任务本来就
 * 该待在 queued;若只按 claimTimeoutMs 从现在起算,退避(403 的 3s / 瞬时策略
 * 的 backoffMs)大于认领阈值时会把正常退避误杀成「未认领」。
 *
 * 从「可被派发」起算 claim 窗口:退避结束后再给满额 claimTimeoutMs,与首次
 * 入队(concurrencyRetryAt=0 → delay=claimTimeoutMs)同式。
 */
export function armClaimTimer(run: QueuedRun): void {
  if (run.claimTimer) {
    clearTimeout(run.claimTimer);
    run.claimTimer = null;
  }
  const claimMs = getClaimTimeoutMs();
  const delay = Math.max(
    claimMs,
    run.concurrencyRetryAt - Date.now() + claimMs,
  );
  run.claimTimer = setTimeout(
    () => handleClaimTimeout(run),
    Math.max(1, delay),
  );
}

/* ---------------- 超时 / 进度处理 ---------------- */

/**
 * 无进展提醒处理(网页体验批次):running 任务连续无输出超过 stallAlertMs
 * (默认 15min,先于 stallTimeoutMs)→ 发一条群消息提醒协调者 + 任务面板行
 * 警示标记(黄色,非失败);静默继续到 stallTimeoutMs 才由 handleStall 标
 * failed。停止指令优先:run.stopped 的任务直接跳过。仅 CLI 路径调度(与静默
 * 检测同界,a2a 无本地进程输出可观察)。
 */
export function handleStallAlert(run: QueuedRun): void {
  if (run.stopped || run.stalled || run.stallAlerted) return;
  run.stallAlerted = true;
  if (run.stallAlertTimer) {
    clearTimeout(run.stallAlertTimer);
    run.stallAlertTimer = null;
  }
  const minutes = Math.max(1, Math.round(getStallAlertMs() / 60_000));
  console.warn(
    `[executor] 无进展提醒: ${run.taskId} 已 ${minutes} 分钟无输出,执行器:${run.ex.label}`,
  );
  void (async () => {
    await postStatus(
      run.db,
      run.groupId,
      run.participantId,
      run.ex,
      `⚠️ 任务 ${run.taskId} 已 ${minutes} 分钟无进展,执行器:${run.ex.label},请介入`,
    );
    // 警示标记落库(diffSummary.stallAlerted),任务面板行加黄色警示样式。
    try {
      const cur = await run.db.query.task.findFirst({
        where: and(
          eq(taskTable.id, run.taskId),
          eq(taskTable.groupId, run.groupId),
        ),
        columns: { diffSummary: true },
      });
      const nextAlert = mergeDiffSummary(
        cur?.diffSummary,
        { stallAlerted: true },
        "scheduling",
      );
      await run.db
        .update(taskTable)
        .set({ diffSummary: nextAlert })
        .where(
          and(eq(taskTable.id, run.taskId), eq(taskTable.groupId, run.groupId)),
        );
    } catch (e) {
      console.warn(`[executor] 写无进展警示标记失败(${run.taskId}): ${e}`);
    }
    void wsHub.broadcastTaskStallAlert(run.groupId, run.taskId);
  })();
}

/**
 * 静默超时处理:running 任务连续无输出超过 stallTimeoutMs → kill 进程组 +
 * 置 stalled。失败落库 / ❌ 回传 / 重试判定由 promise 完成路径(runOne 看到
 * run.stalled)统一处理,避免定时器回调与完成路径并发写状态。
 * 停止指令优先:run.stopped 的任务直接跳过(停止走 cancelled 路径)。
 */
export function handleStall(run: QueuedRun): void {
  if (run.stopped || run.stalled) return;
  run.stalled = true;
  if (run.stallTimer) {
    clearTimeout(run.stallTimer);
    run.stallTimer = null;
  }
  run.kill?.();
  console.error(`[executor] 执行器静默超时: ${run.taskId}`);
}

/**
 * A2A 无进展超时处理(第1层):running 的 A2A 任务连续无任何进展信号(执行器
 * participant 在群里的消息,refreshA2AActivity 顺延)超过 a2aSilenceTimeoutMs
 * → 置 a2aSilenced + 中止在途请求,失败落库 / ❌ 回传由完成路径统一处理
 * (与静默超时同一模式,避免定时器回调与完成路径并发写状态)。
 * 停止指令优先:run.stopped 的任务直接跳过(停止走 cancelled 路径);
 * detached 任务不设此定时器(发送后静默等待执行器 PATCH 是正常态)。
 */
export function handleA2ASilence(run: QueuedRun): void {
  if (run.stopped || run.a2aSilenced || run.detached) return;
  run.a2aSilenced = true;
  if (run.a2aSilenceTimer) {
    clearTimeout(run.a2aSilenceTimer);
    run.a2aSilenceTimer = null;
  }
  run.kill?.();
  console.error(`[executor] A2A 无进展超时: ${run.taskId}`);
}

/**
 * A2A 进度信号(第1层):执行器 participant 在群里发的消息 → 刷新该执行器在本群
 * running 的 A2A 任务最近活跃时间(lastActivityAt),顺延无进展超时定时器。
 * 由 POST /groups/:id/messages 成功写入消息后调用(fire-and-forget,纯内存
 * 同步操作)。消息可以是普通广播消息,无需新协议。不命中(非 A2A / 非 running /
 * 非本执行器消息 / 已停止或已触发无进展)返回 false,不影响消息响应。
 */
export function refreshA2AActivity(
  groupId: string,
  participantId: string,
): boolean {
  for (const g of groupQueues.values()) {
    const run = g.running.find(
      (rr) =>
        !rr.stopped &&
        !rr.a2aSilenced &&
        rr.groupId === groupId &&
        rr.participantId === participantId &&
        rr.ex.kind === "a2a",
    );
    if (!run) continue;
    run.lastActivityAt = Date.now();
    if (run.a2aSilenceTimer) {
      clearTimeout(run.a2aSilenceTimer);
      run.a2aSilenceTimer = setTimeout(
        () => handleA2ASilence(run),
        getA2ASilenceTimeoutMs(),
      );
    }
    return true;
  }
  return false;
}

/**
 * A2A 请求超时时的「最近有进展」判定(第2层):running 起点后有进展信号
 * (lastActivityAt 被进度消息刷新过,即 > runningAt)且距上次进展未超过无进展
 * 窗口 → 视为执行器可能仍在执行/已完成,结果未确认。无进展起点(lastActivityAt
 * === runningAt)或静默已超窗口(此时 a2aSilenceTimer 已先触发)不算。
 */
export function hasRecentA2AProgress(run: QueuedRun): boolean {
  if (!run.runningAt) return false;
  if (run.lastActivityAt <= run.runningAt) return false;
  return Date.now() - run.lastActivityAt < getA2ASilenceTimeoutMs();
}

/**
 * 结果未确认统一出口(第2层):执行器可能已完成但结果无法确认(gateway「did not
 * reply in time」/ 请求超时但有进展 / 网络错误 / HTTP 5xx / detached 超时未回写)。
 * 落库保持 status=failed(不新增状态,避免迁移/兼容问题),diffSummary 加
 * unconfirmed: true + 协议文案;群消息回传 ⚠️ 而非 ❌。不重试(重试有重复执行
 * 风险)。detached 超时触发前会复查 DB 状态(已回写终态则跳过),见 handleDetachedTimeout。
 */
export async function handleUnconfirmed(run: QueuedRun): Promise<void> {
  const { db, taskId } = run;
  await endAttempt(run, {
    status: "failed",
    error: "执行器未按协议回复，结果未确认",
  });
  const failed = await failTask(
    db,
    taskId,
    "执行器未按协议回复，结果未确认",
    run.retryCount,
    { unconfirmed: true },
    run.attempts,
  );
  releaseTaskOutput(taskId);
  if (!failed) return;
  await postStatus(
    db,
    run.groupId,
    run.participantId,
    run.ex,
    "⚠️ 任务结果未确认：执行器可能已完成，请人工核实",
  );
}

/**
 * detached 超时处理(第3层):任务发送后超过 detachedTimeoutMs 执行器仍未 PATCH
 * 回写终态 → 按「结果未确认」处理(第2层)。触发前复查 DB:状态已非 running
 * (执行器已回写 done/failed 或已被停止置 cancelled)→ 跳过,避免覆盖终态。
 */
export function handleDetachedTimeout(run: QueuedRun): void {
  if (run.stopped || run.detachedTimedOut) return;
  run.detachedTimedOut = true;
  if (run.detachedTimer) {
    clearTimeout(run.detachedTimer);
    run.detachedTimer = null;
  }
  console.error(`[executor] detached 任务超时未回写终态: ${run.taskId}`);
  void (async () => {
    try {
      const cur = await run.db.query.task.findFirst({
        where: (t, { and: andFn, eq: eqFn }) =>
          andFn(eqFn(t.id, run.taskId), eqFn(t.groupId, run.groupId)),
        columns: { status: true },
      });
      if (cur?.status !== "running") {
        // 执行器已 PATCH 回写终态(或已停止):结果已确认/已取消,不再覆盖。
        return;
      }
      await handleUnconfirmed(run);
    } catch (e) {
      console.warn(`[executor] detached 超时处理失败(${run.taskId}): ${e}`);
    }
  })();
}

/**
 * 认领超时处理:queued 任务超过 claimTimeoutMs 仍未进入 running → 移出队列 +
 * 置 failed(「任务未被认领」)+ ❌ 回传(注明发布时间)。若任务已被 pump 取走
 * 开始运行(认领完成),从队列找不到即放弃(定时器取消前已入队的回调兜底)。
 * 停止指令优先:run.stopped 的任务直接跳过(停止走 cancelled 路径)。
 */
export function handleClaimTimeout(run: QueuedRun): void {
  if (run.stopped) return;
  // 执行器额度冷却中:不按认领超时处理(任务应保持 queued,等冷却结束由
  // enterCooldown 的定时器泵送自动派发,而非被误标「未认领」)。
  if (isInCooldown(run.ex)) return;
  // per-run 退避窗口未到:与 isRunDispatchable 同源(concurrencyRetryAt,
  // ADR-0009)。armClaimTimer 已按窗口排期,这里是尾窗/时钟回拨的防御;
  // 改期到窗口结束 + claimTimeout,不另写「是否该豁免」的第二套判定。
  const retryInMs = run.concurrencyRetryAt - Date.now();
  if (retryInMs > 0) {
    armClaimTimer(run);
    return;
  }
  const g = groupQueues.get(run.groupKey);
  if (g) {
    const idx = g.queue.indexOf(run);
    if (idx < 0) return; // 已被取走开始运行 → 认领完成,放弃。
    // 工作树闸已满:任务是被泵**合法**跳过的(不是遗弃),豁免认领超时 ——
    // 保持 queued 等闸释放,由既有任务终态的泵送拉起(R1.1)。判据复用泵的
    // 闸判定(workspaceGateBlocked),不另写第二套「队列是否阻塞」(ADR-0009)。
    if (workspaceGateBlocked(g)) return;
    g.queue.splice(idx, 1);
  }
  clearRunTimers(run);
  const publishedAt = new Date(run.createdAt).toLocaleString("zh-CN");
  console.error(`[executor] 任务未认领: ${run.taskId}`);
  void (async () => {
    const failed = await failTask(run.db, run.taskId, "任务未认领");
    if (!failed) return;
    await postStatus(
      run.db,
      run.groupId,
      run.participantId,
      run.ex,
      `❌ [${run.ex.label}] 任务失败 (未认领,发布于 ${publishedAt})`,
    );
  })();
}
