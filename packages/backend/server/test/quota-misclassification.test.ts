/**
 * spec: specs/quota-misclassified-from-coordinator-narration.md(0942cf5a)
 *
 * 硬验收要求**用真实输出文本**,不得用构造的关键词串 —— 本缺陷正是关键词匹配
 * 造成的,用关键词串验收会继承同一个盲区。样本来自 test/fixtures/quota-real-tails.ts
 * (由生产库 task.diff_summary 逐字节导出)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyQuotaFailure } from "../src/lib/executor-task/state";
import {
  REAL_CODEBUDDY_429_LINE,
  REAL_CODEBUDDY_JSONL_LINE,
  REAL_ERROR_01A074C6,
  REAL_TAIL_01A074C6,
  REAL_TAIL_01A074C8,
  REAL_TAIL_01A07239,
} from "./fixtures/quota-real-tails";

/** 「其它执行器」的标识 —— **不含本执行器自己**(R2 文档:除本执行器外)。 */
const PEERS_OF_CODEX = ["pi", "executor", "codebuddy", "AtomCode", "CodeBuddy", "Pi"];
/** codebuddy 自己的输出,peer 列表必须排除 codebuddy 本身。 */
const PEERS_OF_CODEBUDDY = ["pi", "executor", "codex", "AtomCode", "Pi"];

/**
 * 真实语料里的恢复时刻是**事发当时**的未来时间(codebuddy: 2026-09-06 04:08:23
 * UTC+8)。`extractRateLimitRecoveryMs` 只接受未来时刻(过去的时间戳不可能是恢复
 * 时刻),所以断言必须把系统时间拨回事发当时 —— 否则测的是「样本过期」而不是
 * 判定逻辑。事发时刻取该 JSONL 行自带的 `__timestamp`。
 */
const INCIDENT_NOW = new Date("2026-09-05T15:39:04.637Z");

describe("额度误判(真实语料)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(INCIDENT_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("验收1b:01a074c6 真实 outputTail + exit 0 → 不得判额度失败(2026-09-06 冻住整个平台的那条)", () => {
    const v = classifyQuotaFailure([REAL_TAIL_01A074C6], {
      exitCode: 0,
      peerExecutorNames: PEERS_OF_CODEX,
    });
    expect(v.isQuota).toBe(false);
  });

  it("验收1b:平台熔断文案「retry limit reached」不得被当成限流证据", () => {
    const v = classifyQuotaFailure([REAL_ERROR_01A074C6], {
      exitCode: 0,
      peerExecutorNames: PEERS_OF_CODEX,
    });
    expect(v.isQuota).toBe(false);
  });

  it("验收1:协调者转述他人限流(01a07239 真实尾)+ 非零退出 → 不得判额度失败", () => {
    const v = classifyQuotaFailure([REAL_TAIL_01A07239], {
      exitCode: 1,
      peerExecutorNames: PEERS_OF_CODEX,
    });
    expect(v.isQuota).toBe(false);
  });

  it("R1:退出码非零本身不构成证据(同一文本,零/非零退出码结论一致)", () => {
    const a = classifyQuotaFailure([REAL_TAIL_01A074C6], { exitCode: 0, peerExecutorNames: PEERS_OF_CODEX });
    const b = classifyQuotaFailure([REAL_TAIL_01A074C6], { exitCode: 137, peerExecutorNames: PEERS_OF_CODEX });
    expect(a.isQuota).toBe(b.isQuota);
    expect(b.isQuota).toBe(false);
  });

  it("验收2:codebuddy 真实 429 叙述行(含真实重置时刻)→ 仍判额度失败", () => {
    const v = classifyQuotaFailure([REAL_CODEBUDDY_429_LINE], { peerExecutorNames: PEERS_OF_CODEBUDDY });
    expect(v.isQuota).toBe(true);
  });

  it("验收2:codebuddy 真实 JSONL 结果行(errors_info status=429/category=quota)→ 仍判额度失败", () => {
    const v = classifyQuotaFailure([REAL_CODEBUDDY_JSONL_LINE], { peerExecutorNames: PEERS_OF_CODEBUDDY });
    expect(v.isQuota).toBe(true);
  });

  it("真限流不得漏判:AtomCode 真实 [rate-limited] 尾行 → 判额度失败", () => {
    const v = classifyQuotaFailure([REAL_TAIL_01A074C8], { peerExecutorNames: PEERS_OF_CODEBUDDY });
    expect(v.isQuota).toBe(true);
  });

  it("R2:真限流行里的提供方 32-hex token 与 \"status\":429 不得被平台 id/字段形状误伤", () => {
    // 两条都含长十六进制 token,是提供方自己的 request id,不是平台任务 id
    for (const line of [REAL_CODEBUDDY_429_LINE, REAL_CODEBUDDY_JSONL_LINE]) {
      expect(
        classifyQuotaFailure([line], { peerExecutorNames: PEERS_OF_CODEBUDDY })
          .isQuota,
      ).toBe(true);
    }
  });
});
