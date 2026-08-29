import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OutputDetailBlock } from "./OutputDetailBlock";

/**
 * 行渲染的空行保真(line-spacing 修复票):
 * 带 #id 的动作行是块级 span,自带换行;若行间再叠加 `\n` 文本节点,会在
 * 每个动作行上下各产生一个额外空行(基线空行占比 45%)。修复后 `\n` 只在
 * 相邻两行都是纯文本时插入 —— 动作行逐条紧邻,真实空行原样保留。
 *
 * jsdom 不做布局,空行无法用几何量断言;这里直接断言渲染结构:
 *  - 换行文本节点(`\n`)是空行的唯一来源,且只能出现在两个纯文本行之间;
 *  - textContent 里不得出现 `\n\n`(双换行=空行)或块级 span 旁的游离 `\n`。
 */

function renderBlock(text: string) {
  return render(<OutputDetailBlock groupId="g-1" taskId="t-1" text={text} />);
}

function container() {
  return screen.getByTestId("task-live-output");
}

/** 容器直接子节点的文本节点内容;非文本节点(块级 span)为 null。 */
function directTextNodes(): (string | null)[] {
  return Array.from(container().childNodes).map((node) =>
    node.nodeType === Node.TEXT_NODE ? node.textContent : null,
  );
}

describe("OutputDetailBlock 行渲染:动作行紧邻,真实空行保留", () => {
  it("相邻动作行(#id)逐条紧邻:块级 span 之间无任何文本节点", () => {
    renderBlock("[命令 #t1] pnpm test\n[工具 #t2] read file\n[汇报 #t3] 完成");
    // 三个块级 span 直接相邻 → 动作行之间没有换行文本节点,渲染无空行。
    expect(directTextNodes()).toEqual([null, null, null]);
    // 无真实空行的输出渲染后空行占比 0%(基线 45%)。
    expect(container().textContent).not.toContain("\n");
  });

  it("纯文本行之间保留换行分隔(不带 #id 的行仍需 `\\n` 分行)", () => {
    renderBlock("line1\nline2\nline3");
    expect(container()).toHaveTextContent("line1\nline2\nline3", {
      normalizeWhitespace: false,
    });
    expect(directTextNodes()).toEqual(["line1", "\n", "line2", "\n", "line3"]);
  });

  it("纯文本行与动作行交界处无叠加空行:块级 span 自带换行,不再叠加 `\\n`", () => {
    renderBlock("line1\n[工具 #t2] read\nline3");
    // 纯文本行两边都是块级 span → 文本节点里没有 \n,交界处只有一个换行。
    expect(directTextNodes()).toEqual(["line1", null, "line3"]);
    expect(container().textContent).not.toContain("\n");
  });

  it("原始输出中的真实空行原样保留(空行两侧都是纯文本)", () => {
    renderBlock("line1\n\nline2");
    expect(container()).toHaveTextContent("line1\n\nline2", {
      normalizeWhitespace: false,
    });
    // React 不渲染空字符串文本节点:空行只体现为两侧各一个 \n 文本节点。
    expect(directTextNodes()).toEqual(["line1", "\n", "\n", "line2"]);
  });

  it("动作行旁的真实空行保留:空行的 `\\n` 在纯文本一侧,不叠加", () => {
    // 空行夹在纯文本与动作行之间:纯文本侧的 \n 保留空行,动作行侧不再叠加。
    renderBlock("line1\n\n[工具 #t2] read\n\nline3");
    expect(directTextNodes()).toEqual(["line1", "\n", null, "\n", "line3"]);
    // 渲染文本不含双换行 → 无额外空行,真实空行恰好各保留一个。
    expect(container().textContent).not.toContain("\n\n");
  });

  it("典型混合流:渲染换行结构等于原始输出,无额外空行(占比 0% < 5%)", () => {
    const text = [
      "[思考 #t1] 先读规范",
      "[工具 #t2] read AGENTS.md",
      "[命令 #t3] pnpm test",
      "普通输出行",
      "",
      "[汇报 #t4] 完成",
    ].join("\n");
    renderBlock(text);
    // 唯一真实空行位于"普通输出行"与"汇报"之间,保留一个 \n;
    // 动作行之间、动作行与纯文本交界处均无 \n → 额外空行 0。
    expect(container().textContent).toBe(
      "[思考 #t1] 先读规范[工具 #t2] read AGENTS.md[命令 #t3] pnpm test普通输出行\n[汇报 #t4] 完成",
    );
  });
});
