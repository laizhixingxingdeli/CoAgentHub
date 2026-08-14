import { ArrowRight, PenLine, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { participantIdentityHeaders } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import {
  GROUP_ROLES,
  type Member,
  roleLabel,
} from "@/pages/app/groups/messages/types";

type GroupRole = (typeof GROUP_ROLES)[number];

/**
 * 右栏「成员与分工」Tab(轻量版):成员列表(角色徽章 + 提示词截断),
 * 点击成员行弹窗编辑角色/提示词(复用成员页交互,只读 + 编辑弹窗)。
 * 数据来自 GET /groups/:id/members,编辑经 PATCH /members/:participantId。
 */
export function MembersTab({ groupId }: { groupId: string }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 归档/软删群只读:群状态非 active 时,成员行点击编辑禁用并提示。
  const [groupStatus, setGroupStatus] = useState<
    "active" | "archived" | "deleted" | null
  >(null);
  // 编辑弹窗状态:目标成员 + 角色勾选 + 提示词输入。
  const [editing, setEditing] = useState<Member | null>(null);
  const [editRoles, setEditRoles] = useState<GroupRole[]>([]);
  const [editPrompt, setEditPrompt] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const loadGroupStatus = useCallback(async () => {
    try {
      const res = await fetch(`/api/groups/${groupId}`, {
        headers: participantIdentityHeaders(),
      });
      if (res.ok) {
        const group = (await res.json()) as { status: string };
        setGroupStatus(
          group.status === "active" || group.status === "archived"
            ? group.status
            : "deleted",
        );
      }
    } catch {
      // 群状态加载失败按 active 处理,不误伤成员列表只读展示。
    }
  }, [groupId]);

  const loadMembers = useCallback(async () => {
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
      setError(`加载成员失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }, [groupId]);

  useEffect(() => {
    void loadMembers();
    void loadGroupStatus();
  }, [loadMembers, loadGroupStatus]);

  // 归档/软删群只读:非 active 群成员行点击编辑禁用并提示。
  const readOnly = groupStatus !== null && groupStatus !== "active";
  const readOnlyHint = readOnly ? "群已归档,只读" : undefined;

  const startEdit = (member: Member) => {
    setSaveError(null);
    setEditing(member);
    setEditRoles(
      member.roles.filter((r): r is GroupRole =>
        (GROUP_ROLES as readonly string[]).includes(r),
      ),
    );
    setEditPrompt(member.prompt ?? "");
  };

  const toggleRole = (role: GroupRole) => {
    setEditRoles((prev) =>
      prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role],
    );
  };

  const handleSave = async () => {
    if (!editing || saving) {
      return;
    }
    if (editRoles.length === 0) {
      setSaveError("至少选择一个角色");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(
        `/api/groups/${groupId}/members/${editing.participantId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            ...participantIdentityHeaders(),
          },
          body: JSON.stringify({ roles: editRoles, prompt: editPrompt.trim() }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(
          `HTTP ${res.status}${body?.message ? `: ${body.message}` : ""}`,
        );
      }
      setEditing(null);
      await loadMembers();
    } catch (e) {
      setSaveError(`保存失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div data-testid="members-tab" className="flex flex-col gap-2">
      <span className="text-xs font-medium text-muted-foreground">
        成员与分工({members.length})
      </span>
      {error && <p className="text-xs text-red-600">{error}</p>}
      {loading ? (
        <p className="text-sm text-muted-foreground">加载中…</p>
      ) : members.length === 0 ? (
        <p className="text-sm text-muted-foreground">暂无成员</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {members.map((member) => (
            <li key={member.participantId}>
              <button
                type="button"
                data-testid={`member-row-${member.participantId}`}
                disabled={readOnly}
                title={readOnlyHint}
                onClick={() => startEdit(member)}
                className="flex w-full flex-col gap-1 rounded-md border bg-muted/30 px-3 py-2 text-left transition-colors hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <Users className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate text-sm font-medium">
                    {member.name}
                  </span>
                  {member.roles.map((role) => (
                    <span
                      key={role}
                      className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
                    >
                      {roleLabel(role)}
                    </span>
                  ))}
                </span>
                {member.prompt && (
                  <span
                    className="truncate text-xs text-muted-foreground"
                    title={member.prompt}
                  >
                    {member.prompt.length > 40
                      ? `${member.prompt.slice(0, 40)}…`
                      : member.prompt}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      <a
        href={`/groups/${groupId}/members`}
        className="inline-flex shrink-0 items-center gap-1 self-start rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        完整管理
        <ArrowRight className="size-3.5" />
      </a>

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) {
            setEditing(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PenLine className="size-4" />
              编辑 {editing?.name ?? ""}
            </DialogTitle>
          </DialogHeader>
          {editing && (
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <span className="text-xs font-medium text-muted-foreground">
                  角色
                </span>
                <div className="flex flex-wrap gap-2">
                  {GROUP_ROLES.map((role) => (
                    <label
                      key={role}
                      className={cn(
                        "inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                        editRoles.includes(role)
                          ? "border-primary bg-primary/10 text-primary"
                          : "text-muted-foreground hover:border-primary/50",
                      )}
                    >
                      <input
                        type="checkbox"
                        className="hidden"
                        aria-label={`编辑角色 ${roleLabel(role)}`}
                        checked={editRoles.includes(role)}
                        onChange={() => toggleRole(role)}
                      />
                      {roleLabel(role)}
                    </label>
                  ))}
                </div>
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
                  rows={3}
                  maxLength={1000}
                  value={editPrompt}
                  onChange={(e) => setEditPrompt(e.target.value)}
                />
              </div>
              {saveError && <p className="text-xs text-red-600">{saveError}</p>}
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEditing(null)}
              disabled={saving}
            >
              取消
            </Button>
            <Button onClick={handleSave} disabled={saving || !editing}>
              {saving ? "保存中…" : "保存"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
