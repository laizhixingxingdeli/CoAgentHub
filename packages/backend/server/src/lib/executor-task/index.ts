/**
 * 执行器触发链路(executor-task 拆分 barrel):原 lib/executor-task.ts
 * (约 2000 行)按职责拆分为 types / state / output-buffer / notify / report /
 * queue 六个子模块,本文件汇总全部公共导出,`@server/lib/executor-task`
 * 导入路径与导出面保持完全兼容(测试直接 import __resetExecutorQueueForTests
 * 等成员,继续可用)。
 *
 * 职责划分:
 *  - ansi.ts        ANSI 转义序列剥离(流式跨 chunk 扣尾;report 与输出路径共用)
 *  - completion-recipient.ts 完成事件收件人裁定(R1:载荷决定投递对象)
 *  - types.ts        共享类型(队列条目 / 组队列 / 输入 / 分工 / 汇报结构)
 *  - state.ts        模块级可变状态(组队列 / 超时阈值 / 重试与额度配置 /
 *                    冷却登记)+ 测试重置入口
 *  - output-buffer.ts 实时输出缓冲(环形 tail)
 *  - notify.ts       状态通知(task_status_changed WS 推送 / 状态回传 / cancelled)
 *  - report.ts       结构化汇报解析与渲染(parseTaskReport / renderTaskCard)
 *  - queue.ts        队列核心(入队 / 组调度 / 运行 / 停止 / 超时 / 重试 /
 *                    弱验收 / 执行历史 / 测试执行器选择)
 *  - queued-task-reclaim.ts queued 任务周期兜底(链条失败/重启后遗留的排队
 *                    任务补回队列、不可拾起原因可见、超阈值按 stall 告警)
 */

export {
  isTerminalTaskStatus,
  recordCoordinationActivity,
} from "../coordination-activity";
export { createAnsiStripper, stripAnsi } from "./ansi";
export {
  adjudicatedRecipientsOfTask,
  dispatcherRecipients,
  reviewerMemberIds,
  reviewRequestRecipients,
  sameRecipients,
} from "./completion-recipient";
export {
  type CloseGuardBlockedChild,
  type CloseGuardResumeMarker,
  type CloseGuardResumeState,
  consumePendingCompletionEvents,
  deriveCloseGuardResume,
  hasExemptingChildTask,
  hasPendingCloseGuardResume,
  hasPendingResumeEvent,
  inferSupersedesTaskId,
  isResumeTask,
  maybeCreateCoordinatorResumeTask,
  readCloseGuardResume,
  registerCloseGuardResume,
  startCoordinatorResumeConsumer,
} from "./coordinator-resume";
export {
  appendTaskDetail,
  cleanupExpiredTaskDetails,
  clearAllTaskDetails,
  findTaskDetail,
  readTaskDetail,
  type StoredTaskDetail,
  taskDetailFilePath,
} from "./detail-store";
export { notifyTaskStatusChanged, postStatus } from "./notify";
export {
  appendLiveTaskOutput,
  liveTaskOutputTail,
  releaseLiveTaskOutput,
  taskOutputTail,
} from "./output-buffer";
export {
  createExecutorOutputParser,
  type ExecutorOutputParser,
  getCodexSkippedEventCounts,
  getGenericSkippedEventCounts,
  type OutputEntry,
  type OutputEntryKind,
  resetCodexSkippedEventCounts,
  resetGenericSkippedEventCounts,
} from "./output-parser";
export {
  backfillDetachedClosedTokenFields,
  buildTicket,
  cancelQueuedTasks,
  cancelRunningTasks,
  clearExecutorCooldown,
  createTaskDispatchWarnings,
  currentRunningTask,
  enqueueTaskRun,
  executionApiBase,
  formatExecutorStartupFailure,
  isConcurrencyConflict,
  isCoordinatorTask,
  isExecutorProcessAlive,
  isReviewerNotDispatchableTarget,
  liveStreamText,
  maybeDispatchExecutorTask,
  queuedExecutorTaskCount,
  recoverInterruptedTasks,
  refreshA2AActivity,
  resolveTaskRepo,
  resolveTestExecutor,
  restoreExecutorCooldowns,
  spawnFailureHint,
  summaryStreamText,
} from "./queue";
export {
  type QueuedReclaimResult,
  reclaimQueuedTasks,
  startQueuedTaskReclaim,
} from "./queued-task-reclaim";
export {
  DISPATCH_INTENT_RECLAIM_GRACE_MS,
  dispatchAndSettleIntent,
  dispatchInputFromIntent,
  findDispatchIntentByMessage,
  type IntentReclaimResult,
  payloadFromDispatchInput,
  reclaimDispatchIntents,
  recordDispatchIntentFailure,
  settleDispatchIntentAfterAttempt,
  writeDispatchIntent,
} from "./dispatch-intent";
export {
  extractCodeBuddyStreamResult,
  extractGenericJsonlText,
  parseTaskReport,
  renderTaskCard,
  type TaskReport,
} from "./report";
export {
  groupHasReviewerMember,
  reviewRequestCarryAllowed,
} from "./review-request-policy";
export {
  loadTicketTemplate,
  resolveTicketTemplatesDir,
  type TicketRole,
  type TicketTemplate,
} from "./ticket-template";
export {
  __resetExecutorQueueForTests,
  __setL3ResponseMinutesForTests,
  __setMaxConcurrentPerWorkspaceForTests,
  __setMaxParallelGroupsForTests,
  __setMaxRetriesForTests,
  __setRateLimitForTests,
  __setReliabilityTimeoutsForTests,
  activeExecutorTaskCount,
  getL3ResponseMinutesMs,
} from "./state";
export {
  collectTokenUsage,
  extractCodexExecText,
  type TokenUsage,
  type TokenUsageCollectionInput,
  type TokenUsageReason,
  type TokenUsageResult,
} from "./token-usage";
export {
  applyDiffSummaryPatch,
  applyDiffSummaryPatchAllowingClear,
  DIFF_SUMMARY_KEY_OWNERS,
  type DiffSummaryOwner,
  mergeDiffSummary,
  ownerOfDiffSummaryKey,
  PLATFORM_KEY_OWNERS,
} from "./diff-summary";
export {
  DISPATCH_ALLOWED_ROLES,
  type DispatchExecutorInput,
  type GroupPromptInfo,
  mergePlatformTokenFields,
  preserveDispatchKindNote,
  preserveRollbackSkipped,
  sumAttemptTokenUsage,
  sumAttemptTokenUsageReason,
} from "./types";
