import {
  Archive,
  ArrowDown,
  ArrowLeft,
  Download,
  FileText,
  MessageCircle,
  Users,
  X,
} from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRoute } from "wouter";
import { Button } from "@/components/ui/button";
import {
  mergeGroupMessages,
  useGroupWs,
  type WsGroupEvent,
} from "@/hooks/use-group-ws";
import {
  markRead,
  setActiveGroupId,
  updateLastMessage,
} from "@/hooks/use-unread";
import { AGENT_ID_KEY, agentAuthHeaders } from "@/lib/api-client";
import { AGENT_COLORS, colorForId as agentColor } from "@/lib/avatar-color";
import { cn } from "@/lib/utils";

// Ticket 32/33: 头像色板与哈希已抽到 lib(通用 colorForId),这里保持
// `agentColor`/`AGENT_COLORS` 的既有导出面,页面内调用与旧测试均不变。
export { AGENT_COLORS, agentColor };

/**
 * Preset role catalog (mirrors the server-side GROUP_ROLES). Drives the
 * "@ <角色名>" mention targets when composing a message.
 */
const GROUP_ROLES = [
  "human",
  "coordinator",
  "reviewer",
  "executor",
  "observer",
  "specialist",
] as const;

type Audience = "broadcast" | "role" | "agent";

type Member = {
  agentId: string;
  name: string;
  type: string;
  device: string | null;
  roles: string[];
};

type FileRef = {
  name: string;
  size: number;
  sha256: string;
  fetchUrl: string;
  expiresAt?: string;
};

type MessageItem = {
  id: string;
  groupId: string;
  senderId: string;
  parentId: string | null;
  audience: "broadcast" | "role" | "agent";
  audienceRef: string | null;
  body: string;
  /** T26: 后端行形状自带,旧消息可能为 null/undefined → 按 text/plain 处理。 */
  contentType?: string | null;
  fileRef: FileRef | null;
  depth: number;
  createdAt: string;
  /** Locally marked soft-deleted placeholder (ticket 22) — the WS deleted
   * event carries only the id, so the UI marks it here. */
  deleted?: boolean;
};

/** Server-side soft-delete placeholder body (ticket 22), mirrored locally. */
const DELETED_MESSAGE_BODY = "[消息已删除]";

/** Ticket 26 long-message fold: bodies longer than this collapse to a preview. */
const FOLD_THRESHOLD = 200;
const FOLD_PREVIEW_LENGTH = 100;

/** T26 状态条配色:✅ 完成=绿、❌ 失败=红、🛑 取消=黄、📋/🚀 进行中=蓝。 */
type TaskStatusKind = "done" | "failed" | "running" | "cancelled";

function taskStatusKind(body: string): TaskStatusKind {
  if (/^✅/.test(body)) return "done";
  if (/^❌/.test(body)) return "failed";
  if (/^🛑/.test(body)) return "cancelled";
  return "running";
}

const TASK_STATUS_CLASSES: Record<TaskStatusKind, string> = {
  done: "border-emerald-300/60 bg-emerald-500/10 text-emerald-800 dark:border-emerald-700/60 dark:bg-emerald-500/15 dark:text-emerald-300",
  failed:
    "border-red-300/60 bg-red-500/10 text-red-800 dark:border-red-700/60 dark:bg-red-500/15 dark:text-red-300",
  running:
    "border-sky-300/60 bg-sky-500/10 text-sky-800 dark:border-sky-700/60 dark:bg-sky-500/15 dark:text-sky-300",
  cancelled:
    "border-amber-300/60 bg-amber-500/10 text-amber-800 dark:border-amber-700/60 dark:bg-amber-500/15 dark:text-amber-300",
};

type AudienceResolution = {
  audience: Audience;
  audienceRef?: string;
};

/** Human-friendly byte size: B / KB / MB / GB (1 KB = 1024 B). */
function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0
    ? `${value} ${units[unit]}`
    : `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * Ticket 32 humane timestamps (local time):
 * - today → `HH:MM` (17:26)
 * - yesterday → `昨天 HH:MM`
 * - earlier this year → `M月D日 HH:MM` (8月10日 09:30)
 * - any earlier year → `YYYY年M月D日`
 */
export function formatMessageTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const startOfDay = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
  const diffDays = Math.round((startOfToday - startOfDay) / 86_400_000);
  const hhmm = `${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes(),
  ).padStart(2, "0")}`;
  if (diffDays <= 0) {
    return hhmm;
  }
  if (diffDays === 1) {
    return `昨天 ${hhmm}`;
  }
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日 ${hhmm}`;
  }
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

/** Local calendar-day key (YYYY-M-D) — messages sharing it belong to one day section. */
function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** Day-separator label (ticket 21): 今天 / 昨天 / 2026/8/10 for older days. */
function dayLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const startOfDay = new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
  ).getTime();
  const diffDays = Math.round((startOfToday - startOfDay) / 86_400_000);
  if (diffDays === 0) {
    return "今天";
  }
  if (diffDays === 1) {
    return "昨天";
  }
  return d.toLocaleDateString("zh-CN");
}

/**
 * Resolve the audience a composed body will be delivered to (ticket 18):
 * - `@<成员 name>` (a group member; names may contain spaces) → `agent` +
 *   `audienceRef=<agentId>`
 * - `@<角色名>` (GROUP_ROLES) → `role` + `audienceRef=<角色名>`
 * - no mention → `broadcast`
 * - mentions that match no candidate (`@xxx`) are left in the body as plain
 *   text and do not change the audience (stays `broadcast`).
 * The first matched mention wins; scanning is left to right. At each `@` the
 * longest full member name is tried first (case-insensitive, so a manually
 * typed `@CodeBuddy 执行器` — or `@WIN-HERMES` — resolves the same way the
 * mention candidate filter suggests it), then the single-word role token; a
 * member name that is merely a prefix of a longer word (`@win-hermes2`) is
 * not a match, so body text can't be swallowed.
 */
