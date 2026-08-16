import { useCallback, useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useUnread } from "@/hooks/use-unread";
import {
  PARTICIPANT_ID_KEY,
  participantIdentityHeaders,
} from "@/lib/api-client";
import { t } from "@/lib/i18n";
import { useIdentityStore } from "@/lib/stores/identity";

type GroupItem = {
  id: string;
  title: string;
  status: "active" | "archived";
  memberCount: number;
  createdAt: string;
};

/** The bound participant's own registration (GET /api/participants, filtered by id). */
type ParticipantInfo = {
  id: string;
  name: string;
  device: string | null;
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
  const [boundParticipantId, setBoundParticipantId] = useState(() =>
    typeof localStorage !== "undefined"
      ? (localStorage.getItem(PARTICIPANT_ID_KEY) ?? "")
      : "",
  );
  // 手动输入 participant id(全信模型:任意声称的 id 都被接受,不存在的回落
  // Local User)。下拉选择在身份面板的「已有 Participant」列表里完成。
  const [identityInput, setIdentityInput] = useState("");
  // Ticket 20: Participant 设置展开区 — 绑定成功后可见,展示并编辑自己的注册信息。
  const [participantInfo, setParticipantInfo] =
    useState<ParticipantInfo | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [deviceInput, setDeviceInput] = useState("");
  const [savingSettings, setSavingSettings] = useState(false);
  // Ticket 28: 注册新 Participant — 替代终端 curl 注册;注册成功即自动绑定
  // (id 覆盖写入,语义:注册即切换身份,不强制清除旧绑定)。
  const [registerOpen, setRegisterOpen] = useState(false);
  const [regName, setRegName] = useState("");
  const [regDevice, setRegDevice] = useState("");
  const [registering, setRegistering] = useState(false);
  // Ticket 29: 身份面板 — 已有 Participant 名册(公开 GET /api/participants,无需鉴权)。
  const [participants, setParticipants] = useState<ParticipantInfo[]>([]);
  const [participantsLoading, setParticipantsLoading] = useState(false);
  const [participantsError, setParticipantsError] = useState<string | null>(
    null,
  );

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

  // Ticket 29: 拉取已有 Participant 名册(公开端点,无需鉴权)。绑定/清除/注册后
  // 由 commitToken 触发刷新;加载失败只影响面板内的列表区,不阻塞页面。
  const loadParticipants = useCallback(async () => {
    setParticipantsLoading(true);
    setParticipantsError(null);
    try {
      const res = await fetch("/api/participants");
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as ParticipantInfo[];
      setParticipants(data);
    } catch (e) {
      setParticipantsError(
        t("groups.identity.listFailed", {
          detail: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setParticipantsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadParticipants();
  }, [loadParticipants]);

  const commitIdentity = (participantId: string | null) => {
    const trimmed = participantId?.trim() ?? null;
    if (trimmed) {
      useIdentityStore.getState().setIdentity(trimmed);
    } else {
      useIdentityStore.getState().clearIdentity();
    }
    setBoundParticipantId(trimmed ?? "");
    loadGroups();
    loadParticipants();
  };

  const handleSaveIdentity = () => {
    const id = identityInput.trim();
    if (!id) {
      return;
    }
    commitIdentity(id);
    setIdentityInput("");
  };

  const handleClearIdentity = () => {
    commitIdentity(null);
  };

  // 全信模型:选择身份 = 声明身份,无需任何服务端调用(reset-token 端点已删除)。
  const handleBind = (participant: ParticipantInfo) => {
    setMessage(null);
    setError(null);
    commitIdentity(participant.id);
    setMessage(t("groups.identity.switched", { name: participant.name }));
  };

  // Ticket 28: 前端注册 participant(POST /api/participants,公开端点)。成功后用返回的
  // id 自动完成绑定(commitIdentity 覆盖写入 localStorage 并刷新列表)。
  const handleRegister = async () => {
    const name = regName.trim();
    if (!name) {
      setError(t("groups.identity.nameRequired"));
      return;
    }
    setRegistering(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch("/api/participants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          device: regDevice.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(
          `HTTP ${res.status}${body?.message ? `: ${body.message}` : ""}`,
        );
      }
      const participant = (await res.json()) as {
        id: string;
        name: string;
      };
      // 注册即切换身份:id 覆盖写入,不强制清除旧绑定。
      commitIdentity(participant.id);
      setRegName("");
      setRegDevice("");
      setMessage(
        t("groups.identity.registeredAndBound", { name: participant.name }),
      );
    } catch (e) {
      setError(
        t("groups.identity.registerFailed", {
          detail: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setRegistering(false);
    }
  };

  // Ticket 20: 拉取自己(coagenthub.participantId)的注册信息并预填设置表单。加载失败
  // 不影响列表页,设置区静默留空。
  const loadParticipantInfo = useCallback(async () => {
    const participantId =
      typeof localStorage !== "undefined"
        ? localStorage.getItem(PARTICIPANT_ID_KEY)
        : null;
    if (!participantId) {
      setParticipantInfo(null);
      return;
    }
    try {
      const headers = participantIdentityHeaders();
      const res = await fetch("/api/participants", { headers });
      if (!res.ok) {
        return;
      }
      const participants = (await res.json()) as ParticipantInfo[];
      const mine = participants.find((a) => a.id === participantId) ?? null;
      setParticipantInfo(mine);
      if (mine) {
        setNameInput(mine.name);
        setDeviceInput(mine.device ?? "");
      }
    } catch {
      // 静默失败:设置区保持原样。
    }
  }, []);

  // Ticket 20: 绑定 participant 后加载其注册信息(GET /api/participants 找到自己的 id)。
  useEffect(() => {
    if (boundParticipantId) {
      loadParticipantInfo();
    }
  }, [boundParticipantId, loadParticipantInfo]);

  const handleSaveSettings = async () => {
    const participantId =
      typeof localStorage !== "undefined"
        ? localStorage.getItem(PARTICIPANT_ID_KEY)
        : null;
    if (!participantId) {
      setError(t("groups.settings.noParticipant"));
      return;
    }
    // 名称必填:空名称会被 PATCH 静默丢弃(undefined),提示而不是假装成功。
    if (!nameInput.trim()) {
      setError(t("groups.settings.nameEmpty"));
      return;
    }
    setSavingSettings(true);
    setMessage(null);
    setError(null);
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...participantIdentityHeaders(),
      };
      // device 为空时发送 null 表示清空(与后端 PATCH 语义一致)。
      const res = await fetch(`/api/participants/${participantId}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          name: nameInput.trim() || undefined,
          device: deviceInput.trim() ? deviceInput.trim() : null,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(
          `HTTP ${res.status}${body?.message ? `: ${body.message}` : ""}`,
        );
      }
      setMessage(t("groups.settings.saved"));
      await loadParticipantInfo();
    } catch (e) {
      setError(
        t("groups.settings.saveFailed", {
          detail: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setSavingSettings(false);
    }
  };

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

  // Ticket 29: 当前绑定身份 — 从名册里找,找不到则回退 participantInfo(设置区已
  // 加载的自己的注册信息)。localStorage 在 commitIdentity 里同步写入,渲染时
  // 读取即为最新绑定。
  const currentParticipant =
    participants.find((a) => a.id === boundParticipantId) ??
    participantInfo ??
    null;

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
    boundParticipantId,
    identityInput,
    setIdentityInput,
    participantInfo,
    settingsOpen,
    setSettingsOpen,
    nameInput,
    setNameInput,
    deviceInput,
    setDeviceInput,
    savingSettings,
    registerOpen,
    setRegisterOpen,
    regName,
    setRegName,
    regDevice,
    setRegDevice,
    registering,
    participants,
    participantsLoading,
    participantsError,
    handleSaveIdentity,
    handleClearIdentity,
    handleBind,
    handleRegister,
    handleSaveSettings,
    handleCreate,
    startRenameTitle,
    handleRenameTitle,
    handleArchive,
    handleRestore,
    handleDelete,
    loadMore,
    currentParticipant,
  };
}
