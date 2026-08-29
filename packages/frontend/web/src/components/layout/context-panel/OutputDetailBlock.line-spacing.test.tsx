import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OutputDetailBlock } from "./OutputDetailBlock";

/**
 * 行渲染的空行保真(line-spacing 修复票,第 2 次尝试)。
 *
 * 第 1 次尝试只断言 DOM 文本节点与 jsdom textContent —— jsdom 不做布局,
 * 证明不了「真实空行在块级动作行前仍可见」,L2 真实 Chromium 检视发现
 * `line1\n\n[工具 #t2] read` 高度只有 40px(2 行行高):动作行前的真实空行
 * 被吞;对照 `[工具 #t2] read\n\nline3` 为 60px(3 行),问题非对称。
 *
 * 根因(CSS 2.1 空行盒规则):没有内容、也不以保留换行结尾的行盒,浏览器
 * 视为不存在。块级 span 之前的尾随 `\n` 恰好构成这样的空行盒 → 被丢弃;
 * 块级 span 之后的 `\n` 是行首换行,空行盒以保留换行结尾 → 存活。于是
 * 「空行在动作行前消失、在动作行后保留」。
 *
 * 本测试的 lineBoxCount() 建模浏览器判定行盒的同一规则(空行盒的存活条件),
 * 断言**渲染行盒数 === 原始逻辑行数**:多了 = 动作行间/旁叠加了额外空行,
 * 少了 = 真实空行被吞。jsdom 没有布局引擎,这是能在单测里等价证明真实
 * 浏览器布局的判定方式;L2 仍会用真实 Chromium 复核几何高度。
 */

function renderBlock(text: string) {
  return render(<OutputDetailBlock groupId="g-1" taskId="t-1" text={text} />);
}

function container() {
  return screen.getByTestId("task-live-output");
}

/**
 * 按 CSS 2.1 行盒规则统计容器渲染出的行盒数(与浏览器布局同源):
 *  - 文本字符进入当前行盒;`\n` 闭合当前行盒(使其以保留换行结尾)并开启新行盒;
 *  - 块级子元素(动作行)闭合当前行盒、自身占一行盒、然后开启新行盒;
 *  - 行盒闭合时:有内容或**以保留换行结尾**(被 `\n` 闭合)则真实存在,
 *    否则(空行盒、被块级边界或流末尾闭合)视为不存在。
 * 返回 { lineBoxes, blankBoxes }:blankBoxes 是存活的空行盒数(渲染空行数)。
 */
function countLineBoxes(pre: HTMLElement): {
  lineBoxes: number;
  blankBoxes: number;
} {
  let lineBoxes = 0;
  let blankBoxes = 0;
  let hasContent = false;
  let endsWithNewline = false;
  const flush = () => {
    if (hasContent || endsWithNewline) {
      lineBoxes += 1;
      if (!hasContent) blankBoxes += 1;
    }
    hasContent = false;
    endsWithNewline = false;
  };
  for (const node of Array.from(pre.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      for (const ch of node.textContent ?? "") {
        if (ch === "\n") {
          endsWithNewline = true;
          flush();
        } else {
          hasContent = true;
        }
      }
    } else {
      // 块级子元素:闭合当前(空)行盒;折叠态按钮为单行,块自身占一行盒。
      flush();
      lineBoxes += 1;
    }
  }
  flush();
  return { lineBoxes, blankBoxes };
}

/** 断言渲染行盒数等于原始逻辑行数(不多不少)。 */
function expectLineBoxes(text: string) {
  const rendered = countLineBoxes(container());
  const logicalLines = text.split("\n").length;
  expect(rendered.lineBoxes, `渲染行盒数应等于原始逻辑行数`).toBe(logicalLines);
  return rendered;
}

