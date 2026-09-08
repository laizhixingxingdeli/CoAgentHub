/**
 * diffSummary 字段归属与单一合并入口(spec diffsummary-ownership)。
 *
 * 存储与 API 保持扁平;所有者是合并规则上的分区,不是物理嵌套。
 * 本模块是纯函数:不写库、不发 WS。生产写路径改接属于 W2。
 */

/** diffSummary 逻辑所有者(spec §3.1)。 */
export type DiffSummaryOwner =
  | "result"
  | "scheduling"
  | "review"
  | "relation"
  | "metrics"
  | "audit"
  | "terminal";

/**
 * 顶层键 → 所有者登记表。未出现在表中的键归「本次写入声明的所有者」
 * (通常 result),这样执行器扩展字段不会被平台合并丢弃,同时不能覆盖
 * 已登记的他所有者键。
 *
 * `platform` 整块归属 relation,子键在 PLATFORM_KEY_OWNERS 再登记;
 * 对 platform 的 patch 走深合并,不得用只含部分键的对象替换整块。
 */
export const DIFF_SUMMARY_KEY_OWNERS: Readonly<
  Record<string, DiffSummaryOwner>
> = {
  // result — 经过验证或执行器侧的执行结果
  summary: "result",
  hash: "result",
  tests: "result",
  todo: "result",
  reportMissingReason: "result",
  claimVerification: "result",
  unconfirmed: "result",
  alreadySatisfied: "result",

  // scheduling — 平台调度事实
  queuedBlocked: "scheduling",
  stallAlerted: "scheduling",
  executorCooldownEndMs: "scheduling",
  executorCooldownSource: "scheduling",
  cooldownFallbackReason: "scheduling",
  discardedCooldownEndMs: "scheduling",
  quotaMatchedLine: "scheduling",
  quotaMatchedButCommitFound: "scheduling",
  quotaMatchedButTransient: "scheduling",
  staleBuildSuspected: "scheduling",
  noExecutionReason: "scheduling",

  // review — 检视 / 结案证据
  review_request: "review",
  review_result: "review",
  claimAdjudication: "review",
  l1Bypass: "review",
  degradedToTwoParty: "review",

  // relation — 平台续跑与实例关系(`platform` 块)
  platform: "relation",

  // metrics — attempt/task 汇总型可观测字段
  tokenUsage: "metrics",
  tokenUsageReason: "metrics",
  outputTail: "metrics",
  outputTailMissing: "metrics",
  liveOutputTail: "metrics",
  retries: "metrics",
  reconciledReason: "metrics",
  reconciledAt: "metrics",

  // audit — 跨生命周期审计留痕
  dispatchKindNote: "audit",
  rollbackSkipped: "audit",

  // terminal — 终态原因文案
  error: "terminal",
};

/**
 * `platform.*` 子键 → 所有者。当前全部归 relation;未登记子键在
 * relation 写入时同样应用(与顶层未登记键归写入方同一口径)。
 */
export const PLATFORM_KEY_OWNERS: Readonly<Record<string, DiffSummaryOwner>> = {
  resumeOf: "relation",
  resumeForChild: "relation",
  closeGuardResume: "relation",
  ownerServerPid: "relation",
  l3MergedInto: "relation",
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 查顶层键的登记所有者;未登记返回 undefined。 */
export function ownerOfDiffSummaryKey(
  key: string,
): DiffSummaryOwner | undefined {
  return DIFF_SUMMARY_KEY_OWNERS[key];
}

/**
 * 单一 diffSummary 合并入口(spec §3.2)。
 *
 * 规则:
 * 1. `existing` 非对象时视为 `{}`。
 * 2. 结果从 `existing` 的可识别对象浅拷贝开始(platform 子对象再浅拷贝)。
 * 3. 对 `patch` 每个顶层键:登记所有者不是 `owner` → 不应用;是 `owner`
 *    或未登记 → 应用。
 * 4. `platform`:仅 `relation` 可写;双方均为对象时深合并子键。
 * 5. 同所有者再次写入可覆盖自身键。
 * 6. 显式 `null` **仅**清除本所有者(或未登记归本所有者)的键;他所有者
 *    键上的 null 与其它值一样被忽略 —— 作用域不得越权,否则一次 null
 *    会变成另一种「整袋替换」。
 * 7. `undefined` 表示不写(跳过)。
 * 8. 纯函数:不写库、不发 WS、不修改入参。
 */
export function mergeDiffSummary(
  existing: unknown,
  patch: Record<string, unknown>,
  owner: DiffSummaryOwner,
): Record<string, unknown> {
  const result: Record<string, unknown> = isPlainObject(existing)
    ? { ...existing }
    : {};

  // 断开 platform 与 existing 的引用,后续深合并不污染入参。
  if (isPlainObject(result.platform)) {
    result.platform = { ...result.platform };
  }

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;

    if (key === "platform") {
      if (owner !== "relation") continue;
      applyPlatformPatch(result, value);
      continue;
    }

    const registered = DIFF_SUMMARY_KEY_OWNERS[key];
    if (registered !== undefined && registered !== owner) {
      // 他所有者键:值与显式 null 一律忽略
      continue;
    }

    if (value === null) {
      delete result[key];
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * relation 所有者对 `platform` 的写入:
 * - null → 清除整个 platform 块;
 * - 双方对象 → 按子键合并(仅 relation / 未登记子键;显式 null 删子键);
 * - 非对象 patch → 整块替换(relation 自有块,允许)。
 */
function applyPlatformPatch(
  result: Record<string, unknown>,
  platformPatch: unknown,
): void {
  if (platformPatch === null) {
    delete result.platform;
    return;
  }

  if (!isPlainObject(platformPatch)) {
    result.platform = platformPatch;
    return;
  }

  const platform: Record<string, unknown> = isPlainObject(result.platform)
    ? { ...(result.platform as Record<string, unknown>) }
    : {};

  for (const [subKey, subValue] of Object.entries(platformPatch)) {
    if (subValue === undefined) continue;

    const registered = PLATFORM_KEY_OWNERS[subKey];
    // 仅 relation 走进本函数;他所有者登记的子键(若未来有)仍拒绝。
    if (registered !== undefined && registered !== "relation") {
      continue;
    }

    if (subValue === null) {
      delete platform[subKey];
    } else {
      platform[subKey] = subValue;
    }
  }

  result.platform = platform;
}
