import {
  executorAvailability,
  recordExecutorOutput,
  resetExecutorOutputRecords,
} from "@server/lib/executor-availability";
import {
  findProviderError,
  hasStructuredTaskReport,
  hasZeroTokenUsage,
  parseTaskReport,
} from "@server/lib/executor-task/report";
import { afterEach, describe, expect, it } from "vitest";

describe("executor provider error / zero output facts", () => {
  afterEach(() => resetExecutorOutputRecords());

  it("recognizes provider protocol errors and preserves the original line", () => {
    const line =
      '400 {"message":"credit insufficient balance: balance=1492 required=1738","type":"api_error","code":"insufficient_user_quota"}';
    expect(findProviderError(line)).toBe(line);
    expect(findProviderError('{"stopReason":"error"}')).toBe(
      '{"stopReason":"error"}',
    );
    expect(findProviderError("provider credit insufficient")).toBeUndefined();
  });

  it("uses structured report presence independently from token availability", () => {
    expect(hasStructuredTaskReport(parseTaskReport(""))).toBe(false);
    expect(hasZeroTokenUsage(null)).toBe(true);
    expect(
      hasStructuredTaskReport(parseTaskReport("汇报:完成, token unavailable")),
    ).toBe(true);
    expect(hasZeroTokenUsage(undefined)).toBe(true);
  });

  it("exposes two consecutive zero-output results without cooling the executor", () => {
    expect(recordExecutorOutput("pi", true)).toBe(1);
    expect(recordExecutorOutput("pi", true)).toBe(2);
    expect(executorAvailability({ key: "pi" })).toEqual({
      available: true,
      unavailableReason: "连续零产出,疑似 provider 拒绝",
      cooldownEndMs: null,
      cooldownSource: null,
    });
    recordExecutorOutput("pi", false);
    expect(executorAvailability({ key: "pi" }).unavailableReason).toBeNull();
  });
});