export function resolveAudience(
  body: string,
  members: Member[],
): AudienceResolution {
  // Longest member names first so "@CodeBuddy 执行器" hits the member and
  // not a shorter member/role token covering only "@CodeBuddy".
  const byNameLength = [...members].sort(
    (a, b) => b.name.length - a.name.length,
  );
  const lower = body.toLowerCase();
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] !== "@") {
      continue;
    }
    const rest = lower.slice(i + 1);
    // 1) full member name (may contain spaces), longest first
    for (const m of byNameLength) {
      const name = m.name.toLowerCase();
      if (!rest.startsWith(name)) {
        continue;
      }
      // Boundary: the name must not be a prefix of a longer word — the char
      // right after it may be whitespace/punctuation/end, but not a word
      // char ("@win-hermes2" is not "@win-hermes").
      const after = body[i + 1 + name.length];
      if (after === undefined || !/\w/.test(after)) {
        return { audience: "agent", audienceRef: m.agentId };
      }
    }
    // 2) single-word role token (roles never contain spaces)
    const token = rest.match(/^[^\s@]+/)?.[0];
    if (token) {
      const role = GROUP_ROLES.find((r) => r.toLowerCase() === token);
      if (role) {
        return { audience: "role", audienceRef: role };
      }
    }
  }
  return { audience: "broadcast" };
}

/**
 * Detect an in-progress mention at the caret: the last `@` before the caret
 * with no whitespace in between. Returns the text range to replace.
 */
export function detectMention(
  body: string,
  caret: number,
): { start: number; query: string } | null {
  if (caret <= 0) {
    return null;
  }
  let j = caret - 1;
  while (j >= 0) {
    const ch = body[j];
    if (/\s/.test(ch)) {
      return null;
    }
    if (ch === "@") {
      return { start: j, query: body.slice(j + 1, caret) };
    }
    j -= 1;
  }
  return null;
}

type MentionCandidate = {
  token: string;
  kind: "role" | "agent";
};

/**
 * Group message page (ticket 18): WeChat/QQ-style chat UI — three zones
 * (title bar / scrolling bubble stream / bottom composer), own messages
 * right-aligned, others left, and an "@ mention" composer that replaces the
 * old three-select audience picker. Keeps ticket 15 thread folding (root
 * ▸/▾ + reply-count badge) and ticket 16 read-only banner on top of the
 * ticket 14 WS live-append (mergeGroupMessages).
 */
