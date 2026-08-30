import {
  type DispatchPolicy,
  parseRateLimitRecoveryMs,
  type RetryPolicy,
  readDispatchPolicy,
} from "@server/lib/executors";
import { clearAllTaskDetails } from "./detail-store";
import { clearAllTaskOutputs } from "./output-buffer";
import type { QueuedRun, QuotaFailureKind } from "./types";

/**
 * 执行器触发链路的模块级状态(executor-task 拆分):组队列 / 并行槽位 /
 * 超时阈值 / 重试与额度配置 / 冷却登记。所有可变状态收敛在本文件,其余
 * 子模块(notify/output-buffer/queue/report)通过此处读写,保证跨模块
 * 状态一致;测试重置入口(__resetExecutorQueueForTests 等)也在此。
 */

/**
 * 按 project_path 分组的执行队列(模块级,票4):同一组键(project_path)的任务
 * 组内串行;不同组并行执行,并行组数上限 maxParallelGroups(dispatch-policy.json,
 * 默认 2;=1 时退化为全局串行)。组槽位空闲时 pumpQueue 取组内队首运行。
 */
export const groupQueues = new Map<string, import("./types").GroupQueue>();

/** All runs handed from a queue to runOne, including the pre-spawn window. */
export const activeRuns = new Set<import("./types").QueuedRun>();

/** 调度策略:启动时读取一次,所有阈值从同一快照取值,避免重复读盘与不一致。 */
const dispatchPolicy: DispatchPolicy = readDispatchPolicy();

/** 最大并行组数:server 启动时从 scripts/dispatch-policy.json 读取。 */
let maxParallelGroups = dispatchPolicy.maxParallelGroups;

/** 工作树并发上限:同一 projectPath 下同时 running 的任务数上限;启动时读取,
 *  缺省 1(同一工作树串行)。projectPath 为空的默认组不参与本闸(单槽不变)。 */
let maxConcurrentPerWorkspace = dispatchPolicy.maxConcurrentPerWorkspace;

/** 静默超时阈值(ms):running 连续无输出超过即失败;启动时读配置,缺省 30min。 */
let stallTimeoutMs = dispatchPolicy.stallTimeoutMinutes * 60_000;

/** 无进展提醒阈值(ms):running 连续无输出超过即提醒协调者(不失败);
 *  启动时读配置,缺省 15min。 */
let stallAlertMs = dispatchPolicy.stallAlertMinutes * 60_000;

/** 认领超时阈值(ms):queued 超过即失败;启动时读配置,缺省 30min。 */
let claimTimeoutMs = dispatchPolicy.claimTimeoutMinutes * 60_000;

/** A2A 无进展超时阈值(ms):running 的 A2A 任务连续无进展信号即失败;启动时
 *  读配置,缺省 30min。detached 任务不适用(等待执行器事后 PATCH)。 */
let a2aSilenceTimeoutMs = dispatchPolicy.a2aSilenceTimeoutMinutes * 60_000;

/** detached 超时阈值(ms):detached 任务发送后执行器超过该时长未 PATCH 回写
 *  终态 → 按「结果未确认」处理;启动时读配置,缺省 24h。 */
let detachedTimeoutMs = dispatchPolicy.detachedTimeoutMinutes * 60_000;

/** L3 应答超时阈值(ms):协调任务落 done 且带 review_request 后,检视者超过
 *  该时长未公布 review_result → 任务详情派生 l3.overdue=true;启动时读配置,
 *  缺省 120min。逾期只触发群提醒,不改变任务状态或替代检视者裁决。 */
let l3ResponseMinutes = dispatchPolicy.l3ResponseMinutes;

/** 失败重试策略:exit≠0/超时/静默失败后按此配置自动重试;启动时读配置。 */
let retryPolicy: RetryPolicy = dispatchPolicy.retry;

/** 额度/速率限制配置(票7):失败关键词 + 冷却时长;启动时读配置。 */
let rateLimitPatterns = dispatchPolicy.rateLimit.detectPatterns;
let rateLimitCooldownMs = dispatchPolicy.rateLimit.cooldownMinutes * 60_000;

/**
 * 瞬时限流的 per-run 退避时长(ms);null = 未配置 → 不启用瞬时处置
 * (spec transient-ratelimit-escalated-to-long-cooldown R5)。
 */
let transientBackoffMs = transientBackoffMsOf(
  dispatchPolicy.rateLimit.transientBackoffSeconds,
);

