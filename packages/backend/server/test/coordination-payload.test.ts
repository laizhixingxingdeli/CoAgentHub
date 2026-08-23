import {
  normalizeReviewRequestDiffSummary,
  parseKnownCoordinationPayload,
} from "@laizhixingxingdeli/database/schema";
import { describe, expect, it } from "vitest";

describe("协作载荷代码契约", () => {
  const request = {
    type: "review_request",
    layer: 3,
    taskId: "task-1",
    specRef: "specs/x.md",
    specHash: "abc1234",
    diffSummary: "changed files",
  };

  it("接受 review_request 顶层与嵌套位置并归一到嵌套形状", () => {
    expect(normalizeReviewRequestDiffSummary(request)).toEqual({
      review_request: request,
    });
    expect(
      normalizeReviewRequestDiffSummary({
        hash: "abc",
        review_request: request,
      }),
    ).toEqual({ hash: "abc", review_request: request });
  });

  it("认识的 type 形状错误时失败,自由文本和未知 type 放行", () => {
    expect(() =>
      parseKnownCoordinationPayload(
        JSON.stringify({ ...request, specHash: "" }),
      ),
    ).toThrow();
    expect(parseKnownCoordinationPayload("not json")).toBeUndefined();
    expect(
      parseKnownCoordinationPayload(
        JSON.stringify({ type: "future_payload", value: 1 }),
      ),
    ).toBeUndefined();
  });
});
