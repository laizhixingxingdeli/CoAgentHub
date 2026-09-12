import { task as taskTable } from "@laizhixingxingdeli/database/schema";
import type { ExecutorRunResult } from "@server/lib/executor-runner";
import { and, eq } from "drizzle-orm";
import { recordExecutorOutput } from "../executor-availability";
import { endAttempt } from "./attempt-accounting";
import { verifyReportedCommit } from "./claim-verification";
import { applyDiffSummaryPatch } from "./diff-summary";
import { handleFailure } from "./failure";
import { postStatus } from "./notify";
import { liveTaskOutputTail, releaseTaskOutput } from "./output-buffer";
import { routeQuotaFailure } from "./quota-failure";
import {
  findCommitHash,
  findProviderError,
  hasStructuredTaskReport,
  hasZeroTokenUsage,
  lastLinesOf,
  parseTaskReport,
  renderTaskCard,
  type TaskReport,
  taskOutputTailLines,
} from "./report";
import { classifyQuotaFailure } from "./state";
import { writeTaskStatus } from "./task-transitions";
import {
  type QueuedRun,
  sumAttemptTokenUsage,
  sumAttemptTokenUsageReason,
} from "./types";

/**
 * runOne 成功终态(result.code === 0)分支体。从 queue.ts 抽出;
 * 调用方必须在 await 后 return,以保持与原 if 分支「结束 try」等价。
 */
