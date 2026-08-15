import { Archive, ArrowLeft, Pencil, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useRoute } from "wouter";
import { ContextPanelTrigger } from "@/components/layout/context-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import {
  PARTICIPANT_ID_KEY,
  participantIdentityHeaders,
} from "@/lib/api-client";
import {
  PARTICIPANT_COLORS,
  colorForId as participantColor,
} from "@/lib/avatar-color";
import { t } from "@/lib/i18n";
import { maybeNotifyGroupMessage } from "@/lib/notifications";

// Ticket 32/33: 头像色板与哈希已抽到 lib(通用 colorForId),这里保持
// `participantColor`/`PARTICIPANT_COLORS` 的既有导出面,页面内调用与旧测试均不变。

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
  // wouter navigate — used by the desktop notification click handler to jump
  // to this group's message page (/groups/:id) from a background tab.
  const [, navigate] = useLocation();

  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 测试执行器(纯辅助,不改消息 schema):"auto"(默认,按分工提示词自动选择)/
  // "same"(同一执行器)/ participantId(显式指定成员)。显式选择在发送时往 body
  // 追加一行「**测试执行器:<名>**」,由 buildTicket 原样保留进任务书。
  const [testExecutor, setTestExecutor] = useState<string>("auto");
  const [groupStatus, setGroupStatus] = useState<
    "active" | "archived" | "deleted" | null
  >(null);
  const [groupTitle, setGroupTitle] = useState<string | null>(null);
  // 群名行内改名(网页体验批次):标题栏铅笔图标 → 输入 → PATCH /groups/:id {title}。
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [savingTitle, setSavingTitle] = useState(false);
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
  // Message search (enhancement): the title-bar search box. `searchQuery` is the
  // input text; `searchActiveQuery` is the keyword whose results are currently
  // shown (null = normal live stream). Search mode pauses WS appends — new
  // frames may not match the keyword, so the stream shows only the q= snapshot
  // until the user clears the search (then the normal flow reloads).
  const [searchBoxOpen, setSearchBoxOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchActiveQuery, setSearchActiveQuery] = useState<string | null>(
    null,
  );
  const searchActive = searchActiveQuery !== null;
  // Latest searchActive for the WS callback (same sync-during-render pattern as
  // stickToBottomRef below) so the stable socket callback reads the live value.
  const searchActiveRef = useRef(false);
  searchActiveRef.current = searchActive;
  // Monotonic request sequence for loadMessages: every load bumps it, and a
  // response whose sequence is no longer current is dropped — an older q=
  // fetch resolving after a newer search/clear/group-switch must never
  // clobber the list with stale data.
  const loadSeqRef = useRef(0);

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

  // The bound participant id (saved on the groups page identity panel). Absent ⇒
  // no "own" messages: everything renders left-aligned without the 我 badge.
  const myParticipantId = useMemo(
    () =>
      typeof localStorage !== "undefined"
        ? localStorage.getItem(PARTICIPANT_ID_KEY)
        : null,
    [],
  );

  // Latest group title / members / own id for the stable WS callback (same
  // sync-during-render pattern as searchActiveRef above): the notification
  // fired from the socket callback must read the live values, not the ones
  // captured at mount.
  const groupTitleRef = useRef<string | null>(null);
  groupTitleRef.current = groupTitle;
  const membersRef = useRef<Member[]>([]);
  membersRef.current = members;
  const myParticipantIdRef = useRef<string | null>(null);
  myParticipantIdRef.current = myParticipantId;

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
        headers: participantIdentityHeaders(),
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

  /** 群名行内改名(网页体验批次):标题栏铅笔图标 → 输入 → PATCH /groups/:id
   *  {title};仅 active 群可改名(归档/软删只读)。 */
  const handleRenameTitle = async () => {
    const title = titleDraft.trim();
    if (!groupId || !title || savingTitle || isReadOnly) {
      return;
    }
    setSavingTitle(true);
    setError(null);
    try {
      const res = await fetch(`/api/groups/${groupId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...participantIdentityHeaders(),
        },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      setGroupTitle(title);
      setEditingTitle(false);
    } catch (e) {
      setError(
        t("groups.error.renameFailed", {
          detail: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setSavingTitle(false);
    }
  };

  const loadMessages = useCallback(
    async (q?: string) => {
      if (!groupId) {
        return;
      }
      const seq = ++loadSeqRef.current;
      setLoading(true);
      setError(null);
      try {
        const url = q
          ? `/api/groups/${groupId}/messages?q=${encodeURIComponent(q)}`
          : `/api/groups/${groupId}/messages`;
        const res = await fetch(url, {
          headers: participantIdentityHeaders(),
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const fetched = (await res.json()) as MessageItem[];
        if (seq !== loadSeqRef.current) {
          // A newer search/clear/group-switch superseded this request — the
          // stale response must not clobber the list.
          return;
        }
        if (q) {
          // Search mode shows ONLY the q= results — a merge would pollute the
          // snapshot with the previously loaded full history. Leaving search
          // (clear) goes back through the merge path below.
          setMessages(fetched);
          return;
        }
        // A full (non-search) reload means the screen is back on the unfiltered
        // stream: reset the search state so the banner, the WS pause and the
        // data source stay consistent (group switch, post-send reload and the
        // one-click clear all land here).
        setSearchActiveQuery(null);
        setSearchQuery("");
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
        if (seq !== loadSeqRef.current) {
          return;
        }
        setError(
          t("messages.error.loadFailed", {
            detail: e instanceof Error ? e.message : String(e),
          }),
        );
      } finally {
        if (seq === loadSeqRef.current) {
          setLoading(false);
        }
      }
    },
    [groupId],
  );

  // Search actions (enhancement): Enter in the search box runs q=; an empty
  // query or the one-click clear restores the normal full stream.
  const handleSearch = useCallback(() => {
    const q = searchQuery.trim();
    if (!q) {
      setSearchActiveQuery(null);
      loadMessages();
      return;
    }
    setSearchActiveQuery(q);
    loadMessages(q);
  }, [loadMessages, searchQuery]);

  const handleClearSearch = useCallback(() => {
    setSearchQuery("");
    setSearchActiveQuery(null);
    loadMessages();
  }, [loadMessages]);

  const loadMembers = useCallback(async () => {
    if (!groupId) {
      return;
    }
    try {
      const res = await fetch(`/api/groups/${groupId}/members`, {
        headers: participantIdentityHeaders(),
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
        if (!groupId) {
          return;
        }
        if (event.message?.groupId && event.message.groupId !== groupId) {
          return;
        }
        // Browser desktop notification: page hidden + other's message → system
        // notification (title = group title, body = "sender: summary"); click
        // jumps to this group. Permission is requested lazily on first need;
        // denied → silent, never re-asks. All Notification calls are
        // try/catch-wrapped inside the helper (zero noise on unsupported
        // browsers).
        const sender = membersRef.current.find(
          (m) => m.participantId === event.message.senderId,
        );
        maybeNotifyGroupMessage({
          groupId,
          groupTitle: groupTitleRef.current,
          senderName: sender?.name ?? event.message.senderId.slice(0, 8),
          message: event.message,
          myParticipantId: myParticipantIdRef.current,
          navigate,
        });
        // Search mode shows the q= snapshot only: new frames may not match the
        // keyword, so they are NOT appended while search is active. Updated and
        // deleted frames below still apply (they patch the shown rows in place);
        // clearing the search reloads the full stream and live appends resume.
        if (searchActiveRef.current) {
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
      // task_output(实时进度)由任务面板 TasksTab 自己订阅处理,消息流忽略。
      if (event.type === "task_output" || event.type === "task_stall_alert") {
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
    [groupId, navigate],
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
      // 测试执行器(纯辅助,不改消息 schema):显式选择 → body 追加一行
      // 「**测试执行器:<名>**」,由 buildTicket 原样保留进任务书;"auto"/"same"
      // 不加行(自动规则由 buildTicket 应用)。
      let sendBody = trimmed;
      if (testExecutor === "same") {
        sendBody = `${trimmed}\n\n**测试执行器:${t("messages.send.testExecutor.same")}**`;
      } else if (testExecutor !== "auto") {
        const picked = members.find((m) => m.participantId === testExecutor);
        if (picked) {
          sendBody = `${trimmed}\n\n**测试执行器:${picked.name}**`;
        }
      }
      // Ticket 18: the audience comes from the @ mentions in the body, never
      // from a picker. Unmatched @xxx stays plain text → broadcast.
      const resolved = resolveAudience(sendBody, members);
      const payload: Record<string, unknown> = {
        body: sendBody,
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
        headers: {
          "Content-Type": "application/json",
          ...participantIdentityHeaders(),
        },
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
      setError(
        t("messages.error.sendFailed", {
          detail: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setSending(false);
    }
  };

  // 测试执行器候选(纯辅助下拉):群内 executor/specialist 角色成员。
  const executorMembers = useMemo<Member[]>(
    () =>
      members.filter(
        (m) => m.roles.includes("executor") || m.roles.includes("specialist"),
      ),
    [members],
  );

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
        list.push({ token: m.name, kind: "participant" });
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
    if (resolved.audience === "participant") {
      const target = members.find(
        (m) => m.participantId === resolved.audienceRef,
      );
      return `participant:${target ? target.name : resolved.audienceRef}`;
    }
    return t("messages.audience.all");
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
      members.find((m) => m.participantId === msg.senderId)?.name ??
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
          ...participantIdentityHeaders(),
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
      setError(
        t("messages.error.editFailed", {
          detail: e instanceof Error ? e.message : String(e),
        }),
      );
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
    if (!window.confirm(t("messages.delete.confirm"))) {
      return;
    }
    setError(null);
    try {
      const res = await fetch(`/api/groups/${groupId}/messages/${msg.id}`, {
        method: "DELETE",
        headers: participantIdentityHeaders(),
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
      setError(
        t("messages.error.deleteFailed", {
          detail: e instanceof Error ? e.message : String(e),
        }),
      );
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
    <div className="mx-auto flex h-[calc(100dvh-4rem)] w-full max-w-[1440px] flex-col px-4 sm:px-6">
      {/* ── Zone 1: title bar ─────────────────────────────────────────── */}
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-3">
        <a
          href="/groups"
          aria-label={t("messages.back.aria")}
          className="inline-flex shrink-0 items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          <span className="hidden sm:inline">{t("messages.back.label")}</span>
        </a>
        {editingTitle ? (
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <Input
              autoFocus
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  void handleRenameTitle();
                } else if (e.key === "Escape") {
                  setEditingTitle(false);
                }
              }}
              aria-label={t("groups.renameInputAria")}
              className="h-8 min-w-0 flex-1"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={savingTitle || !titleDraft.trim()}
              onClick={() => void handleRenameTitle()}
              className="shrink-0"
            >
              {savingTitle ? t("common.saving") : t("groups.renameSave")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setEditingTitle(false)}
              className="shrink-0"
            >
              {t("groups.renameCancel")}
            </Button>
          </div>
        ) : (
          <h2
            data-testid="group-title-bar"
            className="flex min-w-0 flex-1 items-center gap-1 truncate text-base font-semibold"
          >
            <span className="truncate">
              {groupTitle ?? t("messages.titleFallback")}
            </span>
            {!isReadOnly && (
              <Pencil
                data-testid="rename-group-title"
                className="size-3.5 shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
                aria-label={t("groups.renameAria")}
                onClick={() => {
                  setTitleDraft(groupTitle ?? "");
                  setEditingTitle(true);
                }}
              />
            )}
          </h2>
        )}
        {searchBoxOpen ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <Input
              type="text"
              autoFocus
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleSearch();
                } else if (e.key === "Escape") {
                  setSearchBoxOpen(false);
                }
              }}
              placeholder={t("messages.search.placeholder")}
              aria-label={t("messages.search.aria")}
              className="w-44 sm:w-64"
            />
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("messages.search.clearAria")}
              title={t("messages.search.clearAria")}
              onClick={() => {
                handleClearSearch();
                setSearchBoxOpen(false);
              }}
              className="shrink-0"
            >
              <X className="size-4" />
            </Button>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("messages.search.aria")}
            title={t("messages.search.aria")}
            onClick={() => setSearchBoxOpen(true)}
            className="shrink-0"
          >
            <Search className="size-4" />
          </Button>
        )}
        <ContextPanelTrigger />
      </div>

      {searchActive && (
        <div className="flex shrink-0 items-center gap-2 border-b px-4 py-2 text-sm text-muted-foreground">
          <span className="min-w-0 truncate">
            {t("messages.search.label")}{" "}
            <span className="font-medium text-foreground">
              {searchActiveQuery}
            </span>
          </span>
          <button
            type="button"
            onClick={handleClearSearch}
            className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-3.5" />
            {t("common.clear")}
          </button>
        </div>
      )}

      {isReadOnly && (
        <div className="flex shrink-0 items-center gap-2 border-b border-amber-300 bg-amber-50 px-4 py-2.5 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <Archive className="size-4 shrink-0" />
          {isDeleted
            ? t("messages.readOnly.deleted")
            : t("messages.readOnly.archived")}
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
        myParticipantId={myParticipantId}
        readOnly={isReadOnly}
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
        testExecutor={testExecutor}
        setTestExecutor={setTestExecutor}
        executorMembers={executorMembers}
      />
    </div>
  );
}

export { detectMention, formatMessageTime, resolveAudience } from "./lib";
// Re-exports kept for the test suite (pre-split module surface).
export { PARTICIPANT_COLORS, participantColor };
