import { describe, expect, it } from "vitest";
import { reviewRequestCarryAllowed } from "../src/lib/executor-task/review-request-policy";

/**
 * R3 反向守卫共用判定(任务书 buildReportSection 与 tasks.ts PATCH 终态守卫
 * 共用同一谓词,两处不漂移):仅「非 fix + 群内有 reviewer」允许携带
 * review_request;fix 票复用已过 L3 的冻结 spec 不产生新架构面、无 reviewer
 * 时两层编制不跑 L3,均禁止;dispatchKind=null 的历史行保守按 requirement
 * 处理(允许)。
 */
describe("reviewRequestCarryAllowed(R3 共用判定)", () => {
  it("requirement + 群内有 reviewer → 允许携带", () => {
    expect(reviewRequestCarryAllowed("requirement", true)).toBe(true);
  });

  it("fix + 群内有 reviewer → 禁止(fix 票不产生新架构面)", () => {
    expect(reviewRequestCarryAllowed("fix", true)).toBe(false);
  });

  it("requirement + 群内无 reviewer → 禁止(两层编制不跑 L3)", () => {
    expect(reviewRequestCarryAllowed("requirement", false)).toBe(false);
  });

  it("fix + 群内无 reviewer → 禁止", () => {
    expect(reviewRequestCarryAllowed("fix", false)).toBe(false);
  });

  it("dispatchKind=null + 群内有 reviewer → 按 requirement 保守允许", () => {
    expect(reviewRequestCarryAllowed(null, true)).toBe(true);
  });

  it("dispatchKind=null + 群内无 reviewer → 禁止(无 reviewer 时 null 同样被拒)", () => {
    expect(reviewRequestCarryAllowed(null, false)).toBe(false);
  });
});