export async function handleSuccessOutcome(
  run: QueuedRun,
  ctx: {
    result: ExecutorRunResult;
    output: string;
    isA2a: boolean;
    repoRoot: string;
    getPeerExecutorNames: () => Promise<string[]>;
  },
): Promise<void> {
  const { db, groupId, taskId, participantId, ex } = run;
  const { result, output, isA2a, repoRoot, getPeerExecutorNames } = ctx;

  // 成功路径也要过额度检测(quota-failure-on-clean-exit 规范):执行器
  // 礼貌地打印额度耗尽说明后正常退出(如 `[rate-limited] 5h window
  // exhausted`),走的是 exit 0 路径,若只在超时/失败分支检测会漏判为
  // done。与失败分支(1365)同界(尾部 20 行)命中 → 按额度失败处理(逐条
  // 一致:failed / 冷却 / 不重试 / 回传预计恢复时间);前部命中尾部不命中
  // 则不判(避免误判停派)。不含额度关键词时行为完全不变(继续 done 路径)。
  const successTail = lastLinesOf(output, 20).slice(0, 1500);
  const successQuota = classifyQuotaFailure([successTail], {
    exitCode: 0,
    taskBook: run.body,
    peerExecutorNames: await getPeerExecutorNames(),
  });
  // R6 主闸(quota-failure-on-clean-exit v1.1):exit 0 时先以「本次任务
  // 窗口内是否产生提交」为闸 —— 有提交 → 一律不判额度、不进入冷却(运行
  // 中途出现瞬时限流退避行不代表耗尽,实证 01a05103-db4c:提交 1862e03f
  // 真实存在却因 [rate-limited] auto-continuing in 3s… 被误判停派 5 小时);
  // 无提交 → 保留既有额度语义。只收紧干净退出这一条路径,非零退出/超时
  // 分支逐字不变。
  // R9:为可归因产出判据先解析汇报(与正式汇报同口径),供主闸核实
  const prelimReport: TaskReport = isA2a
    ? (() => {
        const h = findCommitHash(output);
        return {
          summary: (result.stdout ?? "").trim(),
          ...(h ? { hash: h } : {}),
        };
      })()
    : parseTaskReport(output);
  const providerError = findProviderError(output);
  const platformTokenUsage = sumAttemptTokenUsage(run.attempts);
  // 判据收紧到「**执行器根本没输出**」:2026-09-06 事故里 Pi 被 provider
  // 拒绝时 stdout 是**零字节**。「跑了但没给结构化汇报」是另一回事 ——
  // 限流退避、R9 次闸等既有路径本来就以 exit 0 + 无汇报 + 无 token 落 done。
  const zeroOutput =
    output.trim().length === 0 &&
    !hasStructuredTaskReport(prelimReport) &&
    hasZeroTokenUsage(platformTokenUsage);
  // ⚠️ 顺序与优先级(2026-09-07 回归实测):
  // 1) **额度判定优先**。额度失败常常就是 exit 0 + 零提交 + 零 token,
  //    零产出抢在前面会把它整类吞掉(实测 11 条既有用例转红)。
  // 2) **单凭 providerError 不判失败**。`[rate-limited] auto-continuing…`
  //    也命中提供方错误形状,而那类运行确实在干活、既有语义是落 done;
  //    拿它判死会吞掉 R6 主闸/R9 次闸整条路径。providerError 只作证据附注。
  if (zeroOutput && !successQuota.isQuota) {
    const zeroOutputCount = recordExecutorOutput(run.ex.key, zeroOutput);
    const reason = providerError
      ? `执行器服务商错误: ${providerError}`
      : "executor-no-output: 执行器零产出(无结构化汇报且 token 用量为零或不可得)";
    await handleFailure(run, reason, {
      retryable: false,
      message: `❌ [${ex.label}] 任务失败 (${reason})`,
      extra: {
        ...(zeroOutput ? { zeroOutput: true } : {}),
        ...(providerError ? { providerError } : {}),
      },
    });
    if (zeroOutputCount === 2) {
      await postStatus(
        db,
        groupId,
        participantId,
        ex,
        `⚠️ [${ex.label}] 连续零产出 2 次,疑似 provider 拒绝;请介入`,
      );
    }
    return;
  }
  recordExecutorOutput(run.ex.key, false);
  let quotaMatchedButCommitFound:
    | { matchedLine: string | null; note: string }
    | undefined;
  let quotaMatchedButTransient:
    | { matchedLine: string | null; note: string }
    | undefined;
  if (successQuota.isQuota) {
    // R9-a 次闸(必须):复用 classifyQuotaFailure 单点产出的 kind —— 瞬时限流(自愈退避)
    // 不单独构成结构证据,不判额度、不冷却、不退避,留痕区分「命中但被次闸掉」(验收 6)。
    if (successQuota.kind === "transient") {
      quotaMatchedButTransient = {
        matchedLine: successQuota.matchedLine,
        note: "输出尾部命中额度关键词,但为瞬时限流退避(短间隔自愈),按 quota-failure-on-clean-exit v1.2 R9-a 不判额度、不进入冷却",
      };
    } else {
      // R9-b 主闸(必须):可归因产出 = 汇报声明且经 verifyReportedCommit 核实的提交(可归因),
      // 不再以 checkpointRef..HEAD 全局计数作为产出(不可归因,共享工作树下与第三方提交无法区分)。
      const verification = await verifyReportedCommit(
        prelimReport.hash,
        repoRoot,
        run.attempts,
        isA2a ? "a2a" : "cli",
      );
      if (verification?.status === "verified") {
        quotaMatchedButCommitFound = {
          matchedLine: successQuota.matchedLine,
          note: "输出尾部命中额度关键词,但汇报声明提交且经核实(本次运行有可归因产出),按 quota-failure-on-clean-exit v1.2 R9-b 不判额度、不进入冷却",
        };
      } else {
        await routeQuotaFailure(run, "exit 0", successTail, successQuota);
        return;
      }
    }
  }
  // a2a 执行器(远端 participant)的回复就是最终交付内容,直接作为 summary,
  // 不做段落解析;hash 仍从输出提取。CLI 路径走结构化段落解析(票7)。
  // 复用 prelimReport,避免二次解析漂移
  const report: TaskReport = prelimReport;
  const diffSummary: Record<string, unknown> = Object.fromEntries(
    Object.entries(report).filter(([key]) => key !== "tokenUsage"),
  );
  // R6/R9 留痕:区分「未命中」/「命中但被次闸掉」/「命中但有可归因产出」(验收 6)
  if (quotaMatchedButCommitFound) {
    diffSummary.quotaMatchedButCommitFound = quotaMatchedButCommitFound;
  }
  if (quotaMatchedButTransient) {
    diffSummary.quotaMatchedButTransient = quotaMatchedButTransient;
  }
  // 汇报 commit 核实(spec verify-agent-claims v1.1):CLI 完成与 a2a 完成
  // 共用同一套 claim-verification 逻辑;cli 在任务实际仓库核实,a2a 本地
  // 无仓库 → 留下 status=skipped 的「未核实」痕迹(不再静默跳过)。
  const claimVerification = await verifyReportedCommit(
    report.hash,
    repoRoot,
    run.attempts,
    isA2a ? "a2a" : "cli",
  );
  if (claimVerification) {
    diffSummary.claimVerification = claimVerification;
  }
  if (run.retryCount > 0) diffSummary.retries = run.retryCount;
  // 完成回填:最近 500 行输出写进 diffSummary.outputTail(之后不依赖内存)。
  const doneTail = taskOutputTailLines(taskId);
  if (doneTail) diffSummary.outputTail = doneTail;
  const liveTail = liveTaskOutputTail(taskId);
  if (liveTail) diffSummary.liveOutputTail = liveTail;
  await endAttempt(run, {
    status: "done",
    summary: report.summary,
    hash: report.hash,
  });
  const tokenUsage = sumAttemptTokenUsage(run.attempts);
  if (tokenUsage !== undefined) diffSummary.tokenUsage = tokenUsage;
  const tokenUsageReason = sumAttemptTokenUsageReason(run.attempts);
  if (tokenUsageReason) diffSummary.tokenUsageReason = tokenUsageReason;
  // 经单一合并入口写入:以既有为底,result/metrics/scheduling 分所有者合并,
  // audit / relation 等他有键自动保留(spec diffsummary-ownership W2)。
  const curDone = await db.query.task.findFirst({
    where: and(eq(taskTable.id, taskId), eq(taskTable.groupId, groupId)),
    columns: { diffSummary: true },
  });
  const doneSummary = applyDiffSummaryPatch(curDone?.diffSummary, diffSummary);
  releaseTaskOutput(taskId);
  // 原路径 where 含 groupId;notify 默认 true。
  await writeTaskStatus(db, {
    taskId,
    groupId,
    status: "done",
    diffSummary: doneSummary,
  });
  console.log(
    `[executor] 任务完成: ${taskId}${
      report.hash ? ` hash=${report.hash}` : ""
    }${run.retryCount > 0 ? `(重试 ${run.retryCount} 次)` : ""}`,
  );
  await postStatus(
    db,
    groupId,
    participantId,
    ex,
    renderTaskCard(ex.label, report),
  );
}
