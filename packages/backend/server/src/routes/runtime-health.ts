import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import {
  getA2ASilenceTimeoutMs,
  getClaimTimeoutMs,
  getDetachedTimeoutMs,
  getL3ResponseMinutesMs,
  getMaxConcurrentPerWorkspace,
  getMaxParallelGroups,
  getRateLimitCooldownMs,
  getRedispatchFailureLimit,
  getRetryPolicy,
  getStallAlertMs,
  getStallTimeoutMs,
  getTransientQuotaPolicy,
  // 直接引 state 而不是 barrel:这些 getter 大多没在 barrel 再导出,而
  // routes/group/tasks.ts 早有同款直引先例 —— 不为一个只读端点扩大公开面。
} from "../lib/executor-task/state";
import { getDispatchPolicyOrigin } from "../lib/executors";
import { getRuntimeStatus } from "../lib/runtime-status";

/**
 * 调度策略的**当前生效值**与**来源**(spec dispatch-policy-load-is-not-observable)。
 *
 * 为什么要有这个:策略文件路径相对 `process.cwd()` 解析,换个起法就读不到,
 * 而回落到兜底默认是**静默**的 —— 有人配了 maxRetries: 3 却只看到重试 1 次,
 * 会去怀疑重试逻辑,真实原因可能只是 cwd 不对。日志会滚掉,排障往往发生在
 * 几小时之后,所以要能直接查当前状态。
 *
 * 取值一律走 state.ts 的 live getter,**不在这里重读文件** —— 重读报的是
 * 「文件里写了什么」,而这里要答的是「进程现在按什么在跑」。策略在 state.ts
 * 模块加载时读一次并缓存,两者在 cwd 变化或文件被改后就会不一致。
 *
 * 未透出 rateLimit.detectPatterns:它没有对应的 live getter,且其生效值是
 * 「文件里的 ∪ 代码内置默认」的并集,单看哪一边都不代表实际判据 —— 要查它
 * 得另立一条,不在本票范围。除此之外不夹带任何环境变量或无关配置。
 */
function describeDispatchPolicy() {
  const retry = getRetryPolicy();
  return {
    origin: getDispatchPolicyOrigin(),
    effective: {
      maxParallelGroups: getMaxParallelGroups(),
      maxConcurrentPerWorkspace: getMaxConcurrentPerWorkspace(),
      retry: {
        maxRetries: retry.maxRetries,
        resetWorkspace: retry.resetWorkspace,
        switchExecutor: retry.switchExecutor,
      },
      stallTimeoutMs: getStallTimeoutMs(),
      stallAlertMs: getStallAlertMs(),
      claimTimeoutMs: getClaimTimeoutMs(),
      a2aSilenceTimeoutMs: getA2ASilenceTimeoutMs(),
      detachedTimeoutMs: getDetachedTimeoutMs(),
      l3ResponseMs: getL3ResponseMinutesMs(),
      rateLimitCooldownMs: getRateLimitCooldownMs(),
      transientQuota: getTransientQuotaPolicy(),
      redispatchFailureLimit: getRedispatchFailureLimit(),
    },
  };
}

const app = new Hono().get(
  "/",
  describeRoute({
    tags: ["Health"],
    description:
      "Runtime freshness probe: reports the process start time, entry mtime, staleness reason (process/build/both), and the newest scanned source mtime. Also reports the effective dispatch policy and where it was loaded from (file path / env override / built-in default).",
    responses: {
      200: { description: "Runtime status" },
    },
  }),
  // 新增 dispatchPolicy 字段:既有消费方(前端 requirement-workspace 读
  // stale/staleReason)按键取值,加同级字段不影响它们。
  (c) =>
    c.json({ ...getRuntimeStatus(), dispatchPolicy: describeDispatchPolicy() }),
);

export default app;