/** 同一 run 连续瞬时限流次数上限(达到即升级为 exhausted);null = 未配置。 */
let transientEscalationLimit = optionalPositiveInt(
  dispatchPolicy.rateLimit.transientEscalationLimit,
);

/** 瞬时限流配置:秒 → ms;未配置(null)保持 null(不启用瞬时处置)。 */
function transientBackoffMsOf(seconds: number | null): number | null {
  return seconds === null ? null : Math.max(1, Math.floor(seconds * 1_000));
}

/** 正整数才算配置(0 / 负数 / 非整数 = 未配置)。 */
function optionalPositiveInt(value: number | null): number | null {
  return value !== null && Number.isInteger(value) && value >= 1 ? value : null;
}

/**
 * 重派熔断阈值(票 quota-exhaustion R4):同一父任务名下**连续失败**子任务数达到
 * 该值后停止重派(兜底防线,与原因识别无关 —— 即使原因识别失败也必须熔断)。
 * 默认 5(建议值),启动时读配置;测试可覆盖。
 */
let redispatchFailureLimit = 5;

/**
 * 执行器额度冷却(票7):executorKey → 冷却结束时间(epoch ms)。运行时判定仍读
 * 此 Map;额度失败时同步写入 task.diffSummary,启动时由 queue 恢复未到期记录。
 */
export const executorCooldowns = new Map<string, number>();

/** 冷却结束定时器(executorKey → timer):到期清冷却并泵一次,让排队任务自动派发。 */
export const cooldownTimers = new Map<string, NodeJS.Timeout>();

/**
 * 额度判定的调用上下文(伪额度回显修复):只靠关键词命中不足以判额度 ——
 * 必须至少有一条结构证据:非零退出码 / 输出含真实恢复时刻 / 命中行呈提供方
 * 错误行形状。同时排除「自指」命中行:detectPatterns 定义本身与任务书回显。
 */
export interface QuotaFailureContext {
  /** 进程退出码;null/undefined = 未知(如孤儿收敛无退出码可取)。 */
  exitCode?: number | null;
  /** 任务书全文(回显排除):命中行若逐字出现在任务书里 → 视为回显,不计证据。 */
  taskBook?: string | null;
}

/** 额度判定结果:isQuota 为真时 matchedLine 为命中的原始行(安全截断)。 */
export interface QuotaFailureVerdict {
  isQuota: boolean;
  /** 命中的原始行(截断到 QUOTA_MATCHED_LINE_MAX 字符);非配额为 null。 */
  matchedLine: string | null;
  /** 分级(transient / exhausted);非配额为 null。 */
  kind: QuotaFailureKind | null;
}

/**
 * 瞬时限流的相对恢复时长上限(ms):解析出的恢复时长 ≤ 该值 → 供应方只是要求
 * 短暂退避(准确但很短),按 transient 处理;超过 → 按 exhausted 处理(保守)。
 *
 * 与 queue.ts 的 MIN_EFFECTIVE_COOLDOWN_MS 同值:二者是同一条边界的两面 ——
 * R7 把「解析值 ≤ 该窗口」当作形同虚设的冷却而回退固定冷却,本 spec 把同一个
 * 窗口识别为瞬时退避。二者必须同值,否则会出现「既不算瞬时、又被 R7 回退成
 * 5 小时冷却」的空档(spec transient-ratelimit-escalated-to-long-cooldown R1)。
 */
export const TRANSIENT_RECOVERY_MAX_MS = 60_000;

/**
 * 额度耗尽语义(命中任一即 exhausted,且**先于** transient 判定 —— 同时命中
 * 按 exhausted 处理,保守方向)。
 */
const EXHAUSTED_QUOTA_SHAPES: ReadonlyArray<RegExp> = [
  /\busage limit(?:ed)?\b/i,
  /\bwindow exhausted\b/i,
  /\bquota exceeded\b/i,
  /\blimit reached\b/i,
  /额度/,
  /次数限制/,
];

/** 绝对恢复时刻(`resets around HH:MM` / `try again at HH:MM`)→ 窗口耗尽。 */
const ABSOLUTE_RECOVERY_RE =
  /\bresets?\s*around\s+\d{1,2}:\d{2}\b|\btry again at\s+\d{1,2}:\d{2}/i;

/** 相对恢复时长(`try again in N seconds/minutes`)→ 供应方要求的短退避。 */
const RELATIVE_RECOVERY_RE = /\btry again in\s+(\d+)\s*(seconds?|minutes?)\b/i;

