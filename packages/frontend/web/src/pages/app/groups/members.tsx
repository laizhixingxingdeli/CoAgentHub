import {
  ArrowLeft,
  PenLine,
  UserCog,
  UserMinus,
  UserPlus,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useRoute } from "wouter";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { agentAuthHeaders } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { ROLE_LABELS } from "./messages/types";

/**
 * Preset role catalog (mirrors the server-side GROUP_ROLES in
 * packages/backend/database/src/schema/group.ts). The server is the source
 * of truth; this list drives the role checkboxes in the add-member form.
 */
const GROUP_ROLES = [
  "human",
  "coordinator",
  "reviewer",
  "executor",
  "observer",
  "specialist",
] as const;
type GroupRole = (typeof GROUP_ROLES)[number];

type Member = {
  agentId: string;
  name: string;
  type: string;
  device: string | null;
  roles: string[];
  /** 群内分工说明(角色解绑):可空,由「编辑分工」维护。 */
  prompt: string | null;
  joinedAt: string;
};

type AgentOption = {
  id: string;
  name: string;
  type: string;
  device: string | null;
};

/**
 * Group detail / member management page (ticket 02): lists the members of a
 * group (name/type/device/in-group roles) and lets the operator add a member
 * with roles picked from the preset catalog. Initial version — plain fetch.
 */
