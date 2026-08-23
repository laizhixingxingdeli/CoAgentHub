import { fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskItem } from "@/pages/app/groups/messages/TaskPanel";
import { createFetchMock, jsonResponse, renderWithProviders } from "@/test/utils";
import { MockWebSocket } from "@/test/ws-mock";
import { RequirementWorkspace } from "./requirement-workspace";

/**
 * RequirementWorkspace 响应式布局测试(requirement-pane-responsive):
 * - 窄视口(<1024px):单栏 —— 列表 / 详情二选一,点击行进详情,返回键回列表;
 * - 桌面(≥1024px):两栏 —— 列表与详情(含控制条)同时可见。
 * 断点判定走 useIsDesktop(读 window.innerWidth ≥ 1024),测试通过覆盖
 * window.innerWidth 模拟视口宽度;matchMedia 由 setup.ts 提供桩。
 */

function makeTask(overrides: Partial<TaskItem> & { id: string }): TaskItem {
  return {
    groupId: "group-1",
    messageId: "msg-1",
    executorParticipantId: "participant-1",
    executorKey: "codex",
    status: "running",
    checkpointRef: null,
    specRef: "specs/title-readability.md",
    specHash: null,
    diffSummary: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function workspaceFetchMock(tasks: TaskItem[]) {
  return createFetchMock([
    {
      match: (url) => /\/api\/groups\/[^/]+$/.test(String(url)),
      respond: () =>
        jsonResponse({
          id: "group-1",
          title: "评审任务",
          status: "active",
          projectPath: null,
        }),
    },
    {
      match: (url) => url.includes("/api/groups/") && url.endsWith("/messages"),
      respond: () => jsonResponse([]),
    },
    {
      match: (url) => url.includes("/api/groups/") && url.endsWith("/members"),
      respond: () => jsonResponse([]),
    },
    {
      match: (url) => url.includes("/api/groups/") && url.endsWith("/tasks"),
      respond: () => jsonResponse(tasks),
    },
  ]);
}

/** 覆盖 jsdom 默认 innerWidth(1024),模拟指定视口宽度。 */
function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
}

function renderWorkspace(tasks: TaskItem[]) {
  vi.stubGlobal("fetch", workspaceFetchMock(tasks));
  return renderWithProviders(<RequirementWorkspace groupId="group-1" />);
}

const TWO_REQUIREMENTS = [
  makeTask({ id: "task-a", specRef: "specs/a.md", brief: "# 需求A" }),
  makeTask({ id: "task-b", specRef: "specs/b.md", brief: "# 需求B" }),
];

beforeEach(() => {
  MockWebSocket.reset();
  vi.stubGlobal("WebSocket", MockWebSocket);
  // 清掉可能残留的身份绑定,保证 canControl 判定确定性;setup.ts 写入的语言
  // 会被清掉,需补回(否则 t() 回落 en-US 导致中文断言失配)。
  localStorage.clear();
  localStorage.setItem("coagenthub.lang", "zh");
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as { innerWidth?: number }).innerWidth;
});

describe("RequirementWorkspace 响应式布局", () => {
  it("窄视口(<1024px)单栏:默认列表,点击行进详情,返回键回列表", async () => {
    setViewport(500);
    renderWorkspace(TWO_REQUIREMENTS);

    // 默认单栏列表:详情不渲染。
    expect(await screen.findByTestId("requirement-list")).toBeInTheDocument();
    expect(screen.queryByTestId("requirement-detail-panel")).not.toBeInTheDocument();

    // 点击「需求A」行 → 切到详情(含控制条),列表隐藏。
    fireEvent.click(screen.getByTestId("requirement-row-specs/a.md"));
    expect(await screen.findByTestId("requirement-detail-panel")).toBeInTheDocument();
    expect(screen.getByTestId("requirement-control-bar")).toBeInTheDocument();
    expect(screen.queryByTestId("requirement-list")).not.toBeInTheDocument();

    // 返回键 → 回到列表,详情隐藏。
    fireEvent.click(screen.getByTestId("requirement-mobile-back"));
    expect(await screen.findByTestId("requirement-list")).toBeInTheDocument();
    expect(screen.queryByTestId("requirement-detail-panel")).not.toBeInTheDocument();
  });

  it("窄视口单栏切换:重新选中另一需求,详情随之切换", async () => {
    setViewport(500);
    renderWorkspace(TWO_REQUIREMENTS);

    fireEvent.click(await screen.findByTestId("requirement-row-specs/a.md"));
    expect(await screen.findByText("需求A")).toBeInTheDocument();

    // 返回列表 → 点「需求B」→ 详情切到 B。
    fireEvent.click(screen.getByTestId("requirement-mobile-back"));
    fireEvent.click(await screen.findByTestId("requirement-row-specs/b.md"));
    expect(await screen.findByTestId("requirement-detail-panel")).toBeInTheDocument();
    expect(screen.getByText("需求B")).toBeInTheDocument();
    expect(screen.queryByText("需求A")).not.toBeInTheDocument();
  });

  it("桌面(≥1024px)两栏:列表与详情(含控制条)同时可见", async () => {
    setViewport(1280);
    renderWorkspace(TWO_REQUIREMENTS);

    expect(await screen.findByTestId("requirement-list")).toBeInTheDocument();
    expect(await screen.findByTestId("requirement-detail-panel")).toBeInTheDocument();
    expect(screen.getByTestId("requirement-control-bar")).toBeInTheDocument();
    // 两栏模式下默认选中最新需求(需求B),列表行仍可见;详情区标题同为 B。
    expect(screen.getByTestId("requirement-row-specs/a.md")).toBeInTheDocument();
    expect(
      within(screen.getByTestId("requirement-detail-panel")).getByText("需求B"),
    ).toBeInTheDocument();
  });
});
