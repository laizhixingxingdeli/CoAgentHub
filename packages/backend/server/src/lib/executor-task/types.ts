import type { TaskAttempt } from "@laizhixingxingdeli/database/schema";
import type { DataBase } from "@server/lib/database";
import type { ExecutorConfig } from "@server/lib/executors";
import type { TokenUsage, TokenUsageReason } from "./token-usage";

/**
 * 执行器触发链路共享类型(executor-task 拆分):队列条目 / 组队列 / 输入 /
 * 分工信息 / 汇报结构。与拆分前 lib/executor-task.ts 中的定义逐字一致。
 */

/** 下发门角色门槛(与桥 EXEC_ALLOWED_ROLES 同语义):coordinator / human /
 *  reviewer 能发布任务(human 禁言后需求下发由 reviewer 代发)。与 control.ts
 *  的 CONTROL_ALLOWED_ROLES 分开维护——语义不同:前者管下发,后者管停止/回滚。 */
export const DISPATCH_ALLOWED_ROLES = [
  "coordinator",
  "human",
  "reviewer",
] as const;

export interface DispatchExecutorInput {
  groupId: string;
  messageId: string;
  senderRoles: string[];
  /** 消息投递范围:缺省 "participant"(既有路径逐字不变,audienceRef =
   *  participant id);"role" = 角色定向(R1,audienceRef = 角色名,派发层
   *  按角色解析本群目标成员后走同一 dispatchTask 流程)。 */
  audience?: "participant" | "role";
  /** audienceRef = 被 @ 的 participant id(即执行器 participant 身份);
   *  audience="role" 时 = 目标角色名。 */
  audienceRef: string;
  body: string;
  /** 任务下发者(Part A):消息发送者 participant(服务端识别,请求体不可伪造)。 */
  dispatcherParticipantId: string;
  /** 任务下发会话(Part A):仅群内角色命中 DISPATCH_ALLOWED_ROLES
   *  的发送者携带的 metadata.dispatcherSessionId;否则为 null。绝不从 body 解析。 */
  dispatcherSessionId: string | null;
  /** 调用方主动提供的目标选择理由;未提供时审计记录为 null。 */
  selectionReason?: string | null;
  /** 规范驱动下发:任务携带的规范文档路径(如 `specs/login-v2.md`),任务书
   *  模板据此插入「关联规范」段;null = 指令驱动任务,行为与旧版一致。 */
  specRef: string | null;
  /** 规范文档的 Git Hash(版本快照,审计用);无版本哈希时为 null。 */
  specHash: string | null;
  /** 规范驱动下发类型:需求票或修复票;null = 指令驱动任务。 */
  dispatchKind: "requirement" | "fix" | null;
  /** 替代关系(executor-switch-task-identity R2):本任务替代 supersedesTaskId
   *  所指的那次尝试(同一工作项的先后尝试,如换执行器重发);null = 不替代任何
   *  任务。指向的任务必须属于同一群组(路由层 400),不校验其终态。 */
  supersedesTaskId: string | null;
  /** callback 路由信息(Part B):仅允许 { platform?, endpointRef?, sessionRef? }
   *  三个短字符串(≤200 字符),不得存 URL/token/命令/secret。null = 无 callback。 */
  callbackRef: {
    platform?: string;
    endpointRef?: string;
    sessionRef?: string;
  } | null;
  /** R2 缺省审计:findings 未显式指定 dispatchKind 而缺省为 fix 时的 diffSummary 留痕 */
  initialDiffSummary?: Record<string, unknown> | null;
}

/** 群内分工信息(角色解绑后):成员在本群的角色集 + 可选分工提示词。 */
export interface GroupPromptInfo {
  roles: string[];
  prompt: string | null;
}

/**
 * maybeDispatchExecutorTask 的可观察结果:角色定向(R1)失败时返回明确原因,
 * 调用方(消息路由)可据此发出可见信号(响应头),不再静默跳过;成功与
 * participant 路径返回 undefined(行为逐字不变)。
 */
