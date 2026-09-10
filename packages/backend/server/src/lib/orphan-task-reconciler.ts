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
import {
  parseRateLimitRecoveryMs,
  listPeerExecutorNames,
} from "@server/lib/executors";
import { and, eq } from "drizzle-orm";
import {
  applyDiffSummaryPatch,
  hasExemptingChildTask,
  hasPendingCloseGuardResume,
  hasPendingResumeEvent,
  isCoordinatorTask,
  isExecutorProcessAlive,
  notifyTaskStatusChanged,
  taskOutputTail,
} from "./executor-task";
import { EXECUTOR_COOLDOWN_END_MS_FIELD } from "./executor-task/cooldown-store";
import {
  enterCooldown,
  MIN_EFFECTIVE_COOLDOWN_MS,
  normalizeCooldownEnd,
} from "./executor-task/queue";
import { lastLinesOf, taskOutputTailLines } from "./executor-task/report";
import {
  formatEta,
  getRateLimitCooldownMs,
  classifyQuotaFailure,
} from "./executor-task/state";

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
      executorKey: true,
      diffSummary: true,
    },
  });

  let reconciled = 0;
  for (const task of candidates) {
    if (task.executorPid === null) continue;
    if (isExecutorProcessAlive(task.executorPid)) continue;
    // R1(本 spec):等待续跑的协调者任务豁免收敛 —— 执行方是协调者
    // (isCoordinatorTask 同源判定)且名下存在构成豁免的执行子任务
    // (hasExemptingChildTask,R2 口径:running,或 queued 且其执行器当前可派发;
    // 候选状态集与 coordinator-resume 的 NON_TERMINAL_TASK_STATUSES 同源)时,
    // pid 消失不判死,等子任务终态触发续跑。R2 收缩:queued 且从未启动
    // (executor_pid 为空)、执行器不可派发(冷却中 / 并发已满 / 查无配置)的
    // 子任务并不在干活,不构成豁免 —— 否则已死的协调者链会被「排队等冷却
    // (最长 300 分钟)」的子任务无限期钉住,整棵子树无进展也无告警。
    // 本 spec 的必经竞态窗口——子任务刚转终态而续跑尚未创建——由
    // hasPendingResumeEvent 兜住:完成事件与终态同事务落库,pending 事件 =
    // 消费方下一个周期就会创建续跑,期间父任务同样不判死。
    // R1(本 spec):resumeOf 标识的续跑任务与协调根任务同条件豁免 —— 它「派完
    // 即退」、名下仍有豁免子任务或待建续跑事件时不判死;仅当它自己也无事可做
    // (无豁免子任务且无待建续跑)时才收敛,保住 R3 的「不被永远豁免」本意。
    // hasPendingResumeEvent 已排除续跑任务自身的完成事件,终止性判定不受影响。
    // 第三判据(R2,specs/detached-close-deadlock-guard-vs-no-poll.md):结案
    // 守卫拒绝过结案、且已登记待续跑的协调任务同样不判死 —— 它是**被平台挡住**
    // 才退出的(协调者规则禁止轮询等待),pid 消失是正常的 detached 语义,不是
    // 失败。判据复用 deriveCloseGuardResume:以「被登记的子任务是否仍有非终态」
    // 为准,而非「任务上有没有标记」,标记是历史留痕、它自己不会失效。
    // ADR-0009:本判据拿「被登记的子任务仍未终态」代替「有人在推进这棵子树」,
    // 前提是子任务终态会触发完成事件并由既有消费路径创建续跑任务把协调者拉起;
    // 不成立的情形是被登记的子任务自己永远停在非终态(排队但无人可派发)——
    // 此时与「有 running 子任务」的既有豁免同款,由 detached 超时
    // (detachedTimeoutMinutes,默认 24h)兜底,不会永久挂 running。真正失联的
    // 进程(无任何待续跑依据)处置逐字不变。
    if (
      (await isCoordinatorTask(
        db,
        task.groupId,
        task.executorParticipantId ?? "",
      )) &&
      ((await hasExemptingChildTask(db, task.id)) ||
        (await hasPendingResumeEvent(db, task.id)) ||
        (await hasPendingCloseGuardResume(db, task)))
    ) {
      continue;
    }
    const reason = `executor pid ${task.executorPid} no longer exists`;
    // 判死写库前只检查已捕获输出尾部 20 行(与 queue 超时/失败/成功分支同界
    // lastLinesOf(out, 20),不放宽):命中额度关键词 → 复用既有额度语义 —— error
    // 用既有额度失败文案并含 ETA、diffSummary 写 executorCooldownEndMs、冷却该
    // 执行器(enterCooldown,不自动重试 —— 收敛本身无重试路径)。非额度路径逐字
    // 不变。executorKey 缺失(历史任务)时无法冷却指定执行器 → 走普通路径。
    const tail = lastLinesOf(taskOutputTail(task.id) ?? "", 20);
    // R2 转述排除:孤儿收敛同样只在「非转述 + 正面证据」时判额度(01a07239
    // 实证:协调者汇报里的子任务转述被误冷却)。
    const quota =
      task.executorKey !== null &&
      classifyQuotaFailure([tail], {
        peerExecutorNames: await listPeerExecutorNames(db, task.executorKey),
      }).isQuota;
    let error = reason;
    let cooldownEnd: number | null = null;
    let cooldownSource: "parsed" | "fallback" = "fallback";
    const extra: Record<string, unknown> = {};
    if (quota) {
      const parsedMs = parseRateLimitRecoveryMs(tail, now.getTime());
      cooldownEnd = normalizeCooldownEnd(
        parsedMs ?? now.getTime() + getRateLimitCooldownMs(),
        now.getTime(),
      );
      error = `${reason}(执行器额度限制,预计 ${formatEta(cooldownEnd)} 恢复)`;
      extra[EXECUTOR_COOLDOWN_END_MS_FIELD] = cooldownEnd;
      cooldownSource =
        parsedMs !== null &&
        parsedMs > now.getTime() + MIN_EFFECTIVE_COOLDOWN_MS
          ? "parsed"
          : "fallback";
      extra.executorCooldownSource = cooldownSource;
      if (
        parsedMs !== null &&
        parsedMs <= now.getTime() + MIN_EFFECTIVE_COOLDOWN_MS
      ) {
        extra.cooldownFallbackReason = "解析所得时刻不可用,已回退固定冷却";
        extra.discardedCooldownEndMs = parsedMs;
      }
    }
    // R2 + diffsummary-ownership W2:经单一合并入口以既有为底写入 terminal/
    // metrics/scheduling 键,保留 platform.* / audit / result 等他有字段。
    // 额度路径额外写 executorCooldownEndMs(与 queue 的 handleQuotaFailure 同键,
    // 重启由 restoreExecutorCooldowns 恢复)。
    const outputTail = taskOutputTailLines(task.id);
    const next = applyDiffSummaryPatch(task.diffSummary, {
      error,
      reconciledReason: error,
      reconciledAt: now.toISOString(),
      ...(outputTail ? { outputTail } : {}),
      ...extra,
    });
    const [updated] = await db
      .update(taskTable)
      .set({
        status: "failed",
        diffSummary: next,
      })
      // R5:以「仍为 running」为条件更新,并发写回 done 的任务不再匹配。
      .where(and(eq(taskTable.id, task.id), eq(taskTable.status, "running")))
      .returning();
    if (!updated) continue;
    reconciled += 1;
    console.log(
      `[orphan] 收敛孤儿任务 ${task.id}: ${error} (${now.toISOString()})`,
    );
    if (quota && task.executorKey !== null && cooldownEnd !== null) {
      enterCooldown(
        { key: task.executorKey, label: task.executorKey },
        cooldownEnd,
        cooldownSource,
        { db, taskId: task.id },
      );
    }
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
