import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useGroupHeader } from "@/hooks/use-group-header";
import {
  mergeGroupMessages,
  useGroupWs,
  type WsGroupEvent,
} from "@/hooks/use-group-ws";
import { updateLastMessage } from "@/hooks/use-unread";
import { t } from "@/lib/i18n";
import { fetchLocalUserParticipantId } from "@/lib/local-user";
import { maybeNotifyGroupMessage } from "@/lib/notifications";
import {
  DELETED_MESSAGE_BODY,
  type Member,
  type MessageItem,
} from "@/pages/app/groups/messages/types";

/**
 * All state, effects and handlers for the group message page (ticket 18):
 * the message stream, member roster, group status/title, WS live updates,
 * thread collapse, search, reply/copy/edit/delete
 * and the read-only banner state. Extracted from GroupMessagesPage so the
 * page component is a thin composition of this hook and the main pane.
 *
 * 现在的消费者是 GroupLayout(WS 订阅 + 未读/通知),不再是聊天流:
 * MessageList.tsx 已随聊天流下线删除(2026-09-10),群内页主区是
 * RequirementWorkspace。本 hook 里仍留着为聊天流准备的 state/handler。
 */
export function useMessagesPage(groupId: string | undefined) {
  // wouter navigate — used by the desktop notification click handler to jump
  // to this group's message page (/groups/:id) from a background tab.
  const [, navigate] = useLocation();

  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 群标题 / 群状态 / 行内改名与页面头部共享同一实现(useGroupHeader):消息
  // 流已搬进右栏消息 Tab,不再渲染页面头部,但桌面通知(群标题)与只读判定
  // (归档/软删)仍需要这两份数据。
  const header = useGroupHeader(groupId);
  // Collapsed thread roots (ticket 15). Keyed by root message id and kept in
  // its own state so a WS merge (which replaces the message list) never resets
  // the user's fold choices — the badge counts below recompute from the list.
  const [collapsedRootIds, setCollapsedRootIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // Auto-scroll stickiness: stay at the bottom for new messages unless the
  // user has scrolled up (no forced pull).
  const [stickToBottom, setStickToBottom] = useState(true);
  // Accumulated new messages while the user is scrolled up (ticket 21): the
  // WS handler counts them; scrolling back to the bottom clears the counter.
  const [pendingCount, setPendingCount] = useState(0);
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
  // Latest stickToBottom for the WS callback. Synced during render (not in an
  // effect) so the stable socket callback always reads the live value — an
  // effect would lag one commit behind and could miss a pending-count bump in
  // the window between a scroll-up and the next paint.
  const stickToBottomRef = useRef(true);
  stickToBottomRef.current = stickToBottom;
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The browser no longer binds to a participant. The server-created Local User
  // id is read from the participant roster only for notification self-filtering.
  // undefined means the roster lookup is still pending (or unavailable).
  const [myParticipantId, setMyParticipantId] = useState<string | undefined>();

  // Latest group title / members / own id for the stable WS callback (same
  // sync-during-render pattern as searchActiveRef above): the notification
  // fired from the socket callback must read the live values, not the ones
  // captured at mount.
  const groupTitleRef = useRef<string | null>(null);
  groupTitleRef.current = header.groupTitle;
  const membersRef = useRef<Member[]>([]);
  membersRef.current = members;
  const myParticipantIdRef = useRef<string | undefined>(undefined);
  myParticipantIdRef.current = myParticipantId;

  useEffect(() => {
    let cancelled = false;
    void fetchLocalUserParticipantId()
      .then((participantId) => {
        if (cancelled || !participantId) {
          return;
        }
        // Update the ref before state so an event arriving in the same turn as
        // the roster response is filtered even before React re-renders.
        myParticipantIdRef.current = participantId;
        setMyParticipantId(participantId);
      })
      .catch(() => {
        // Notifications stay silent when the Local User cannot be resolved.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Archived and soft-deleted groups remain browsable as read-only history.
  // (已随头部数据一并移入 useGroupHeader,此处仅保留消息流自身的加载。)
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
        const res = await fetch(url);
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
        // data source stay consistent (group switch and the one-click clear
        // all land here).
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
      const res = await fetch(`/api/groups/${groupId}/members`);
      if (!res.ok) {
        return;
      }
      setMembers(await res.json());
    } catch {
      // The sender badges stay sparse when the roster request fails.
    }
  }, [groupId]);
  useEffect(() => {
    loadMessages();
    loadMembers();
  }, [loadMessages, loadMembers]);

  // Ticket 23 的 markRead / setActiveGroupId 已随消息 hook 常驻化移出:进入
  // 消息页(GroupMessagesPage)时清零未读,成员页(仅共享右栏面板)不再误清零。

  // Live updates (ticket 14): the WS hub pushes every group message frame for
  // this group (including the sender's own echo). Merge new messages by id so
  // a WS push and a later reload stay idempotent — duplicates never render
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
      if (
        event.type === "task_output" ||
        event.type === "task_stall_alert" ||
        event.type === "task_status_changed"
      ) {
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

  // Clear the copy-feedback timer on unmount.
  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current !== null) {
        clearTimeout(copyTimeoutRef.current);
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

  return {
    messages,
    members,
    loading,
    error,
    groupStatus: header.groupStatus,
    groupTitle: header.groupTitle,
    editingTitle: header.editingTitle,
    setEditingTitle: header.setEditingTitle,
    titleDraft: header.titleDraft,
    setTitleDraft: header.setTitleDraft,
    savingTitle: header.savingTitle,
    collapsedRootIds,
    pendingCount,
    openActionsId,
    setOpenActionsId,
    copiedId,
    editingId,
    savingEdit,
    editBody,
    setEditBody,
    expandedIds,
    toggleFold,
    searchBoxOpen,
    setSearchBoxOpen,
    searchQuery,
    setSearchQuery,
    searchActive,
    searchActiveQuery,
    scrollRef,
    myParticipantId,
    threadTree,
    toggleCollapsed,
    isReadOnly: header.isReadOnly,
    isDeleted: header.isDeleted,
    handleRenameTitle: header.handleRenameTitle,
    handleSearch,
    handleClearSearch,
    handleStreamScroll,
    handleJumpToBottom,
    handleCopy,
    handleEditStart,
    handleEditSave,
    handleEditCancel,
    handleDelete,
  };
}
