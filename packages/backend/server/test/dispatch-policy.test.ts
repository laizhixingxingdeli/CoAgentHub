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
const {
  __resetExecutorQueueForTests,
  getTransientQuotaPolicy,
  isQuotaFailure,
  classifyQuotaFailure,
} = await import("../src/lib/executor-task/state");

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

/** 切到真实运行时策略(仓库根 dispatch-policy.json 与默认关键词并集)。 */
function useRealPatterns(): void {
  delete process.env[policyFileEnv];
  process.chdir(repoRoot);
  reloadRateLimitPatterns();
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

  it("样本 1: [rate-limited] window exhausted + resets around 04:33 → quota(零产出/exit 0 不阻止)", () => {
    useRealPatterns();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 29, 20, 0, 0)); // 20:00, 04:33 已过
    try {
      const line = "[rate-limited] 5h window exhausted — resets around 04:33";
      const verdict = classifyQuotaFailure([line], {
        exitCode: 0,
        taskBook: "无关内容",
      });
      expect(verdict.isQuota).toBe(true);
      expect(verdict.matchedLine).toBe(line);
      // 恢复时刻应落到下一合理窗口(明天 04:33)。
      expect(parseRateLimitRecoveryMs(line)).toBe(
        new Date(2026, 7, 30, 4, 33, 0).getTime(),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("样本 2: 执行器额度限制 + resets around 18:33 → quota, cooldown 至明天 18:33", () => {
    useRealPatterns();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 29, 20, 0, 0)); // 20:00, 18:33 已过
    try {
      const line = "exit 0(执行器额度限制,预计 ... resets around 18:33)";
      const verdict = classifyQuotaFailure([line], {
        exitCode: 0,
        taskBook: "无关内容",
      });
      expect(verdict.isQuota).toBe(true);
      expect(verdict.matchedLine).toBe(line);
      expect(parseRateLimitRecoveryMs(line)).toBe(
        new Date(2026, 7, 30, 18, 33, 0).getTime(),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("样本 3: usage limit + try again at 7:50 PM → quota, cooldown 至 19:50", () => {
    useRealPatterns();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 29, 14, 0, 0)); // 14:00, 19:50 未过
    try {
      const line = "usage limit. ... try again at 7:50 PM";
      const verdict = classifyQuotaFailure([line], {
        exitCode: 0,
        taskBook: "无关内容",
      });
      expect(verdict.isQuota).toBe(true);
      expect(verdict.matchedLine).toBe(line);
      expect(parseRateLimitRecoveryMs(line)).toBe(
        new Date(2026, 7, 29, 19, 50, 0).getTime(),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("样本 4: 01a04e01-b50b 真实自指输出(读取额度检测源码,含额度/quota 大量回显) → 非配额", () => {
    useRealPatterns();
    // 完整保留足以触发历史问题的真实上下文:工具读文件回显 + 源码片段 +
    // 中文汇报,exit 0 且无恢复时刻/错误行形状 → 必须判非额度。
    const echoLines = [
      '[tool→ read_file #t1] {"file_path": "/Users/apple/Projects/CoAgentHub/packages/backend/server/src/lib/executor-task/state.ts", "limit": 200}',
      'export const EXECUTOR_COOLDOWN_END_MS_FIELD = "executorCooldownEndMs";',
      'export const executorCooldowns = new Map<string, number>();',
      'export const cooldownTimers = new Map<string, NodeJS.Timeout>();',
      'let rateLimitPatterns = dispatchPolicy.rateLimit.detectPatterns;',
      'let rateLimitCooldownMs = dispatchPolicy.rateLimit.cooldownMinutes * 60_000;',
      'export function classifyQuotaFailure(',
      '  texts: string[],',
      '  ctx: QuotaFailureContext = {},',
      '): QuotaFailureVerdict {',
      '  const { exitCode, taskBook } = ctx;',
      '  const nonzeroExit = typeof exitCode === "number" && exitCode !== 0;',
      '  for (const raw of texts) {',
      '    for (const rawLine of raw.split("\\n")) {',
      '      const line = rawLine.trim();',
      '      if (!line) continue;',
      '      const lower = line.toLowerCase();',
      '      if (!rateLimitPatterns.some((p) => lower.includes(p.toLowerCase()))) {',
      '        continue;',
      '      }',
      '      if (isDetectPatternsDefinitionLine(line)) continue;',
      '      if (isTaskBookEcho(line, taskBook)) continue;',
      '      const hasEvidence =',
      '        nonzeroExit ||',
      '        parseRateLimitRecoveryMs(line) !== null ||',
      '        PROVIDER_ERROR_LINE_SHAPES.some((re) => re.test(line));',
      '      if (hasEvidence) {',
      '        return {',
      '          isQuota: true,',
      '          matchedLine: line.slice(0, QUOTA_MATCHED_LINE_MAX),',
      '        };',
      '      }',
      '    }',
      '  }',
      '  return { isQuota: false, matchedLine: null };',
      '}',
      '[tool← read_file #t1] 成功读取 42 行',
      '[tool→ read_file #t2] {"file_path": "/Users/apple/Projects/CoAgentHub/packages/backend/server/src/lib/executor-task/cooldown-store.ts", "limit": 80}',
      'export async function listPersistedExecutorCooldowns(',
      '  db: DataBase,',
      '): Promise<PersistedExecutorCooldown[]> {',
      '  const rows = await db.query.task.findMany({',
      '    where: (task, { isNotNull }) => isNotNull(task.diffSummary),',
      '    columns: { id: true, executorKey: true, diffSummary: true },',
      '    orderBy: (task, { desc }) => [desc(task.createdAt)],',
      '  });',
      '  const records: PersistedExecutorCooldown[] = [];',
      '  for (const row of rows) {',
      '    if (!row.executorKey) continue;',
      '    const diffSummary = asDiffSummary(row.diffSummary);',
      '    if (!diffSummary) continue;',
      '    const endMs = diffSummary[EXECUTOR_COOLDOWN_END_MS_FIELD];',
      '    if (typeof endMs !== "number" || !Number.isFinite(endMs)) continue;',
      '    records.push({ taskId: row.id, executorKey: row.executorKey, endMs });',
      '  }',
      '  return records;',
      '}',
      '[tool← read_file #t2] 成功读取 28 行',
      '汇报: 读取并分析了额度检测与冷却存储的源码实现，理解了 classifyQuotaFailure 的判定逻辑。',
      '遗留: 无',
    ];
    const verdict = classifyQuotaFailure(echoLines, { exitCode: 0 });
    expect(verdict.isQuota).toBe(false);
    expect(verdict.matchedLine).toBeNull();
  });

  it("样本 5: 01a04e31-3194 同类自指输出(读取额度测试源码 + JSONL 回显) → 非配额", () => {
    useRealPatterns();
    // 完整保留真实上下文:测试源码回显 + message_update JSONL + 中文汇报,
    // 含「额度」多次但无恢复时刻/错误行形状/非零退出码 → 必须判非额度。
    const echoLines = [
      '[tool→ read_file #t3] {"file_path": "/Users/apple/Projects/CoAgentHub/packages/backend/server/test/executor-report-quota.test.ts", "limit": 150}',
      'describe("任务书模板 + 汇报结构化 + 额度感知调度(票7)", () => {',
      '  const app = createTestApp();',
      '  beforeEach(() => {',
      '    __resetExecutorQueueForTests();',
      '  });',
      '  describe("额度感知调度(票7)", () => {',
      '    it("rate limit 退出 → failed + 原因含「额度」+ 不重试 + ❌ 注明恢复时间", async () => {',
      '      const counterDir = mkdtempSync(',
      '        path.join(tmpdir(), "coagenthub-quota-cnt-"),',
      '      );',
      '      const counterFile = path.join(counterDir, "n.txt");',
      '      process.env.FAKE_RATE_LIMIT = "1";',
      '      process.env.FAKE_COUNTER_FILE = counterFile;',
      '      try {',
      '        const { __setRateLimitForTests } = await import(',
      '          "@server/lib/executor-task"',
      '        );',
      '        __setRateLimitForTests(60_000, ["rate limit", "429"]);',
      '        const { coordinator, codebuddy, group } = await setupGroup();',
      '        const msg = await postMessage(coordinator.id, group.id, {',
      '          body: "额度受限任务",',
      '          audience: "participant",',
      '          audienceRef: codebuddy.id,',
      '        });',
      '        const t = await waitForTaskStatus(',
      '          coordinator.id, group.id, msg.id, "failed",',
      '        );',
      '        const diff = t.diffSummary as Record<string, unknown> | null;',
      '        expect(String(diff?.error)).toContain("额度");',
      '        expect(t.retryCount).toBe(0);',
      '        expect(readFileSync(counterFile, "utf8").trim()).toBe("1");',
      '        const messages = await listMessages(coordinator.id, group.id);',
      '        expect(messages.some((m) => m.body.startsWith("↻"))).toBe(false);',
      '        await waitForMessage(',
      '          coordinator.id, group.id,',
      '          (m) =>',
      '            m.body.includes("执行器额度限制") &&',
      '            m.body.includes("预计") &&',
      '            m.body.includes("恢复"),',
      '        );',
      '      } finally {',
      '        delete process.env.FAKE_RATE_LIMIT;',
      '        delete process.env.FAKE_COUNTER_FILE;',
      '        rmSync(counterDir, { recursive: true, force: true });',
      '      }',
      '    }, 30_000);',
      '[tool← read_file #t3] 成功读取 48 行',
      '[tool→ read_file #t4] {"file_path": "/Users/apple/Projects/CoAgentHub/packages/backend/server/test/executor-quota-redispatch.test.ts", "limit": 120}',
      'describe("额度耗尽触发无限重派修复(specs/quota-exhaustion-triggers-infinite-retry)", () => {',
      '  const app = createTestApp();',
      '  beforeEach(() => {',
      '    __resetExecutorQueueForTests();',
      '    for (const key of [',
      '      "FAKE_QUOTA_USAGE_LIMIT",',
      '      "FAKE_TRY_AGAIN_AT",',
      '      "FAKE_ALWAYS_FAIL",',
      '    ]) {',
      '      delete process.env[key];',
      '    }',
      '  });',
      '  afterEach(() => {',
      '    __resetExecutorQueueForTests();',
      '  });',
      '  async function registerParticipant(name: string) {',
      '[tool← read_file #t4] 成功读取 32 行',
      '{"type":"message_update","usage":{"input":0},"assistantMessageEvent":{"type":"text_delta","delta":"额度"}}',
      '{"type":"message_update","usage":{"output":0},"assistantMessageEvent":{"type":"text_delta","delta":"检测"}}',
      '{"type":"message_update","usage":{"total":0},"assistantMessageEvent":{"type":"text_delta","delta":"源码"}}',
      '汇报: 读取了 executor-report-quota 与 executor-quota-redispatch 测试文件，分析了额度感知调度与无限重派修复的测试用例。',
      '遗留: 无',
    ];
    const verdict = classifyQuotaFailure(echoLines, { exitCode: 0 });
    expect(verdict.isQuota).toBe(false);
    expect(verdict.matchedLine).toBeNull();
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

/**
 * 额度失败分级(specs/transient-ratelimit-escalated-to-long-cooldown R1):
 * 分级收敛在 classifyQuotaFailure 单点,先判 exhausted 再判 transient ——
 * 瞬时限流(短相对恢复提示)不再被 R7 升级成 5 小时冷却。
 */
describe("classifyQuotaFailure:额度分级 transient/exhausted", () => {
  it("验收 1:[rate-limited] try again in 5 seconds → transient", () => {
    useRealPatterns();
    // 供应方明确要求等 5 秒:解析准确但很短 → 瞬时退避,不是额度耗尽。
    const verdict = classifyQuotaFailure(
      ["[rate-limited] try again in 5 seconds"],
      { exitCode: 1 },
    );
    expect(verdict.isQuota).toBe(true);
    expect(verdict.kind).toBe("transient");
  });

  it("验收 2:usage limit reached, resets around 13:33 → exhausted", () => {
    useRealPatterns();
    const verdict = classifyQuotaFailure(
      ["usage limit reached, resets around 13:33"],
      { exitCode: 1 },
    );
    expect(verdict.isQuota).toBe(true);
    expect(verdict.kind).toBe("exhausted");
  });

  it("验收 6:仅关键词命中、无结构证据 → isQuota=false 且 kind=null", () => {
    useRealPatterns();
    // 源码/文件名回显(伪额度回显现场):不算额度,自然也没有分级。
    const verdict = classifyQuotaFailure(
      ["we read executor-report-quota.test.ts"],
      { exitCode: 0 },
    );
    expect(verdict.isQuota).toBe(false);
    expect(verdict.kind).toBeNull();
  });

  it("绝对恢复时刻(try again at HH:MM)→ exhausted", () => {
    useRealPatterns();
    expect(
      classifyQuotaFailure(["You've hit your usage limit. try again at 3:32"], {
        exitCode: 1,
      }).kind,
    ).toBe("exhausted");
  });

  it("相对恢复时长超过瞬时分界(try again in 600 seconds)→ exhausted", () => {
    useRealPatterns();
    // 600s 远长于 60s 分界:供应方要求的是长窗口等待,按耗尽处理(保守)。
    expect(
      classifyQuotaFailure(
        ["[rate-limited] 5h window exhausted — try again in 600 seconds"],
        { exitCode: 0 },
      ).kind,
    ).toBe("exhausted");
  });

  it("同时命中 transient 与 exhausted → exhausted(先判耗尽,保守)", () => {
    useRealPatterns();
    expect(
      classifyQuotaFailure(
        ["[rate-limited] usage limit reached, try again in 5 seconds"],
        { exitCode: 1 },
      ).kind,
    ).toBe("exhausted");
  });

  it("429 + retry/backoff 动词且无耗尽关键词 → transient", () => {
    useRealPatterns();
    expect(
      classifyQuotaFailure(["HTTP 429 too many requests, retrying"], {
        exitCode: 1,
      }).kind,
    ).toBe("transient");
  });

  it("有结构证据但两条判据都不命中 → 回落 exhausted(fail-safe)", () => {
    useRealPatterns();
    // 真额度(非零退出 + 错误行形状),但既无恢复时刻也无瞬时特征:
    // 宁可长冷却也不要无限退避。
    expect(
      classifyQuotaFailure(["error: rate limit exceeded"], { exitCode: 1 })
        .kind,
    ).toBe("exhausted");
  });
});

/**
 * 瞬时限流配置(spec R5 / §7):两个键缺失或非法 → null → 不启用瞬时处置,
 * 调用方回落 exhausted 语义(fail-safe:宁可长冷却也不要无限退避)。
 */
describe("瞬时限流配置(读不到 → fail-safe 回落 exhausted)", () => {
  it("scripts/dispatch-policy.json 带两个键 → 读到 120s / 3", () => {
    delete process.env[policyFileEnv];
    process.chdir(repoRoot);
    const policy = readDispatchPolicy().rateLimit;
    expect(policy.transientBackoffSeconds).toBe(120);
    expect(policy.transientEscalationLimit).toBe(3);
    // 缺省策略(配置文件不可读的兜底)不启用瞬时处置。
    expect(DEFAULT_RATE_LIMIT_POLICY.transientBackoffSeconds).toBeNull();
    expect(DEFAULT_RATE_LIMIT_POLICY.transientEscalationLimit).toBeNull();
  });

  it("删掉两个配置键 → null → getTransientQuotaPolicy() 为 null(等价现状)", () => {
    usePolicyFile({ rateLimit: { cooldownMinutes: 300 } });
    reloadRateLimitPatterns();
    expect(readDispatchPolicy().rateLimit.transientBackoffSeconds).toBeNull();
    expect(readDispatchPolicy().rateLimit.transientEscalationLimit).toBeNull();
    expect(getTransientQuotaPolicy()).toBeNull();
  });

  it("非法值(0 / 负数 / 非整数)→ 同样视为未配置", () => {
    usePolicyFile({
      rateLimit: { transientBackoffSeconds: 0, transientEscalationLimit: 2.5 },
    });
    reloadRateLimitPatterns();
    expect(getTransientQuotaPolicy()).toBeNull();
  });

  it("两个键都合法 → 读到退避时长与升级上限", () => {
    usePolicyFile({
      rateLimit: { transientBackoffSeconds: 30, transientEscalationLimit: 2 },
    });
    reloadRateLimitPatterns();
    expect(getTransientQuotaPolicy()).toEqual({
      backoffMs: 30_000,
      escalationLimit: 2,
    });
  });
});
