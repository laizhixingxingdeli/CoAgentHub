import { useSyncExternalStore } from "react";
import { PARTICIPANT_ID_KEY } from "@/lib/api-client";
import { connectParticipantWs } from "./use-group-ws";

/**
 * Global unread store for the sidebar conversation list (ticket 23).
 *
 * One module-level singleton (no provider nesting) shared by the sidebar and
 * the message pages: `useUnread()` subscribes components, `markRead` /
 * `setActiveGroupId` are callable directly. The store owns a single resident
 * WS connection (`connectParticipantWs`, same backoff as the per-group message hook)
 * and counts `group_message` frames per group — the server hub already pushes
 * every group the identity can see, so the badge is pure frontend with zero
 * backend changes.
 *
 * The badge is in-memory only, deliberately: a refresh zeroes it. The message
 * page loads the full history on mount anyway, so unread is a within-session
 * affordance — persisting it would add localStorage churn for no real gain.
 */

/** Unread badge counts per group; an absent key means no unread. */
export type UnreadMap = ReadonlyMap<string, number>;

/** Last-message preview for the sidebar (in-memory: fed by `group_message`
 *  frames and seeded from the message page's fetched history — never
 *  refetched per frame, per ticket 23). */
export type LastMessage = { body: string };

export type UnreadSnapshot = {
  unread: UnreadMap;
  lastMessageByGroup: ReadonlyMap<string, LastMessage>;
  activeGroupId: string | null;
  markRead: (groupId: string) => void;
  setActiveGroupId: (groupId: string | null) => void;
};

type StoreState = {
  unread: Map<string, number>;
  lastMessageByGroup: Map<string, LastMessage>;
  activeGroupId: string | null;
};

let state: StoreState = {
  unread: new Map(),
  lastMessageByGroup: new Map(),
  activeGroupId: null,
};

const listeners = new Set<() => void>();

// Resident connection state: the participant id the current socket was opened
// with and its teardown. `socketId` stays set while the socket is mid-backoff,
// so a no-op re-check never restarts the retry sequence.
let socketId: string | null = null;
let teardownWs: (() => void) | null = null;
let started = false;
let storageListener: (() => void) | null = null;

function readParticipantId(): string {
  return typeof localStorage !== "undefined"
    ? (localStorage.getItem(PARTICIPANT_ID_KEY) ?? "")
    : "";
}

function setState(next: StoreState) {
  state = next;
  for (const listener of listeners) {
    listener();
  }
}

function getSnapshot(): StoreState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  startIfNeeded();
  return () => {
    listeners.delete(listener);
  };
}

function startIfNeeded() {
  if (started) {
    return;
  }
  started = true;
  syncUnreadConnection();
  // Token saved/cleared in another tab — same-tab binding is picked up by the
  // sidebar conversation list's navigation pulse (localStorage writes fire no
  // storage event in the tab that wrote them).
  storageListener = () => syncUnreadConnection();
  window.addEventListener("storage", storageListener);
}

/**
 * (Re)connect the resident socket to match the current identity — the
 * navigation pulse the sidebar conversation list calls on mount and every
 * navigation. No identity ⇒ stay silent (the sidebar renders without badges,
 * nothing is fetched). Same id ⇒ keep the existing socket or its in-flight
 * backoff untouched.
 */
export function syncUnreadConnection(): void {
  const participantId = readParticipantId();
  if (!participantId) {
    if (teardownWs) {
      teardownWs();
      teardownWs = null;
    }
    socketId = null;
    return;
  }
  if (socketId === participantId) {
    return;
  }
  if (teardownWs) {
    teardownWs();
    teardownWs = null;
  }
  socketId = participantId;
  teardownWs = connectParticipantWs({
    onFrame: handleFrame,
  });
}

/**
 * Every `group_message` frame bumps the target group's unread (unless it is
 * the currently open group) and refreshes its sidebar preview. Updated /
 * deleted frames never touch the badge — the same rule the message page's
 * new-message pill counter uses.
 */
function handleFrame(data: unknown) {
  if (!data || typeof data !== "object") {
    return;
  }
  const frame = data as {
    type?: unknown;
    groupId?: unknown;
    message?: unknown;
  };
  if (frame.type !== "group_message" || typeof frame.groupId !== "string") {
    return;
  }
  const message = frame.message as
    | { body?: unknown; createdAt?: unknown }
    | null
    | undefined;
  if (!message || typeof message.body !== "string") {
    return; // malformed payload — never count a frame we can't trust
  }
  const next: StoreState = {
    ...state,
    unread: new Map(state.unread),
    lastMessageByGroup: new Map(state.lastMessageByGroup),
  };
  if (frame.groupId !== state.activeGroupId) {
    next.unread.set(frame.groupId, (next.unread.get(frame.groupId) ?? 0) + 1);
  }
  next.lastMessageByGroup.set(frame.groupId, { body: message.body });
  setState(next);
}

/** Seed/refresh the sidebar preview for a group from a non-WS source (ticket
 *  23: the message page seeds its fetched history's newest body on load, so a
 *  preview survives a reload instead of showing 暂无消息 until the next live
 *  frame). */
export function updateLastMessage(groupId: string, body: string): void {
  const lastMessageByGroup = new Map(state.lastMessageByGroup);
  lastMessageByGroup.set(groupId, { body });
  setState({ ...state, lastMessageByGroup });
}

/** Clear a group's unread badge (opening its message page). */
export function markRead(groupId: string): void {
  if (!state.unread.has(groupId)) {
    return;
  }
  const unread = new Map(state.unread);
  unread.delete(groupId);
  setState({ ...state, unread });
}

/**
 * Track which group is open. Entering a group clears its badge (a frame that
 * slipped in between navigation and mount is wiped again by the message page's
 * own markRead call). Pure state — the resident socket is (re)started by the
 * sidebar's `syncUnreadConnection` pulse, so mounting the message page alone
 * never opens a second store socket.
 */
export function setActiveGroupId(groupId: string | null): void {
  const next: StoreState = { ...state, activeGroupId: groupId };
  if (groupId && next.unread.has(groupId)) {
    const unread = new Map(next.unread);
    unread.delete(groupId);
    next.unread = unread;
  }
  setState(next);
}

/**
 * Subscribe the calling component to the global unread store. The sidebar
 * conversation section (always mounted in the app layout) is the primary
 * subscriber; message pages call `markRead` / `setActiveGroupId` directly.
 */
export function useUnread(): UnreadSnapshot {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot);
  return {
    unread: snapshot.unread,
    lastMessageByGroup: snapshot.lastMessageByGroup,
    activeGroupId: snapshot.activeGroupId,
    markRead,
    setActiveGroupId,
  };
}

/**
 * Test-only: tear down the resident socket and reset every bit of module state
 * so each test starts from a clean singleton (vitest reuses the module within
 * a test file).
 */
export function __resetUnreadStore(): void {
  if (teardownWs) {
    teardownWs();
    teardownWs = null;
  }
  if (storageListener) {
    window.removeEventListener("storage", storageListener);
    storageListener = null;
  }
  socketId = null;
  started = false;
  state = {
    unread: new Map(),
    lastMessageByGroup: new Map(),
    activeGroupId: null,
  };
  listeners.clear();
}
