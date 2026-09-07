import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockWebSocket } from "@/test/ws-mock";
import { mergeGroupMessages, useGroupWs } from "./use-group-ws";

function stubWebSocket() {
  vi.stubGlobal("WebSocket", MockWebSocket);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

beforeEach(() => {
  MockWebSocket.reset();
});

describe("useGroupWs (ticket 14)", () => {
  it("connects to ws://<host>/api/ws as Local User", () => {
    stubWebSocket();

    renderHook(() => useGroupWs("group-1", vi.fn()));

    expect(MockWebSocket.instances).toHaveLength(1);
    // Dev goes through the vite proxy on :5173, prod through serve.mjs :3000 —
    // the host always comes from the current page.
    expect(MockWebSocket.instances[0].url).toBe(
      `ws://${window.location.host}/api/ws`,
    );
  });

  it("forwards group_message frames for the subscribed group and reports connected", () => {
    stubWebSocket();
    const onEvent = vi.fn();

    const { result } = renderHook(() => useGroupWs("group-1", onEvent));
    const ws = MockWebSocket.instances[0];

    act(() => ws.open());
    expect(result.current.connected).toBe(true);

    const message = {
      id: "msg-ws-1",
      groupId: "group-1",
      senderId: "participant-1",
      parentId: null,
      audience: "broadcast",
      audienceRef: null,
      body: "实时新消息",
      depth: 0,
      createdAt: "2026-08-02T00:00:00.000Z",
    };
    act(() =>
      ws.receive(
        JSON.stringify({ type: "group_message", groupId: "group-1", message }),
      ),
    );

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith({
      type: "group_message",
      groupId: "group-1",
      message,
    });
  });

  it("forwards group_message_updated with the full updated row (ticket 22)", () => {
    stubWebSocket();
    const onEvent = vi.fn();

    renderHook(() => useGroupWs("group-1", onEvent));
    const ws = MockWebSocket.instances[0];
    act(() => ws.open());

    const message = {
      id: "msg-ws-1",
      groupId: "group-1",
      senderId: "participant-1",
      parentId: null,
      audience: "broadcast",
      audienceRef: null,
      body: "改后内容",
      depth: 0,
      createdAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:05:00.000Z",
    };
    act(() =>
      ws.receive(
        JSON.stringify({
          type: "group_message_updated",
          groupId: "group-1",
          message,
        }),
      ),
    );

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith({
      type: "group_message_updated",
      groupId: "group-1",
      message,
    });
  });

  it("forwards group_message_deleted with only the id (ticket 22)", () => {
    stubWebSocket();
    const onEvent = vi.fn();

    renderHook(() => useGroupWs("group-1", onEvent));
    const ws = MockWebSocket.instances[0];
    act(() => ws.open());

    act(() =>
      ws.receive(
        JSON.stringify({
          type: "group_message_deleted",
          groupId: "group-1",
          messageId: "msg-ws-1",
        }),
      ),
    );

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith({
      type: "group_message_deleted",
      groupId: "group-1",
      messageId: "msg-ws-1",
    });
  });

  it("forwards task_status_changed with its task snapshot", () => {
    stubWebSocket();
    const onEvent = vi.fn();
    renderHook(() => useGroupWs("group-1", onEvent));
    const ws = MockWebSocket.instances[0];
    act(() => ws.open());

    const task = {
      id: "task-1",
      status: "running",
      executorParticipantId: "participant-1",
      executorKey: "codex",
      brief: "# 实时需求",
      diffSummary: null,
      specRef: "specs/live.md",
      specHash: null,
      createdAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:01:00.000Z",
      retryCount: 0,
    };
    act(() =>
      ws.receive(
        JSON.stringify({
          type: "task_status_changed",
          groupId: "group-1",
          taskId: "task-1",
          status: "running",
          task,
        }),
      ),
    );

    expect(onEvent).toHaveBeenCalledWith({
      type: "task_status_changed",
      groupId: "group-1",
      taskId: "task-1",
      status: "running",
      task,
    });
  });

  it("ignores frames for other groups, other types and malformed payloads", () => {
    stubWebSocket();
    const onEvent = vi.fn();

    renderHook(() => useGroupWs("group-1", onEvent));
    const ws = MockWebSocket.instances[0];
    act(() => ws.open());

    const frame = (groupId: string) =>
      JSON.stringify({
        type: "group_message",
        groupId,
        message: { id: "m", groupId, body: "x" },
      });
    act(() => ws.receive(frame("group-other")));
    act(() =>
      ws.receive(
        JSON.stringify({ type: "presence", groupId: "group-1", online: true }),
      ),
    );
    act(() => ws.receive("not json"));
    act(() => ws.receive(JSON.stringify({ type: "group_message" })));

    expect(onEvent).not.toHaveBeenCalled();
  });

  it("reconnects with exponential backoff 1s→2s→4s… capped at 30s", () => {
    vi.useFakeTimers();
    stubWebSocket();

    renderHook(() => useGroupWs("group-1", vi.fn()));

    // Drop the connection, then assert the retry fires exactly `delay` later:
    // 1s → 2s → 4s → 8s → 16s → 30s (cap) → 30s (stays capped).
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

  
  it("fires onReconnect only after a true reconnect, not the first open", () => {
    vi.useFakeTimers();
    stubWebSocket();
    const onReconnect = vi.fn();
    renderHook(() => useGroupWs("group-1", vi.fn(), { onReconnect }));
    const first = MockWebSocket.instances[0];
    act(() => first.open());
    expect(onReconnect).not.toHaveBeenCalled();

    act(() => first.close());
    act(() => vi.advanceTimersByTime(1000));
    const second = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    expect(second).not.toBe(first);
    act(() => second.open());
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("closes the socket on unmount and never reconnects", () => {
    vi.useFakeTimers();
    stubWebSocket();

    const { unmount } = renderHook(() => useGroupWs("group-1", vi.fn()));
    const ws = MockWebSocket.instances[0];

    unmount();
    expect(ws.closed).toBe(true);

    act(() => vi.advanceTimersByTime(60_000));
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("does not connect without a group id", () => {
    stubWebSocket();
    renderHook(() => useGroupWs(undefined, vi.fn()));
    expect(MockWebSocket.instances).toHaveLength(0);
  });
});

describe("mergeGroupMessages (ticket 14)", () => {
  it("appends incoming messages", () => {
    const prev = [{ id: "m1" }, { id: "m2" }];
    expect(mergeGroupMessages(prev, [{ id: "m3" }])).toEqual([
      { id: "m1" },
      { id: "m2" },
      { id: "m3" },
    ]);
  });

  it("de-dupes by id — a WS echo and a reload that re-fetches do not duplicate", () => {
    const prev = [{ id: "m1" }, { id: "m2" }];
    // Echo of m2 + a brand-new m3 + a duplicate within the same batch.
    const out = mergeGroupMessages(prev, [
      { id: "m2" },
      { id: "m3" },
      { id: "m2" },
    ]);
    expect(out).toEqual([{ id: "m1" }, { id: "m2" }, { id: "m3" }]);
  });

  it("re-sorts when an incoming message lands out of order", () => {
    const prev = [{ id: "m1" }, { id: "m3" }];
    const out = mergeGroupMessages(prev, [{ id: "m2" }]);
    expect(out.map((m) => m.id)).toEqual(["m1", "m2", "m3"]);
  });

  it("does not mutate the previous list", () => {
    const prev = [{ id: "m1" }];
    const out = mergeGroupMessages(prev, [{ id: "m2" }]);
    expect(prev).toEqual([{ id: "m1" }]);
    expect(out).not.toBe(prev);
  });
});
