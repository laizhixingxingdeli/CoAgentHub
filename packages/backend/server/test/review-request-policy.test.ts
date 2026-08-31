import { describe, expect, it } from "vitest";
import { reviewRequestCarryAllowed } from "../src/lib/executor-task/review-request-policy";

/**
 * R3 反向守卫共用判定(任务书 buildReportSection 与 tasks.ts PATCH 终态守卫
 * 共用同一谓词,两处不漂移)。v4.1(spec §3.14.6):裁定的事实是「群成员构成
 * 是否允许独立 L3」——仅当群内有 reviewer 成员;`dispatchKind` 只选择深度
 * (requirement=完整档,fix=精简档 `lite:true`),不决定是否携带。
 * 回归锚点:fix + 群内有 reviewer 必须允许(v4.0 曾在此 400 拒收)。
 */
describe("reviewRequestCarryAllowed(R3 共用判定)", () => {
  it("requirement + 群内有 reviewer → 允许携带(完整档)", () => {
    expect(reviewRequestCarryAllowed("requirement", true)).toBe(true);
  });

  it("fix + 群内有 reviewer → 允许携带(精简档,v4.1 回归:不再 400)", () => {
    expect(reviewRequestCarryAllowed("fix", true)).toBe(true);
  });

  it("requirement + 群内无 reviewer → 禁止(两层编制不跑 L3)", () => {
    expect(reviewRequestCarryAllowed("requirement", false)).toBe(false);
  });

  it("fix + 群内无 reviewer → 禁止(两方编制任何 dispatchKind 都不携带)", () => {
    expect(reviewRequestCarryAllowed("fix", false)).toBe(false);
  });

  it("dispatchKind=null + 群内有 reviewer → 按 requirement 保守允许", () => {
    expect(reviewRequestCarryAllowed(null, true)).toBe(true);
  });

  it("dispatchKind=null + 群内无 reviewer → 禁止(无 reviewer 时 null 同样被拒)", () => {
    expect(reviewRequestCarryAllowed(null, false)).toBe(false);
  });
});
