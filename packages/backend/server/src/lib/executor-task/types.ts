import type { TaskAttempt } from "@laizhixingxingdeli/database/schema";
import type { DataBase } from "@server/lib/database";
import type { ExecutorConfig } from "@server/lib/executors";

/**
 * 执行器触发链路共享类型(executor-task 拆分):队列条目 / 组队列 / 输入 /
 * 分工信息 / 汇报结构。与拆分前 lib/executor-task.ts 中的定义逐字一致。
 */

/** 与桥 EXEC_ALLOWED_ROLES 一致:只有 coordinator / human 能发布任务。 */
export const EXEC_ALLOWED_ROLES = ["coordinator", "human"] as const;

export interface DispatchExecutorInput {
  groupId: string;
  messageId: string;
  senderRoles: string[];
  /** audienceRef = 被 @ 的 participant id(即执行器 participant 身份)。 */
  audienceRef: string;
  body: string;
}

/** 群内分工信息(角色解绑后):成员在本群的角色集 + 分工提示词,拼进任务书。 */
export interface GroupPromptInfo {
  roles: string[];
  prompt: string;
}

/** 队列条目:一次待执行/执行中的运行。 */
export interface QueuedRun {
  db: DataBase;
  groupId: string;
  messageId: string;
  taskId: string;
  participantId: string;
  ex: ExecutorConfig;
  body: string;
  summary: string;
  /** 群内分工(角色解绑后);成员在本群无 prompt 时为 null,任务书不含该段。 */
  groupPrompt: GroupPromptInfo | null;
  /** 组键:群 project_path(空 → DEFAULT_GROUP_KEY),分组串行/并行用。 */
  groupKey: string;
  /** 群绑定的项目路径(spawn cwd/快照仓库用);未绑定为 null。 */
  projectPath: string | null;
  /** 运行中句柄的 kill(停止指令用);spawn 前为 null。 */
  kill: (() => void) | null;
  /** 停止指令已终止本任务(完成回调不再回传 ❌,改置 cancelled)。 */
  stopped: boolean;
  /** 入队时间(ms,认领超时起点;重新执行的任务以本次入队时间为准)。 */
  createdAt: number;
  /** 进入 running 的时间(ms);尚未开始为 null。 */
  runningAt: number | null;
  /** 最近一次 stdout/stderr 输出的时间(ms);静默检测用。 */
  lastOutputAt: number;
  /** A2A 最近进展时间(ms):任务 running 起点置位,执行器 participant 在群里
   *  发的消息(进度信号)刷新;A2A 无进展超时 / 请求超时判定用。 */
  lastActivityAt: number;
  /** 认领超时定时器(入队时调度,进入 running 时取消)。 */
  claimTimer: NodeJS.Timeout | null;
  /** 静默超时定时器(spawn 时调度,每次输出重排);a2a 无本地进程不调度。 */
  stallTimer: NodeJS.Timeout | null;
  /** 无进展提醒定时器(spawn 时调度,每次输出重排);先于 stallTimer 触发,
   *  只发提醒消息 + 警示标记,不失败。 */
  stallAlertTimer: NodeJS.Timeout | null;
  /** A2A 无进展超时定时器(running 时调度,进度消息重排);触发 → a2aSilenced
   *  + 中止在途请求,失败由完成路径统一处理。detached 任务不调度。 */
  a2aSilenceTimer: NodeJS.Timeout | null;
  /** detached 超时定时器(detached 任务发送完成后调度,等待执行器 PATCH 回写
   *  终态);触发 → 按「结果未确认」处理。独立于 clearRunTimers,跨队列存活。 */
  detachedTimer: NodeJS.Timeout | null;
  /** 静默超时已触发(完成回调不再重复回传 ❌)。 */
  stalled: boolean;
  /** 无进展提醒已发送(避免重复提醒)。 */
  stallAlerted: boolean;
  /** A2A 无进展超时已触发(完成回调按「无进展失败」处理,不再回传 ❌)。 */
  a2aSilenced: boolean;
  /** 任务书标记了 ReplyMode: detached(A2A 发送后保持 running,等执行器
   *  PATCH 回写终态;不设静默/无进展超时)。 */
  detached: boolean;
  /** detached 超时已触发(避免重复按结果未确认处理)。 */
  detachedTimedOut: boolean;
  /** 已自动重试次数(失败重试用;重试前回滚 checkpoint、重新入队重跑)。 */
  retryCount: number;
  /** 执行前 git 快照 ref(重试回滚/弱验收对比用);a2a 无快照为 null。 */
  checkpointRef: string | null;
  /** 执行历史(attempt 时间线):spawn 前 append running,结束时补 endedAt/status。 */
  attempts: TaskAttempt[];
}

/** 未绑定项目路径(project_path 为空)的群任务归入默认组。 */
export const DEFAULT_GROUP_KEY = "__default__";

/** 单个 project_path 的组队列:组内串行 FIFO,不同组并行(受组槽位数限制)。 */
export interface GroupQueue {
  key: string;
  queue: QueuedRun[];
  running: QueuedRun | null;
}
