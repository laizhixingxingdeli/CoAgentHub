import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PARTICIPANT_TOKEN_KEY } from "@/lib/api-client";
import { groupMessageFrame } from "@/test/frames";
import { MockWebSocket } from "@/test/ws-mock";
import {
  __resetUnreadStore,
  markRead,
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
    localStorage.setItem(PARTICIPANT_TOKEN_KEY, "tok-abc");
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
    localStorage.setItem(PARTICIPANT_TOKEN_KEY, "tok-abc");
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
    localStorage.setItem(PARTICIPANT_TOKEN_KEY, "tok-abc");
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
    localStorage.setItem(PARTICIPANT_TOKEN_KEY, "tok-abc");
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
    localStorage.setItem(PARTICIPANT_TOKEN_KEY, "tok-abc");
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
    localStorage.setItem(PARTICIPANT_TOKEN_KEY, "tok-abc");
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
    localStorage.setItem(PARTICIPANT_TOKEN_KEY, "tok-abc");
    stubWebSocket();

    const { result } = renderHook(() => useUnread());
    act(() => updateLastMessage("group-1", "加载历史的最新一条"));

    expect(result.current.lastMessageByGroup.get("group-1")?.body).toBe(
      "加载历史的最新一条",
    );
    // Seeding never touches the unread badge.
    expect(result.current.unread.size).toBe(0);
  });

  it("does not connect without a token (silent)", () => {
    stubWebSocket();
    const { result } = renderHook(() => useUnread());
    expect(MockWebSocket.instances).toHaveLength(0);
    expect(result.current.unread.size).toBe(0);
  });

  it("starts the socket after a token is bound (navigation pulse)", () => {
    stubWebSocket();
    renderHook(() => useUnread());
    expect(MockWebSocket.instances).toHaveLength(0);

    localStorage.setItem(PARTICIPANT_TOKEN_KEY, "tok-abc");
    act(() => syncUnreadConnection());
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).toBe(
      `ws://${window.location.host}/api/ws?token=tok-abc`,
    );
  });

  it("reconnects when the token is re-bound to a different value", () => {
    localStorage.setItem(PARTICIPANT_TOKEN_KEY, "tok-1");
    stubWebSocket();

    renderHook(() => useUnread());
    expect(MockWebSocket.instances).toHaveLength(1);

    localStorage.setItem(PARTICIPANT_TOKEN_KEY, "tok-2");
    act(() => syncUnreadConnection());

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.instances[1].url).toBe(
      `ws://${window.location.host}/api/ws?token=tok-2`,
    );
    // The old socket was torn down, not left connected.
    expect(MockWebSocket.instances[0].closed).toBe(true);
  });

  it("keeps the same socket when the token is unchanged (no restart)", () => {
    localStorage.setItem(PARTICIPANT_TOKEN_KEY, "tok-1");
    stubWebSocket();

    renderHook(() => useUnread());
    const socket = MockWebSocket.instances[0];

    act(() => syncUnreadConnection());
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(socket.closed).toBe(false);
  });

  it("reconnects with exponential backoff 1s→2s→4s… capped at 30s", () => {
    vi.useFakeTimers();
    localStorage.setItem(PARTICIPANT_TOKEN_KEY, "tok-abc");
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
