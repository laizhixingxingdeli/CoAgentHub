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
import { ContextPanelTrigger } from "@/components/layout/context-panel";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { participantIdentityHeaders } from "@/lib/api-client";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { roleLabel } from "./messages/types";

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
  participantId: string;
  name: string;
  device: string | null;
  roles: string[];
  /** 群内分工说明(角色解绑):可空,由「编辑分工」维护。 */
  prompt: string | null;
  joinedAt: string;
};

type ParticipantOption = {
  id: string;
  name: string;
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
  const [participants, setParticipants] = useState<ParticipantOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [selectedParticipantId, setSelectedParticipantId] = useState("");
  const [selectedRoles, setSelectedRoles] = useState<GroupRole[]>(["observer"]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  // Ticket 20: 群主(createdBy)不可被移除;成员行内编辑角色的表单状态。
  const [createdBy, setCreatedBy] = useState<string | null>(null);
  // 归档/软删群只读:群状态非 active 时,添加/编辑/移除成员按钮禁用并提示。
  const [groupStatus, setGroupStatus] = useState<
    "active" | "archived" | "deleted" | null
  >(null);
  const [editingParticipantId, setEditingParticipantId] = useState<
    string | null
  >(null);
  const [editRoles, setEditRoles] = useState<GroupRole[]>([]);
  const [savingRoles, setSavingRoles] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  // Ticket 21: 群内分工提示词 — 加成员表单与行内编辑的输入状态。
  const [newPrompt, setNewPrompt] = useState("");
  const [editingPromptParticipantId, setEditingPromptParticipantId] = useState<
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
        headers: participantIdentityHeaders(),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      setMembers(await res.json());
    } catch (e) {
      setError(
        t("members.error.loadFailed", {
          detail: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setLoading(false);
    }
  }, [groupId]);

  const loadParticipants = useCallback(async () => {
    try {
      const res = await fetch("/api/participants", {
        headers: participantIdentityHeaders(),
      });
      if (!res.ok) {
        return;
      }
      setParticipants(await res.json());
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
        headers: participantIdentityHeaders(),
      });
      if (!res.ok) {
        return;
      }
      const group = (await res.json()) as {
        createdBy: string;
        status: string;
      };
      setCreatedBy(group.createdBy);
      setGroupStatus(
        group.status === "active" || group.status === "archived"
          ? group.status
          : "deleted",
      );
    } catch {
      // 加载失败不影响成员列表,移除按钮不做群主禁用保护。
    }
  }, [groupId]);

  useEffect(() => {
    loadMembers();
    loadParticipants();
    loadGroup();
  }, [loadMembers, loadParticipants, loadGroup]);

  // 归档/软删群只读:非 active 群禁止成员写操作(添加/编辑/移除)。
  const readOnly = groupStatus !== null && groupStatus !== "active";
  const readOnlyHint = readOnly ? t("members.readOnly") : undefined;

  const toggleRole = (role: GroupRole) => {
    setSelectedRoles((prev) =>
      prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role],
    );
  };

  const handleAddMember = async () => {
    if (!groupId || !selectedParticipantId) {
      return;
    }
    setAdding(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch(`/api/groups/${groupId}/members`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...participantIdentityHeaders(),
        },
        body: JSON.stringify({
          participantId: selectedParticipantId,
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
      setMessage(t("members.added"));
      setSelectedParticipantId("");
      setSelectedRoles(["observer"]);
      setNewPrompt("");
      await loadMembers();
    } catch (e) {
      setError(
        t("members.error.addFailed", {
          detail: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setAdding(false);
    }
  };

  const alreadyMembers = new Set(members.map((m) => m.participantId));
  const candidates = participants.filter((a) => !alreadyMembers.has(a.id));

  // Ticket 20: 行内编辑角色 — 打开编辑表单并预填该成员现有角色。
  const startEditRoles = (member: Member) => {
    setEditingPromptParticipantId(null);
    setEditRoles(
      member.roles.filter((r): r is GroupRole =>
        (GROUP_ROLES as readonly string[]).includes(r),
      ),
    );
    setEditingParticipantId(member.participantId);
  };

  const toggleEditRole = (role: GroupRole) => {
    setEditRoles((prev) =>
      prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role],
    );
  };

  const handleSaveRoles = async () => {
    if (!groupId || !editingParticipantId) {
      return;
    }
    if (editRoles.length === 0) {
      setError(t("members.error.roleRequired"));
      return;
    }
    setSavingRoles(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch(
        `/api/groups/${groupId}/members/${editingParticipantId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            ...participantIdentityHeaders(),
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
      setMessage(t("members.rolesUpdated"));
      setEditingParticipantId(null);
      await loadMembers();
    } catch (e) {
      setError(
        t("members.error.rolesUpdateFailed", {
          detail: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setSavingRoles(false);
    }
  };

  // Ticket 21: 行内编辑分工提示词 — 打开编辑表单并预填该成员现有 prompt。
  const startEditPrompt = (member: Member) => {
    setEditingParticipantId(null);
    setEditPromptValue(member.prompt ?? "");
    setEditingPromptParticipantId(member.participantId);
  };

  const handleSavePrompt = async () => {
    if (!groupId || !editingPromptParticipantId) {
      return;
    }
    setSavingPrompt(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch(
        `/api/groups/${groupId}/members/${editingPromptParticipantId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            ...participantIdentityHeaders(),
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
      setMessage(t("members.promptUpdated"));
      setEditingPromptParticipantId(null);
      await loadMembers();
    } catch (e) {
      setError(
        t("members.error.promptUpdateFailed", {
          detail: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setSavingPrompt(false);
    }
  };

  // Ticket 20: 移除成员 — 群主不可移除(按钮已禁用,这里兜底提示)。
  const handleRemoveMember = async (member: Member) => {
    if (member.participantId === createdBy) {
      setMessage(t("members.cannotRemoveOwner"));
      return;
    }
    if (!window.confirm(t("members.confirm.remove", { name: member.name }))) {
      return;
    }
    setRemovingId(member.participantId);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch(
        `/api/groups/${groupId}/members/${member.participantId}`,
        {
          method: "DELETE",
          headers: participantIdentityHeaders(),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(
          `HTTP ${res.status}${body?.message ? `: ${body.message}` : ""}`,
        );
      }
      setMessage(t("members.removed", { name: member.name }));
      await loadMembers();
    } catch (e) {
      setError(
        t("members.error.removeFailed", {
          detail: e instanceof Error ? e.message : String(e),
        }),
      );
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
          {t("members.back")}
        </a>
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-xl font-semibold">{t("members.pageTitle")}</h2>
          <ContextPanelTrigger />
        </div>
        <p className="text-muted-foreground text-sm">{t("members.subtitle")}</p>
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
          {t("members.addMember")}
        </div>
        {readOnly && (
          <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            {t("members.readOnlyHint")}
          </div>
        )}
        <div className="flex flex-col gap-3">
          <select
            aria-label={t("members.selectAria")}
            value={selectedParticipantId}
            onChange={(e) => setSelectedParticipantId(e.target.value)}
            disabled={readOnly}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60 sm:w-64"
          >
            <option value="">
              {candidates.length === 0
                ? t("members.noCandidates")
                : t("members.selectPlaceholder")}
            </option>
            {candidates.map((participant) => (
              <option key={participant.id} value={participant.id}>
                {participant.name}
                {participant.device ? ` · ${participant.device}` : ""}
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
                  readOnly && "cursor-not-allowed opacity-60",
                )}
              >
                <input
                  type="checkbox"
                  className="hidden"
                  checked={selectedRoles.includes(role)}
                  onChange={() => toggleRole(role)}
                  disabled={readOnly}
                />
                {roleLabel(role)}
              </label>
            ))}
          </div>
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="member-prompt"
              className="text-xs font-medium text-muted-foreground"
            >
              {t("members.promptLabel")}
            </label>
            <Textarea
              id="member-prompt"
              rows={2}
              maxLength={1000}
              placeholder={t("members.promptPlaceholder")}
              value={newPrompt}
              onChange={(e) => setNewPrompt(e.target.value)}
              disabled={readOnly}
            />
          </div>
          <div>
            <Button
              onClick={handleAddMember}
              disabled={adding || !selectedParticipantId || readOnly}
              title={readOnlyHint}
              size="sm"
            >
              {adding ? t("members.adding") : t("members.addMember")}
            </Button>
          </div>
        </div>
      </div>

      {/* Member list */}
      <div className="rounded-lg border bg-card shadow-sm">
        {members.length === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground">
            {loading ? t("common.loading") : t("members.emptyHint")}
          </div>
        ) : (
          <>
            {/* Mobile: card list */}
            <div className="flex flex-col gap-3 p-3 md:hidden">
              {members.map((member) => (
                <div
                  key={member.participantId}
                  className="flex flex-col gap-2 rounded-lg border bg-card p-4"
                >
                  <div className="flex items-center gap-2">
                    <Users className="size-4 shrink-0 text-muted-foreground" />
                    <span className="truncate text-sm font-medium">
                      {member.name}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    {member.device && <span>{member.device}</span>}
                  </div>
                  {editingParticipantId === member.participantId ? (
                    <RoleEditor
                      selected={editRoles}
                      onToggle={toggleEditRole}
                      onSave={handleSaveRoles}
                      onCancel={() => setEditingParticipantId(null)}
                      busy={savingRoles}
                    />
                  ) : (
                    <RoleBadges roles={member.roles} />
                  )}
                  {editingPromptParticipantId === member.participantId ? (
                    <PromptEditor
                      value={editPromptValue}
                      onChange={setEditPromptValue}
                      onSave={handleSavePrompt}
                      onCancel={() => setEditingPromptParticipantId(null)}
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
                      disabled={readOnly}
                      title={readOnlyHint}
                      onClick={() => startEditRoles(member)}
                    >
                      <UserCog />
                      {t("members.editRoles")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      disabled={readOnly}
                      title={readOnlyHint}
                      onClick={() => startEditPrompt(member)}
                    >
                      <PenLine />
                      {t("members.editPrompt")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1 text-red-600 hover:text-red-700"
                      disabled={
                        readOnly ||
                        member.participantId === createdBy ||
                        removingId === member.participantId
                      }
                      title={
                        readOnly
                          ? readOnlyHint
                          : member.participantId === createdBy
                            ? t("members.cannotRemoveOwner")
                            : undefined
                      }
                      onClick={() => handleRemoveMember(member)}
                    >
                      <UserMinus />
                      {removingId === member.participantId
                        ? t("members.removing")
                        : t("members.remove")}
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
                    {t("members.table.name")}
                  </th>
                  <th className="px-4 py-3 font-medium">
                    {t("members.table.device")}
                  </th>
                  <th className="px-4 py-3 font-medium">
                    {t("members.table.role")}
                  </th>
                  <th className="px-4 py-3 font-medium">
                    {t("members.table.prompt")}
                  </th>
                  <th className="px-4 py-3 text-right font-medium">
                    {t("members.table.actions")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {members.map((member) => (
                  <tr
                    key={member.participantId}
                    className="border-b last:border-0"
                  >
                    <td className="px-4 py-3 font-medium">{member.name}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {member.device ?? "-"}
                    </td>
                    <td className="px-4 py-3">
                      {editingParticipantId === member.participantId ? (
                        <RoleEditor
                          selected={editRoles}
                          onToggle={toggleEditRole}
                          onSave={handleSaveRoles}
                          onCancel={() => setEditingParticipantId(null)}
                          busy={savingRoles}
                        />
                      ) : (
                        <RoleBadges roles={member.roles} />
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {editingPromptParticipantId === member.participantId ? (
                        <PromptEditor
                          value={editPromptValue}
                          onChange={setEditPromptValue}
                          onSave={handleSavePrompt}
                          onCancel={() => setEditingPromptParticipantId(null)}
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
                          disabled={readOnly}
                          title={readOnlyHint}
                          onClick={() => startEditRoles(member)}
                        >
                          <UserCog />
                          {t("members.editRoles")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={readOnly}
                          title={readOnlyHint}
                          onClick={() => startEditPrompt(member)}
                        >
                          <PenLine />
                          {t("members.editPrompt")}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-red-600 hover:text-red-700"
                          disabled={
                            readOnly ||
                            member.participantId === createdBy ||
                            removingId === member.participantId
                          }
                          title={
                            readOnly
                              ? readOnlyHint
                              : member.participantId === createdBy
                                ? t("members.cannotRemoveOwner")
                                : undefined
                          }
                          onClick={() => handleRemoveMember(member)}
                        >
                          <UserMinus />
                          {removingId === member.participantId
                            ? t("members.removing")
                            : t("members.remove")}
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
          {roleLabel(role as GroupRole) ?? role}
        </span>
      ))}
    </div>
  );
}

/**
 * Ticket 20: 行内角色编辑表单 — 与添加成员表单同款复选框,保存调用
 * PATCH /api/groups/:id/members/:participantId。
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
              aria-label={t("members.editRoleAria", {
                role: roleLabel(role),
              })}
              checked={selected.includes(role)}
              onChange={() => onToggle(role)}
            />
            {roleLabel(role)}
          </label>
        ))}
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={onSave} disabled={busy}>
          {busy ? t("common.saving") : t("common.save")}
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel} disabled={busy}>
          {t("common.cancel")}
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
    return (
      <span className="text-xs text-muted-foreground/70">
        {t("members.notSet")}
      </span>
    );
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
          {expanded ? t("common.collapse") : t("common.expand")}
        </button>
      )}
    </div>
  );
}

/**
 * Ticket 21: 行内编辑分工提示词 — textarea + 保存/取消,调用
 * PATCH /api/groups/:id/members/:participantId 单独更新 prompt。
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
        aria-label={t("members.promptEditAria")}
        rows={2}
        maxLength={1000}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <div className="flex gap-2">
        <Button size="sm" onClick={onSave} disabled={busy}>
          {busy ? t("common.saving") : t("common.save")}
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel} disabled={busy}>
          {t("common.cancel")}
        </Button>
      </div>
    </div>
  );
}
