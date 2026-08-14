import { useEffect, useRef, useState } from "react";
import { PARTICIPANT_ID_KEY } from "@/lib/api-client";

/** First reconnect delay; doubles per failed attempt until the cap below. */
const INITIAL_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30_000;

/**
 * The `group_message` frame pushed by the server WS hub (ticket 13). It is a
 * superset of the `GET /groups/:id/messages` row (adds contentType/updatedAt),
 * so a consumer can append it straight to the fetched list.
 */
export type WsGroupMessage = {
  id: string;
  groupId: string;
  senderId: string;
  parentId: string | null;
  audience: "broadcast" | "role" | "participant";
  audienceRef: string | null;
  body: string;
  contentType?: string | null;
  fileRef: {
    name: string;
    size: number;
    sha256: string;
    fetchUrl: string;
    expiresAt?: string;
  } | null;
  depth: number;
  createdAt: string;
  updatedAt?: string;
};

type GroupMessageEvent = {
  type: "group_message";
  groupId: string;
  message: WsGroupMessage;
};

type GroupMessageUpdatedEvent = {
  type: "group_message_updated";
  groupId: string;
  message: WsGroupMessage;
};

type GroupMessageDeletedEvent = {
  type: "group_message_deleted";
  groupId: string;
  messageId: string;
};

/** Any frame the server WS hub pushes for a group (tickets 13/22). */
export type WsGroupEvent =
  | GroupMessageEvent
  | GroupMessageUpdatedEvent
  | GroupMessageDeletedEvent;

/**
 * Loose shape of a raw WS frame, validated before forwarding as a typed
 * WsGroupEvent. Discriminants stay required so the `type` comparisons narrow
 * the frame — a `Partial<WsGroupEvent>` would widen them to `| undefined`,
 * which defeats union-member exclusion.
 */
type WsGroupFrame =
  | {
      type: "group_message" | "group_message_updated";
      groupId?: string;
      message?: WsGroupMessage;
    }
  | {
      type: "group_message_deleted";
      groupId?: string;
      messageId?: string;
    };

type MessageEventLike = { data: unknown };

/**
 * Merge incoming messages into an existing list: de-dupe by `id` (a WS echo of
 * a message the sender just POSTed, or a reload that re-fetches it, must not
 * duplicate). `prev` must already be sorted by id (server rows and previous
 * merges are); incoming frames arrive in server receive order, so the common
 * case is appending after the last element with no re-sort — only an
 * out-of-order incoming id triggers the full sort. Server message ids are
 * uuidv7 — time-ordered — so id order reproduces server receive order.
 */
export function mergeGroupMessages<T extends { id: string }>(
  prev: T[],
  incoming: readonly T[],
): T[] {
  const seen = new Set(prev.map((m) => m.id));
  const next = [...prev];
  let needsSort = false;
  for (const msg of incoming) {
    if (seen.has(msg.id)) {
      continue;
    }
    seen.add(msg.id);
    if (next.length > 0 && next[next.length - 1].id.localeCompare(msg.id) > 0) {
      needsSort = true;
    }
    next.push(msg);
  }
  if (needsSort) {
    next.sort((a, b) => a.id.localeCompare(b.id));
  }
  return next;
}

/**
 * Low-level participant-WS connection shared by the per-group message hook and the
 * global unread store (ticket 23).
 *
 * Opens `ws://<host>/api/ws?participantId=<id>` — `<host>` is the current page
 * host, so dev goes through the vite proxy on :5173 and prod through serve.mjs
 * on :3000. The id is re-read from localStorage on every (re)connect. Every
 * parsed frame (any type, any group) is delivered to `onFrame`; connection
 * state is reported through `onStatusChange`. Failed connections retry with
 * exponential backoff 1s→2s→4s… capped at 30s. The returned teardown detaches
 * the handlers and cancels any pending retry — the caller's own close must not
 * schedule a new attempt.
 */
export function connectParticipantWs(opts: {
  onFrame: (frame: unknown) => void;
  onStatusChange?: (connected: boolean) => void;
}): () => void {
  const { onFrame, onStatusChange } = opts;
  let disposed = false;
  // Backoff is reset per connection (fresh consumer mount = fresh sequence).
  let delay = INITIAL_RECONNECT_DELAY;
  let socket: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const connect = () => {
    if (disposed) {
      return;
    }
    const participantId = localStorage.getItem(PARTICIPANT_ID_KEY) ?? "";
    const url = `ws://${window.location.host}/api/ws?participantId=${encodeURIComponent(participantId)}`;
    socket = new WebSocket(url);

    socket.onopen = () => {
      if (disposed) {
        return;
      }
      delay = INITIAL_RECONNECT_DELAY;
      onStatusChange?.(true);
    };

    socket.onmessage = (event: MessageEventLike) => {
      if (disposed) {
        return;
      }
      let data: unknown;
      try {
        data = JSON.parse(String(event.data));
      } catch {
        return; // ignore malformed frames
      }
      onFrame(data);
    };

    socket.onclose = () => {
      if (disposed) {
        return;
      }
      onStatusChange?.(false);
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        connect();
      }, delay);
      delay = Math.min(delay * 2, MAX_RECONNECT_DELAY);
    };

    socket.onerror = () => {
      // The browser always fires `close` after `error`, which schedules the
      // retry; nothing to do here (and no double-retry).
    };
  };

  connect();

  return () => {
    disposed = true;
    clearTimer();
    if (socket) {
      // Detach handlers so the close event of our own teardown does not
      // schedule a retry.
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.close();
    }
  };
}

/**
 * Live message updates over the server WS hub (ticket 14).
 *
 * Opens a connection through `connectParticipantWs` and forwards the frames for the
 * subscribed group to `onEvent` (ticket 22): `group_message` /
 * `group_message_updated` carry the full message, `group_message_deleted`
 * carries only the id (the receiver marks the placeholder locally). Frames for
 * other groups are ignored, so one socket per group page stays isolated.
 */
export function useGroupWs(
  groupId: string | undefined,
  onEvent: (event: WsGroupEvent) => void,
): { connected: boolean } {
  // Keep the latest callback without re-running the connect effect.
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!groupId) {
      return;
    }

    const handleFrame = (data: unknown) => {
      if (!data || typeof data !== "object") {
        return;
      }
      const frame = data as WsGroupFrame;
      // Forward every group message frame for this group (ticket 22): new /
      // updated events carry a full message, deleted carries only the id —
      // groupId still filters, so one socket per group page stays isolated.
      if (
        frame.groupId !== groupId ||
        typeof frame.type !== "string" ||
        !frame.type.startsWith("group_message")
      ) {
        return;
      }
      if (frame.type === "group_message_deleted") {
        if (frame.messageId) {
          onEventRef.current({
            type: "group_message_deleted",
            groupId,
            messageId: frame.messageId,
          });
        }
        return;
      }
      if (frame.message?.id) {
        onEventRef.current({
          type: frame.type,
          groupId,
          message: frame.message,
        });
      }
    };

    return connectParticipantWs({
      onFrame: handleFrame,
      onStatusChange: setConnected,
    });
  }, [groupId]);

  return { connected };
}
