/**
 * 执行器触发链路(executor-task 拆分 barrel):原 lib/executor-task.ts
 * (约 2000 行)按职责拆分为 types / state / output-buffer / notify / report /
 * queue 六个子模块,本文件汇总全部公共导出,`@server/lib/executor-task`
 * 导入路径与导出面保持完全兼容(测试直接 import __resetExecutorQueueForTests
 * 等成员,继续可用)。
 *
 * 职责划分:
 *  - types.ts        共享类型(队列条目 / 组队列 / 输入 / 分工 / 汇报结构)
 *  - state.ts        模块级可变状态(组队列 / 超时阈值 / 重试与额度配置 /
 *                    冷却登记)+ 测试重置入口
 *  - output-buffer.ts 实时输出缓冲(环形 tail)
 *  - notify.ts       状态通知(task_status_changed WS 推送 / 状态回传 / cancelled)
 *  - report.ts       结构化汇报解析与渲染(parseTaskReport / renderTaskCard)
 *  - queue.ts        队列核心(入队 / 组调度 / 运行 / 停止 / 超时 / 重试 /
 *                    弱验收 / 执行历史 / 测试执行器选择)
 */

export { notifyTaskStatusChanged, postStatus } from "./notify";
export { taskOutputTail } from "./output-buffer";
export {
  currentRunningTask,
  maybeDispatchExecutorTask,
  queuedExecutorTaskCount,
  recoverInterruptedTasks,
  refreshA2AActivity,
  resolveTestExecutor,
  stopRunningTask,
  verifyTaskCommitted,
} from "./queue";
export { parseTaskReport, renderTaskCard, type TaskReport } from "./report";
export {
  __resetExecutorQueueForTests,
  __setMaxParallelGroupsForTests,
  __setRateLimitForTests,
  __setReliabilityTimeoutsForTests,
} from "./state";
export {
  type DispatchExecutorInput,
  EXEC_ALLOWED_ROLES,
  type GroupPromptInfo,
} from "./types";
