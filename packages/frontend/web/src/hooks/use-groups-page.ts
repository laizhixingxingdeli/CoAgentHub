import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useUnread } from "@/hooks/use-unread";
import { participantIdentityHeaders } from "@/lib/api-client";
import { t } from "@/lib/i18n";
import { useIdentityStore } from "@/lib/stores/identity";

type GroupItem = {
  id: string;
  title: string;
  status: "active" | "archived";
  memberCount: number;
  createdAt: string;
};

/** Status filter tabs; "all" fetches without a ?status= param. */
type StatusFilter = "all" | "active" | "archived";

/** 群列表分页:首屏/重置每次取一页,「加载更多」按此步长追加。 */
const PAGE_SIZE = 20;

/**
 * Turn a non-OK response into a human-readable error. The identity middleware
 * never returns 401/403 (LAN full-trust model), so a 4xx here is a plain
 * request error — the message just describes which identity was declared.
 */
function throwForStatus(res: Response, sentIdentity: boolean): never {
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      sentIdentity
        ? t("groups.error.identityRejected")
        : t("groups.error.identityMissing"),
    );
  }
  throw new Error(`HTTP ${res.status}`);
}

/**
 * All state and data-fetching logic for the group list page (ticket 02).
 * Extracted from GroupsPage so the page component is a thin composition of
 * this hook, the identity/participant panel sections and the list rendering.
 */