describe("OutputDetailBlock 行渲染:真实空行原样保留,动作行逐条紧邻", () => {
  it("真实空行位于动作行之前 → 空行盒仍存活(第 1 次尝试的失败点)", () => {
    renderBlock("line1\n\n[工具 #t2] read");
    // 3 个逻辑行(line1 / 空行 / 动作行)必须渲染出 3 个行盒 ——
    // 旧算法只产出 ["line1","\n",块级 span],尾随 \n 的空行盒被丢弃 → 2 盒,
    // 本断言在旧算法下失败。
    const rendered = expectLineBoxes("line1\n\n[工具 #t2] read");
    expect(rendered.blankBoxes).toBe(1);
  });

  it("真实空行位于动作行之后 → 空行盒仍存活", () => {
    renderBlock("[工具 #t2] read\n\nline3");
    const rendered = expectLineBoxes("[工具 #t2] read\n\nline3");
    expect(rendered.blankBoxes).toBe(1);
  });

  it("动作行两侧同时有真实空行 → 两侧空行盒都存活", () => {
    renderBlock("line1\n\n[工具 #t2] read\n\nline3");
    const rendered = expectLineBoxes("line1\n\n[工具 #t2] read\n\nline3");
    expect(rendered.blankBoxes).toBe(2);
  });

  it("相邻动作行逐条紧邻:块级 span 之间不产生任何空行盒", () => {
    renderBlock("[工具 #t1] a\n[命令 #t2] b\n[汇报 #t3] c");
    const rendered = expectLineBoxes(
      "[工具 #t1] a\n[命令 #t2] b\n[汇报 #t3] c",
    );
    expect(rendered.blankBoxes).toBe(0);
  });

  it("动作行之间的真实空行保留且只保留一个(不为修复前置空行引入双空行)", () => {
    renderBlock("[工具 #t1] a\n\n[命令 #t2] b");
    const rendered = expectLineBoxes("[工具 #t1] a\n\n[命令 #t2] b");
    expect(rendered.blankBoxes).toBe(1);
  });

  it("纯文本行之间的真实空行仍原样保留", () => {
    renderBlock("line1\n\nline2");
    const rendered = expectLineBoxes("line1\n\nline2");
    expect(rendered.blankBoxes).toBe(1);
  });

  it("连续多个真实空行逐个保留", () => {
    renderBlock("line1\n\n\nline3");
    const rendered = expectLineBoxes("line1\n\n\nline3");
    expect(rendered.blankBoxes).toBe(2);
  });

  it("典型混合流:动作行紧邻,唯一真实空行保留,空行占比 < 5%(基线 45%)", () => {
    // 接近真实输出规模:20 条连续动作行 + 1 普通行 + 1 真实空行 + 1 汇报。
    const lines = [
      ...Array.from(
        { length: 20 },
        (_, i) => `[工具 #t${i + 1}] step ${i + 1}`,
      ),
      "普通输出行",
      "",
      "[汇报 #t21] 完成",
    ];
    const text = lines.join("\n");
    renderBlock(text);
    const rendered = countLineBoxes(container());
    // 渲染行盒数 = 逻辑行数(无叠加空行、无吞空行);空行占比 1/23 < 5%。
    expect(rendered.lineBoxes).toBe(lines.length);
    expect(rendered.blankBoxes).toBe(1);
    expect(rendered.blankBoxes / rendered.lineBoxes).toBeLessThan(0.05);
  });

  it("行盒模型能识别旧结构(动作行前空行被吞)的失败 —— 模型非恒真", () => {
    // 旧算法对 "line1\n\n[工具 #t2] read" 的产物:文本节点与块级 span 直接
    // 相邻,空行只剩一个尾随 \n。模型按浏览器规则判为 2 行盒 ≠ 3 个逻辑行,
    // 证明本测试的判定方式确实能捕获该回归,不是恒真断言。
    const pre = document.createElement("pre");
    pre.append(
      "line1",
      "\n",
      Object.assign(document.createElement("span"), { className: "block" }),
    );
    expect(countLineBoxes(pre).lineBoxes).toBe(2);
  });
});