/** 瞬时退避动词:429 与 retry/backoff 类动词同时出现(且无耗尽关键词)→ 瞬时。 */
const TRANSIENT_RETRY_VERB_RE =
  /\b(?:retry|retrying|retried|backoff|back(?:ing)? off)\b/i;

/**
 * 额度失败分级(单点判定,调用方只读 kind):先 exhausted 后 transient;两者都
 * 不命中但确属额度(已有结构证据)→ 回落 exhausted(fail-safe:宁可长冷却也
 * 不要无限退避)。
 */
function classifyQuotaKind(line: string): QuotaFailureKind {
  const normalized = line.toLowerCase().replace(/-/g, " ");
  if (EXHAUSTED_QUOTA_SHAPES.some((re) => re.test(normalized))) {
    return "exhausted";
  }
  if (ABSOLUTE_RECOVERY_RE.test(normalized)) return "exhausted";
  const relative = RELATIVE_RECOVERY_RE.exec(normalized);
  if (relative) {
    const unitMs = relative[2].startsWith("minute") ? 60_000 : 1_000;
    return Number(relative[1]) * unitMs <= TRANSIENT_RECOVERY_MAX_MS
      ? "transient"
      : "exhausted";
  }
  if (/\b429\b/.test(normalized) && TRANSIENT_RETRY_VERB_RE.test(normalized)) {
    return "transient";
  }
  return "exhausted";
}

/** quotaMatchedLine 落库的最大长度(安全截断,避免超长 JSONL 行原样入 diffSummary)。 */
const QUOTA_MATCHED_LINE_MAX = 300;

/** 提供方错误行语义形状(逐行):命中行需呈现「报错/限流诊断」外观,而不是源码
 *  回显或文件名里的 quota 字样。与 CLI 无关,不写死任何执行器名。
 *   - error/fatal 前缀
 *   - [rate-limited] 等方括号限流标签
 *   - {"type":"error",...} JSON 错误事件(Codex 事故原文形态)
 *   - 限流/额度动词短语(rate limit exceeded / window exhausted / ...)
 *   - HTTP 状态码 429 / 5xx */
