import {
  Archive,
  KeyRound,
  MessageSquare,
  Plus,
  RotateCcw,
  Settings,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useUnread } from "@/hooks/use-unread";
import {
  AGENT_ID_KEY,
  AGENT_TOKEN_KEY,
  agentAuthHeaders,
} from "@/lib/api-client";
import { cn } from "@/lib/utils";

type GroupItem = {
  id: string;
  title: string;
  status: "active" | "archived";
  memberCount: number;
  createdAt: string;
};

/** The bound agent's own registration (GET /api/agents, filtered by id). */
type AgentInfo = {
  id: string;
  name: string;
  type: string;
  device: string | null;
  webhookUrl: string | null;
};

/** Status filter tabs; "all" fetches without a ?status= param. */
type StatusFilter = "all" | "active" | "archived";

/**
 * Turn a non-OK response into a human-readable error. A 401 means the
 * agentAuth middleware rejected the request: if no `Authorization` header was
 * sent the token is simply not bound yet, otherwise the bound token was
 * rejected/revoked and needs to be cleared and re-bound.
 */
function throwForStatus(res: Response, sentAuthHeader: boolean): never {
  if (res.status === 401) {
    throw new Error(
      sentAuthHeader
        ? "Agent Token 无效或已失效,请在上方清除后重新绑定"
        : "未绑定 Agent Token,请在上方输入并保存",
    );
  }
  throw new Error(`HTTP ${res.status}`);
}

/**
 * Group list page (ticket 02): shows all groups with status and member
 * counts, lets the operator create a new group and archive finished ones.
 * The web viewer acts as a human agent: an agent token can be bound at the
 * top of the page, and every request carries it as `Authorization: Bearer`
 * so the agentAuth-protected group APIs accept the browser session.
 */
