import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import GroupLayout from "@/components/layout/group-layout";
import {
  createFetchMock,
  jsonResponse,
  renderWithProviders,
} from "@/test/utils";
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
    {
      match: (url) => String(url).endsWith("/api/participants"),
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

    expect(
      await screen.findByTestId("requirement-workspace"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("context-panel")).toBeNull();
    expect(screen.queryByTestId("context-panel-sheet")).toBeNull();
  });

  it("标题栏的设置入口打开抽屉且不导航", async () => {
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
    fireEvent.click(screen.getByTestId("open-group-settings"));
    expect(
      await screen.findByTestId("group-settings-drawer"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("requirement-workspace")).toBeInTheDocument();
    // The in-memory router used by renderWithProviders does not mirror
    // window.location; the still-mounted workspace is the navigation guard.
  });

  it("抽屉支持关闭按钮、遮罩与 Escape,未保存编辑会确认", async () => {
    vi.stubGlobal("fetch", groupPageFetchMock());
    renderWithProviders(
      <GroupLayout groupId="group-1">
        <GroupMessagesPage />
      </GroupLayout>,
      "/groups/group-1",
    );

    fireEvent.click(await screen.findByTestId("open-group-settings"));
    await screen.findByTestId("group-settings-drawer-content");
    fireEvent.change(screen.getByLabelText("群名称"), {
      target: { value: "未保存的群名" },
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByTestId("close-group-settings"));
    expect(screen.getByTestId("group-settings-drawer")).toBeInTheDocument();
    expect(confirm).toHaveBeenCalled();

    confirm.mockReturnValue(true);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByTestId("group-settings-drawer")).toBeNull(),
    );

    fireEvent.click(screen.getByTestId("open-group-settings"));
    await screen.findByTestId("group-settings-drawer");
    fireEvent.click(screen.getByRole("button", { name: "关闭群设置遮罩" }));
    await waitFor(() =>
      expect(screen.queryByTestId("group-settings-drawer")).toBeNull(),
    );
    confirm.mockRestore();
  });
});
