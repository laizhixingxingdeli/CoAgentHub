import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

/**
 * readDispatchPolicy 的额度关键词合并边界(specs/quota-exhaustion-triggers-infinite-retry
 * L2 修正):scripts/dispatch-policy.json 随代码版本化并整段提供 detectPatterns,
 * 而代码里的默认关键词是 R1 语义识别的兜底 —— 两者必须并集生效,否则配置里
 * 少写一条就漏判(事故原文 "usage limit" / "try again at" 正是这样失效的)。
 *
 * 既有契约保持:显式 detectPatterns: [] = 关闭额度检测。
 */

const { DEFAULT_RATE_LIMIT_POLICY, readDispatchPolicy } = await import(
  "@server/lib/executors"
);
const { __resetExecutorQueueForTests, isQuotaFailure } = await import(
  "../src/lib/executor-task/state"
);

/** 仓库根(test/ → server/ → backend/ → packages/ → 根)。 */
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

const policyFileEnv = "COAGENTHUB_DISPATCH_POLICY_FILE";

/** 写一份临时策略文件并接管读取路径(不改动进程 cwd)。 */
function usePolicyFile(policy: unknown): void {
  const file = path.join(
    mkdtempSync(path.join(tmpdir(), "coagenthub-policy-")),
    "dispatch-policy.json",
  );
  writeFileSync(file, JSON.stringify(policy));
  process.env[policyFileEnv] = file;
}

/** 让 state.ts 的额度关键词重新按当前策略文件取值(与真实启动同路径)。 */
function reloadRateLimitPatterns(): void {
  __resetExecutorQueueForTests();
}

const originalEnv = process.env[policyFileEnv];
const originalCwd = process.cwd();

afterEach(() => {
  if (originalEnv === undefined) delete process.env[policyFileEnv];
  else process.env[policyFileEnv] = originalEnv;
  process.chdir(originalCwd);
  reloadRateLimitPatterns();
});

describe("readDispatchPolicy:额度关键词合并边界", () => {
  it("仓库根 cwd 读取 scripts/dispatch-policy.json → 有效关键词含 usage limit 与 try again at", () => {
    delete process.env[policyFileEnv];
    process.chdir(repoRoot);

    const patterns = readDispatchPolicy().rateLimit.detectPatterns;

    // 事故原文关键词(R1):配置里没写,由默认集合补齐。
    expect(patterns).toContain("usage limit");
    expect(patterns).toContain("try again at");
    // 配置自带的关键词仍在(并集,不是被默认顶掉)。
    expect(patterns).toContain("window exhausted");
    expect(patterns).toContain("次数限制");
  });

  it("配置的关键词与默认关键词取并集(配置不覆盖默认)", () => {
    usePolicyFile({ rateLimit: { detectPatterns: ["window exhausted"] } });

    const patterns = readDispatchPolicy().rateLimit.detectPatterns;

    expect(patterns).toContain("window exhausted");
    for (const p of DEFAULT_RATE_LIMIT_POLICY.detectPatterns) {
      expect(patterns).toContain(p);
    }
    // 同一关键词不重复出现。
    expect(new Set(patterns).size).toBe(patterns.length);
  });

  it("rateLimit 段缺失 → 默认关键词", () => {
    usePolicyFile({ maxParallelGroups: 3 });

    expect(readDispatchPolicy().rateLimit.detectPatterns).toEqual(
      DEFAULT_RATE_LIMIT_POLICY.detectPatterns,
    );
  });

  it("显式空 detectPatterns → 关闭额度检测(既有契约)", () => {
    usePolicyFile({ rateLimit: { detectPatterns: [] } });

    expect(readDispatchPolicy().rateLimit.detectPatterns).toEqual([]);
    // 语义层面确认关闭:事故原文文本也不再命中。
    reloadRateLimitPatterns();
    expect(
      isQuotaFailure([
        "You've hit your usage limit. try again at 3:32 PM",
        "rate limit exceeded",
      ]),
    ).toBe(false);
  });

  it("默认关键词在真实策略下可命中事故原文(并集生效的语义证据)", () => {
    delete process.env[policyFileEnv];
    process.chdir(repoRoot);
    reloadRateLimitPatterns();

    expect(
      isQuotaFailure(["You've hit your usage limit. try again at 3:32 PM"]),
    ).toBe(true);
    expect(isQuotaFailure(["ordinary crash"])).toBe(false);
  });
});