export default function GroupsPage() {
  const [, navigate] = useLocation();
  const [groups, setGroups] = useState<GroupItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
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
  const [boundToken, setBoundToken] = useState(() =>
    typeof localStorage !== "undefined"
      ? (localStorage.getItem(AGENT_TOKEN_KEY) ?? "")
      : "",
  );
  const [tokenInput, setTokenInput] = useState("");
  // Ticket 18: the viewer's own agent id, bound alongside the token so the
  // messages page can right-align "my" bubbles. The server never exposes
  // token_hash, so it must be entered explicitly (not looked up).
  const [agentIdInput, setAgentIdInput] = useState("");
  // Ticket 20: Agent 设置展开区 — 绑定成功后可见,展示并编辑自己的注册信息。
  const [agentInfo, setAgentInfo] = useState<AgentInfo | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [deviceInput, setDeviceInput] = useState("");
  const [webhookUrlInput, setWebhookUrlInput] = useState("");
  const [savingSettings, setSavingSettings] = useState(false);
  // Ticket 28: 注册新 Agent — 替代终端 curl 注册;注册成功即自动绑定
  // (token 覆盖写入,语义:注册即切换身份,不强制清除旧绑定)。
  const [registerOpen, setRegisterOpen] = useState(false);
  const [regName, setRegName] = useState("");
  const [regType, setRegType] = useState("human");
  const [regTypeCustom, setRegTypeCustom] = useState("");
  const [regDevice, setRegDevice] = useState("");
  const [registering, setRegistering] = useState(false);
  // 注册响应里的一次性 token:仅显示一次,供用户复制留档。
  const [registeredToken, setRegisteredToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Ticket 29: 身份面板 — 已有 Agent 名册(公开 GET /api/agents,无需鉴权)。
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  // 正在一键绑定的 agent id(按钮转圈防连点)。
  const [bindingId, setBindingId] = useState<string | null>(null);
  // 「高级:手动输入 token」折叠区(兼容特殊场景,默认收起)。
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const loadGroups = useCallback(async () => {
    setLoading(true);
    setError(null);
    // Snapshot the filter this request was made for; a stale response (a
    // slower fetch from a previously active tab resolving after the user
    // switched tabs) must not clobber the list with the wrong filter's data.
    const filter = statusFilter;
    try {
      const headers = agentAuthHeaders();
      // "all" carries no ?status= (server returns active + archived and hides
      // soft-deleted rows); the tabs pass the exact enum the server filters on.
      const query = filter === "all" ? "" : `?status=${filter}`;
      const res = await fetch(`/api/groups${query}`, { headers });
      if (!res.ok) {
        throwForStatus(res, Boolean(headers.Authorization));
      }
      const data = (await res.json()) as GroupItem[];
      if (filter === statusFilter) {
        setGroups(data);
      }
    } catch (e) {
      if (filter === statusFilter) {
        setError(`加载群组失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      if (filter === statusFilter) {
        setLoading(false);
      }
    }
  }, [statusFilter]);

  useEffect(() => {
    loadGroups();
  }, [loadGroups]);

  // Ticket 29: 拉取已有 Agent 名册(公开端点,无需鉴权)。绑定/清除/注册后
  // 由 commitToken 触发刷新;加载失败只影响面板内的列表区,不阻塞页面。
  const loadAgents = useCallback(async () => {
    setAgentsLoading(true);
    setAgentsError(null);
    try {
      const res = await fetch("/api/agents");
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as AgentInfo[];
      setAgents(data);
    } catch (e) {
      setAgentsError(
        `Agent 列表加载失败: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setAgentsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAgents();
  }, [loadAgents]);

  const commitToken = (next: string | null, agentId: string | null) => {
    const trimmed = next?.trim() ?? null;
    const trimmedAgentId = agentId?.trim() ?? null;
    if (trimmed) {
      localStorage.setItem(AGENT_TOKEN_KEY, trimmed);
    } else {
      localStorage.removeItem(AGENT_TOKEN_KEY);
    }
    // Ticket 18: the agent id rides along with the token so the messages page
    // can right-align the viewer's own bubbles. Clearing the token clears it
    // too (a stale id would misalign messages after re-binding).
    if (trimmedAgentId) {
      localStorage.setItem(AGENT_ID_KEY, trimmedAgentId);
    } else {
      localStorage.removeItem(AGENT_ID_KEY);
    }
    setBoundToken(trimmed ?? "");
    loadGroups();
    loadAgents();
  };

  const handleSaveToken = () => {
    const token = tokenInput.trim();
    if (!token) {
      return;
    }
    commitToken(token, agentIdInput);
    setTokenInput("");
    setAgentIdInput("");
  };

  const handleClearToken = () => {
    commitToken(null, null);
  };

  // Ticket 29: 一键绑定 — 调公开端点 POST /:id/reset-token 取回明文 token
  // (局域网信任模型:注册与查/重置 token 均无需鉴权),自动写入并切换身份。
  // 因库中只存 SHA-256 哈希无法还原,后端采用「重置」而非「查」:生成新
  // token 覆盖存储(旧 token 立即失效)并仅此一次返回明文。
  const handleBind = async (agent: AgentInfo) => {
    setBindingId(agent.id);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch(`/api/agents/${agent.id}/reset-token`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(
          `HTTP ${res.status}${body?.message ? `: ${body.message}` : ""}`,
        );
      }
      const { id, token } = (await res.json()) as {
        id: string;
        token: string;
      };
      commitToken(token, id);
      setMessage(`已切换为 ${agent.name}`);
    } catch (e) {
      setError(`绑定失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBindingId(null);
    }
  };

  // Ticket 28: 前端注册 agent(POST /api/agents,公开端点)。成功后用返回的
  // id + token 自动完成绑定(commitToken 覆盖写入 localStorage 并刷新列表)。
  const handleRegister = async () => {
    const name = regName.trim();
    if (!name) {
      setError("Agent 名称不能为空");
      return;
    }
    // 后端 type 是自由文本(z.string().min(1),无枚举校验);select 提供常用
    // 值,「自定义」走自由输入。
    const type = regType === "custom" ? regTypeCustom.trim() : regType;
    if (!type) {
      setError("Agent 类型不能为空");
      return;
    }
    setRegistering(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          type,
          device: regDevice.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(
          `HTTP ${res.status}${body?.message ? `: ${body.message}` : ""}`,
        );
      }
      const agent = (await res.json()) as {
        id: string;
        name: string;
        token: string;
      };
      // 注册即切换身份:token/id 覆盖写入,不强制清除旧绑定。
      commitToken(agent.token, agent.id);
      setRegName("");
      setRegType("human");
      setRegTypeCustom("");
      setRegDevice("");
      setCopied(false);
      setRegisteredToken(agent.token);
      setMessage(`✅ 已注册并绑定 ${agent.name}`);
    } catch (e) {
      setError(`注册失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRegistering(false);
    }
  };

  const handleCopyToken = async () => {
    if (!registeredToken) {
      return;
    }
    try {
      await navigator.clipboard?.writeText(registeredToken);
      setCopied(true);
    } catch {
      // 剪贴板不可用时静默失败(readonly 输入框仍可手动复制)。
    }
  };

  // Ticket 20: 拉取自己(coagenthub.agentId)的注册信息并预填设置表单。加载失败
  // 不影响列表页,设置区静默留空。
  const loadAgentInfo = useCallback(async () => {
    const agentId =
      typeof localStorage !== "undefined"
        ? localStorage.getItem(AGENT_ID_KEY)
        : null;
    if (!agentId) {
      setAgentInfo(null);
      return;
    }
    try {
      const headers = agentAuthHeaders();
      const res = await fetch("/api/agents", { headers });
      if (!res.ok) {
        return;
      }
      const agents = (await res.json()) as AgentInfo[];
      const mine = agents.find((a) => a.id === agentId) ?? null;
      setAgentInfo(mine);
      if (mine) {
        setNameInput(mine.name);
        setDeviceInput(mine.device ?? "");
        setWebhookUrlInput(mine.webhookUrl ?? "");
      }
    } catch {
      // 静默失败:设置区保持原样。
    }
  }, []);

  // Ticket 20: 绑定 agent 后加载其注册信息(GET /api/agents 找到自己的 id)。
  useEffect(() => {
    if (boundToken) {
      loadAgentInfo();
    }
  }, [boundToken, loadAgentInfo]);

  const handleSaveSettings = async () => {
    const agentId =
      typeof localStorage !== "undefined"
        ? localStorage.getItem(AGENT_ID_KEY)
        : null;
    if (!agentId) {
      setError("未绑定 agentId,无法保存 Agent 设置");
      return;
    }
    // 名称必填:空名称会被 PATCH 静默丢弃(undefined),提示而不是假装成功。
    if (!nameInput.trim()) {
      setError("名称不能为空");
      return;
    }
    setSavingSettings(true);
    setMessage(null);
    setError(null);
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...agentAuthHeaders(),
      };
      // device/webhookUrl 为空时发送 null 表示清空(与后端 PATCH 语义一致)。
      const res = await fetch(`/api/agents/${agentId}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          name: nameInput.trim() || undefined,
          device: deviceInput.trim() ? deviceInput.trim() : null,
          webhookUrl: webhookUrlInput.trim() ? webhookUrlInput.trim() : null,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(
          `HTTP ${res.status}${body?.message ? `: ${body.message}` : ""}`,
        );
      }
      setMessage("Agent 设置已保存");
      await loadAgentInfo();
    } catch (e) {
      setError(
        `保存 Agent 设置失败: ${e instanceof Error ? e.message : String(e)}`,
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
        ...agentAuthHeaders(),
      };
      const res = await fetch("/api/groups", {
        method: "POST",
        headers,
        body: JSON.stringify({ title }),
      });
      if (!res.ok) {
        throwForStatus(res, Boolean(headers.Authorization));
      }
      setNewTitle("");
      setMessage(`群组「${title}」创建成功`);
      await loadGroups();
    } catch (e) {
      setError(`创建失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCreating(false);
    }
  };

  const handleArchive = async (group: GroupItem) => {
    if (
      !window.confirm(`确定归档群组「${group.title}」吗?归档后可随时恢复。`)
    ) {
      return;
    }
    setError(null);
    setMessage(null);
    try {
      const headers = agentAuthHeaders();
      const res = await fetch(`/api/groups/${group.id}/archive`, {
        method: "POST",
        headers,
      });
      if (!res.ok) {
        throwForStatus(res, Boolean(headers.Authorization));
      }
      setMessage(`群组「${group.title}」已归档`);
      await loadGroups();
    } catch (e) {
      setError(`归档失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleRestore = async (group: GroupItem) => {
    setError(null);
    setMessage(null);
    try {
      const headers = agentAuthHeaders();
      const res = await fetch(`/api/groups/${group.id}/unarchive`, {
        method: "POST",
        headers,
      });
      if (!res.ok) {
        throwForStatus(res, Boolean(headers.Authorization));
      }
      setMessage(`群组「${group.title}」已恢复为进行中`);
      await loadGroups();
    } catch (e) {
      setError(`恢复失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // Ticket 24: 删除群组 — 软删除(status -> deleted),行数据保留,仅从列表
  // 移除。active 与 archived 都显示删除入口;active 用更醒目的确认文案提示
  // 消息与成员关系将被移除,建议先归档(防误删)。
  const handleDelete = async (group: GroupItem) => {
    if (
      !window.confirm(
        group.status === "active"
          ? `确定删除进行中的群组「${group.title}」吗?删除后不可恢复(数据保留,仅从列表移除),群内消息与成员关系都将被移除。建议先归档。`
          : `确定删除群组「${group.title}」吗?删除后不可恢复(数据保留,仅从列表移除)。`,
      )
    ) {
      return;
    }
    setError(null);
    setMessage(null);
    try {
      const headers = agentAuthHeaders();
      const res = await fetch(`/api/groups/${group.id}`, {
        method: "DELETE",
        headers,
      });
      if (!res.ok) {
        throwForStatus(res, Boolean(headers.Authorization));
      }
      setMessage(`群组「${group.title}」已删除`);
      await loadGroups();
    } catch (e) {
      setError(`删除失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // Ticket 29: 当前绑定身份 — 从名册里找,找不到则回退 agentInfo(设置区已
  // 加载的自己的注册信息)。localStorage 在 commitToken 里同步写入,渲染时
  // 读取即为最新绑定。
  const boundAgentId =
    typeof localStorage !== "undefined"
      ? localStorage.getItem(AGENT_ID_KEY)
      : null;
  const currentAgent =
    agents.find((a) => a.id === boundAgentId) ?? agentInfo ?? null;

  return (
    <div className="mx-auto w-full max-w-4xl p-4 sm:p-6">
      <div className="mb-6">
        <h2 className="text-xl font-semibold">群组</h2>
        <p className="text-muted-foreground text-sm">
          一个群组对应一个任务上下文;成员在群组内分配角色
        </p>
      </div>

      {/* 身份面板(ticket 29):当前身份 + 已有 Agent 一键绑定 + 手动绑定 + 注册 */}
      <div className="mb-6 rounded-lg border bg-card">
        {/* ① 当前身份:已绑定显示「使用中: name(typedevice)」,未绑定提示 */}
        <div className="border-b px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            {boundToken ? (
              <span className="inline-flex min-w-0 items-center gap-2 text-sm font-medium">
                <KeyRound className="size-4 shrink-0" />
                <span className="truncate">
                  使用中:{" "}
                  {currentAgent
                    ? `${currentAgent.name}(${currentAgent.type}${
                        currentAgent.device ? `·${currentAgent.device}` : ""
                      })`
                    : "已绑定"}
                </span>
              </span>
            ) : (
              <span className="text-sm text-muted-foreground">
                未绑定 agent,从下方列表一键绑定,或展开「高级:手动输入 token」
              </span>
            )}
            {boundToken && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleClearToken}
                className="shrink-0"
              >
                清除
              </Button>
            )}
          </div>
        </div>

        {/* ② 已有 Agent 列表:一键绑定(公开 POST /:id/reset-token 取回 token) */}
        <div className="border-b px-4 py-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium">已有 Agent</span>
            <span className="text-xs text-muted-foreground">
              {agentsLoading ? "加载中…" : `共 ${agents.length} 个`}
            </span>
          </div>
          {agentsError && (
            <p className="mb-2 text-xs text-red-600">{agentsError}</p>
          )}
          {agents.length === 0 && !agentsLoading ? (
            <p className="text-sm text-muted-foreground">
              暂无已注册 Agent,展开下方「注册新 Agent」创建
            </p>
          ) : (
            <ul className="max-h-48 space-y-1 overflow-y-auto pr-1">
              {agents.map((agent) => {
                const isBound = agent.id === boundAgentId;
                return (
                  <li
                    key={agent.id}
                    className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-muted"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm">{agent.name}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {agent.type}
                        {agent.device ? ` ${agent.device}` : ""}
                      </div>
                    </div>
                    {isBound ? (
                      <span className="inline-flex shrink-0 items-center rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
                        使用中
                      </span>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleBind(agent)}
                        disabled={bindingId === agent.id}
                        className="shrink-0"
                      >
                        {bindingId === agent.id ? "绑定中…" : "绑定"}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* ③ 高级:手动输入 token(兼容特殊场景,默认收起) */}
        <div className="border-b px-4 py-3">
          <button
            type="button"
            onClick={() => setAdvancedOpen((v) => !v)}
            className="flex w-full items-center justify-between text-sm font-medium"
            aria-expanded={advancedOpen}
          >
            <span className="inline-flex items-center gap-2">
              <KeyRound className="size-4" />
              高级:手动输入 token
            </span>
            <span className="text-xs text-muted-foreground">
              {advancedOpen ? "收起" : "展开"}
            </span>
          </button>
          {advancedOpen && (
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
              <Input
                type="password"
                placeholder="输入 agent token…"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    handleSaveToken();
                  }
                }}
                aria-label="Agent Token"
                className="sm:max-w-xs"
              />
              <Input
                type="text"
                placeholder="输入你的 agentId(可选,用于气泡靠右)…"
                value={agentIdInput}
                onChange={(e) => setAgentIdInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    handleSaveToken();
                  }
                }}
                aria-label="Agent ID"
                className="sm:max-w-xs"
              />
              <Button
                size="sm"
                onClick={handleSaveToken}
                disabled={!tokenInput.trim()}
                className="shrink-0"
              >
                保存
              </Button>
            </div>
          )}
        </div>

        {/* ④ 注册新 Agent(ticket 28):替代终端 curl 注册;成功即自动绑定并切换身份 */}
        <div className="border-t px-4 py-3">
          <button
            type="button"
            onClick={() => setRegisterOpen((v) => !v)}
            className="flex w-full items-center justify-between text-sm font-medium"
            aria-expanded={registerOpen}
          >
            <span className="inline-flex items-center gap-2">
              <UserPlus className="size-4" />
              注册新 Agent
            </span>
            <span className="text-xs text-muted-foreground">
              {registerOpen ? "收起" : "展开"}
            </span>
          </button>
          {registerOpen && (
            <div className="mt-3 flex flex-col gap-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Input
                  type="text"
                  placeholder="Agent 名称(必填,如「我的 Mac」)"
                  value={regName}
                  onChange={(e) => setRegName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      handleRegister();
                    }
                  }}
                  aria-label="注册 Agent 名称"
                  className="sm:max-w-xs"
                />
                <select
                  aria-label="注册 Agent 类型"
                  value={regType}
                  onChange={(e) => setRegType(e.target.value)}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm sm:w-36"
                >
                  <option value="human">human</option>
                  <option value="hermes">hermes</option>
                  <option value="atomcode">atomcode</option>
                  <option value="openclaw">openclaw</option>
                  <option value="agent">agent</option>
                  <option value="custom">自定义…</option>
                </select>
                <Input
                  type="text"
                  placeholder="设备(可选,如 mac / iphone / cli)"
                  value={regDevice}
                  onChange={(e) => setRegDevice(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      handleRegister();
                    }
                  }}
                  aria-label="注册 Agent 设备"
                  className="sm:max-w-xs"
                />
                <Button
                  size="sm"
                  onClick={handleRegister}
                  disabled={registering}
                  className="shrink-0"
                >
                  {registering ? "注册中…" : "注册并绑定"}
                </Button>
              </div>
              {regType === "custom" && (
                <Input
                  type="text"
                  placeholder="自定义类型(如 cli)"
                  value={regTypeCustom}
                  onChange={(e) => setRegTypeCustom(e.target.value)}
                  aria-label="自定义 Agent 类型"
                  className="sm:max-w-xs"
                />
              )}
              <p className="text-xs text-muted-foreground">
                注册成功后将自动写入 agent token 并完成绑定,无需终端 curl
              </p>
              {registeredToken && (
                <div className="flex flex-col gap-2 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 dark:border-emerald-800 dark:bg-emerald-950/40">
                  <div className="flex items-center justify-between gap-2 text-sm text-emerald-800 dark:text-emerald-200">
                    <span className="truncate">
                      Agent Token(仅显示一次,请复制留档)
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleCopyToken}
                      className="shrink-0"
                    >
                      {copied ? "已复制" : "复制"}
                    </Button>
                  </div>
                  <Input
                    readOnly
                    value={registeredToken}
                    aria-label="注册返回的 Agent Token"
                    className="bg-background font-mono text-xs"
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Agent 设置(ticket 20):绑定后可见,展示并编辑自己的注册信息 */}
      {boundToken && agentInfo && (
        <div className="mb-6 rounded-lg border bg-card p-4">
          <button
            type="button"
            onClick={() => setSettingsOpen((v) => !v)}
            className="flex w-full items-center justify-between text-sm font-medium"
            aria-expanded={settingsOpen}
          >
            <span className="inline-flex items-center gap-2">
              <Settings className="size-4" />
              Agent 设置
            </span>
            <span className="text-xs text-muted-foreground">
              {settingsOpen ? "收起" : "展开"}
            </span>
          </button>
          {settingsOpen && (
            <div className="mt-3 flex flex-col gap-3">
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>名称:{agentInfo.name}</span>
                <span>类型:{agentInfo.type}(只读)</span>
                <span>设备:{agentInfo.device ?? "-"}</span>
                <span>Webhook:{agentInfo.webhookUrl ?? "-"}</span>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Input
                  type="text"
                  placeholder="名称"
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  aria-label="Agent 名称"
                  className="sm:max-w-xs"
                />
                <Input
                  type="text"
                  placeholder="设备"
                  value={deviceInput}
                  onChange={(e) => setDeviceInput(e.target.value)}
                  aria-label="Agent 设备"
                  className="sm:max-w-xs"
                />
                <Input
                  type="text"
                  placeholder="Webhook URL(可空)"
                  value={webhookUrlInput}
                  onChange={(e) => setWebhookUrlInput(e.target.value)}
                  aria-label="Webhook URL"
                  className="sm:max-w-xs"
                />
                <Button
                  size="sm"
                  onClick={handleSaveSettings}
                  disabled={savingSettings}
                  className="shrink-0"
                >
                  {savingSettings ? "保存中…" : "保存"}
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
          placeholder="输入任务名,创建群组…"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              handleCreate();
            }
          }}
          aria-label="群组名称"
        />
        <Button
          onClick={handleCreate}
          disabled={creating || !newTitle.trim()}
          className="shrink-0"
        >
          <Plus />
          {creating ? "创建中…" : "创建群组"}
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
            ["all", "全部"],
            ["active", "进行中"],
            ["archived", "已归档"],
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
              "加载中…"
            ) : (
              <>
                <Users className="size-8" />
                <p>
                  {statusFilter === "archived"
                    ? "暂无已归档群组"
                    : statusFilter === "active"
                      ? "暂无进行中的群组"
                      : "暂无群组,输入任务名点击「创建群组」开始"}
                </p>
                {statusFilter === "all" && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      document
                        .getElementById("group-title-input")
                        ?.focus()
                    }
                  >
                    <Plus />
                    去创建群组
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
                      {group.memberCount} 名成员
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
                      成员管理
                    </Button>
                    {group.status === "active" ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1"
                        onClick={() => handleArchive(group)}
                      >
                        <Archive />
                        归档
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1"
                        onClick={() => handleRestore(group)}
                      >
                        <RotateCcw />
                        恢复
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1 text-red-600 hover:text-red-700"
                      onClick={() => handleDelete(group)}
                    >
                      <Trash2 />
                      删除
                    </Button>
                  </div>
                </div>
              ))}
            </div>
            {/* Desktop: table */}
            <table className="hidden w-full text-sm md:table">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="px-4 py-3 font-medium">群组名称</th>
                  <th className="px-4 py-3 font-medium">状态</th>
                  <th className="px-4 py-3 font-medium">成员数</th>
                  <th className="px-4 py-3 font-medium">最近消息</th>
                  <th className="px-4 py-3 text-right font-medium">操作</th>
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
                        {previewFor(group) ?? "暂无消息"}
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
                          成员管理
                        </Button>
                        {group.status === "active" ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleArchive(group)}
                          >
                            <Archive />
                            归档
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRestore(group)}
                          >
                            <RotateCcw />
                            恢复
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-red-600 hover:text-red-700"
                          onClick={() => handleDelete(group)}
                        >
                          <Trash2 />
                          删除
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
      {status === "active" ? "进行中" : "已归档"}
    </span>
  );
}
