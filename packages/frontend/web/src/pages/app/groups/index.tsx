import {
  Archive,
  KeyRound,
  MessageSquare,
  Plus,
  RotateCcw,
  Search,
  SearchX,
  Settings,
  Trash2,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useUnread } from "@/hooks/use-unread";
import {
  PARTICIPANT_ID_KEY,
  participantIdentityHeaders,
} from "@/lib/api-client";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

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
 * Group list page (ticket 02): shows all groups with status and member
 * counts, lets the operator create a new group and archive finished ones.
 * The web viewer acts as a human participant: an identity (participant id) can
 * be selected at the top of the page, and every request carries it as
 * `X-Participant-Id` so the identity middleware treats the browser session as
 * that participant.
 */
export default function GroupsPage() {
  const [, navigate] = useLocation();
  const [groups, setGroups] = useState<GroupItem[]>([]);
  const [loading, setLoading] = useState(false);
  // 分页:total 为满足当前过滤条件的总数(由后端返回),用于判断是否还有更多;
  // loadingMore 表示「加载更多」请求进行中(按钮禁用防重复点击)。
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
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
      localStorage.setItem(PARTICIPANT_ID_KEY, trimmed);
    } else {
      localStorage.removeItem(PARTICIPANT_ID_KEY);
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

  return (
    <div className="mx-auto w-full max-w-4xl p-4 sm:p-6">
      <div className="mb-6 flex flex-col gap-3">
        <div>
          <h2 className="text-xl font-semibold">{t("groups.title")}</h2>
          <p className="text-muted-foreground text-sm">
            {t("groups.subtitle")}
          </p>
        </div>
        {/* 群列表搜索(enhancement):按标题关键词过滤,输入防抖 300ms 后拉取;
            带清除按钮,清空恢复全量;下方显示当前结果数。 */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="text"
            placeholder={t("groups.search.placeholder")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            aria-label={t("groups.search.aria")}
            className="pl-9 pr-9"
          />
          {searchQuery && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setSearchQuery("")}
              aria-label={t("groups.search.clearAria")}
              className="absolute right-1 top-1/2 -translate-y-1/2 p-1"
            >
              <X className="size-4" />
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {loading
            ? t("common.loading")
            : debouncedQuery
              ? t("groups.count.matched", {
                  count: groups.length,
                  query: debouncedQuery,
                })
              : t("groups.count.total", { count: groups.length })}
        </p>
      </div>

      {/* 身份面板(ticket 29):当前身份 + 已有 Participant 选择 + 手动输入 id + 注册 */}
      <div className="mb-6 rounded-lg border bg-card">
        {/* ① 当前身份:已绑定显示「使用中: name(typedevice)」,未绑定提示 */}
        <div className="border-b px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            {boundParticipantId ? (
              <span className="inline-flex min-w-0 items-center gap-2 text-sm font-medium">
                <KeyRound className="size-4 shrink-0" />
                <span className="truncate">
                  {t("groups.identity.inUse")}{" "}
                  {currentParticipant
                    ? `${currentParticipant.name}${
                        currentParticipant.device
                          ? `(${currentParticipant.device})`
                          : ""
                      }`
                    : t("groups.identity.bound")}
                </span>
              </span>
            ) : (
              <span className="text-sm text-muted-foreground">
                {t("groups.identity.unbound")}
              </span>
            )}
            {boundParticipantId && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleClearIdentity}
                className="shrink-0"
              >
                {t("common.clear")}
              </Button>
            )}
          </div>
        </div>

        {/* ② 已有 Participant 列表:选择身份(全信模型,声明即绑定,无服务端调用) */}
        <div className="border-b px-4 py-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium">
              {t("groups.identity.existing")}
            </span>
            <span className="text-xs text-muted-foreground">
              {participantsLoading
                ? t("common.loading")
                : t("groups.identity.count", { count: participants.length })}
            </span>
          </div>
          {participantsError && (
            <p className="mb-2 text-xs text-red-600">{participantsError}</p>
          )}
          {participants.length === 0 && !participantsLoading ? (
            <p className="text-sm text-muted-foreground">
              {t("groups.identity.empty")}
            </p>
          ) : (
            <ul className="max-h-48 space-y-1 overflow-y-auto pr-1">
              {participants.map((participant) => {
                const isBound = participant.id === boundParticipantId;
                return (
                  <li
                    key={participant.id}
                    className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-muted"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm">{participant.name}</div>
                      {participant.device && (
                        <div className="truncate text-xs text-muted-foreground">
                          {participant.device}
                        </div>
                      )}
                    </div>
                    {isBound ? (
                      <span className="inline-flex shrink-0 items-center rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
                        {t("common.inUse")}
                      </span>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleBind(participant)}
                        className="shrink-0"
                      >
                        {t("common.use")}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* ③ 手动输入 participant id(全信模型:任意声称的 id 都被接受) */}
        <div className="border-b px-4 py-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              type="text"
              placeholder={t("groups.identity.inputPlaceholder")}
              value={identityInput}
              onChange={(e) => setIdentityInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  handleSaveIdentity();
                }
              }}
              aria-label={t("groups.identity.inputAria")}
              className="sm:max-w-xs"
            />
            <Button
              size="sm"
              onClick={handleSaveIdentity}
              disabled={!identityInput.trim()}
              className="shrink-0"
            >
              {t("groups.identity.bind")}
            </Button>
          </div>
        </div>

        {/* ④ 注册新 Participant(ticket 28):替代终端 curl 注册;成功即自动绑定并切换身份 */}
        <div className="border-t px-4 py-3">
          <button
            type="button"
            onClick={() => setRegisterOpen((v) => !v)}
            className="flex w-full items-center justify-between text-sm font-medium"
            aria-expanded={registerOpen}
          >
            <span className="inline-flex items-center gap-2">
              <UserPlus className="size-4" />
              {t("groups.identity.register")}
            </span>
            <span className="text-xs text-muted-foreground">
              {registerOpen ? t("common.collapse") : t("common.expand")}
            </span>
          </button>
          {registerOpen && (
            <div className="mt-3 flex flex-col gap-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Input
                  type="text"
                  placeholder={t("groups.identity.regNamePlaceholder")}
                  value={regName}
                  onChange={(e) => setRegName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      handleRegister();
                    }
                  }}
                  aria-label={t("groups.identity.regNameAria")}
                  className="sm:max-w-xs"
                />
                <Input
                  type="text"
                  placeholder={t("groups.identity.regDevicePlaceholder")}
                  value={regDevice}
                  onChange={(e) => setRegDevice(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      handleRegister();
                    }
                  }}
                  aria-label={t("groups.identity.regDeviceAria")}
                  className="sm:max-w-xs"
                />
                <Button
                  size="sm"
                  onClick={handleRegister}
                  disabled={registering}
                  className="shrink-0"
                >
                  {registering
                    ? t("groups.identity.registering")
                    : t("groups.identity.registerButton")}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {t("groups.identity.registerHint")}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Participant 设置(ticket 20):绑定后可见,展示并编辑自己的注册信息 */}
      {boundParticipantId && participantInfo && (
        <div className="mb-6 rounded-lg border bg-card p-4">
          <button
            type="button"
            onClick={() => setSettingsOpen((v) => !v)}
            className="flex w-full items-center justify-between text-sm font-medium"
            aria-expanded={settingsOpen}
          >
            <span className="inline-flex items-center gap-2">
              <Settings className="size-4" />
              {t("groups.settings.title")}
            </span>
            <span className="text-xs text-muted-foreground">
              {settingsOpen ? t("common.collapse") : t("common.expand")}
            </span>
          </button>
          {settingsOpen && (
            <div className="mt-3 flex flex-col gap-3">
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>
                  {t("groups.settings.name")}
                  {participantInfo.name}
                </span>
                <span>
                  {t("groups.settings.device")}
                  {participantInfo.device ?? "-"}
                </span>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Input
                  type="text"
                  placeholder={t("groups.settings.namePlaceholder")}
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  aria-label={t("groups.settings.nameAria")}
                  className="sm:max-w-xs"
                />
                <Input
                  type="text"
                  placeholder={t("groups.settings.devicePlaceholder")}
                  value={deviceInput}
                  onChange={(e) => setDeviceInput(e.target.value)}
                  aria-label={t("groups.settings.deviceAria")}
                  className="sm:max-w-xs"
                />
                <Button
                  size="sm"
                  onClick={handleSaveSettings}
                  disabled={savingSettings}
                  className="shrink-0"
                >
                  {savingSettings ? t("common.saving") : t("common.save")}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Create group */}
      <div className="mb-6 flex flex-col gap-2 sm:flex-row">
        <Input
          id="group-title-input"
          placeholder={t("groups.create.placeholder")}
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              handleCreate();
            }
          }}
          aria-label={t("groups.create.aria")}
        />
        <Button
          onClick={handleCreate}
          disabled={creating || !newTitle.trim()}
          className="shrink-0"
        >
          <Plus />
          {creating ? t("common.creating") : t("groups.create.button")}
        </Button>
      </div>

      {message && (
        <div className="mb-4 rounded-md border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
          {message}
        </div>
      )}
      {error && (
        <div className="mb-4 rounded-md border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </div>
      )}

      {/* Status filter tabs */}
      <div className="mb-4 flex gap-1 rounded-lg border bg-card p-1">
        {(
          [
            ["all", t("groups.filter.all")],
            ["active", t("groups.filter.active")],
            ["archived", t("groups.filter.archived")],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setStatusFilter(value)}
            className={cn(
              "flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              statusFilter === value
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:bg-muted",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="rounded-lg border bg-card shadow-sm">
        {groups.length === 0 ? (
          <div className="flex flex-col items-center gap-3 p-10 text-center text-sm text-muted-foreground">
            {loading ? (
              t("common.loading")
            ) : debouncedQuery ? (
              // 搜索无结果:与「暂无群组」区分开的空态文案。
              <>
                <SearchX className="size-8" />
                <p>{t("groups.empty.notFound")}</p>
              </>
            ) : (
              <>
                <Users className="size-8" />
                <p>
                  {statusFilter === "archived"
                    ? t("groups.empty.archived")
                    : statusFilter === "active"
                      ? t("groups.empty.active")
                      : t("groups.empty.all")}
                </p>
                {statusFilter === "all" && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      document.getElementById("group-title-input")?.focus()
                    }
                  >
                    <Plus />
                    {t("groups.empty.createCta")}
                  </Button>
                )}
              </>
            )}
          </div>
        ) : (
          <>
            {/* Mobile: card list */}
            <div className="flex flex-col gap-3 p-3 md:hidden">
              {groups.map((group) => (
                <div
                  key={group.id}
                  className="flex flex-col gap-2 rounded-lg border bg-card p-4"
                >
                  <div className="flex items-center justify-between gap-2">
                    <button
                      type="button"
                      className="min-w-0 flex-1 truncate text-left text-sm font-medium hover:underline"
                      onClick={() => navigate(`/groups/${group.id}`)}
                    >
                      {group.title}
                    </button>
                    <StatusBadge status={group.status} />
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <Users className="size-3.5" />
                      {t("groups.memberCount", { count: group.memberCount })}
                    </span>
                    {previewFor(group) && (
                      <span className="inline-flex min-w-0 items-center gap-1">
                        <MessageSquare className="size-3.5 shrink-0" />
                        <span className="truncate">{previewFor(group)}</span>
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => navigate(`/groups/${group.id}/members`)}
                    >
                      {t("groups.members.manage")}
                    </Button>
                    {group.status === "active" ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1"
                        onClick={() => handleArchive(group)}
                      >
                        <Archive />
                        {t("groups.archive")}
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1"
                        onClick={() => handleRestore(group)}
                      >
                        <RotateCcw />
                        {t("groups.restore")}
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1 text-red-600 hover:text-red-700"
                      onClick={() => handleDelete(group)}
                    >
                      <Trash2 />
                      {t("common.delete")}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
            {/* Desktop: table */}
            <table className="hidden w-full text-sm md:table">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="px-4 py-3 font-medium">
                    {t("groups.table.name")}
                  </th>
                  <th className="px-4 py-3 font-medium">
                    {t("groups.table.status")}
                  </th>
                  <th className="px-4 py-3 font-medium">
                    {t("groups.table.members")}
                  </th>
                  <th className="px-4 py-3 font-medium">
                    {t("groups.table.lastMessage")}
                  </th>
                  <th className="px-4 py-3 text-right font-medium">
                    {t("groups.table.actions")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => (
                  <tr key={group.id} className="border-b last:border-0">
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        className="font-medium hover:underline"
                        onClick={() => navigate(`/groups/${group.id}`)}
                      >
                        {group.title}
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={group.status} />
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {group.memberCount}
                    </td>
                    <td className="max-w-56 px-4 py-3 text-muted-foreground">
                      <span className="block truncate">
                        {previewFor(group) ?? t("common.noMessages")}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            navigate(`/groups/${group.id}/members`)
                          }
                        >
                          <Users />
                          {t("groups.members.manage")}
                        </Button>
                        {group.status === "active" ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleArchive(group)}
                          >
                            <Archive />
                            {t("groups.archive")}
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRestore(group)}
                          >
                            <RotateCcw />
                            {t("groups.restore")}
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-red-600 hover:text-red-700"
                          onClick={() => handleDelete(group)}
                        >
                          <Trash2 />
                          {t("common.delete")}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {/* 分页:还有更多时才显示「加载更多」,加载中禁用防重复点击 */}
            {groups.length > 0 && groups.length < total && (
              <div className="flex justify-center border-t p-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={loadMore}
                  disabled={loadingMore}
                >
                  {loadingMore ? t("common.loading") : t("groups.loadMore")}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: "active" | "archived" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        status === "active"
          ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200"
          : "bg-muted text-muted-foreground",
      )}
    >
      {status === "active"
        ? t("groups.status.active")
        : t("groups.status.archived")}
    </span>
  );
}
