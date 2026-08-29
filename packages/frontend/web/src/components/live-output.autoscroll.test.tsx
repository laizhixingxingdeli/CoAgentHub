import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LiveOutput } from "./live-output";

/**
 * 输出容器的滚动定位(spec live-output-hide-thinking-and-autoscroll R3/R4):
 *  - R3:展开(挂载)即滚到底部 —— 停在顶部等于每次都要手动往下拖。
 *  - R4:追加新行时,仅当追加前距底 ≤32px 才跟随;用户上滚看历史时不被拉回。
 *
 * 与 OutputDetailBlock.autoscroll 同一套断言(两处滚动行为逐条一致);
 * jsdom 不做布局(scrollHeight/clientHeight 恒为 0),故在原型上装一组可控
 * 尺寸;scrollTop 用 jsdom 原生的可写属性,组件写入即为滚动位置。
 */

let viewport = { scrollHeight: 400, clientHeight: 100 };

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      return viewport.scrollHeight;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return viewport.clientHeight;
    },
  });
});

beforeEach(() => {
  viewport = { scrollHeight: 400, clientHeight: 100 };
});

/** 容器滚到底部时的 scrollTop(scrollHeight - clientHeight)。 */
function bottom(): number {
  return viewport.scrollHeight - viewport.clientHeight;
}

function renderBlock(text: string) {
  return render(<LiveOutput text={text} />);
}

/** 模拟「输出变长」:容器变高 + 组件收到更长的文本。 */
function append(
  rerender: (ui: ReactElement) => void,
  text: string,
  height = 600,
) {
  viewport = { ...viewport, scrollHeight: height };
  rerender(<LiveOutput text={text} />);
}

function container() {
  return screen.getByTestId("task-live-output");
}

describe("LiveOutput 输出容器滚动(R3/R4)", () => {
  it("展开(挂载)后初始滚动位置在底部,而不是停在顶部", () => {
    renderBlock("[命令 #t1] pnpm test\n[汇报 #t2] 完成");
    expect(container().scrollTop).toBe(bottom());
  });

  it("已在底部时追加新行 → 自动跟随到最新输出", () => {
    const { rerender } = renderBlock("[命令 #t1] pnpm test\n[工具 #t2] read");
    expect(container().scrollTop).toBe(bottom());

    append(rerender, "[命令 #t1] pnpm test\n[工具 #t2] read\n[工具 #t3] write");
    expect(container().scrollTop).toBe(bottom());
  });

  it("用户上滚看历史后追加新行 → 不被拉回底部(成败关键)", () => {
    const { rerender } = renderBlock("[命令 #t1] pnpm test\n[工具 #t2] read");
    // 用户向上滚动:落到顶部后浏览器会派发 scroll 事件。
    container().scrollTop = 0;
    fireEvent.scroll(container());

    append(rerender, "[命令 #t1] pnpm test\n[工具 #t2] read\n[工具 #t3] write");
    expect(container().scrollTop).toBe(0);
  });

  it("阈值内(追加前距底 32px)→ 仍跟随", () => {
    const { rerender } = renderBlock("[命令 #t1] pnpm test");
    container().scrollTop = bottom() - 32;
    fireEvent.scroll(container());

    append(rerender, "[命令 #t1] pnpm test\n[工具 #t2] read");
    expect(container().scrollTop).toBe(bottom());
  });

  it("阈值外(追加前距底 33px)→ 不跟随", () => {
    const { rerender } = renderBlock("[命令 #t1] pnpm test");
    const parked = bottom() - 33;
    container().scrollTop = parked;
    fireEvent.scroll(container());

    append(rerender, "[命令 #t1] pnpm test\n[工具 #t2] read");
    expect(container().scrollTop).toBe(parked);
  });

  it("上滚后滚回底部 → 重新跟随", () => {
    const { rerender } = renderBlock("[命令 #t1] pnpm test");
    container().scrollTop = 0;
    fireEvent.scroll(container());
    append(rerender, "[命令 #t1] pnpm test\n[工具 #t2] read");
    expect(container().scrollTop).toBe(0);

    // 用户自己滚回底部 → 继续跟随。
    container().scrollTop = bottom();
    fireEvent.scroll(container());
    append(
      rerender,
      "[命令 #t1] pnpm test\n[工具 #t2] read\n[工具 #t3] ls",
      800,
    );
    expect(container().scrollTop).toBe(bottom());
  });
});
