import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { groupMessageFrame } from "@/test/frames";
import { createFetchMock, jsonResponse } from "@/test/utils";
import { MockWebSocket } from "@/test/ws-mock";
import {
  __resetUnreadStore,
  markRead,
  seedGroupPreviews,
  setActiveGroupId,
  syncUnreadConnection,
  updateLastMessage,
  useUnread,
} from "./use-unread";

function stubWebSocket() {
  vi.stubGlobal("WebSocket", MockWebSocket);
}

afterEach(() => {
  __resetUnreadStore();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

beforeEach(() => {
  MockWebSocket.reset();
});

describe("useUnread (ticket 23)", () => {
  it("counts group_message frames per group while nothing is open", () => {
    stubWebSocket();

    const { result } = renderHook(() => useUnread());
    const ws = MockWebSocket.instances[0];
    act(() => ws.open());

    act(() => ws.receive(groupMessageFrame("group-1", "第一条")));
    act(() => ws.receive(groupMessageFrame("group-1", "第二条")));
    act(() => ws.receive(groupMessageFrame("group-2", "别的群")));

    expect(result.current.unread.get("group-1")).toBe(2);
    expect(result.current.unread.get("group-2")).toBe(1);
  });

  it("does not count messages for the currently open group", () => {
    stubWebSocket();
    act(() => setActiveGroupId("group-1"));

    const { result } = renderHook(() => useUnread());
    const ws = MockWebSocket.instances[0];
    act(() => ws.open());

    act(() => ws.receive(groupMessageFrame("group-1", "自己在看")));
    act(() => ws.receive(groupMessageFrame("group-2", "别人的")));

    expect(result.current.unread.get("group-1")).toBeUndefined();
    expect(result.current.unread.get("group-2")).toBe(1);
  });

  it("markRead clears a group's badge", () => {
    stubWebSocket();

    const { result } = renderHook(() => useUnread());
    const ws = MockWebSocket.instances[0];
    act(() => ws.open());
    act(() => ws.receive(groupMessageFrame("group-1", "第一条")));
    act(() => ws.receive(groupMessageFrame("group-1", "第二条")));
    expect(result.current.unread.get("group-1")).toBe(2);

    act(() => markRead("group-1"));
    expect(result.current.unread.get("group-1")).toBeUndefined();
  });

  it("entering a group clears its badge (setActiveGroupId)", () => {
    stubWebSocket();

    const { result } = renderHook(() => useUnread());
    const ws = MockWebSocket.instances[0];
    act(() => ws.open());
    act(() => ws.receive(groupMessageFrame("group-1", "来了")));
    expect(result.current.unread.get("group-1")).toBe(1);

    act(() => setActiveGroupId("group-1"));
    expect(result.current.activeGroupId).toBe("group-1");
    expect(result.current.unread.get("group-1")).toBeUndefined();
  });

  it("ignores updated/deleted frames, other frame types and malformed payloads", () => {
    stubWebSocket();

    const { result } = renderHook(() => useUnread());
    const ws = MockWebSocket.instances[0];
    act(() => ws.open());

    act(() =>
      ws.receive(groupMessageFrame("group-1", "改后", "group_message_updated")),
    );
    act(() =>
      ws.receive(
        JSON.stringify({
          type: "group_message_deleted",
          groupId: "group-1",
          messageId: "msg-x",
        }),
      ),
    );
    act(() =>
      ws.receive(JSON.stringify({ type: "presence", groupId: "group-1" })),
    );
    act(() => ws.receive("not json"));
    act(() => ws.receive(JSON.stringify({ type: "group_message" })));

    expect(result.current.unread.size).toBe(0);
  });

  it("feeds the last-message preview cache from group_message frames", () => {
    stubWebSocket();

    const { result } = renderHook(() => useUnread());
    const ws = MockWebSocket.instances[0];
    act(() => ws.open());
    act(() => ws.receive(groupMessageFrame("group-1", "最后一条正文")));

    expect(result.current.lastMessageByGroup.get("group-1")?.body).toBe(
      "最后一条正文",
    );
  });

  it("updateLastMessage seeds the preview from a non-WS source (messages page)", () => {
    stubWebSocket();

    const { result } = renderHook(() => useUnread());
    act(() => updateLastMessage("group-1", "加载历史的最新一条"));

    expect(result.current.lastMessageByGroup.get("group-1")?.body).toBe(
      "加载历史的最新一条",
    );
    // Seeding never touches the unread badge.
    expect(result.current.unread.size).toBe(0);
  });

  it("keeps the same socket when the navigation pulse repeats", () => {
    stubWebSocket();

    renderHook(() => useUnread());
    const socket = MockWebSocket.instances[0];

    act(() => syncUnreadConnection());
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(socket.closed).toBe(false);
  });

  it("reconnects with exponential backoff 1s→2s→4s… capped at 30s", () => {
    vi.useFakeTimers();
    stubWebSocket();

    renderHook(() => useUnread());

    const next = (delayMs: number) => {
      const before = MockWebSocket.instances.length;
      act(() => MockWebSocket.instances[before - 1].fail());
      act(() => vi.advanceTimersByTime(delayMs - 1));
      expect(MockWebSocket.instances).toHaveLength(before);
      act(() => vi.advanceTimersByTime(1));
      expect(MockWebSocket.instances).toHaveLength(before + 1);
    };

    next(1000);
    next(2000);
    next(4000);
    next(8000);
    next(16_000);
    next(30_000);
    next(30_000);
  });
});

describe("seedGroupPreviews (ticket: 侧栏预览对所有群生效)", () => {
  function seedFetchMock() {
    return createFetchMock([
      {
        match: (url) => String(url).includes("/api/groups/group-1/messages"),
        respond: () => jsonResponse([{ id: "m1", body: "群1最后一条" }]),
      },
      {
        match: (url) => String(url).includes("/api/groups/group-2/messages"),
        respond: () => jsonResponse([{ id: "m2", body: "群2最后一条" }]),
      },
    ]);
  }

  it("seeds a preview for every group from its newest message", async () => {
    stubWebSocket();
    const fetchMock = seedFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useUnread());
    await act(() => seedGroupPreviews(["group-1", "group-2"]));

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "/api/groups/group-1/messages?limit=1",
      "/api/groups/group-2/messages?limit=1",
    ]);

    // The newest row (last element, id-ascending) wins, never the older one.
    expect(result.current.lastMessageByGroup.get("group-1")?.body).toBe(
      "群1最后一条",
    );
    expect(result.current.lastMessageByGroup.get("group-2")?.body).toBe(
      "群2最后一条",
    );
    // Seeding never touches the unread badge.
    expect(result.current.unread.size).toBe(0);
  });

  it("degrades silently when a single group's fetch fails", async () => {
    stubWebSocket();
    vi.stubGlobal(
      "fetch",
      createFetchMock([
        {
          match: (url) => String(url).includes("/api/groups/group-1/messages"),
          respond: () => jsonResponse({ message: "not found" }, 404),
        },
        {
          match: (url) => String(url).includes("/api/groups/group-2/messages"),
          respond: () => jsonResponse([{ id: "m2", body: "群2最后一条" }]),
        },
      ]),
    );

    const { result } = renderHook(() => useUnread());
    await act(() => seedGroupPreviews(["group-1", "group-2"]));

    // group-1 keeps 暂无消息 (no entry), group-2 unaffected, nothing thrown.
    expect(result.current.lastMessageByGroup.has("group-1")).toBe(false);
    expect(result.current.lastMessageByGroup.get("group-2")?.body).toBe(
      "群2最后一条",
    );
  });

  it("is silent on network failure for a group (no throw, others seed)", async () => {
    stubWebSocket();
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("group-1")) {
        throw new TypeError("network down");
      }
      return jsonResponse([{ id: "m2", body: "群2最后一条" }]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useUnread());
    await act(() => seedGroupPreviews(["group-1", "group-2"]));

    expect(result.current.lastMessageByGroup.has("group-1")).toBe(false);
    expect(result.current.lastMessageByGroup.get("group-2")?.body).toBe(
      "群2最后一条",
    );
  });

  it("fetches each group at most once per session (no polling)", async () => {
    stubWebSocket();
    const fetchMock = seedFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useUnread());
    await act(() => seedGroupPreviews(["group-1", "group-2"]));
    await act(() => seedGroupPreviews(["group-1", "group-2"]));
    await act(() => seedGroupPreviews(["group-1"]));

    // 4 fetches max: one per group across the whole session.
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes("/messages")),
    ).toHaveLength(2);
    expect(result.current.lastMessageByGroup.get("group-1")?.body).toBe(
      "群1最后一条",
    );
  });

  it("skips groups that already hold a preview (WS frame or message page)", async () => {
    stubWebSocket();
    const fetchMock = seedFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useUnread());
    const ws = MockWebSocket.instances[0];
    act(() => ws.open());
    act(() => ws.receive(groupMessageFrame("group-1", "WS 实时帧")));

    await act(() => seedGroupPreviews(["group-1"]));

    // The WS-fed preview wins; no fetch was issued for group-1.
    expect(result.current.lastMessageByGroup.get("group-1")?.body).toBe(
      "WS 实时帧",
    );
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).includes("/messages")),
    ).toHaveLength(0);
  });
});