export type DispatchOutcome =
  | { status: "dispatched"; participantId: string }
  | { status: "redispatch-stopped"; parentTaskId: string }
  | {
      status: "role-unresolved";
      reason: "role-not-legal" | "role-no-member" | "role-no-executor";
      role: string;
    };

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
  /** 规范驱动下发:规范文档路径(任务书「关联规范」段用);null = 指令驱动。 */
  specRef: string | null;
  /** 规范文档版本哈希(任务书「关联规范」段用);无版本哈希为 null。 */
  specHash: string | null;
  /** 规范驱动下发类型(任务书「汇报格式要求」段裁定 review_request 是否可携带
   *  用,与 tasks.ts R3 守卫共用判定);null = 指令驱动任务。 */
  dispatchKind: "requirement" | "fix" | null;
  /**
   * 反应式排队标记(403 后排队):执行器返回 `403 atomgit_session_concurrency_conflict`
   * 后由 handleConcurrencyConflict 置位并重新入队 —— pump 在该执行器仍有其他
   * running 任务(或退避窗口未过)时不再派发,等既有任务终态后自动重试。
   * 无 maxConcurrency 配置的执行器走此路径;显式配置的执行器由 isRunDispatchable
   * 直接按上限排队,不会置位本标记。
   */
  concurrencyBlocked: boolean;
  /**
   * 403 后最早重试时刻(epoch ms;0 = 未设置):避免「无既有 running 任务但执行器
   * 仍被外部会话占用」时立即重派形成空转热循环。重试由 handleConcurrencyConflict
   * 调度的退避定时器(或既有 running 任务终态后的泵送)触发。
   */
  concurrencyRetryAt: number;
  /**
   * 同一 run 连续被判「瞬时限流」的次数(spec transient-ratelimit-escalated-to-
   * long-cooldown R2):达到 transientEscalationLimit 的那一次升级为耗尽处理
   * (防 per-run 退避死循环);非瞬时限流的失败出口(handleFailure)归零,
   * 保证计数是「连续」而非「累计」。
   */
  transientQuotaCount: number;
  /** 执行历史(attempt 时间线):spawn 前 append running,结束时补 endedAt/status。 */
  attempts: TaskAttempt[];
}

/**
 * 额度失败分级(spec transient-ratelimit-escalated-to-long-cooldown R1):
 *  - `transient`:供应方要求短退避(如 `try again in 5 seconds`)—— 解析准确但
 *    时长很短,走 QueuedRun 的 per-run 退避重试,**不进执行器级冷却**;
 *  - `exhausted`:额度/窗口耗尽(恢复时刻是绝对时刻,或相对时长超过瞬时分界)
 *    —— 既有冷却路径逐字不变。
 * 分级由 classifyQuotaFailure 单点产出,调用方只读 kind,不得自行判定。
 */
export type QuotaFailureKind = "transient" | "exhausted";

export type { TokenUsage, TokenUsageReason } from "./token-usage";

/** Sum platform-collected token usage across attempts. */
export function sumAttemptTokenUsage(
  attempts: readonly TaskAttempt[],
): TokenUsage | null | undefined {
  const usages = attempts
    .map((attempt) => attempt.tokenUsage)
    .filter(
      (usage): usage is TokenUsage =>
        usage !== null && typeof usage === "object",
    );
  if (usages.length === 0) {
    return attempts.some((attempt) => "tokenUsage" in attempt)
      ? null
      : undefined;
  }
  const source = usages.every((usage) => usage.source === usages[0].source)
    ? usages[0].source
    : "mixed";
  return {
    inputTokens: usages.reduce((sum, usage) => sum + usage.inputTokens, 0),
    outputTokens: usages.reduce((sum, usage) => sum + usage.outputTokens, 0),
    cachedInputTokens: usages.reduce(
      (sum, usage) => sum + (usage.cachedInputTokens ?? 0),
      0,
    ),
    totalTokens: usages.reduce((sum, usage) => sum + usage.totalTokens, 0),
    source,
  };
}

export function sumAttemptTokenUsageReason(
  attempts: readonly TaskAttempt[],
): TokenUsageReason | undefined {
  const reasons = attempts
    .map((attempt) => attempt.tokenUsageReason)
    .filter((reason): reason is TokenUsageReason => reason !== undefined);
  if (reasons.length === 0) return undefined;
  return reasons.every((reason) => reason === reasons[0])
    ? reasons[0]
    : "unavailable";
}

