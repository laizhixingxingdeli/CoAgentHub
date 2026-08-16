import {
  type DispatchPolicy,
  type RetryPolicy,
  readDispatchPolicy,
} from "@server/lib/executors";
import { clearAllTaskOutputs } from "./output-buffer";
import type { QueuedRun } from "./types";

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

/** 调度策略:启动时读取一次,所有阈值从同一快照取值,避免重复读盘与不一致。 */
const dispatchPolicy: DispatchPolicy = readDispatchPolicy();

/** 最大并行组数:server 启动时从 scripts/dispatch-policy.json 读取。 */
let maxParallelGroups = dispatchPolicy.maxParallelGroups;

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

/** 失败重试策略:exit≠0/超时/静默失败后按此配置自动重试;启动时读配置。 */
let retryPolicy: RetryPolicy = dispatchPolicy.retry;

/** 额度/速率限制配置(票7):失败关键词 + 冷却时长;启动时读配置。 */
let rateLimitPatterns = dispatchPolicy.rateLimit.detectPatterns;
let rateLimitCooldownMs = dispatchPolicy.rateLimit.cooldownMinutes * 60_000;

/**
 * 执行器额度冷却(票7,内存态):executorKey → 冷却结束时间(epoch ms)。重启
 * 丢失可接受(重启后冷却失效,任务按普通状态恢复)。
 */
export const executorCooldowns = new Map<string, number>();

/** 冷却结束定时器(executorKey → timer):到期清冷却并泵一次,让排队任务自动派发。 */
export const cooldownTimers = new Map<string, NodeJS.Timeout>();

/** 额度失败文本是否命中关键词(rate limit/quota/429/额度 等,大小写不敏感)。 */
export function isQuotaFailure(texts: string[]): boolean {
  const haystack = texts.join("\n").toLowerCase();
  return rateLimitPatterns.some((p) => haystack.includes(p.toLowerCase()));
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
  for (const g of groupQueues.values()) if (g.running) n += 1;
  return n;
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

/** 读最大并行组数。 */
export function getMaxParallelGroups(): number {
  return maxParallelGroups;
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
    if (g.running) {
      g.running.stopped = true;
      g.running.kill?.();
      clearRunTimers(g.running);
    }
    for (const q of g.queue) clearRunTimers(q);
    g.queue.length = 0;
  }
  groupQueues.clear();
  clearAllTaskOutputs();
  for (const t of cooldownTimers.values()) clearTimeout(t);
  cooldownTimers.clear();
  executorCooldowns.clear();
  const policy = readDispatchPolicy();
  maxParallelGroups = policy.maxParallelGroups;
  stallTimeoutMs = policy.stallTimeoutMinutes * 60_000;
  stallAlertMs = policy.stallAlertMinutes * 60_000;
  claimTimeoutMs = policy.claimTimeoutMinutes * 60_000;
  a2aSilenceTimeoutMs = policy.a2aSilenceTimeoutMinutes * 60_000;
  detachedTimeoutMs = policy.detachedTimeoutMinutes * 60_000;
  retryPolicy = policy.retry;
  rateLimitPatterns = policy.rateLimit.detectPatterns;
  rateLimitCooldownMs = policy.rateLimit.cooldownMinutes * 60_000;
}

/** 测试专用:覆盖最大并行组数(默认读 scripts/dispatch-policy.json)。 */
export function __setMaxParallelGroupsForTests(n: number): void {
  maxParallelGroups = Math.max(1, Math.floor(n));
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
