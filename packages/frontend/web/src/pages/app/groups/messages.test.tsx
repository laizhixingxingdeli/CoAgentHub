import { screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import GroupLayout from "@/components/layout/group-layout";
import { createFetchMock, jsonResponse, renderWithProviders } from "@/test/utils";
import { MockWebSocket } from "@/test/ws-mock";
import GroupMessagesPage from "./messages";

function groupPageFetchMock() {
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
      respond: () => jsonResponse([]),
    },
  ]);
}

describe("群页面布局", () => {
  beforeEach(() => {
    MockWebSocket.reset();
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("主区显示需求工作区且不再渲染右侧 Context Panel", async () => {
    vi.stubGlobal("fetch", groupPageFetchMock());
    renderWithProviders(
      <GroupLayout groupId="group-1">
        <GroupMessagesPage />
      </GroupLayout>,
      "/groups/group-1",
    );

    expect(await screen.findByTestId("requirement-workspace")).toBeInTheDocument();
    expect(screen.queryByTestId("context-panel")).toBeNull();
    expect(screen.queryByTestId("context-panel-sheet")).toBeNull();
  });

  it("标题栏的设置入口指向群设置页", async () => {
    vi.stubGlobal("fetch", groupPageFetchMock());
    renderWithProviders(
      <GroupLayout groupId="group-1">
        <GroupMessagesPage />
      </GroupLayout>,
      "/groups/group-1",
    );

    expect(await screen.findByTestId("group-title-bar")).toHaveTextContent(
      "评审任务",
    );
    expect(screen.getByRole("link", { name: "群设置" })).toHaveAttribute(
      "href",
      "/groups/group-1/settings",
    );
  });
});