export default function GroupMessagesPage() {
  const [, params] = useRoute("/groups/:id");
  const groupId = params?.id;

  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [groupStatus, setGroupStatus] = useState<
    "active" | "archived" | "deleted" | null
  >(null);
  const [groupTitle, setGroupTitle] = useState<string | null>(null);
  const [body, setBody] = useState("");
  // Collapsed thread roots (ticket 15). Keyed by root message id and kept in
  // its own state so a WS merge (which replaces the message list) never resets
  // the user's fold choices — the badge counts below recompute from the list.
  const [collapsedRootIds, setCollapsedRootIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // Active "@ mention" at the caret (ticket 18): { start, query } or null.
  const [mention, setMention] = useState<{
    start: number;
    query: string;
  } | null>(null);
  const [caret, setCaret] = useState(0);
  const [highlightIndex, setHighlightIndex] = useState(0);
  // Auto-scroll stickiness: stay at the bottom for new messages unless the
  // user has scrolled up (no forced pull).
  const [stickToBottom, setStickToBottom] = useState(true);
  // Accumulated new messages while the user is scrolled up (ticket 21): the
  // WS handler counts them; scrolling back to the bottom clears the counter.
  const [pendingCount, setPendingCount] = useState(0);
  // In-progress reply quote (ticket 21): set by 回复, sent as parentId, and
  // cleared after a successful send or when the user dismisses the bar.
  const [replyTo, setReplyTo] = useState<{
    id: string;
    senderName: string;
    preview: string;
  } | null>(null);
  // Mobile action bar: which message's actions are open (tap-to-open, tap
  // outside to close). Desktop uses the CSS hover bar instead.
  const [openActionsId, setOpenActionsId] = useState<string | null>(null);
  // "已复制" feedback: the id of the message whose copy button says so.
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // In-progress edit (ticket 22): at most one message edits at a time —
  // editingId is the message whose bubble shows the save/cancel textarea.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  // Ticket 26: expanded long-message ids. Bodies over FOLD_THRESHOLD collapse
  // to a FOLD_PREVIEW_LENGTH preview by default; expanding adds the id here.
  // Session-only (not persisted); kept in its own Set so WS merges that replace
  // the message list never reset a user's choice. Edit mode is unaffected — the
  // editing branch renders the full original text, never this preview.
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const toggleFold = (id: string) =>
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Latest stickToBottom for the WS callback. Synced during render (not in an
  // effect) so the stable socket callback always reads the live value — an
  // effect would lag one commit behind and could miss a pending-count bump in
  // the window between a scroll-up and the next paint.
  const stickToBottomRef = useRef(true);
  stickToBottomRef.current = stickToBottom;
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusRafRef = useRef<number | null>(null);

  // The bound agent id (saved with the token on the groups page). Absent ⇒
  // no "own" messages: everything renders left-aligned without the 我 badge
  // (never guess — the server can't be asked for it via token).
  const myAgentId = useMemo(
    () =>
      typeof localStorage !== "undefined"
        ? localStorage.getItem(AGENT_ID_KEY)
        : null,
    [],
  );

  // Archived AND soft-deleted groups are read-only (the backend rejects any
  // non-active group with 400): fetch the single-group status so the page can
  // render a banner and lock the composer (history stays browsable). The same
  // response carries the title for the chat header.
  const loadGroup = useCallback(async () => {
    if (!groupId) {
      return;
    }
    try {
      const res = await fetch(`/api/groups/${groupId}`, {
        headers: agentAuthHeaders(),
      });
      if (!res.ok) {
        return;
      }
      const group = (await res.json()) as {
        status: "active" | "archived" | "deleted";
        title?: string;
      };
      setGroupStatus(group.status);
      if (group.title) {
        setGroupTitle(group.title);
      }
    } catch {
      // Status is only needed for the read-only banner; a failure just leaves
      // the composer unlocked (the server still enforces the 400 on writes).
    }
  }, [groupId]);

  const loadMessages = useCallback(async () => {
    if (!groupId) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/groups/${groupId}/messages`, {
        headers: agentAuthHeaders(),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const fetched = (await res.json()) as MessageItem[];
      // Merge into current state instead of replacing it wholesale: a message
      // pushed by WS while this GET was in flight must survive a stale snapshot.
      // Isolate by group: when switching groups without remount (wouter reuses
      // the page component), prev may still hold the previous group's messages —
      // filter them out so two groups' histories never mix.
      setMessages((prev) =>
        mergeGroupMessages(
          fetched,
          prev.filter((m) => m.groupId === groupId),
        ),
      );
      // Ticket 23: seed the sidebar preview with the fetched history's newest
      // message (server rows are id-sorted, so the last element is the latest).
      const last = fetched[fetched.length - 1];
      if (last) {
        updateLastMessage(groupId, last.body);
      }
    } catch (e) {
      setError(`加载消息失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, [groupId]);

  const loadMembers = useCallback(async () => {
    if (!groupId) {
      return;
    }
    try {
      const res = await fetch(`/api/groups/${groupId}/members`, {
        headers: agentAuthHeaders(),
      });
      if (!res.ok) {
        return;
      }
      setMembers(await res.json());
    } catch {
      // The sender badges and the mention candidates just stay sparse.
    }
  }, [groupId]);
  useEffect(() => {
    loadGroup();
    loadMessages();
    loadMembers();
  }, [loadGroup, loadMessages, loadMembers]);

  // Ticket 23: opening a group marks its sidebar badge read. The unread store
  // clears the badge when the group becomes active; the explicit markRead also
  // wipes any frame that slipped in between navigation and this effect.
  useEffect(() => {
    if (!groupId) {
      return;
    }
    setActiveGroupId(groupId);
    markRead(groupId);
  }, [groupId]);

  // Live updates (ticket 14): the WS hub pushes every group message frame for
  // this group (including the sender's own echo). Merge new messages by id so
  // the echo and the post-send reload stay idempotent — duplicates never render
  // twice. While the user has scrolled up, each incoming NEW message bumps the
  // new-message pill counter (ticket 21) instead of being silently appended
  // off-screen; updated/deleted frames never bump it (the bubble is already on
  // screen or the user explicitly acted).
  const handleWsEvent = useCallback(
    (event: WsGroupEvent) => {
      if (event.type === "group_message") {
        // Belt-and-suspenders: never merge a frame that does not belong to the
        // group this page is showing (useGroupWs filters by frame.groupId, but
        // the message itself also carries a groupId — trust both).
        if (event.message?.groupId && event.message.groupId !== groupId) {
          return;
        }
        setMessages((prev) => mergeGroupMessages(prev, [event.message]));
        if (!stickToBottomRef.current) {
          setPendingCount((n) => n + 1);
        }
        return;
      }
      if (event.type === "group_message_updated") {
        // Full-row replace keeps the original position (map, not merge).
        setMessages((prev) =>
          prev.map((m) => (m.id === event.message.id ? event.message : m)),
        );
        return;
      }
      // group_message_deleted carries only the id — mark the placeholder locally.
      setMessages((prev) =>
        prev.map((m) =>
          m.id === event.messageId
            ? { ...m, body: DELETED_MESSAGE_BODY, deleted: true }
            : m,
        ),
      );
    },
    [groupId],
  );

  useGroupWs(groupId, handleWsEvent);

  // Clear the copy-feedback timer and any pending focus rAF on unmount so no
  // stale handle fires into an unmounted component.
  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current !== null) {
        clearTimeout(copyTimeoutRef.current);
      }
      if (focusRafRef.current !== null) {
        cancelAnimationFrame(focusRafRef.current);
      }
    };
  }, []);

  // Thread tree (ticket 15): the message list is a flat, receive-ordered
  // stream, but replies form a tree via parentId. Build the children map per
  // list change — a WS merge appending a message recomputes descendant counts,
  // so a collapsed root's badge updates even while hidden (collapse state
  // itself lives in the separate Set above and survives merges untouched).
  const threadTree = useMemo(() => {
    const byId = new Map(messages.map((m) => [m.id, m]));
    const childrenByParentId = new Map<string, MessageItem[]>();
    for (const msg of messages) {
      if (!msg.parentId) {
        continue;
      }
      const siblings = childrenByParentId.get(msg.parentId);
      if (siblings) {
        siblings.push(msg);
      } else {
        childrenByParentId.set(msg.parentId, [msg]);
      }
    }
    // Descendant count per root (no parentId), walking the children map so
    // nested replies count too.
    const descendantCount = new Map<string, number>();
    const countDescendants = (id: string): number => {
      const children = childrenByParentId.get(id);
      if (!children) {
        return 0;
      }
      return children.reduce(
        (n, child) => n + 1 + countDescendants(child.id),
        0,
      );
    };
    for (const msg of messages) {
      if (!msg.parentId) {
        descendantCount.set(msg.id, countDescendants(msg.id));
      }
    }
    return { byId, descendantCount };
  }, [messages]);

  // A message is hidden when the root of its parentId chain is collapsed —
  // never the root itself (the toggle lives on the root's own row). A message
  // whose parentId is not in the loaded list (e.g. a WS event that arrived
  // before its parent) has no root to hang under: it renders flat and is
  // never dropped.
  const isCollapsed = useCallback(
    (msg: MessageItem): boolean => {
      if (collapsedRootIds.size === 0) {
        return false;
      }
      let current = msg;
      while (current.parentId) {
        const parent = threadTree.byId.get(current.parentId);
        if (!parent) {
          return false;
        }
        current = parent;
      }
      return current.id !== msg.id && collapsedRootIds.has(current.id);
    },
    [collapsedRootIds, threadTree.byId],
  );

  const toggleCollapsed = (rootId: string) => {
    setCollapsedRootIds((prev) => {
      const next = new Set(prev);
      if (next.has(rootId)) {
        next.delete(rootId);
      } else {
        next.add(rootId);
      }
      return next;
    });
  };

  // Lock the composer for every non-active status (archived or soft-deleted):
  // the backend rejects writes to either with 400, so the UI must not offer
  // the send affordance at all. `null` (status not yet loaded) stays unlocked.
  const isReadOnly = groupStatus !== null && groupStatus !== "active";
  const isDeleted = groupStatus === "deleted";

  const handleSend = async () => {
    const trimmed = body.trim();
    if (!groupId || !trimmed) {
      return;
    }
    setSending(true);
    setError(null);
    try {
      // Ticket 18: the audience comes from the @ mentions in the body, never
      // from a picker. Unmatched @xxx stays plain text → broadcast.
      const resolved = resolveAudience(trimmed, members);
      const payload: Record<string, unknown> = {
        body: trimmed,
        audience: resolved.audience,
      };
      if (resolved.audienceRef) {
        payload.audienceRef = resolved.audienceRef;
      }
      // Ticket 21: a reply carries the replied message id (backend supports
      // parentId on POST already).
      if (replyTo) {
        payload.parentId = replyTo.id;
      }
      const res = await fetch(`/api/groups/${groupId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...agentAuthHeaders() },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      setBody("");
      setMention(null);
      setCaret(0);
      setReplyTo(null);
      await loadMessages();
    } catch (e) {
      setError(`发送失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSending(false);
    }
  };

  // ── "@ mention" composer (ticket 18) ──────────────────────────────────────
  const mentionCandidates = useMemo<MentionCandidate[]>(() => {
    if (!mention) {
      return [];
    }
    const q = mention.query.toLowerCase();
    const seen = new Set<string>();
    const list: MentionCandidate[] = [];
    for (const role of GROUP_ROLES) {
      if (!q || role.startsWith(q)) {
        list.push({ token: role, kind: "role" });
        seen.add(role);
      }
    }
    for (const m of members) {
      if (seen.has(m.name)) {
        continue;
      }
      if (!q || m.name.toLowerCase().startsWith(q)) {
        list.push({ token: m.name, kind: "agent" });
      }
    }
    return list;
  }, [mention, members]);

  const insertMention = (candidate: MentionCandidate) => {
    if (!mention) {
      return;
    }
    const insertPos = mention.start + candidate.token.length + 1;
    const next =
      body.slice(0, mention.start) + `@${candidate.token}` + body.slice(caret);
    setBody(next);
    setMention(null);
    setHighlightIndex(0);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(insertPos, insertPos);
      }
    });
  };

  const handleBodyChange = (value: string, selectionStart: number) => {
    setBody(value);
    setCaret(selectionStart);
    setMention(detectMention(value, selectionStart));
    setHighlightIndex(0);
  };

  const handleComposerKeyDown = (
    e: React.KeyboardEvent<HTMLTextAreaElement>,
  ) => {
    if (mention && mentionCandidates.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightIndex((h) => (h + 1) % mentionCandidates.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightIndex(
          (h) => (h - 1 + mentionCandidates.length) % mentionCandidates.length,
        );
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        insertMention(mentionCandidates[highlightIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
    // Enter sends, Shift+Enter inserts a newline (kept from the old composer).
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  // Live preview of the resolved audience (ticket 18): "将发送给 …".
  const audiencePreview = useMemo(() => {
    const trimmed = body.trim();
    if (!trimmed) {
      return null;
    }
    const resolved = resolveAudience(trimmed, members);
    if (resolved.audience === "role") {
      return `role:${resolved.audienceRef}`;
    }
    if (resolved.audience === "agent") {
      const target = members.find((m) => m.agentId === resolved.audienceRef);
      return `agent:${target ? target.name : resolved.audienceRef}`;
    }
    return "全体成员";
  }, [body, members]);

  // Auto-scroll: follow new messages while at the bottom; never yank the view
  // back down once the user has scrolled up (collapse changes too — expanding
  // a thread below the fold scrolls it into view).
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberately re-runs when messages/collapse state changes to keep the viewport pinned
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, collapsedRootIds, stickToBottom]);

  const handleStreamScroll = () => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    if (nearBottom !== stickToBottom) {
      setStickToBottom(nearBottom);
    }
    // Scrolling back to the bottom clears the accumulated new-message counter
    // (the pill disappears with it).
    if (nearBottom && pendingCount > 0) {
      setPendingCount(0);
    }
  };

  // Jump to the bottom from the new-message pill (ticket 21): restore the
  // auto-scroll stickiness and clear the backlog in one gesture.
  const handleJumpToBottom = () => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
    setStickToBottom(true);
    setPendingCount(0);
  };

  // Reply (ticket 21): open the quote bar above the composer, prefill it with
  // the sender name + the first 30 chars of the body, and focus the textarea.
  const handleReply = (msg: MessageItem) => {
    const senderName =
      members.find((m) => m.agentId === msg.senderId)?.name ??
      msg.senderId.slice(0, 8);
    const text = msg.body || msg.fileRef?.name || "";
    const preview = text.length > 30 ? `${text.slice(0, 30)}…` : text;
    setReplyTo({ id: msg.id, senderName, preview });
    setOpenActionsId(null);
    focusRafRef.current = requestAnimationFrame(() => {
      focusRafRef.current = null;
      textareaRef.current?.focus();
    });
  };

  // Copy (ticket 21): write the body (file-only messages copy the file name)
  // to the clipboard and flash "已复制" on the button for 1.5s. Falls back to
  // execCommand where the async Clipboard API is unavailable (non-secure ctx).
  const handleCopy = async (msg: MessageItem) => {
    const text = msg.body || msg.fileRef?.name || "";
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      setCopiedId(msg.id);
      if (copyTimeoutRef.current !== null) {
        clearTimeout(copyTimeoutRef.current);
      }
      copyTimeoutRef.current = setTimeout(() => setCopiedId(null), 1500);
    } catch {
      // Clipboard unavailable — the copy simply does nothing.
    }
  };

  // Edit (ticket 22): enter the inline edit mode for one message — at most one
  // edit at a time, so starting a new one cancels any in-progress edit.
  const handleEditStart = (msg: MessageItem) => {
    setEditingId(msg.id);
    setEditBody(msg.body || "");
    setOpenActionsId(null);
  };

  const handleEditCancel = () => {
    setEditingId(null);
    setEditBody("");
  };

  // Save the edited body via PATCH; on success replace the row locally (the
  // sender's own WS echo is a full-row replace too — idempotent) and exit.
  const handleEditSave = async (msg: MessageItem) => {
    const trimmed = editBody.trim();
    if (!groupId || !trimmed || savingEdit) {
      return;
    }
    setSavingEdit(true);
    setError(null);
    try {
      const res = await fetch(`/api/groups/${groupId}/messages/${msg.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...agentAuthHeaders(),
        },
        body: JSON.stringify({ body: trimmed }),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const updated = (await res.json()) as MessageItem;
      setMessages((prev) =>
        prev.map((m) => (m.id === updated.id ? updated : m)),
      );
      handleEditCancel();
    } catch (e) {
      setError(`编辑失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSavingEdit(false);
    }
  };

  // Delete (ticket 22): confirm, then soft-delete via DELETE; on success mark
  // the placeholder locally (the WS deleted event also arrives — deduped by
  // id). Already-deleted messages never reach here (no action bar).
  const handleDelete = async (msg: MessageItem) => {
    if (!groupId) {
      return;
    }
    if (!window.confirm("确定删除这条消息吗?删除后不可恢复。")) {
      return;
    }
    setError(null);
    try {
      const res = await fetch(`/api/groups/${groupId}/messages/${msg.id}`, {
        method: "DELETE",
        headers: agentAuthHeaders(),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msg.id
            ? { ...m, body: DELETED_MESSAGE_BODY, deleted: true }
            : m,
        ),
      );
      setOpenActionsId(null);
      if (editingId === msg.id) {
        handleEditCancel();
      }
    } catch (e) {
      setError(`删除失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // Mobile action bar: tapping anywhere outside the open message's row closes
  // it (tap-the-bubble toggles it; see the row onClick below).
  useEffect(() => {
    if (!openActionsId) {
      return;
    }
    const close = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest(`[data-message-id="${openActionsId}"]`)) {
        setOpenActionsId(null);
      }
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [openActionsId]);

  const senderName = (senderId: string) => {
    const member = members.find((m) => m.agentId === senderId);
    return member ? member.name : senderId.slice(0, 8);
  };
  // Ticket 32: type / device no longer ride on the sender name — type gets a
  // small badge on the info line, device moves into the avatar title tooltip.
  const senderType = (senderId: string) =>
    members.find((m) => m.agentId === senderId)?.type ?? null;
  const senderDevice = (senderId: string) =>
    members.find((m) => m.agentId === senderId)?.device ?? null;

  const senderRoles = (senderId: string): string[] =>
    members.find((m) => m.agentId === senderId)?.roles ?? [];

  // Ticket 26 audience tag: `→ @<成员名>` for agent-targeted (name from the
  // loaded member list, falling back to the first 8 chars of the ref), `→
  // @<角色名>` for role-targeted, nothing for broadcast. Shows for own
  // messages too — confirming who a directed message went to.
  const audienceLabel = (msg: MessageItem) => {
    if (msg.audience === "role" && msg.audienceRef) {
      return `→ @${msg.audienceRef}`;
    }
    if (msg.audience === "agent" && msg.audienceRef) {
      const target = members.find((m) => m.agentId === msg.audienceRef);
      return `→ @${target ? target.name : msg.audienceRef.slice(0, 8)}`;
    }
    return null;
  };

  const visibleMessages = messages.filter((msg) => !isCollapsed(msg));

  return (
    <div className="mx-auto flex h-[calc(100dvh-4rem)] w-full max-w-4xl flex-col">
      {/* ── Zone 1: title bar ─────────────────────────────────────────── */}
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-3">
        <a
          href="/groups"
          aria-label="返回群组列表"
          className="inline-flex shrink-0 items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          <span className="hidden sm:inline">返回</span>
        </a>
        <h2 className="min-w-0 flex-1 truncate text-base font-semibold">
          {groupTitle ?? "群组消息"}
        </h2>
        <a
          href={`/groups/${groupId}/members`}
          className="inline-flex shrink-0 items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <Users className="size-4" />
          成员
        </a>
      </div>

      {isReadOnly && (
        <div className="flex shrink-0 items-center gap-2 border-b border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <Archive className="size-4 shrink-0" />
          {isDeleted
            ? "该群组已删除,历史消息仍可查看,发送已禁用。"
            : "该群组已归档,处于只读状态;历史消息可继续查看,发送已禁用。"}
        </div>
      )}

      {error && (
        <div className="mx-4 mt-3 shrink-0 rounded-md border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </div>
      )}

      {/* ── Zone 2: message stream (scrollable) ───────────────────────── */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={handleStreamScroll}
          data-testid="message-stream"
          // Ticket 22 WeChat-style chat background: light gray base + a very
          // faint diagonal grid texture; the muted tokens flip automatically
          // in dark mode. Bubbles stay on top with their card contrast.
          className="h-full overflow-y-auto bg-muted/30 dark:bg-muted/15 [background-image:repeating-linear-gradient(45deg,color-mix(in_oklab,var(--color-muted-foreground)_5%,transparent)_0_1px,transparent_1px_14px)]"
        >
          {visibleMessages.length === 0 ? (
            <div className="flex flex-col items-center gap-2 p-10 text-center text-sm text-muted-foreground">
              {loading ? (
                "加载中…"
              ) : (
                <>
                  <MessageCircle className="size-8" />
                  <p>暂无消息,发送第一条吧</p>
                  <p className="text-xs">@ 角色或成员可以让消息直达目标</p>
                </>
              )}
            </div>
          ) : (
            <ul className="flex flex-col py-3">
              {visibleMessages.map((msg, i) => {
                const prev = i > 0 ? visibleMessages[i - 1] : undefined;
                const own = myAgentId !== null && msg.senderId === myAgentId;
                const contentType = msg.contentType ?? "text/plain";
                const isStatus = contentType === "task_status";
                // Ticket 26 long-message fold: bodies over FOLD_THRESHOLD chars
                // show a preview unless expanded; applies to every message type.
                // Array.from splits by code points so an emoji (surrogate pair)
                // straddling the cut is never split into a lone-half "�".
                const bodyLong = (msg.body ?? "").length > FOLD_THRESHOLD;
                const folded = bodyLong && !expandedIds.has(msg.id);
                const displayBody = folded
                  ? `${Array.from(msg.body).slice(0, FOLD_PREVIEW_LENGTH).join("")}…`
                  : msg.body;
                const replyCount = msg.parentId
                  ? 0
                  : (threadTree.descendantCount.get(msg.id) ?? 0);
                const isRootWithReplies = !msg.parentId && replyCount > 0;
                const collapsed =
                  isRootWithReplies && collapsedRootIds.has(msg.id);
                // Ticket 21 WeChat rule: merge same-sender rows (avatar/name
                // hidden on the follow-ups) while the gap stays within 5 minutes
                // and the parent is the same — never on a root that carries the
                // fold toggle, so the badge stays reachable. A >5min gap (or a
                // sender change) re-opens a header row with a fresh timestamp.
                const compact =
                  !isRootWithReplies &&
                  prev !== undefined &&
                  prev.senderId === msg.senderId &&
                  prev.parentId === msg.parentId &&
                  Date.parse(msg.createdAt) - Date.parse(prev.createdAt) <=
                    5 * 60 * 1000;
                const label = audienceLabel(msg);
                const deleted =
                  msg.deleted === true || msg.body === DELETED_MESSAGE_BODY;
                // Ticket 22: 编辑/删除 are sender-only (own messages); a deleted
                // placeholder shows no action bar at all.
                const actions = deleted ? null : (
                  <>
                    {own && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleEditStart(msg);
                        }}
                        className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        编辑
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleReply(msg);
                      }}
                      className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      回复
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleCopy(msg);
                      }}
                      className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      {copiedId === msg.id ? "已复制" : "复制"}
                    </button>
                    {own && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleDelete(msg);
                        }}
                        className="rounded-md px-2 py-1 text-xs text-destructive transition-colors hover:bg-destructive/10"
                      >
                        删除
                      </button>
                    )}
                  </>
                );
                return (
                  <Fragment key={msg.id}>
                    {prev !== undefined &&
                      dayKey(prev.createdAt) !== dayKey(msg.createdAt) && (
                        <li className="px-3 py-2" data-testid="day-separator">
                          <div className="mx-auto w-fit rounded-full bg-muted px-3 py-0.5 text-xs text-muted-foreground">
                            {dayLabel(msg.createdAt)}
                          </div>
                        </li>
                      )}
                    <li
                      data-message-id={msg.id}
                      data-own={own ? "true" : "false"}
                      className={cn(
                        "group relative flex items-end gap-2 px-3 py-1.5",
                        own && !isStatus && "flex-row-reverse",
                        isStatus && "justify-center",
                      )}
                      // Ticket 34: cap the reply-tree indent so deep threads
                      // keep enough room for a readable bubble on narrow screens.
                      style={{
                        paddingLeft: `${Math.min(msg.depth * 16, 64)}px`,
                      }}
                    >
                      {isStatus ? (
                        deleted ? (
                          /* 已删除的状态消息同样显示灰色占位,不伪装成进行中的状态条。 */
                          <div className="max-w-[85%] rounded-lg border bg-muted/40 px-3 py-1.5 text-xs italic text-muted-foreground">
                            消息已删除
                          </div>
                        ) : (
                          /* Ticket 26: 桥回传状态消息 → 微信系统消息风格的居中紧凑
                       状态条(不占大气泡、不分左右);颜色按状态区分。 */
                          <div
                            data-testid="task-status"
                            data-status={taskStatusKind(msg.body)}
                            className={cn(
                              "max-w-[85%] rounded-lg border px-3 py-1.5 shadow-sm",
                              TASK_STATUS_CLASSES[taskStatusKind(msg.body)],
                            )}
                          >
                            <p className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
                              {displayBody}
                            </p>
                            {bodyLong && (
                              <button
                                type="button"
                                onClick={() => toggleFold(msg.id)}
                                className="mt-1 inline-flex items-center rounded px-1 text-xs underline underline-offset-2 transition-opacity hover:opacity-80"
                              >
                                {folded ? "展开全文" : "收起"}
                              </button>
                            )}
                            <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-muted-foreground/80">
                              <span>{formatMessageTime(msg.createdAt)}</span>
                            </div>
                          </div>
                        )
                      ) : (
                        <>
                          {!compact && (
                            <div
                              title={[
                                senderName(msg.senderId),
                                senderDevice(msg.senderId),
                              ]
                                .filter(Boolean)
                                .join(" ")}
                              className={cn(
                                "flex size-9 shrink-0 select-none items-center justify-center rounded-full text-sm font-semibold",
                                agentColor(msg.senderId),
                              )}
                            >
                              {senderName(msg.senderId)
                                .slice(0, 1)
                                .toUpperCase()}
                            </div>
                          )}
                          <div
                            className={cn(
                              "flex min-w-0 flex-col gap-1",
                              own ? "items-end" : "items-start",
                            )}
                          >
                            {!compact && (
                              <div
                                className={cn(
                                  "flex max-w-full flex-wrap items-baseline gap-x-1.5 gap-y-0.5 px-1 text-xs",
                                  own && "flex-row-reverse",
                                )}
                              >
                                {/* Ticket 32 info line 1: 昵称 + 我 + 时间(小字,右上) */}
                                <span className="flex min-w-0 items-baseline gap-1">
                                  <span className="max-w-40 truncate font-medium text-foreground">
                                    {senderName(msg.senderId)}
                                  </span>
                                  {own && (
                                    <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 font-medium text-primary">
                                      我
                                    </span>
                                  )}
                                  <span className="shrink-0 text-[10px] text-muted-foreground">
                                    {formatMessageTime(msg.createdAt)}
                                  </span>
                                </span>
                                {/* Ticket 32 info line 2: 类型 / 角色 / 受众徽章(小字) */}
                                <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                                  {senderType(msg.senderId) && (
                                    <span className="rounded-full bg-muted px-1.5 py-0.5">
                                      {senderType(msg.senderId)}
                                    </span>
                                  )}
                                  {senderRoles(msg.senderId).length > 0 && (
                                    <span className="rounded-full bg-muted px-1.5 py-0.5">
                                      {senderRoles(msg.senderId).join("/")}
                                    </span>
                                  )}
                                  {label && (
                                    <span className="rounded-full bg-muted px-1.5 py-0.5">
                                      {label}
                                    </span>
                                  )}
                                </span>
                                {isRootWithReplies && (
                                  <button
                                    type="button"
                                    aria-label={collapsed ? "展开" : "折叠"}
                                    onClick={() => toggleCollapsed(msg.id)}
                                    className="inline-flex items-center gap-1 rounded-md border bg-muted/40 px-1.5 py-0.5 font-medium text-foreground transition-colors hover:bg-muted"
                                  >
                                    <span aria-hidden="true">
                                      {collapsed ? "▸" : "▾"}
                                    </span>
                                    {replyCount} 条回复
                                  </button>
                                )}
                              </div>
                            )}
                            {/* Bubble: own = primary/right, others = muted/left. Tap
                        toggles the mobile action bar (ticket 21); the desktop
                        hover bar sits outside the bubble. role/tabIndex make
                        the tap action keyboard-reachable too. Ticket 22: an
                        in-progress edit swaps the bubble for a save/cancel
                        textarea; a deleted message renders a gray placeholder. */}
                            {editingId === msg.id ? (
                              <div
                                data-testid="message-edit-form"
                                className="max-w-[75%] rounded-2xl border bg-background px-3.5 py-2.5 text-sm shadow-sm sm:max-w-[60%]"
                              >
                                <textarea
                                  autoFocus
                                  aria-label="编辑消息"
                                  value={editBody}
                                  onChange={(e) => setEditBody(e.target.value)}
                                  rows={2}
                                  className="w-full resize-none rounded-md border bg-background px-2 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                />
                                {msg.fileRef && (
                                  <div className="mt-1.5 flex items-center gap-3 rounded-md border bg-muted/40 px-3 py-2">
                                    <FileText className="size-5 shrink-0 text-muted-foreground" />
                                    <div className="min-w-0 flex-1">
                                      <p
                                        className="truncate text-sm font-medium"
                                        title={msg.fileRef.name}
                                      >
                                        {msg.fileRef.name}
                                      </p>
                                      <p className="text-xs text-muted-foreground">
                                        {formatSize(msg.fileRef.size)}
                                      </p>
                                    </div>
                                  </div>
                                )}
                                <div className="mt-2 flex items-center justify-end gap-2">
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={handleEditCancel}
                                  >
                                    取消
                                  </Button>
                                  <Button
                                    size="sm"
                                    onClick={() => void handleEditSave(msg)}
                                    disabled={savingEdit || !editBody.trim()}
                                  >
                                    {savingEdit ? "保存中…" : "保存"}
                                  </Button>
                                </div>
                              </div>
                            ) : deleted ? (
                              <div
                                className={cn(
                                  "max-w-[75%] rounded-2xl px-3.5 py-2 text-sm sm:max-w-[60%]",
                                  own
                                    ? "rounded-br-md bg-muted/40"
                                    : "rounded-bl-md bg-muted/40",
                                )}
                              >
                                <p className="whitespace-pre-wrap break-words text-xs italic text-muted-foreground">
                                  消息已删除
                                </p>
                              </div>
                            ) : (
                              <div
                                role="button"
                                tabIndex={0}
                                aria-expanded={openActionsId === msg.id}
                                aria-label={`${msg.body ? msg.body.slice(0, 20) : "消息"} 操作`}
                                onClick={() =>
                                  setOpenActionsId((prev) =>
                                    prev === msg.id ? null : msg.id,
                                  )
                                }
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    setOpenActionsId((prev) =>
                                      prev === msg.id ? null : msg.id,
                                    );
                                  }
                                }}
                                className={cn(
                                  "relative max-w-[75%] rounded-2xl px-3.5 py-2.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:max-w-[60%]",
                                  own
                                    ? "rounded-br-md bg-primary text-primary-foreground"
                                    : "rounded-bl-md bg-muted",
                                )}
                              >
                                {/* Ticket 22 WeChat-style bubble tail: a small triangle at
                          the bottom edge (own right, others left), matched to
                          the bubble fill via the same color token. */}
                                <span
                                  aria-hidden="true"
                                  className={cn(
                                    "absolute -bottom-[7px] h-0 w-0 border-l-[8px] border-r-[8px] border-t-[7px] border-l-transparent border-r-transparent",
                                    own
                                      ? "right-3 border-t-primary"
                                      : "left-3 border-t-muted",
                                  )}
                                />
                                {contentType === "discussion" && (
                                  /* Ticket 26: hermes 讨论回复 → 气泡左上角 💬 小标记。 */
                                  <span
                                    aria-hidden="true"
                                    data-testid="discussion-mark"
                                    className="absolute -top-2 left-2 rounded-full border bg-popover px-1.5 py-0.5 text-xs shadow-sm"
                                  >
                                    💬
                                  </span>
                                )}
                                {msg.body && (
                                  <>
                                    <p className="whitespace-pre-wrap break-words">
                                      {displayBody}
                                    </p>
                                    {bodyLong && (
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          toggleFold(msg.id);
                                        }}
                                        className="mt-1 inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs font-medium text-primary transition-colors hover:bg-muted"
                                      >
                                        {folded ? "展开全文" : "收起"}
                                      </button>
                                    )}
                                  </>
                                )}
                                {msg.fileRef && (
                                  <div className="mt-1.5 flex items-center gap-3 rounded-md border bg-background/50 px-3 py-2">
                                    <FileText className="size-5 shrink-0 text-muted-foreground" />
                                    <div className="min-w-0 flex-1">
                                      <p
                                        className="truncate text-sm font-medium"
                                        title={msg.fileRef.name}
                                      >
                                        {msg.fileRef.name}
                                      </p>
                                      <p className="text-xs text-muted-foreground">
                                        {formatSize(msg.fileRef.size)}
                                        {msg.fileRef.expiresAt
                                          ? ` · 有效期至 ${new Date(msg.fileRef.expiresAt).toLocaleString("zh-CN", { hour12: false })}`
                                          : ""}
                                      </p>
                                    </div>
                                    <a
                                      href={msg.fileRef.fetchUrl}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="inline-flex shrink-0 items-center gap-1 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
                                    >
                                      <Download className="size-3.5" />
                                      下载
                                    </a>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                          {/* Ticket 21 actions: hover bar on md+, tap-to-open bar on
                      mobile (toggled by the bubble onClick, closed by tapping
                      outside). Positioned on the outside edge of the row —
                      left for own messages (bubble cluster hugs the right),
                      right for received ones. `invisible` keeps the buttons
                      out of the tab order / a11y tree until hover or focus
                      (opacity alone would leave invisible focusable buttons). */}
                          {actions && (
                            <div
                              data-testid="message-actions-hover"
                              className={cn(
                                "absolute top-1/2 z-10 hidden -translate-y-1/2 items-center gap-0.5 rounded-lg border bg-popover p-0.5 opacity-0 shadow-sm transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 invisible group-hover:visible group-focus-within:visible md:flex",
                                own ? "left-2" : "right-2",
                              )}
                            >
                              {actions}
                            </div>
                          )}
                          {actions && openActionsId === msg.id && (
                            <div
                              data-testid="message-actions-mobile"
                              className={cn(
                                "absolute top-1/2 z-10 flex -translate-y-1/2 items-center gap-0.5 rounded-lg border bg-popover p-0.5 shadow-md md:hidden",
                                own ? "left-2" : "right-2",
                              )}
                            >
                              {actions}
                            </div>
                          )}
                        </>
                      )}
                    </li>
                  </Fragment>
                );
              })}
            </ul>
          )}
        </div>
        {pendingCount > 0 && (
          <button
            type="button"
            data-testid="new-message-pill"
            onClick={handleJumpToBottom}
            className="absolute bottom-5 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border bg-background/90 px-4 py-2 text-xs font-medium text-foreground shadow-lg backdrop-blur transition-transform hover:-translate-y-0.5"
          >
            <ArrowDown className="size-3.5" />
            {pendingCount} 条新消息
          </button>
        )}
      </div>

      {/* ── Zone 3: composer (贴底,@ 提及,回复引用) ───────────────────── */}
      <div className="shrink-0 border-t bg-card px-4 py-3">
        {replyTo && (
          <div
            data-testid="reply-quote-bar"
            className="mb-2 flex items-center gap-2 rounded-md border-l-4 border-primary bg-muted/60 px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-foreground">
                回复 {replyTo.senderName}
              </p>
              {replyTo.preview && (
                <p className="truncate text-xs text-muted-foreground">
                  {replyTo.preview}
                </p>
              )}
            </div>
            <button
              type="button"
              aria-label="取消回复"
              onClick={() => setReplyTo(null)}
              className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </div>
        )}
        <div className="relative">
          {mention && mentionCandidates.length > 0 && (
            <ul
              role="listbox"
              aria-label="提及候选"
              data-testid="mention-list"
              className="absolute bottom-full left-0 right-0 mb-2 max-h-56 overflow-y-auto rounded-lg border bg-popover p-1 shadow-md"
            >
              {mentionCandidates.map((candidate, idx) => (
                <li key={`${candidate.kind}:${candidate.token}`}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={idx === highlightIndex}
                    onMouseEnter={() => setHighlightIndex(idx)}
                    onClick={() => insertMention(candidate)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm",
                      idx === highlightIndex && "bg-muted",
                    )}
                  >
                    <span className="font-medium">@{candidate.token}</span>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                      {candidate.kind === "role" ? "角色" : "成员"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <textarea
            ref={textareaRef}
            aria-label="消息内容"
            value={body}
            onChange={(e) =>
              handleBodyChange(
                e.target.value,
                e.target.selectionStart ?? e.target.value.length,
              )
            }
            onKeyDown={handleComposerKeyDown}
            placeholder={
              isReadOnly
                ? "已归档,无法发送消息"
                : "输入消息内容,@ 提及角色或成员…"
            }
            rows={2}
            disabled={isReadOnly}
            className="w-full resize-none rounded-md border bg-background px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
          />
        </div>
        <div className="mt-2 flex items-center justify-between gap-2">
          <div
            data-testid="audience-preview"
            className="min-w-0 truncate text-xs text-muted-foreground"
          >
            {audiencePreview ? `将发送给 ${audiencePreview}` : ""}
          </div>
          <Button
            onClick={handleSend}
            disabled={isReadOnly || sending || !body.trim()}
            size="sm"
            className="shrink-0"
          >
            {sending ? "发送中…" : "发送"}
          </Button>
        </div>
      </div>
    </div>
  );
}
