import { Folder } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { participantAuthHeaders } from "@/lib/api-client";

/**
 * 右栏「项目」Tab:现有项目绑定区块(路径显示/绑定/解绑)移入。
 * 数据来自 GET /groups/:id 的 projectPath,绑定/解绑经 PATCH /groups/:id。
 */
export function ProjectTab({ groupId }: { groupId: string }) {
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [projectPathInput, setProjectPathInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const loadProject = useCallback(async () => {
    try {
      const res = await fetch(`/api/groups/${groupId}`, {
        headers: participantAuthHeaders(),
      });
      if (!res.ok) {
        return;
      }
      const group = (await res.json()) as { projectPath?: string | null };
      setProjectPath(group.projectPath ?? null);
    } catch {
      // 加载失败仅影响展示,编辑区仍可用。
    }
  }, [groupId]);

  useEffect(() => {
    void loadProject();
  }, [loadProject]);

  const handleSave = async () => {
    const path = projectPathInput.trim();
    if (!path || saving) {
      return;
    }
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/groups/${groupId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...participantAuthHeaders(),
        },
        body: JSON.stringify({ projectPath: path }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(
          `HTTP ${res.status}${body?.message ? `: ${body.message}` : ""}`,
        );
      }
      const updated = (await res.json()) as { projectPath: string | null };
      setProjectPath(updated.projectPath);
      setProjectPathInput("");
      setMessage(`已绑定项目:${updated.projectPath}`);
    } catch (e) {
      setError(`绑定失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const handleUnbind = async () => {
    if (saving) {
      return;
    }
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/groups/${groupId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...participantAuthHeaders(),
        },
        body: JSON.stringify({ projectPath: null }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(
          `HTTP ${res.status}${body?.message ? `: ${body.message}` : ""}`,
        );
      }
      setProjectPath(null);
      setMessage("已解绑项目");
    } catch (e) {
      setError(`解绑失败: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div data-testid="project-tab" className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Folder className="size-4 shrink-0" />
        项目绑定
      </div>
      {projectPath && (
        <div className="flex flex-wrap items-center gap-2">
          <code
            data-testid="project-path"
            className="min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1 font-mono text-xs"
          >
            {projectPath}
          </code>
          <Button
            variant="outline"
            size="sm"
            onClick={handleUnbind}
            disabled={saving}
            className="shrink-0"
          >
            {saving ? "处理中…" : "解绑"}
          </Button>
        </div>
      )}
      <div className="flex flex-col gap-2">
        <Input
          type="text"
          placeholder="输入项目绝对路径,如 /Users/me/proj…"
          value={projectPathInput}
          onChange={(e) => setProjectPathInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              void handleSave();
            }
          }}
          aria-label="项目绝对路径"
        />
        <Button
          size="sm"
          onClick={handleSave}
          disabled={saving || !projectPathInput.trim()}
        >
          {saving ? "保存中…" : "保存"}
        </Button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
      {message && <p className="text-xs text-emerald-600">{message}</p>}
    </div>
  );
}
