import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  recordUnknownParticipantFailure,
  resetUnknownParticipantWarnState,
} from "../src/lib/unknown-participant";

/**
 * 去重告警(R3,specs/unknown-participant-is-not-forbidden.md):同一个不存在
 * 的 participant 在 10 分钟内失败超过 20 次 → 只输出一条 warn;阈值内不输出;
 * 不做封禁/限流。本文件直接单测 lib 的去重逻辑(路由侧由 HTTP 回归测试覆盖)。
 */
describe("unknown participant 去重告警", () => {
  beforeEach(() => {
    resetUnknownParticipantWarnState();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    resetUnknownParticipantWarnState();
  });

  it("阈值内(≤20 次)不输出 warn", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 20; i++) {
      recordUnknownParticipantFailure("dead-participant-1");
    }
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("超过 20 次只输出一条 warn,且包含 id 与修复建议", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const id = "dead-participant-2";
    for (let i = 0; i < 21; i++) {
      recordUnknownParticipantFailure(id);
    }
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const message = warnSpy.mock.calls[0]?.[0] as string;
    expect(message).toContain(id);
    expect(message).toContain("重新注册并更新 COAGENTHUB_PARTICIPANT_ID");
    warnSpy.mockRestore();
  });

  it("同一窗口内继续失败不再重复 warn(去重)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const id = "dead-participant-3";
    for (let i = 0; i < 25; i++) {
      recordUnknownParticipantFailure(id);
    }
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("不同 id 的去重状态相互独立", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 25; i++) {
      recordUnknownParticipantFailure("dead-a");
    }
    // 另一个 id 只失败 1 次 → 不输出。
    recordUnknownParticipantFailure("dead-b");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0] as string).toContain("dead-a");
    warnSpy.mockRestore();
  });

  it("窗口滑过(10 分钟后旧失败过期)后允许下一窗口再次 warn", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const id = "dead-participant-4";
    for (let i = 0; i < 21; i++) {
      recordUnknownParticipantFailure(id);
    }
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // 推进 10 分钟:旧时间戳全部滑出窗口,count 回落到 0 → 去重标记重置。
    vi.setSystemTime(new Date("2026-08-26T00:10:01.000Z"));
    for (let i = 0; i < 21; i++) {
      recordUnknownParticipantFailure(id);
    }
    expect(warnSpy).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });
});
