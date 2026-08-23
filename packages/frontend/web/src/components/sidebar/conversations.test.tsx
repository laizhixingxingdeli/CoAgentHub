import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Router, useLocation } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { SidebarProvider } from "@/components/ui/sidebar";
import { __resetUnreadStore } from "@/hooks/use-unread";
import { colorForId } from "@/lib/avatar-color";
import { groupMessageFrame } from "@/test/frames";
import { createFetchMock, jsonResponse } from "@/test/utils";
import { MockWebSocket } from "@/test/ws-mock";
import { ConversationList } from "./conversations";

/** Records the current route into a test-local variable (wouter's memory
 *  location hook cannot be called outside render). */
function LocationProbe({ onPath }: { onPath: (path: string) => void }) {
  const [path] = useLocation();
  useEffect(() => {
    onPath(path);
  }, [path, onPath]);
  return null;
}

const GROUPS = [
  {
    id: "group-1",
    title: "评审任务",
    status: "active",
    memberCount: 3,
    createdAt: "2026-08-01T00:00:00.000Z",
  },
  {
    id: "group-2",
    title: "部署上线",
    status: "active",
    memberCount: 2,
    createdAt: "2026-08-02T00:00:00.000Z",
  },
];

function conversationFetchMock(groups: unknown[] = GROUPS) {
  return createFetchMock([
    {
      match: (url) => String(url).includes("/api/groups"),
      // GET /groups 已改为 {items,total} 形状(ticket: 群列表分页)。
      respond: () => jsonResponse({ items: groups, total: groups.length }),
    },
  ]);
}

function renderConversations(path = "/") {
  const hook = memoryLocation({ path }).hook;
  let currentPath = path;
  const utils = render(
    <Router hook={hook}>
      <SidebarProvider>
        <ConversationList />
        <LocationProbe onPath={(p) => (currentPath = p)} />
      </SidebarProvider>
    </Router>,
  );
  return { ...utils, getPath: () => currentPath };
}

beforeEach(() => {
  MockWebSocket.reset();
  __resetUnreadStore();
});

