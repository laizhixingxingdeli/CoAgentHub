import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * readDispatchPolicy 的额度关键词合并边界(specs/quota-exhaustion-triggers-infinite-retry
 * L2 修正):scripts/dispatch-policy.json 随代码版本化并整段提供 detectPatterns,
 * 而代码里的默认关键词是 R1 语义识别的兜底 —— 两者必须并集生效,否则配置里
 * 少写一条就漏判(事故原文 "usage limit" / "try again at" 正是这样失效的)。
 *
 * 既有契约保持:显式 detectPatterns: [] = 关闭额度检测。
 */

const { DEFAULT_RATE_LIMIT_POLICY, readDispatchPolicy, parseRateLimitRecoveryMs } =
  await import("@server/lib/executors");
const { __resetExecutorQueueForTests, isQuotaFailure, classifyQuotaFailure } =
  await import("../src/lib/executor-task/state");

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

/**
 * 伪额度回显修复(dispatchKind=fix):isQuotaFailure 只靠关键词命中不足以判额度
 * —— 必须至少一条结构证据:非零退出码 / 真实恢复时刻 / 提供方错误行形状;且排除
 * detectPatterns 定义与任务书逐字回显(自指)。本组用例逐条覆盖票面验收 1-6。
 */
describe("classifyQuotaFailure:结构证据与自指排除(伪额度回显修复)", () => {
  /** 切到真实运行时策略(仓库根 dispatch-policy.json 与默认关键词并集)。 */
  function useRealPatterns(): void {
    delete process.env[policyFileEnv];
    process.chdir(repoRoot);
    reloadRateLimitPatterns();
  }

  it("exit 0 + quota 关键词但无恢复时刻/错误行形状 → 非配额(验收 1)", () => {
    useRealPatterns();
    // 仅源码/文件名里的 quota 字样回显(旧实现误判的现场),exit 0 无恢复时刻。
    expect(
      classifyQuotaFailure(["we read executor-report-quota.test.ts"], {
        exitCode: 0,
      }).isQuota,
    ).toBe(false);
    expect(
      classifyQuotaFailure(["quota is documented in src/lib/quota.ts"], {
        exitCode: 0,
      }).isQuota,
    ).toBe(false);
  });

  it("exit 0 + resets around 18:33 → 仍配额,冷却解析至当天 18:33(验收 2)", () => {
    useRealPatterns();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 29, 10, 0, 0)); // 本地 10:00
    try {
      const verdict = classifyQuotaFailure(
        ["usage limit reached — resets around 18:33"],
        { exitCode: 0 },
      );
      expect(verdict.isQuota).toBe(true);
      // 冷却到解析出的恢复时刻(与 queue.handleQuotaFailure 同源解析)。
      expect(
        parseRateLimitRecoveryMs("usage limit reached — resets around 18:33"),
      ).toBe(new Date(2026, 7, 29, 18, 33, 0).getTime());
    } finally {
      vi.useRealTimers();
    }
  });

  it("非零退出码 + rate limit → 仍配额(验收 3)", () => {
    useRealPatterns();
    expect(
      classifyQuotaFailure(["rate limit exceeded"], { exitCode: 2 }).isQuota,
    ).toBe(true);
    expect(
      classifyQuotaFailure(["usage limit"], { exitCode: 1 }).isQuota,
    ).toBe(true);
  });

  it("detectPatterns 定义回显(自指)→ 不计证据(验收 4)", () => {
    useRealPatterns();
    // 输出里出现配置定义本身(整行是引号包裹的关键词列表),不是执行器真报错。
    const definitionLine =
      '"usage limit", "rate limit", "quota", "429", "额度", "次数限制", "window exhausted"';
    expect(
      classifyQuotaFailure([definitionLine], { exitCode: 0 }).isQuota,
    ).toBe(false);
    expect(
      classifyQuotaFailure([definitionLine], { exitCode: 1 }).isQuota,
    ).toBe(false);
  });

  it("任务书逐字回显(自指)→ 不计证据(验收 4)", () => {
    useRealPatterns();
    const taskBook = [
      "# CoAgentHub 任务",
      "请处理额度耗尽问题(rate limit)",
      "## 汇报格式要求",
    ].join("\n");
    // 执行器把任务书整行回显到输出 → 即使含关键词也不算证据(自指)。
    expect(
      classifyQuotaFailure(["请处理额度耗尽问题(rate limit)"], {
        exitCode: 1,
        taskBook,
      }).isQuota,
    ).toBe(false);
  });

  it("配额判定回传命中原始行(截断)供 quotaMatchedLine 留痕(验收 5)", () => {
    useRealPatterns();
    const longLine = `error: rate limit exceeded (429 too many requests) ${"x".repeat(400)}`;
    const verdict = classifyQuotaFailure([longLine], { exitCode: 1 });
    expect(verdict.isQuota).toBe(true);
    expect(verdict.matchedLine).toBe(longLine.slice(0, 300));
    expect(verdict.matchedLine?.length).toBeLessThanOrEqual(300);
    // 非配额时 matchedLine 为 null。
    expect(
      classifyQuotaFailure(["ordinary crash"], { exitCode: 0 }).matchedLine,
    ).toBeNull();
  });

  it("回归 fixture 01a04e01-b50b:回显含 quota 的测试文件名 → exit 0 非配额(验收 6)", () => {
    useRealPatterns();
    // 该任务输出尾部回显了 executor-report-quota.test.ts 等含 quota 字样的
    // 源码/文件名(旧实现按关键词命中误判配额),exit 0 无恢复时刻 → 非配额。
    const echoLines = [
      '[tool→ read_file #t170] {"file_path": "/Users/apple/Projects/CoAgentHub/packages/backend/server/test/executor-report-quota.test.ts", "limit": 120}',
      "测试: 全量 L1 通过 — **59 测试文件 / 860 用例**",
    ];
    expect(classifyQuotaFailure(echoLines, { exitCode: 0 }).isQuota).toBe(
      false,
    );
  });

  it("回归 fixture 01a04e31-3194:回显含 额度 的测试源码/JSONL → exit 0 非配额(验收 6)", () => {
    useRealPatterns();
    // 该任务输出尾部回显了含「额度」的测试源码与 message_update JSONL
    // (旧实现按关键词命中误判配额),exit 0 无恢复时刻 → 非配额。
    const echoLines = [
      'expect(err).toContain("执行器额度限制")',
      '{"type":"message_update","usage":{"input":0},"assistantMessageEvent":{"type":"text_delta","delta":"额度"}}',
    ];
    expect(classifyQuotaFailure(echoLines, { exitCode: 0 }).isQuota).toBe(
      false,
    );
  });
});
