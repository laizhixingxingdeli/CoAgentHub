import { Archive, ArrowLeft, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRoute } from "wouter";
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

// Ticket 32/33: 头像色板与哈希已抽到 lib(通用 colorForId),这里保持
// `agentColor`/`AGENT_COLORS` 的既有导出面,页面内调用与旧测试均不变。

/**
 * Preset role catalog (mirrors the server-side GROUP_ROLES). Drives the
 * "@ <角色名>" mention targets when composing a message.
 */

import { Composer } from "./Composer";
import { detectMention, type MentionCandidate, resolveAudience } from "./lib";

import { MessageList } from "./MessageList";
import {
  DELETED_MESSAGE_BODY,
  GROUP_ROLES,
  type Member,
  type MessageItem,
} from "./types";

/**
 * Group message page (ticket 18): WeChat/QQ-style chat UI — three zones
 * (title bar / scrolling bubble stream / bottom composer).
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

      <MessageList
        loading={loading}
        messages={messages}
        members={members}
        myAgentId={myAgentId}
        expandedIds={expandedIds}
        collapsedRootIds={collapsedRootIds}
        threadTree={threadTree}
        openActionsId={openActionsId}
        setOpenActionsId={setOpenActionsId}
        copiedId={copiedId}
        editingId={editingId}
        savingEdit={savingEdit}
        editBody={editBody}
        setEditBody={setEditBody}
        scrollRef={scrollRef}
        handleStreamScroll={handleStreamScroll}
        pendingCount={pendingCount}
        handleJumpToBottom={handleJumpToBottom}
        handleReply={handleReply}
        handleCopy={handleCopy}
        handleEditStart={handleEditStart}
        handleEditSave={handleEditSave}
        handleEditCancel={handleEditCancel}
        handleDelete={handleDelete}
        toggleCollapsed={toggleCollapsed}
        toggleFold={toggleFold}
      />
      <Composer
        body={body}
        mention={mention}
        mentionCandidates={mentionCandidates}
        highlightIndex={highlightIndex}
        setHighlightIndex={setHighlightIndex}
        replyTo={replyTo}
        setReplyTo={setReplyTo}
        sending={sending}
        isReadOnly={isReadOnly}
        audiencePreview={audiencePreview}
        textareaRef={textareaRef}
        handleBodyChange={handleBodyChange}
        handleComposerKeyDown={handleComposerKeyDown}
        handleSend={handleSend}
        insertMention={insertMention}
      />
    </div>
  );
}

export { detectMention, formatMessageTime, resolveAudience } from "./lib";
// Re-exports kept for the test suite (pre-split module surface).
export { AGENT_COLORS, agentColor };