afterEach(() => {
  __resetUnreadStore();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("ConversationList (ticket 23)", () => {
  it("renders the active groups with a preview placeholder", async () => {
    vi.stubGlobal("fetch", conversationFetchMock());

    renderConversations();

    expect(await screen.findByText("评审任务")).toBeInTheDocument();
    expect(screen.getByText("部署上线")).toBeInTheDocument();
    // No message seen yet for either group.
    expect(screen.getAllByText("暂无消息")).toHaveLength(2);
  });

  it("shows 还没有群组 for an empty list", async () => {
    vi.stubGlobal("fetch", conversationFetchMock([]));

    renderConversations();

    expect(await screen.findByText("还没有群组")).toBeInTheDocument();
  });

  it("fills a preview for every group from its messages endpoint, not just the open one", async () => {
    vi.stubGlobal(
      "fetch",
      createFetchMock([
        // Messages endpoints must be matched before the /api/groups list one.
        {
          match: (url) => String(url).includes("/api/groups/group-1/messages"),
          respond: () =>
            jsonResponse([
              { id: "m0", body: "评审任务较早一条" },
              { id: "m1", body: "评审任务最后一条" },
            ]),
        },
        {
          match: (url) => String(url).includes("/api/groups/group-2/messages"),
          respond: () => jsonResponse([{ id: "m2", body: "部署上线最新" }]),
        },
        {
          match: (url) => String(url).includes("/api/groups"),
          respond: () => jsonResponse({ items: GROUPS, total: GROUPS.length }),
        },
      ]),
    );

    renderConversations();

    // Newest row wins for group-1; group-2 was never opened yet.
    expect(await screen.findByText("评审任务最后一条")).toBeInTheDocument();
    expect(screen.getByText("部署上线最新")).toBeInTheDocument();
    expect(screen.queryByText("暂无消息")).not.toBeInTheDocument();
  });

  it("keeps 暂无消息 for a group whose preview fetch fails, others unaffected", async () => {
    vi.stubGlobal(
      "fetch",
      createFetchMock([
        {
          match: (url) => String(url).includes("/api/groups/group-1/messages"),
          respond: () => jsonResponse({ message: "not found" }, 404),
        },
        {
          match: (url) => String(url).includes("/api/groups/group-2/messages"),
          respond: () => jsonResponse([{ id: "m2", body: "部署上线最新" }]),
        },
        {
          match: (url) => String(url).includes("/api/groups"),
          respond: () => jsonResponse({ items: GROUPS, total: GROUPS.length }),
        },
      ]),
    );

    renderConversations();

    expect(await screen.findByText("部署上线最新")).toBeInTheDocument();
    // group-1 degrades to the placeholder; the rest of the list stays intact.
    expect(screen.getByText("评审任务")).toBeInTheDocument();
    expect(screen.getAllByText("暂无消息")).toHaveLength(1);
  });

  it("stays silent when the fetch fails (no error, no fake empty state)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ message: "unauthorized" }, 401)),
    );

    renderConversations();

    await waitFor(() =>
      expect(screen.queryByText("还没有群组")).not.toBeInTheDocument(),
    );
    expect(screen.queryByText("评审任务")).not.toBeInTheDocument();
  });

  it("shows the live unread badge and the WS-fed preview (latest body, truncated)", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal("fetch", conversationFetchMock());

    renderConversations();
    await screen.findByText("评审任务");

    // The store's resident socket delivers the frames that drive the badge.
    const ws = MockWebSocket.instances[0];
    act(() => ws.open());
    act(() =>
      ws.receive(
        groupMessageFrame("group-1", "这是一条很长的消息预览内容超过十二个字"),
      ),
    );

    expect(await screen.findByText("1")).toBeInTheDocument();
    // 19-char body truncated to the first 12 chars + "…".
    expect(screen.getByText("这是一条很长的消息预览内…")).toBeInTheDocument();

    // A newer frame replaces the preview and bumps the badge (2).
    act(() => ws.receive(groupMessageFrame("group-1", "又一条")));
    expect(await screen.findByText("2")).toBeInTheDocument();
    expect(screen.getByText("又一条")).toBeInTheDocument();
    expect(screen.getByText("暂无消息")).toBeInTheDocument(); // group-2 untouched
  });

  it("renders a group-first-char round avatar with a stable hash color", async () => {
    vi.stubGlobal("fetch", conversationFetchMock());

    renderConversations();
    await screen.findByText("评审任务");

    // 群首字圆标:标题首字即头像文本(评审任务 → 评,部署上线 → 部)。
    const avatar1 = screen.getByText("评");
    expect(avatar1).toBeInTheDocument();
    expect(screen.getByText("部")).toBeInTheDocument();
    // 背景色类来自 colorForId(群 id) 的色板,群 id 稳定映射同色。
    expect(avatar1.className).toContain(colorForId("group-1").split(" ")[0]);
    expect(screen.getByText("部").className).toContain(
      colorForId("group-2").split(" ")[0],
    );
  });

  it("caps the unread badge at 99+", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal("fetch", conversationFetchMock());

    renderConversations();
    await screen.findByText("评审任务");

    const ws = MockWebSocket.instances[0];
    act(() => ws.open());
    act(() => {
      for (let i = 0; i < 100; i += 1) {
        ws.receive(groupMessageFrame("group-1", `第 ${i} 条`));
      }
    });

    expect(await screen.findByText("99+")).toBeInTheDocument();
    expect(screen.queryByText("100")).not.toBeInTheDocument();
  });

  it("navigates to the message page and clears the badge on click", async () => {
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.stubGlobal("fetch", conversationFetchMock());

    const { getPath } = renderConversations();
    await screen.findByText("评审任务");

    const ws = MockWebSocket.instances[0];
    act(() => ws.receive(groupMessageFrame("group-1", "未读消息")));
    expect(await screen.findByText("1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: /评审任务/ }));

    await waitFor(() => expect(getPath()).toBe("/groups/group-1"));
    // markRead ran: the badge is gone and the item becomes the active one.
    await waitFor(() =>
      expect(screen.queryByText("1")).not.toBeInTheDocument(),
    );
  });

  it("highlights the currently open group", async () => {
    vi.stubGlobal("fetch", conversationFetchMock());

    renderConversations("/groups/group-1");
    await screen.findByText("评审任务");

    expect(screen.getByRole("link", { name: /评审任务/ })).toHaveAttribute(
      "data-active",
      "true",
    );
    expect(screen.getByRole("link", { name: /部署上线/ })).toHaveAttribute(
      "data-active",
      "false",
    );
  });
});
