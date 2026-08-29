import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownBody } from "./MarkdownBody";

/**
 * 任务书正文的 markdown 渲染与防注入(spec …R7):`#` / `**` / 列表 / 代码围栏
 * 必须按结构与重点渲染;正文来自 agent,原始 HTML 与危险协议链接不得生效。
 */

describe("MarkdownBody 任务书正文渲染(R7)", () => {
  it("# 标题 / **重点** / 列表按 markdown 渲染,不再是原样文本", () => {
    render(
      <MarkdownBody
        body={"# 任务书\n\n**重点**:修掉输出滚动\n\n- 第一项\n- 第二项"}
      />,
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "任务书",
    );
    expect(screen.getByText("重点").tagName).toBe("STRONG");
    expect(
      screen.getAllByRole("listitem").map((item) => item.textContent),
    ).toEqual(["第一项", "第二项"]);
  });

  it("代码围栏渲染为代码块,不再与正文混在一起", () => {
    const { container } = render(
      <MarkdownBody
        body={"步骤如下:\n\n```sh\npnpm --filter server test\n```"}
      />,
    );
    const pre = container.querySelector("pre");
    expect(pre?.textContent).toContain("pnpm --filter server test");
  });

  it("原始 HTML 不生效:只作为文本呈现,不产生元素(无注入面)", () => {
    const raw = '<img src=x onerror="alert(1)"><b>粗体</b>';
    const { container } = render(<MarkdownBody body={raw} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    // 未启用 rehype-raw:原始 HTML 被转义成文本,不进入 DOM 结构。
    expect(container.textContent).toContain(raw);
  });

  it("危险协议链接被 urlTransform 过滤,javascript: 不落进 href", () => {
    const { container } = render(
      <MarkdownBody
        body={"[点我](javascript:alert(1)) 与 [文档](https://example.com)"}
      />,
    );
    const links = Array.from(container.querySelectorAll("a"));
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link.getAttribute("href") ?? "").not.toMatch(/^javascript:/i);
    }
    expect(links[1].getAttribute("href")).toBe("https://example.com");
  });
});
