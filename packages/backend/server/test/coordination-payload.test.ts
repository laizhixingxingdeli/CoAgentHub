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

  // 头条验收信号(unit 级):解析器从 markdown 取出载荷后,enforce 路径据此
  // 把 findings 广播判 400、把 pass 派生 l3.answered=true。这里直接锁定解析器
  // 对两种 verdict 的提取结果,使端到端信号有可审计的单元级根因。
  it("markdown 包裹的 findings review_result 解析为 verdict=findings 载荷", () => {
    const findings = [{ severity: "high", note: "needs work" }] as const;
    const body = [
      "## L3 裁决：发现项",
      "",
      "<人读说明>",
      "",
      "```json",
      JSON.stringify({
        type: "review_result",
        layer: 3,
        taskId: "task-1",
        verdict: "findings",
        findings,
      }),
      "```",
    ].join("\n");
    const parsed = parseKnownCoordinationPayload(body);
    expect(parsed).toEqual({
      type: "review_result",
      layer: 3,
      taskId: "task-1",
      verdict: "findings",
      findings,
    });
  });

  it("markdown 包裹的 pass review_result 解析为 verdict=pass 载荷", () => {
    const body = [
      "## L3 裁决：通过 —— pass",
      "",
      "<人读说明>",
      "",
      "```json",
      JSON.stringify({
        type: "review_result",
        layer: 3,
        taskId: "task-1",
        verdict: "pass",
        findings: [],
      }),
      "```",
    ].join("\n");
    const parsed = parseKnownCoordinationPayload(body);
    expect(parsed).toMatchObject({
      type: "review_result",
      verdict: "pass",
      findings: [],
    });
  });
});