export function useGroupsPage() {
  const [, navigate] = useLocation();
  const [groups, setGroups] = useState<GroupItem[]>([]);
  const [loading, setLoading] = useState(false);
  // 分页:total 为满足当前过滤条件的总数(由后端返回),用于判断是否还有更多;
  // loadingMore 表示「加载更多」请求进行中(按钮禁用防重复点击)。
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  // 群名行内改名(网页体验批次):editingTitleId = 正在改名的群 id,titleDraft 为输入值。
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [savingTitle, setSavingTitle] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  // 群列表搜索(enhancement):输入即时更新,防抖 300ms 后才触发重新拉取。
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  // Ticket: 最近一条消息预览 — 复用全局 unread store(WS 帧 + 消息页历史
  // 加载都会写入),不新增任何 API 调用。
  const { lastMessageByGroup } = useUnread();
  /** 群组最近消息预览:无消息返回 null(显示占位),长文截断到 30 字。 */
  const previewFor = (group: GroupItem) => {
    const body = lastMessageByGroup.get(group.id)?.body;
    if (!body) {
      return null;
    }
    return body.length > 30 ? `${body.slice(0, 30)}…` : body;
  };

  const loadGroups = useCallback(async () => {
    setLoading(true);
    setError(null);
    // Snapshot the filter and query this request was made for; a stale
    // response (a slower fetch from a previously active tab resolving after
    // the user switched tabs or kept typing) must not clobber the list with
    // the wrong filter/search's data.
    const filter = statusFilter;
    const q = debouncedQuery;
    try {
      const headers = participantIdentityHeaders();
      // "all" carries no ?status= (server returns active + archived and hides
      // soft-deleted rows); the tabs pass the exact enum the server filters on.
      // A non-empty search appends ?q= (title ILIKE) and combines with the tab.
      const params = new URLSearchParams();
      if (filter !== "all") {
        params.set("status", filter);
      }
      if (q) {
        params.set("q", q);
      }
      // 分页:首次加载/过滤重置总是从第一页(limit=20,offset=0)开始。
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", "0");
      const res = await fetch(`/api/groups?${params.toString()}`, { headers });
      if (!res.ok) {
        throwForStatus(res, Boolean(headers["X-Participant-Id"]));
      }
      const data = (await res.json()) as { items: GroupItem[]; total: number };
      if (filter === statusFilter && q === debouncedQuery) {
        setGroups(data.items);
        setTotal(data.total);
      }
    } catch (e) {
      if (filter === statusFilter && q === debouncedQuery) {
        setError(
          t("groups.error.loadFailed", {
            detail: e instanceof Error ? e.message : String(e),
          }),
        );
      }
    } finally {
      if (filter === statusFilter && q === debouncedQuery) {
        setLoading(false);
      }
    }
  }, [statusFilter, debouncedQuery]);

  // 「加载更多」:按当前已加载数量作为 offset 追加下一页;仅当前过滤条件
  // 未变化时提交结果,避免与新的搜索/过滤请求交错。
  const loadMore = useCallback(async () => {
    if (loadingMore) {
      return;
    }
    const filter = statusFilter;
    const q = debouncedQuery;
    setLoadingMore(true);
    setError(null);
    try {
      const headers = participantIdentityHeaders();
      const params = new URLSearchParams();
      if (filter !== "all") {
        params.set("status", filter);
      }
      if (q) {
        params.set("q", q);
      }
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(groups.length));
      const res = await fetch(`/api/groups?${params.toString()}`, { headers });
      if (!res.ok) {
        throwForStatus(res, Boolean(headers["X-Participant-Id"]));
      }
      const data = (await res.json()) as { items: GroupItem[]; total: number };
      if (filter === statusFilter && q === debouncedQuery) {
        setGroups((prev) => [...prev, ...data.items]);
        setTotal(data.total);
      }
    } catch (e) {
      if (filter === statusFilter && q === debouncedQuery) {
        setError(
          t("groups.error.loadMoreFailed", {
            detail: e instanceof Error ? e.message : String(e),
          }),
        );
      }
    } finally {
      if (filter === statusFilter && q === debouncedQuery) {
        setLoadingMore(false);
      }
    }
  }, [statusFilter, debouncedQuery, groups.length, loadingMore]);

  useEffect(() => {
    loadGroups();
  }, [loadGroups]);

  // 群列表搜索防抖:输入停顿 300ms 后才更新 debouncedQuery 触发重新拉取;
  // 清空输入同样防抖后恢复全量列表。
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(searchQuery), 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // 身份切换后群列表刷新:绑定/清除发生在侧栏(身份切换器),页面不再直接持有
  // commitIdentity;订阅 identity store 的 participantId,变化即重新拉取列表,
  // 与旧实现中 commitIdentity 调用 loadGroups() 的语义一致。
  const identityId = useIdentityStore((s) => s.participantId);
  const prevIdentityId = useRef(identityId);
  useEffect(() => {
    if (prevIdentityId.current !== identityId) {
      prevIdentityId.current = identityId;
      void loadGroups();
    }
  }, [identityId, loadGroups]);

  const handleCreate = async () => {
    const title = newTitle.trim();
    if (!title) {
      return;
    }
    setCreating(true);
    setMessage(null);
    setError(null);
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...participantIdentityHeaders(),
      };
      const res = await fetch("/api/groups", {
        method: "POST",
        headers,
        body: JSON.stringify({ title }),
      });
      if (!res.ok) {
        throwForStatus(res, Boolean(headers["X-Participant-Id"]));
      }
      setNewTitle("");
      setMessage(t("groups.created", { title }));
      await loadGroups();
    } catch (e) {
      setError(
        t("groups.error.createFailed", {
          detail: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setCreating(false);
    }
  };

  /** 群名行内改名(网页体验批次):PATCH /groups/:id { title } 后刷新列表。
   * 只允许 active 群改名(归档/软删只读,与其它写操作一致)。 */
  const startRenameTitle = (group: GroupItem) => {
    setEditingTitleId(group.id);
    setTitleDraft(group.title);
  };

  const handleRenameTitle = async () => {
    const title = titleDraft.trim();
    if (!editingTitleId || !title || savingTitle) {
      return;
    }
    setError(null);
    setMessage(null);
    setSavingTitle(true);
    try {
      const headers = participantIdentityHeaders();
      const res = await fetch(`/api/groups/${editingTitleId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) {
        throwForStatus(res, Boolean(headers["X-Participant-Id"]));
      }
      setMessage(t("groups.renamed", { title }));
      setEditingTitleId(null);
      await loadGroups();
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

  const handleArchive = async (group: GroupItem) => {
    if (!window.confirm(t("groups.confirm.archive", { title: group.title }))) {
      return;
    }
    setError(null);
    setMessage(null);
    try {
      const headers = participantIdentityHeaders();
      const res = await fetch(`/api/groups/${group.id}/archive`, {
        method: "POST",
        headers,
      });
      if (!res.ok) {
        throwForStatus(res, Boolean(headers["X-Participant-Id"]));
      }
      setMessage(t("groups.archived", { title: group.title }));
      await loadGroups();
    } catch (e) {
      setError(
        t("groups.error.archiveFailed", {
          detail: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  };

  const handleRestore = async (group: GroupItem) => {
    setError(null);
    setMessage(null);
    try {
      const headers = participantIdentityHeaders();
      const res = await fetch(`/api/groups/${group.id}/unarchive`, {
        method: "POST",
        headers,
      });
      if (!res.ok) {
        throwForStatus(res, Boolean(headers["X-Participant-Id"]));
      }
      setMessage(t("groups.restored", { title: group.title }));
      await loadGroups();
    } catch (e) {
      setError(
        t("groups.error.restoreFailed", {
          detail: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  };

  // Ticket 24: 删除群组 — 软删除(status -> deleted),行数据保留,仅从列表
  // 移除。active 与 archived 都显示删除入口;active 用更醒目的确认文案提示
  // 消息与成员关系将被移除,建议先归档(防误删)。
  const handleDelete = async (group: GroupItem) => {
    if (
      !window.confirm(
        group.status === "active"
          ? t("groups.confirm.deleteActive", { title: group.title })
          : t("groups.confirm.deleteArchived", { title: group.title }),
      )
    ) {
      return;
    }
    setError(null);
    setMessage(null);
    try {
      const headers = participantIdentityHeaders();
      const res = await fetch(`/api/groups/${group.id}`, {
        method: "DELETE",
        headers,
      });
      if (!res.ok) {
        throwForStatus(res, Boolean(headers["X-Participant-Id"]));
      }
      setMessage(t("groups.deleted", { title: group.title }));
      await loadGroups();
    } catch (e) {
      setError(
        t("groups.error.deleteFailed", {
          detail: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  };

  return {
    navigate,
    groups,
    loading,
    total,
    loadingMore,
    creating,
    newTitle,
    setNewTitle,
    editingTitleId,
    setEditingTitleId,
    titleDraft,
    setTitleDraft,
    savingTitle,
    error,
    message,
    statusFilter,
    setStatusFilter,
    searchQuery,
    setSearchQuery,
    debouncedQuery,
    previewFor,
    handleCreate,
    startRenameTitle,
    handleRenameTitle,
    handleArchive,
    handleRestore,
    handleDelete,
    loadMore,
  };
}
