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
      match: (url) => url.endsWith("/api/agents"),
      respond: () => jsonResponse([]),
    },
    {
      match: (url) => url.includes("/api/groups/") && url.endsWith("/members"),
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

  it("/files 渲染文件页", async () => {
    vi.stubGlobal("fetch", routerFetchMock());
    renderWithProviders(<App />, "/files");

    // The page heading and the sidebar nav item both contain "文件传输".
    expect(await screen.findAllByText("文件传输")).not.toHaveLength(0);
    // The upload control is a <label> (Button asChild), not a real button.
    expect(await screen.findByText("上传文件")).toBeInTheDocument();
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

  it("/groups/:id 渲染群组消息流页", async () => {
    vi.stubGlobal("fetch", routerFetchMock());
    renderWithProviders(<App />, "/groups/group-1");

    expect(await screen.findByText("群组消息流")).toBeInTheDocument();
    expect(
      await screen.findByText("暂无消息,发送第一条吧"),
    ).toBeInTheDocument();
  });

  it("/groups/:id/members 渲染群组成员管理页", async () => {
    vi.stubGlobal("fetch", routerFetchMock());
    renderWithProviders(<App />, "/groups/group-1/members");

    expect(await screen.findByText("群组成员")).toBeInTheDocument();
    expect(await screen.findByText("返回消息流")).toBeInTheDocument();
  });

  it("未知路径渲染 404 fallback", async () => {
    vi.stubGlobal("fetch", routerFetchMock());
    renderWithProviders(<App />, "/no-such-page");

    expect(await screen.findByText("404:页面不存在")).toBeInTheDocument();
  });
});
