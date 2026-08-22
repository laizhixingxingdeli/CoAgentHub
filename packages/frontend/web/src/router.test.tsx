import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFetchMock,
  jsonResponse,
  renderWithProviders,
} from "@/test/utils";
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
      match: (url) => url.includes("/api/groups/") && url.endsWith("/messages"),
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

    // 群标题(来自 GET /api/groups/:id)。
    expect(await screen.findByText("群组消息流")).toBeInTheDocument();
    // 主区:需求工作区(无任务 → TaskPanel 空态)。
    expect(await screen.findByTestId("requirement-workspace")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "群设置" })).toHaveAttribute(
      "href",
      "/groups/group-1/settings",
    );
  });

  it("/groups/:id 不再渲染右栏上下文面板", async () => {
    vi.stubGlobal("fetch", routerFetchMock());
    renderWithProviders(<App />, "/groups/group-1");

    expect(await screen.findByTestId("requirement-workspace")).toBeInTheDocument();
    expect(screen.queryByTestId("context-panel")).toBeNull();
  });

  it("/groups/:id/settings 渲染群组设置与成员管理页", async () => {
    vi.stubGlobal("fetch", routerFetchMock());
    renderWithProviders(<App />, "/groups/group-1/settings");

    expect(await screen.findByText("群设置")).toBeInTheDocument();
    expect(await screen.findByText("返回消息流")).toBeInTheDocument();
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
