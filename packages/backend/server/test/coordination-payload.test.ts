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

  it("从带标题正文的 json 围栏解析 review_result", () => {
    const payload = {
      type: "review_result",
      layer: 3,
      taskId: "task-1",
      verdict: "pass",
      findings: [],
    } as const;

    expect(
      parseKnownCoordinationPayload(
        [
          "## L3 裁决：通过",
          "",
          "说明文字",
          "",
          "```json",
          JSON.stringify(payload),
          "```",
        ].join("\n"),
      ),
    ).toEqual(payload);
  });

  it("从无语言标注的围栏解析 payload", () => {
    expect(
      parseKnownCoordinationPayload(
        [
          "```",
          JSON.stringify({
            type: "spec_published",
            specRef: "specs/x.md",
            specHash: "abc1234",
            summary: "published",
          }),
          "```",
        ].join("\n"),
      ),
    ).toEqual({
      type: "spec_published",
      specRef: "specs/x.md",
      specHash: "abc1234",
      summary: "published",
    });
  });

  it("多个围栏取第一个可识别的 known payload", () => {
    const payload = {
      type: "review_result",
      layer: 3,
      taskId: "task-1",
      verdict: "findings",
      findings: [{ severity: "high", note: "needs work" }],
    } as const;

    expect(
      parseKnownCoordinationPayload(
        [
          "```json",
          "not json",
          "```",
          "```json",
          JSON.stringify({ type: "future_payload" }),
          "```",
          "```json",
          JSON.stringify(payload),
          "```",
        ].join("\n"),
      ),
    ).toEqual(payload);
  });

  it("整体 JSON 优先且结果保持逐字不变", () => {
    const payload = {
      type: "review_result",
      layer: 3,
      taskId: "task-1",
      verdict: "pass",
      findings: [],
      note: "exact value",
    } as const;
    expect(parseKnownCoordinationPayload(JSON.stringify(payload))).toEqual(
      payload,
    );
  });

  it("自由文本、未知 type 与未知围栏内容仍返回 undefined", () => {
    expect(
      parseKnownCoordinationPayload("这是普通说明，不是协作载荷"),
    ).toBeUndefined();
    expect(
      parseKnownCoordinationPayload(
        '```json\n{"type":"future_payload","value":1}\n```',
      ),
    ).toBeUndefined();
  });
});