export default function GroupMembersPage() {
  const [, params] = useRoute("/groups/:id/members");
  const groupId = params?.id;

  const [members, setMembers] = useState<Member[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [selectedRoles, setSelectedRoles] = useState<GroupRole[]>(["observer"]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // Ticket 20: 群主(createdBy)不可被移除;成员行内编辑角色的表单状态。
  const [createdBy, setCreatedBy] = useState<string | null>(null);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [editRoles, setEditRoles] = useState<GroupRole[]>([]);
  const [savingRoles, setSavingRoles] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  // Ticket 21: 群内分工提示词 — 加成员表单与行内编辑的输入状态。
  const [newPrompt, setNewPrompt] = useState("");
  const [editingPromptAgentId, setEditingPromptAgentId] = useState<
    string | null
  >(null);
  const [editPromptValue, setEditPromptValue] = useState("");
  const [savingPrompt, setSavingPrompt] = useState(false);

  const loadMembers = useCallback(async () => {
    if (!groupId) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/groups/${groupId}/members`, {
        headers: agentAuthHeaders(),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      setMembers(await res.json());
    } catch (e) {
      setError(`加载成员失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, [groupId]);

  const loadAgents = useCallback(async () => {
    try {
      const res = await fetch("/api/agents", { headers: agentAuthHeaders() });
      if (!res.ok) {
        return;
      }
      setAgents(await res.json());
    } catch {
      // The add-member select just stays empty if the roster cannot load.
    }
  }, []);

  // Ticket 20: 群主(createdBy)不可被移除,行内移除按钮据此禁用。
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
      const group = (await res.json()) as { createdBy: string };
      setCreatedBy(group.createdBy);
    } catch {
      // 加载失败不影响成员列表,移除按钮不做群主禁用保护。
    }
  }, [groupId]);

  useEffect(() => {
    loadMembers();
    loadAgents();
    loadGroup();
  }, [loadMembers, loadAgents, loadGroup]);

  const toggleRole = (role: GroupRole) => {
    setSelectedRoles((prev) =>
      prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role],
    );
  };

  const handleAddMember = async () => {
    if (!groupId || !selectedAgentId) {
      return;
    }
    setAdding(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch(`/api/groups/${groupId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...agentAuthHeaders() },
        body: JSON.stringify({
          agentId: selectedAgentId,
          roles: selectedRoles,
          // 空则不带 prompt 字段,保持幂等 upsert 语义。
          prompt: newPrompt.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(
          `HTTP ${res.status}${body?.message ? `: ${body.message}` : ""}`,
        );
      }
      setMessage("成员添加成功");
      setSelectedAgentId("");
      setSelectedRoles(["observer"]);
      setNewPrompt("");
      await loadMembers();
    } catch (e) {
      setError(`添加成员失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setAdding(false);
    }
  };

  const alreadyMembers = new Set(members.map((m) => m.agentId));
  const candidates = agents.filter((a) => !alreadyMembers.has(a.id));

  // Ticket 20: 行内编辑角色 — 打开编辑表单并预填该成员现有角色。
  const startEditRoles = (member: Member) => {
    setEditingPromptAgentId(null);
    setEditRoles(
      member.roles.filter((r): r is GroupRole =>
        (GROUP_ROLES as readonly string[]).includes(r),
      ),
    );
    setEditingAgentId(member.agentId);
  };

  const toggleEditRole = (role: GroupRole) => {
    setEditRoles((prev) =>
      prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role],
    );
  };

  const handleSaveRoles = async () => {
    if (!groupId || !editingAgentId) {
      return;
    }
    if (editRoles.length === 0) {
      setError("至少选择一个角色");
      return;
    }
    setSavingRoles(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch(
        `/api/groups/${groupId}/members/${editingAgentId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            ...agentAuthHeaders(),
          },
          body: JSON.stringify({ roles: editRoles }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(
          `HTTP ${res.status}${body?.message ? `: ${body.message}` : ""}`,
        );
      }
      setMessage("角色已更新");
      setEditingAgentId(null);
      await loadMembers();
    } catch (e) {
      setError(`更新角色失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSavingRoles(false);
    }
  };

  // Ticket 21: 行内编辑分工提示词 — 打开编辑表单并预填该成员现有 prompt。
  const startEditPrompt = (member: Member) => {
    setEditingAgentId(null);
    setEditPromptValue(member.prompt ?? "");
    setEditingPromptAgentId(member.agentId);
  };

  const handleSavePrompt = async () => {
    if (!groupId || !editingPromptAgentId) {
      return;
    }
    setSavingPrompt(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch(
        `/api/groups/${groupId}/members/${editingPromptAgentId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            ...agentAuthHeaders(),
          },
          // 空字符串表示清空分工说明(PATCH 可单独更新 prompt)。
          body: JSON.stringify({ prompt: editPromptValue.trim() }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(
          `HTTP ${res.status}${body?.message ? `: ${body.message}` : ""}`,
        );
      }
      setMessage("分工已更新");
      setEditingPromptAgentId(null);
      await loadMembers();
    } catch (e) {
      setError(`更新分工失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSavingPrompt(false);
    }
  };

  // Ticket 20: 移除成员 — 群主不可移除(按钮已禁用,这里兜底提示)。
  const handleRemoveMember = async (member: Member) => {
    if (member.agentId === createdBy) {
      setMessage("不能移除群主");
      return;
    }
    if (!window.confirm(`确定将成员「${member.name}」移出群组吗?`)) {
      return;
    }
    setRemovingId(member.agentId);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch(
        `/api/groups/${groupId}/members/${member.agentId}`,
        {
          method: "DELETE",
          headers: agentAuthHeaders(),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(
          `HTTP ${res.status}${body?.message ? `: ${body.message}` : ""}`,
        );
      }
      setMessage(`成员「${member.name}」已移出群组`);
      await loadMembers();
    } catch (e) {
      setError(`移除成员失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <div className="mx-auto w-full max-w-4xl p-4 sm:p-6">
      <div className="mb-6">
        <a
          href={groupId ? `/groups/${groupId}` : "/groups"}
          className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          返回消息流
        </a>
        <h2 className="text-xl font-semibold">群组成员</h2>
        <p className="text-muted-foreground text-sm">
          成员在群组内分配角色(同一 agent 可在不同群组持有不同角色)
        </p>
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

      {/* Add member */}
      <div className="mb-6 rounded-lg border bg-card p-4">
        <div className="mb-3 flex items-center gap-2 text-sm font-medium">
          <UserPlus className="size-4" />
          添加成员
        </div>
        <div className="flex flex-col gap-3">
          <select
            aria-label="选择成员 agent"
            value={selectedAgentId}
            onChange={(e) => setSelectedAgentId(e.target.value)}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm sm:w-64"
          >
            <option value="">
              {candidates.length === 0
                ? "没有可添加的 agent"
                : "选择要添加的 agent…"}
            </option>
            {candidates.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
                {agent.type ? ` (${agent.type})` : ""}
                {agent.device ? ` · ${agent.device}` : ""}
              </option>
            ))}
          </select>
          <div className="flex flex-wrap gap-2">
            {GROUP_ROLES.map((role) => (
              <label
                key={role}
                className={cn(
                  "inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                  selectedRoles.includes(role)
                    ? "border-primary bg-primary/10 text-primary"
                    : "text-muted-foreground hover:border-primary/50",
                )}
              >
                <input
                  type="checkbox"
                  className="hidden"
                  checked={selectedRoles.includes(role)}
                  onChange={() => toggleRole(role)}
                />
                {ROLE_LABELS[role]}
              </label>
            ))}
          </div>
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="member-prompt"
              className="text-xs font-medium text-muted-foreground"
            >
              本群分工提示词(可选)
            </label>
            <Textarea
              id="member-prompt"
              rows={2}
              maxLength={1000}
              placeholder="在本组你负责 code review,重点关注测试覆盖与可读性"
              value={newPrompt}
              onChange={(e) => setNewPrompt(e.target.value)}
            />
          </div>
          <div>
            <Button
              onClick={handleAddMember}
              disabled={adding || !selectedAgentId}
              size="sm"
            >
              {adding ? "添加中…" : "添加成员"}
            </Button>
          </div>
        </div>
      </div>

      {/* Member list */}
      <div className="rounded-lg border bg-card shadow-sm">
        {members.length === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground">
            {loading ? "加载中…" : "暂无成员,从上方添加 agent 进入群组"}
          </div>
        ) : (
          <>
            {/* Mobile: card list */}
            <div className="flex flex-col gap-3 p-3 md:hidden">
              {members.map((member) => (
                <div
                  key={member.agentId}
                  className="flex flex-col gap-2 rounded-lg border bg-card p-4"
                >
                  <div className="flex items-center gap-2">
                    <Users className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate text-sm font-medium">
                      {member.name}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>{member.type}</span>
                    {member.device && <span>{member.device}</span>}
                  </div>
                  {editingAgentId === member.agentId ? (
                    <RoleEditor
                      selected={editRoles}
                      onToggle={toggleEditRole}
                      onSave={handleSaveRoles}
                      onCancel={() => setEditingAgentId(null)}
                      busy={savingRoles}
                    />
                  ) : (
                    <RoleBadges roles={member.roles} />
                  )}
                  {editingPromptAgentId === member.agentId ? (
                    <PromptEditor
                      value={editPromptValue}
                      onChange={setEditPromptValue}
                      onSave={handleSavePrompt}
                      onCancel={() => setEditingPromptAgentId(null)}
                      busy={savingPrompt}
                    />
                  ) : (
                    <PromptLine prompt={member.prompt} />
                  )}
                  <div className="mt-1 flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => startEditRoles(member)}
                    >
                      <UserCog />
                      编辑角色
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => startEditPrompt(member)}
                    >
                      <PenLine />
                      编辑分工
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1 text-red-600 hover:text-red-700"
                      disabled={
                        member.agentId === createdBy ||
                        removingId === member.agentId
                      }
                      title={
                        member.agentId === createdBy
                          ? "不能移除群主"
                          : undefined
                      }
                      onClick={() => handleRemoveMember(member)}
                    >
                      <UserMinus />
                      {removingId === member.agentId ? "移除中…" : "移除"}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
            {/* Desktop: table */}
            <table className="hidden w-full text-sm md:table">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="px-4 py-3 font-medium">名称</th>
                  <th className="px-4 py-3 font-medium">类型</th>
                  <th className="px-4 py-3 font-medium">设备</th>
                  <th className="px-4 py-3 font-medium">角色</th>
                  <th className="px-4 py-3 font-medium">分工</th>
                  <th className="px-4 py-3 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {members.map((member) => (
                  <tr key={member.agentId} className="border-b last:border-0">
                    <td className="px-4 py-3 font-medium">{member.name}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {member.type}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {member.device ?? "-"}
                    </td>
                    <td className="px-4 py-3">
                      {editingAgentId === member.agentId ? (
                        <RoleEditor
                          selected={editRoles}
                          onToggle={toggleEditRole}
                          onSave={handleSaveRoles}
                          onCancel={() => setEditingAgentId(null)}
                          busy={savingRoles}
                        />
                      ) : (
                        <RoleBadges roles={member.roles} />
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {editingPromptAgentId === member.agentId ? (
                        <PromptEditor
                          value={editPromptValue}
                          onChange={setEditPromptValue}
                          onSave={handleSavePrompt}
                          onCancel={() => setEditingPromptAgentId(null)}
                          busy={savingPrompt}
                        />
                      ) : (
                        <PromptLine prompt={member.prompt} />
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => startEditRoles(member)}
                        >
                          <UserCog />
                          编辑角色
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => startEditPrompt(member)}
                        >
                          <PenLine />
                          编辑分工
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-red-600 hover:text-red-700"
                          disabled={
                            member.agentId === createdBy ||
                            removingId === member.agentId
                          }
                          title={
                            member.agentId === createdBy
                              ? "不能移除群主"
                              : undefined
                          }
                          onClick={() => handleRemoveMember(member)}
                        >
                          <UserMinus />
                          {removingId === member.agentId ? "移除中…" : "移除"}
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

function RoleBadges({ roles }: { roles: string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {roles.map((role) => (
        <span
          key={role}
          className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
        >
          {ROLE_LABELS[role as GroupRole] ?? role}
        </span>
      ))}
    </div>
  );
}

/**
 * Ticket 20: 行内角色编辑表单 — 与添加成员表单同款复选框,保存调用
 * PATCH /api/groups/:id/members/:agentId。
 */
function RoleEditor({
  selected,
  onToggle,
  onSave,
  onCancel,
  busy,
}: {
  selected: GroupRole[];
  onToggle: (role: GroupRole) => void;
  onSave: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {GROUP_ROLES.map((role) => (
          <label
            key={role}
            className={cn(
              "inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              selected.includes(role)
                ? "border-primary bg-primary/10 text-primary"
                : "text-muted-foreground hover:border-primary/50",
            )}
          >
            <input
              type="checkbox"
              className="hidden"
              aria-label={`编辑角色 ${ROLE_LABELS[role]}`}
              checked={selected.includes(role)}
              onChange={() => onToggle(role)}
            />
            {ROLE_LABELS[role]}
          </label>
        ))}
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={onSave} disabled={busy}>
          {busy ? "保存中…" : "保存"}
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel} disabled={busy}>
          取消
        </Button>
      </div>
    </div>
  );
}

/**
 * Ticket 21: 分工提示词展示 — 有则截断/展开,无则显示「未设置」灰字。
 * 超过 40 字时收成一行,点击「展开」查看全文。
 */
function PromptLine({ prompt }: { prompt: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const text = prompt?.trim();
  if (!text) {
    return <span className="text-xs text-muted-foreground/70">未设置</span>;
  }
  const clamped = text.length > 40;
  return (
    <div className="text-xs leading-relaxed text-muted-foreground">
      <span className={clamped && !expanded ? "line-clamp-1" : undefined}>
        {text}
      </span>
      {clamped && (
        <button
          type="button"
          className="ml-1 align-baseline font-medium text-primary hover:underline"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "收起" : "展开"}
        </button>
      )}
    </div>
  );
}

/**
 * Ticket 21: 行内编辑分工提示词 — textarea + 保存/取消,调用
 * PATCH /api/groups/:id/members/:agentId 单独更新 prompt。
 */
function PromptEditor({
  value,
  onChange,
  onSave,
  onCancel,
  busy,
}: {
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Textarea
        aria-label="编辑分工提示词"
        rows={2}
        maxLength={1000}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <div className="flex gap-2">
        <Button size="sm" onClick={onSave} disabled={busy}>
          {busy ? "保存中…" : "保存"}
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel} disabled={busy}>
          取消
        </Button>
      </div>
    </div>
  );
}
