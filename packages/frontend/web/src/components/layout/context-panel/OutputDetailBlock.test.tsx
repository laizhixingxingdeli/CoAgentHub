import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFetchMock, jsonResponse } from "@/test/utils";
import { OutputDetailBlock } from "./OutputDetailBlock";

const TEXT_WITH_ID = "[思考 #t7] 先确认守卫在哪个文件";

function renderBlock(text: string, taskId = "t-1") {
  return render(
    <OutputDetailBlock groupId="g-1" taskId={taskId} text={text} />,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OutputDetailBlock 单条明细展开", () => {
  it("无 #id 的纯文本行渲染为文本,不出现可点击控件(不成为按钮/空壳)", () => {
    renderBlock("line1\nline2\nline3");
    expect(screen.getByTestId("task-live-output")).toHaveTextContent(
      "line1\nline2\nline3",
      { normalizeWhitespace: false },
    );
    expect(
      screen.queryByTestId(/^output-entry-toggle-/),
    ).not.toBeInTheDocument();
  });

  it("带 #id 的行渲染为可展开控件;点击按正确 URL 请求单条明细并就地展示完整原文", async () => {
    const fetchMock = createFetchMock([
      {
        match: (url) => url === "/api/groups/g-1/tasks/t-1/output/t7",
        respond: () =>
          jsonResponse({
            id: "t7",
            kind: "thinking",
            at: "2026-08-27T04:00:00.000Z",
            text: "完整原文:守卫在 requirement-workspace.tsx 的 outputTail 优先级里",
          }),
      },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    renderBlock(TEXT_WITH_ID);
    const toggle = screen.getByTestId("output-entry-toggle-t7");
    expect(toggle).toHaveTextContent(TEXT_WITH_ID);

    fireEvent.click(toggle);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/groups/g-1/tasks/t-1/output/t7",
    );
    expect(
      await screen.findByTestId("output-entry-detail-t7"),
    ).toHaveTextContent(
      "完整原文:守卫在 requirement-workspace.tsx 的 outputTail 优先级里",
    );
  });

  it("请求期间显示加载状态,完成后替换为完整原文", async () => {
    let resolveFetch!: (r: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderBlock(TEXT_WITH_ID);
    fireEvent.click(screen.getByTestId("output-entry-toggle-t7"));
    expect(screen.getByTestId("output-entry-detail-t7")).toHaveTextContent(
      "加载中",
    );

    resolveFetch(
      jsonResponse({ id: "t7", kind: "thinking", at: "…", text: "终于加载完" }),
    );
    expect(
      await screen.findByTestId("output-entry-detail-t7"),
    ).toHaveTextContent("终于加载完");
  });

  it("404(明细已被清理)→ 就地显示可理解的失败原因,不静默收起", async () => {
    const fetchMock = createFetchMock([
      {
        match: () => true,
        respond: () =>
          jsonResponse(
            {
              message: "明细文件不存在(可能已被 14 天清理,或该任务无明细记录)",
            },
            404,
          ),
      },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    renderBlock(TEXT_WITH_ID);
    fireEvent.click(screen.getByTestId("output-entry-toggle-t7"));
    expect(
      await screen.findByTestId("output-entry-detail-t7"),
    ).toHaveTextContent("明细文件不存在");
    expect(screen.getByTestId("output-entry-detail-t7")).toHaveTextContent(
      "14 天清理",
    );
  });

  it("非 2xx 且无 message → 显示状态码失败文案", async () => {
    const fetchMock = createFetchMock([
      {
        match: () => true,
        respond: () => jsonResponse({}, 500),
      },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    renderBlock(TEXT_WITH_ID);
    fireEvent.click(screen.getByTestId("output-entry-toggle-t7"));
    expect(
      await screen.findByTestId("output-entry-detail-t7"),
    ).toHaveTextContent("明细获取失败: HTTP 500");
  });

  it("网络失败 → 就地显示网络错误文案", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    renderBlock(TEXT_WITH_ID);
    fireEvent.click(screen.getByTestId("output-entry-toggle-t7"));
    expect(
      await screen.findByTestId("output-entry-detail-t7"),
    ).toHaveTextContent("网络错误");
  });

  it("追加新行(rerender 更长文本)→ 已展开条目保持展开,新行正常渲染", async () => {
    const fetchMock = createFetchMock([
      {
        match: () => true,
        respond: () =>
          jsonResponse({
            id: "t7",
            kind: "thinking",
            at: "…",
            text: "t7 的完整原文",
          }),
      },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = renderBlock(TEXT_WITH_ID);
    fireEvent.click(screen.getByTestId("output-entry-toggle-t7"));
    expect(
      await screen.findByTestId("output-entry-detail-t7"),
    ).toHaveTextContent("t7 的完整原文");

    rerender(
      <OutputDetailBlock
        groupId="g-1"
        taskId="t-1"
        text={`${TEXT_WITH_ID}\n[思考 #t8] 追加的思考`}
      />,
    );
    // 已展开的 t7 仍保持展开,追加的 t8 正常渲染为可展开控件。
    expect(screen.getByTestId("output-entry-detail-t7")).toHaveTextContent(
      "t7 的完整原文",
    );
    expect(screen.getByTestId("output-entry-toggle-t8")).toHaveTextContent(
      "[思考 #t8] 追加的思考",
    );
  });

  it("折叠后再次展开复用已取明细,不重复请求", async () => {
    const fetchMock = createFetchMock([
      {
        match: () => true,
        respond: () =>
          jsonResponse({
            id: "t7",
            kind: "thinking",
            at: "…",
            text: "已取回的原文",
          }),
      },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    renderBlock(TEXT_WITH_ID);
    const toggle = screen.getByTestId("output-entry-toggle-t7");
    fireEvent.click(toggle);
    expect(
      await screen.findByTestId("output-entry-detail-t7"),
    ).toHaveTextContent("已取回的原文");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 折叠 → 再展开:详情复用缓存,不重复请求。
    fireEvent.click(toggle);
    expect(
      screen.queryByTestId("output-entry-detail-t7"),
    ).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByTestId("output-entry-detail-t7")).toHaveTextContent(
      "已取回的原文",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
