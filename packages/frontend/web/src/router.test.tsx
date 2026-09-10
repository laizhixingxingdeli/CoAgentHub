import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFetchMock,
  jsonResponse,
  renderWithProviders,
} from "@/test/utils";
import { MockWebSocket } from "@/test/ws-mock";
import App from "./router";

function routerFetchMock() {
  return createFetchMock([
    {
      // Single-group detail (drives the title bar + read-only status).
      match: (url) =>
        /\/api\/groups\/[^/]+$/.test(String(url)) && !String(url).includes("?"),
      respond: () =>
        jsonResponse({ id: "group-1", title: "群组消息流", status: "active" }),
    },
    {
      match: (url) =>
        url.includes("/api/groups/") && url.split("?")[0].endsWith("/messages"),
      respond: () => jsonResponse([]),
    },
    {
      match: (url) => url.includes("/messages"),
      respond: () => jsonResponse({ data: [] }),
    },
    {
      match: (url) => url.endsWith("/api/file/list"),
      respond: () => jsonResponse([]),
    },
    {
      match: (url) => url.endsWith("/api/groups"),
      respond: () => jsonResponse([]),
    },
    {
      match: (url) => url.endsWith("/api/participants"),
      respond: () => jsonResponse([]),
    },
    {
      match: (url) => url.includes("/api/groups/") && url.endsWith("/members"),
      respond: () => jsonResponse([]),
    },
    {
      // 主区需求工作区:GET /tasks(无任务 → 空态)。
      match: (url) => url.includes("/api/groups/") && url.endsWith("/tasks"),
      respond: () => jsonResponse([]),
    },
  ]);
}

beforeEach(() => {
  // GroupLayout → useMessagesPage → useGroupWs 会 new WebSocket;/groups/:id
  // 路径若无 mock,jsdom 的 WS 实现各版本行为不一,标题拉取可能被错误打断。
  MockWebSocket.reset();
  vi.stubGlobal("WebSocket", MockWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("路由", () => {
  it("/ 重定向到 /groups 并渲染群组列表页", async () => {
    vi.stubGlobal("fetch", routerFetchMock());
    renderWithProviders(<App />, "/");

    expect(
      await screen.findByRole("button", { name: "创建群组" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("暂无群组,输入任务名点击「创建群组」开始"),
    ).toBeInTheDocument();
  });

  it("/files 已移除:重定向到 /groups(文件信令保留在 API 层,UI 不再提供)", async () => {
    vi.stubGlobal("fetch", routerFetchMock());
    renderWithProviders(<App />, "/files");

    // 文件页已从导航与路由移除:重定向到群列表。
    expect(
      await screen.findByRole("button", { name: "创建群组" }),
    ).toBeInTheDocument();
  });

  it("/groups 渲染群组列表页", async () => {
    vi.stubGlobal("fetch", routerFetchMock());
    renderWithProviders(<App />, "/groups");

    expect(
      await screen.findByRole("button", { name: "创建群组" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("暂无群组,输入任务名点击「创建群组」开始"),
    ).toBeInTheDocument();
  });

  it("/groups/:id 渲染群组页:主区需求工作区且有设置入口", async () => {
    vi.stubGlobal("fetch", routerFetchMock());
    renderWithProviders(<App />, "/groups/group-1");

    // 主区先就绪(lazy + Suspense);标题栏异步 GET /api/groups/:id。
    // 用 testid 等标题栏出现,再断言 mock 的 title —— 比裸 findByText 更稳
    // (CI 曾因标题还是 fallback「群组消息」而找不到「群组消息流」)。
    expect(
      await screen.findByTestId("requirement-workspace"),
    ).toBeInTheDocument();
    expect(await screen.findByTestId("group-title-bar")).toHaveTextContent(
      "群组消息流",
    );
    expect(screen.getByTestId("open-group-settings")).toBeInTheDocument();
  });

  it("/groups/:id 不再渲染右栏上下文面板", async () => {
    vi.stubGlobal("fetch", routerFetchMock());
    renderWithProviders(<App />, "/groups/group-1");

    expect(
      await screen.findByTestId("requirement-workspace"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("context-panel")).toBeNull();
  });

  it("/groups/:id/settings 以抽屉打开设置且保留底层群页面", async () => {
    vi.stubGlobal("fetch", routerFetchMock());
    renderWithProviders(<App />, "/groups/group-1/settings");

    expect(
      await screen.findByTestId("group-settings-drawer"),
    ).toBeInTheDocument();
    expect(
      await screen.findByTestId("requirement-workspace"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("group-settings-drawer-content"),
    ).toBeInTheDocument();
    expect(screen.queryByText("返回消息流")).toBeNull();

    fireEvent.click(screen.getByTestId("close-group-settings"));
    await waitFor(() =>
      expect(screen.queryByTestId("group-settings-drawer")).toBeNull(),
    );
    expect(screen.getByTestId("requirement-workspace")).toBeInTheDocument();
  });

  it("/groups/:id/members 重定向到设置页", async () => {
    vi.stubGlobal("fetch", routerFetchMock());
    renderWithProviders(<App />, "/groups/group-1/members");

    expect(await screen.findByText("群设置")).toBeInTheDocument();
  });

  it("未知路径渲染 404 fallback", async () => {
    vi.stubGlobal("fetch", routerFetchMock());
    renderWithProviders(<App />, "/no-such-page");

    expect(await screen.findByText("404:页面不存在")).toBeInTheDocument();
  });
});
