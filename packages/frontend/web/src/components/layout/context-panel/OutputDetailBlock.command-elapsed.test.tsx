import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFetchMock, jsonResponse } from "@/test/utils";
import { OutputDetailBlock } from "./OutputDetailBlock";

/**
 * 运行中命令的已耗时(spec live-output-hide-thinking-and-autoscroll R8):
 * 执行器跑全量测试等长命令时实时输出静默,动作行要能显示「等了多久」。
 *
 * 依据:耗时按**明细条目的 `at`**(后端落盘时刻)推算 —— 摘要行本身不带时间戳,
 * 而 `GET /output/:entryId` 本来就返回 `at`,不必改摘要行的行格式
 * (spec 明确要求仍是一行一条目),也不必为计时新增接口。开始时刻取后端落盘
 * 时刻,还能让「组件中途才挂载(用户后来才展开)」也显示真实耗时。
 */

const NOW = Date.parse("2026-08-29T00:00:00.000Z");
/** 5 分 12 秒前开始(与 spec 里的示例 `5m12s` 同形)。 */
const STARTED_AT = new Date(NOW - 312_000).toISOString();
const COMMAND_LINE = "[命令 #t5] pnpm --filter server test";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function commandEntryFetch() {
  return createFetchMock([
    {
      match: () => true,
      respond: () =>
        jsonResponse({
          id: "t5",
          kind: "command",
          at: STARTED_AT,
          text: COMMAND_LINE,
        }),
    },
  ]);
}

describe("OutputDetailBlock 运行中命令的已耗时(R8)", () => {
  it("未完成的命令行尾显示已耗时,并随秒推进", async () => {
    const fetchMock = commandEntryFetch();
    vi.stubGlobal("fetch", fetchMock);

    render(
      <OutputDetailBlock
        groupId="g-1"
        taskId="t-1"
        text={COMMAND_LINE}
        running
      />,
    );
    await act(async () => undefined);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/groups/g-1/tasks/t-1/output/t5",
    );
    expect(screen.getByTestId("output-elapsed-t5")).toHaveTextContent(
      "(运行中 5m 12s)",
    );
    // 每秒重算一次(useLiveNow),静默期能看出「还在等」。
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(screen.getByTestId("output-elapsed-t5")).toHaveTextContent(
      "(运行中 5m 13s)",
    );
  });

  it("终态任务(running=false)不给命令计时,也不为此发请求", async () => {
    const fetchMock = commandEntryFetch();
    vi.stubGlobal("fetch", fetchMock);

    render(
      <OutputDetailBlock groupId="g-1" taskId="t-1" text={COMMAND_LINE} />,
    );
    await act(async () => undefined);

    expect(screen.queryByTestId("output-elapsed-t5")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("命令结束后(后续行追加)→ 耗时消失", async () => {
    const fetchMock = commandEntryFetch();
    vi.stubGlobal("fetch", fetchMock);

    const { rerender } = render(
      <OutputDetailBlock
        groupId="g-1"
        taskId="t-1"
        text={COMMAND_LINE}
        running
      />,
    );
    await act(async () => undefined);
    expect(screen.getByTestId("output-elapsed-t5")).toBeInTheDocument();

    // 命令行不再是最末条目 → 该命令已结束,不再计时。
    rerender(
      <OutputDetailBlock
        groupId="g-1"
        taskId="t-1"
        text={`${COMMAND_LINE}\n[工具 #t6] bash ok 42 passed`}
        running
      />,
    );
    await act(async () => undefined);
    expect(screen.queryByTestId("output-elapsed-t5")).toBeNull();
  });

  it("明细取不到(404)→ 不显示耗时,不猜一个开始时刻", async () => {
    const fetchMock = createFetchMock([
      {
        match: () => true,
        respond: () =>
          jsonResponse({ message: "明细文件不存在(可能已被 14 天清理)" }, 404),
      },
    ]);
    vi.stubGlobal("fetch", fetchMock);

    render(
      <OutputDetailBlock
        groupId="g-1"
        taskId="t-1"
        text={COMMAND_LINE}
        running
      />,
    );
    await act(async () => undefined);

    expect(screen.queryByTestId("output-elapsed-t5")).toBeNull();
    // 摘要行本身一字未改。
    expect(screen.getByTestId("output-entry-toggle-t5")).toHaveTextContent(
      COMMAND_LINE,
    );
  });
});