/** diffSummary 归一化:JSON 列可能是 null / 数组 / 基本类型,只有对象是有效载荷。 */
export function asDiffSummaryRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * R2 缺省留痕跨生命周期保留(spec findings-ticket-hardcoded-to-fix-bypasses-l3
 * R2 的审计口径):任何 diffSummary 覆盖都不得丢失既有 dispatchKindNote。
 * 三条生命周期路径(队列内回填/取消落库、PATCH /tasks 结案)共用此单点,
 * 禁止各自内联副本:
 *
 * - existing 不可解析为 record(null/数组/标量)→ 安全不写,原样返回 next;
 * - existing 有 note 且 next 缺该键 → 以旧值补写(原地变更,返回 next);
 * - next 已显式含该键(含 null)→ 以新值为准,保留规则的唯一出口。
 *
 * 无需保留时原样返回入参(引用相等),调用方据此判断是否需要落库。
 */
export function preserveDispatchKindNote(
  existing: unknown,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const prev = asDiffSummaryRecord(existing);
  if (prev?.dispatchKindNote && !Object.hasOwn(next, "dispatchKindNote")) {
    next.dispatchKindNote = prev.dispatchKindNote;
  }
  return next;
}

/**
 * 外来提交防护留痕的跨生命周期保留(spec retry-rollback-must-not-destroy-foreign-
 * commits R2):任何 diffSummary 覆盖都不得丢失既有 rollbackSkipped 留痕。
 * 与 preserveDispatchKindNote 同款单点口径,共用三条生命周期路径(队列内
 * 回填/取消落库、PATCH /tasks 结案),禁止各自内联副本:
 *
 * - existing 不可解析为 record(null/数组/标量)→ 安全不写,原样返回 next;
 * - existing 有留痕且 next 缺该键 → 以旧值补写(原地变更,返回 next);
 * - next 已显式含该键(含 null)→ 以新值为准,保留规则的唯一出口。
 *
 * 无需保留时原样返回入参(引用相等),调用方据此判断是否需要落库。
 */
export function preserveRollbackSkipped(
  existing: unknown,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const prev = asDiffSummaryRecord(existing);
  if (prev?.rollbackSkipped && !Object.hasOwn(next, "rollbackSkipped")) {
    next.rollbackSkipped = prev.rollbackSkipped;
  }
  return next;
}

/**
 * 平台采集的 token 字段并入 diffSummary(spec token-fields-clobbered-by-close
 * R1/R2),PATCH 结案与 detached 采集落库两条写入链共用同一口径:
 *
 * - summary 已含该键(含显式 null)→ 以调用方为准,不覆盖(R2);
 * - summary 不含该键 → 写平台值:优先取既有 diffSummary(平台完成回填的结果),
 *   缺失时回落到 attempts 采集口径(sumAttemptToken*;undefined 不写)。
 *
 * 未改动时原样返回入参(引用相等),调用方据此判断是否需要落库。
 */
export function mergePlatformTokenFields(
  summary: Record<string, unknown>,
  platform: {
    /** 既有的 diffSummary(平台完成回填的落点);null/非对象视为无。 */
    existing?: unknown;
    /** 采集结果(attempts 时间线);缺省空数组。 */
    attempts?: readonly TaskAttempt[];
  },
): Record<string, unknown> {
  const existing = asDiffSummaryRecord(platform.existing);
  const attempts = platform.attempts ?? [];
  // diffSummary 里已有该键时它就是平台完成回填的结果,不再回到 attempts。
  const tokenUsage =
    existing && Object.hasOwn(existing, "tokenUsage")
      ? existing.tokenUsage
      : sumAttemptTokenUsage(attempts);
  const tokenUsageReason =
    existing && Object.hasOwn(existing, "tokenUsageReason")
      ? existing.tokenUsageReason
      : sumAttemptTokenUsageReason(attempts);
  let next = summary;
  if (!Object.hasOwn(next, "tokenUsage") && tokenUsage !== undefined) {
    next = { ...next, tokenUsage };
  }
  if (!Object.hasOwn(next, "tokenUsageReason") && tokenUsageReason) {
    next = { ...next, tokenUsageReason };
  }
  return next;
}

/** 未绑定项目路径(project_path 为空)的群任务归入默认组。 */
export const DEFAULT_GROUP_KEY = "__default__";

/** 单个 project_path 的组队列:组内 FIFO,不同组并行(受组槽位数限制)。
 *  running 为当前运行中任务列表(同一工作树并行数 ≤ maxConcurrentPerWorkspace,
 *  缺省 1 = 组内串行;projectPath 为空的默认组始终单槽,不参与工作树闸)。 */
export interface GroupQueue {
  key: string;
  queue: QueuedRun[];
  running: QueuedRun[];
}