const PROVIDER_ERROR_LINE_SHAPES: ReadonlyArray<RegExp> = [
  /^\s*(?:error|fatal)\b/i,
  /^\s*\[(?:rate[- ]?limit(?:ed)?|quota|limit|429)\]/i,
  /"type"\s*:\s*"error"/i,
  /\b(?:rate[- ]?limit(?:ed)? exceeded|too many requests|window exhausted|quota exceeded|usage limit(?:ed)?|you'?ve hit your (?:usage|rate) limit|limit reached|exhausted)\b/i,
  /\b(?:HTTP\s*)?(?:429|5\d{2})\b/,
];

/** 是否「detectPatterns 定义」自指行:输出里出现配置定义本身(含 detectPatterns
 *  键名,或 ≥2 个引号包裹的关键词列表,形如 "usage limit", "rate limit", "quota")。
 *  这类行只是回显了模式表,不是执行器真遇到的额度报错。 */
function isDetectPatternsDefinitionLine(line: string): boolean {
  if (/\bdetectPatterns\b/i.test(line)) return true;
  const quoted = line.match(/"[^"]*"/g) ?? [];
  const patternHits = quoted.filter((q) =>
    rateLimitPatterns.some((p) => q.toLowerCase().includes(p.toLowerCase())),
  );
  return patternHits.length >= 2;
}

/** 是否任务书逐字回显(自指):命中行整行出现在任务书正文里 → 不算证据。
 *  只做「整行包含」判定(逐字回显),不抓长行里夹带的任务书片段。 */
function isTaskBookEcho(line: string, taskBook: string | null | undefined): boolean {
  if (!taskBook) return false;
  const trimmed = line.trim();
  return trimmed.length > 0 && taskBook.includes(trimmed);
}

/**
 * 额度失败判定(伪额度回显修复):对每行做「关键词命中 → 排除自指 → 结构证据」
 * 三段判定。结构证据至少满足一条才算额度:非零退出码(整次运行级)、命中行可
 * 解析出真实恢复时刻、命中行呈提供方错误行形状。仅关键词命中(如输出回显了
 * 含 quota 字样的源码/测试名/任务书)→ 不算额度,避免误冷却停派。
 *
 * 返回命中的原始行(截断),供 diffSummary.quotaMatchedLine 留痕;并给出分级
 * kind(瞬时限流 / 额度耗尽),供调用方分流(R1:分级收敛在本函数单点)。
 */
export function classifyQuotaFailure(
  texts: string[],
  ctx: QuotaFailureContext = {},
): QuotaFailureVerdict {
  const { exitCode, taskBook } = ctx;
  const nonzeroExit = typeof exitCode === "number" && exitCode !== 0;
  for (const raw of texts) {
    for (const rawLine of raw.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      const lower = line.toLowerCase();
      const normalized = lower.replace(/-/g, " ");
      if (
        !rateLimitPatterns.some(
          (p) => lower.includes(p.toLowerCase()) || normalized.includes(p.toLowerCase()),
        )
      ) {
        continue;
      }
      // 自指排除:detectPatterns 定义 / 任务书回显。
      if (isDetectPatternsDefinitionLine(line)) continue;
      if (isTaskBookEcho(line, taskBook)) continue;
      // 结构证据:非零退出码 / 真实恢复时刻 / 提供方错误行形状。
      const hasEvidence =
        nonzeroExit ||
        parseRateLimitRecoveryMs(line) !== null ||
        PROVIDER_ERROR_LINE_SHAPES.some((re) => re.test(line));
      if (hasEvidence) {
        return {
          isQuota: true,
          matchedLine: line.slice(0, QUOTA_MATCHED_LINE_MAX),
          kind: classifyQuotaKind(line),
        };
      }
    }
  }
  return { isQuota: false, matchedLine: null, kind: null };
}

/** 额度失败文本是否命中关键词(rate limit/quota/429/额度 等,大小写不敏感)。
 *  保持原签名(孤儿收敛等既有调用点不变);底层复用 classifyQuotaFailure 的
 *  结构证据判定(无退出码、无任务书时可退化为恢复时刻 / 错误行形状证据)。 */
export function isQuotaFailure(texts: string[]): boolean {
  return classifyQuotaFailure(texts).isQuota;
}

/** 格式化冷却结束时间(zh-CN 本地时间,与认领超时回传一致)。 */
export function formatEta(endMs: number): string {
  return new Date(endMs).toLocaleString("zh-CN");
}

/** 冷却结束时间(epoch ms);无冷却记录返回 0。 */
export function cooldownEndMs(ex: { key: string }): number {
  return executorCooldowns.get(ex.key) ?? 0;
}

/** 执行器是否处于额度冷却期。 */
export function isInCooldown(ex: { key: string }): boolean {
  return cooldownEndMs(ex) > Date.now();
}

/** 当前运行中的组数(组槽位占用数)。 */
export function runningGroupCount(): number {
  let n = 0;
  for (const g of groupQueues.values()) if (g.running.length > 0) n += 1;
  return n;
}

/**
 * 指定执行器当前 running 的任务数(跨所有组):执行器级并发上限(声明式
 * maxConcurrency)与反应式排队(403 后等待既有任务终态)的调度判定用。
 * 组内串行不变,但同一执行器在不同组可能各有 running —— 本函数按
 * executor key 聚合,供 pumpQueue 决定是否还能向该执行器派发。
 */
export function runningExecutorCount(exKey: string): number {
  let n = 0;
  for (const g of groupQueues.values()) {
    for (const r of g.running) {
      if (r.ex.key === exKey) n += 1;
    }
  }
  return n;
}

/**
 * 工作树维度当前 running 的任务数:同一 projectPath(群绑定项目路径)下跨
 * 所有组(不同群绑同一路径也计入同一闸)正在 running 的任务数;pumpQueue
 * 按 maxConcurrentPerWorkspace 上限判定是否还能向该工作树派发。projectPath
 * 为空 → 不参与本闸,恒返回 0(默认组由组内单槽维持原行为)。
 */
export function runningWorkspaceCount(projectPath: string | null): number {
  if (!projectPath) return 0;
  let n = 0;
  for (const g of groupQueues.values()) {
    for (const r of g.running) {
      if (r.projectPath === projectPath) n += 1;
    }
  }
  return n;
}

/** Test teardown visibility for the fire-and-forget runOne lifecycle. */
export function activeExecutorTaskCount(): number {
  return activeRuns.size;
}

/** pumpQueue 重入保护:并行启动多个组时,同一时刻只允许一个泵循环。 */
export let pumping = false;

/** pumpQueue 进入临界区(仅 queue.ts 内部调用)。 */
export function setPumping(value: boolean): void {
  pumping = value;
}

/** 读静默超时阈值(ms)。 */
export function getStallTimeoutMs(): number {
  return stallTimeoutMs;
}

/** 读无进展提醒阈值(ms)。 */
export function getStallAlertMs(): number {
  return stallAlertMs;
}

/** 读认领超时阈值(ms)。 */
export function getClaimTimeoutMs(): number {
  return claimTimeoutMs;
}

/** 读 A2A 无进展超时阈值(ms)。 */
export function getA2ASilenceTimeoutMs(): number {
  return a2aSilenceTimeoutMs;
}

/** 读 detached 超时阈值(ms)。 */
export function getDetachedTimeoutMs(): number {
  return detachedTimeoutMs;
}

/** 读 L3 应答超时阈值(ms)。 */
export function getL3ResponseMinutesMs(): number {
  return l3ResponseMinutes * 60_000;
}

/** 读最大并行组数。 */
export function getMaxParallelGroups(): number {
  return maxParallelGroups;
}

/** 读工作树并发上限。 */
export function getMaxConcurrentPerWorkspace(): number {
  return maxConcurrentPerWorkspace;
}

/** 读失败重试策略。 */
export function getRetryPolicy(): RetryPolicy {
  return retryPolicy;
}

/** 读额度冷却时长(ms)。 */
export function getRateLimitCooldownMs(): number {
  return rateLimitCooldownMs;
}

/**
 * 读瞬时限流处置配置(per-run 退避时长 + 连续升级上限);未配置 → null。
 *
 * null 时调用方必须回落 exhausted 语义(fail-safe:宁可长冷却也不要无限退避,
 * spec transient-ratelimit-escalated-to-long-cooldown R5/§7)。两个键缺一即
 * 视为未配置 —— 没有退避时长的退避、没有上限的退避都是半个机制。
 */
export function getTransientQuotaPolicy(): {
  backoffMs: number;
  escalationLimit: number;
} | null {
  if (transientBackoffMs === null || transientEscalationLimit === null) {
    return null;
  }
  return {
    backoffMs: transientBackoffMs,
    escalationLimit: transientEscalationLimit,
  };
}

/** 读重派熔断阈值(同一父任务连续失败子任务数上限)。 */
export function getRedispatchFailureLimit(): number {
  return redispatchFailureLimit;
}

/**
 * 取消单个 run 的认领/静默定时器(幂等;停止/完成/重置时调用)。
 *  detachedTimer 不在清理范围:detached 任务发送完成后 run 已离开队列,超时
 *  定时器需跨队列存活(等待执行器 PATCH,超时按结果未确认处理)。
 */
export function clearRunTimers(run: QueuedRun): void {
  if (run.claimTimer) {
    clearTimeout(run.claimTimer);
    run.claimTimer = null;
  }
  if (run.stallTimer) {
    clearTimeout(run.stallTimer);
    run.stallTimer = null;
  }
  if (run.stallAlertTimer) {
    clearTimeout(run.stallAlertTimer);
    run.stallAlertTimer = null;
  }
  if (run.a2aSilenceTimer) {
    clearTimeout(run.a2aSilenceTimer);
    run.a2aSilenceTimer = null;
  }
}

/**
 * 测试专用:终止全部运行中任务并清空所有组队列(模块级状态跨测试文件/用例
 * 共享,避免前一个用例残留的 running/queued 影响后续断言)。仅测试调用。
 */
export function __resetExecutorQueueForTests(): void {
  for (const g of groupQueues.values()) {
    for (const r of g.running) {
      r.stopped = true;
      r.kill?.();
      clearRunTimers(r);
    }
    for (const q of g.queue) clearRunTimers(q);
    g.queue.length = 0;
  }
  groupQueues.clear();
  clearAllTaskOutputs();
  clearAllTaskDetails();
  for (const t of cooldownTimers.values()) clearTimeout(t);
  cooldownTimers.clear();
  executorCooldowns.clear();
  const policy = readDispatchPolicy();
  maxParallelGroups = policy.maxParallelGroups;
  maxConcurrentPerWorkspace = policy.maxConcurrentPerWorkspace;
  stallTimeoutMs = policy.stallTimeoutMinutes * 60_000;
  stallAlertMs = policy.stallAlertMinutes * 60_000;
  claimTimeoutMs = policy.claimTimeoutMinutes * 60_000;
  a2aSilenceTimeoutMs = policy.a2aSilenceTimeoutMinutes * 60_000;
  detachedTimeoutMs = policy.detachedTimeoutMinutes * 60_000;
  l3ResponseMinutes = policy.l3ResponseMinutes;
  retryPolicy = policy.retry;
  rateLimitPatterns = policy.rateLimit.detectPatterns;
  rateLimitCooldownMs = policy.rateLimit.cooldownMinutes * 60_000;
  transientBackoffMs = transientBackoffMsOf(
    policy.rateLimit.transientBackoffSeconds,
  );
  transientEscalationLimit = optionalPositiveInt(
    policy.rateLimit.transientEscalationLimit,
  );
  redispatchFailureLimit = 5;
}

/** 测试专用:覆盖最大并行组数(默认读 scripts/dispatch-policy.json)。 */
export function __setMaxParallelGroupsForTests(n: number): void {
  maxParallelGroups = Math.max(1, Math.floor(n));
}

/** 测试专用:覆盖工作树并发上限(默认读 scripts/dispatch-policy.json)。
 *  =2 时同一 projectPath 允许两个并行;=1 恢复串行(改动前行为)。 */
export function __setMaxConcurrentPerWorkspaceForTests(n: number): void {
  maxConcurrentPerWorkspace = Math.max(1, Math.floor(n));
}

/**
 * 测试专用:覆盖静默/认领/A2A 无进展/detached 超时阈值(默认读
 * scripts/dispatch-policy.json,单位 ms)。测试用 100ms 级小阈值避免拖慢测试,
 * 与配置单位(分钟)无关。a2aSilence/detached 未显式传值时给 60s 兜底,避免
 * 既有测试(未关注新阈值)被意外触发。
 */
export function __setReliabilityTimeoutsForTests(
  stallMs: number,
  claimMs: number,
  stallAlertMsOverride?: number,
  a2aSilenceMsOverride?: number,
  detachedMsOverride?: number,
): void {
  stallTimeoutMs = Math.max(1, Math.floor(stallMs));
  claimTimeoutMs = Math.max(1, Math.floor(claimMs));
  // 默认提醒阈值取 stall 的 2 倍:不改变既有测试行为(静默在 stall 即失败,
  // 提醒不会先触发);需要验证提醒的测试显式传小阈值。
  stallAlertMs =
    stallAlertMsOverride !== undefined
      ? Math.max(1, Math.floor(stallAlertMsOverride))
      : Math.max(1, Math.floor(stallMs)) * 2;
  a2aSilenceTimeoutMs =
    a2aSilenceMsOverride !== undefined
      ? Math.max(1, Math.floor(a2aSilenceMsOverride))
      : Math.max(60_000, Math.floor(stallMs));
  detachedTimeoutMs =
    detachedMsOverride !== undefined
      ? Math.max(1, Math.floor(detachedMsOverride))
      : Math.max(60_000, Math.floor(stallMs));
}

/** 测试专用:覆盖 L3 应答超时阈值(默认读 scripts/dispatch-policy.json,单位
 * 分钟;=1 时退化为 1 分钟,测试用 1 分钟级小阈值验证 overdue 派生)。 */
export function __setL3ResponseMinutesForTests(minutes: number): void {
  l3ResponseMinutes = Math.max(1, Math.floor(minutes));
}

/**
 * 测试专用:覆盖额度配置(关键词 + 冷却时长,单位 ms——与配置的分钟单位解耦,
 * 测试用 100ms~1s 级小阈值验证冷却拦截与自动恢复,避免拖慢测试)。
 */
export function __setRateLimitForTests(
  cooldownMs: number,
  patterns: string[],
): void {
  rateLimitCooldownMs = Math.max(1, Math.floor(cooldownMs));
  rateLimitPatterns = [...patterns];
}

/**
 * 测试专用:覆盖瞬时限流处置配置(per-run 退避时长 ms + 连续升级上限)。
 * 传 null(或非法值)即「未配置」→ getTransientQuotaPolicy() 返回 null,
 * 调用方回落 exhausted 语义(fail-safe,验收 9)。
 */
export function __setTransientQuotaForTests(
  backoffMs: number | null,
  escalationLimit: number | null,
): void {
  transientBackoffMs =
    backoffMs !== null && Number.isFinite(backoffMs) && backoffMs > 0
      ? Math.floor(backoffMs)
      : null;
  transientEscalationLimit = optionalPositiveInt(escalationLimit);
}
