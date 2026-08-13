import { Bot, HeartPulse, Loader2, Pencil, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PARTICIPANT_ID_KEY, participantAuthHeaders } from "@/lib/api-client";

/**
 * 接入 Participant(ticket: 网页 @executor 发布):管理执行器配置。
 *
 * 表单字段 = 名字 / 类型 / 调用方式(cli|a2a)/ 命令或 gateway 地址 / 参数模板
 * (cli,可空)/ 设备(可选)。提交调 POST /api/executors,server 自动注册对应
 * participant(token 后端生成,界面绝不出现任何 token/token_hash 字段)。
 *
 * 列表 = 内置执行器 + DB 配置(GET /api/executors 合并返回),内置项不可删除。
 *
 * Participant 自管理(ticket: 补全 /participants 页):列表行同时带出 participant 注册信息
 * (GET /api/participants,按 name 匹配),展示 device / capabilities / 在线状态;
 * 绑定后自己的 participant 可编辑(PATCH)与上报在线(heartbeat)。
 */

type ExecutorItem = {
  key: string;
  agentName: string;
  type: string;
  kind: "cli" | "a2a";
  bin: string;
  url: string | null;
  args: string[];
  label: string;
  builtin: boolean;
  /** 加载时按 name 匹配到的 participant id;渲染按 id 取 participant(改名后仍能对应)。 */
  participantId?: string;
};

/** Participant 注册信息(GET /api/participants):自管理字段 + 在线状态。 */
type ParticipantInfo = {
  id: string;
  name: string;
  type: string;
  device: string | null;
  capabilities: string[];
  lastSeen: string | null;
};

/** 在线判定(与后端 T13 约定一致):lastSeen 距今 < 60s 视为在线。 */
const ONLINE_WINDOW_MS = 60_000;

const PARTICIPANT_TYPES = [
  "hermes",
  "atomcode",
  "openclaw",
  "human",
  "custom",
] as const;

export default function ExecutorsPage() {
  const [items, setItems] = useState<ExecutorItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // 表单状态
  const [name, setName] = useState("");
  const [type, setType] = useState<string>("atomcode");
  const [kind, setKind] = useState<"cli" | "a2a">("cli");
  const [bin, setBin] = useState("");
  const [url, setUrl] = useState("");
  const [args, setArgs] = useState("");
  const [device, setDevice] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);

  // Participant 自管理:编辑对话框 + 心跳
  const [participants, setParticipants] = useState<ParticipantInfo[]>([]);
  const [editingParticipant, setEditingParticipant] =
    useState<ParticipantInfo | null>(null);
  const [editName, setEditName] = useState("");
  const [editDevice, setEditDevice] = useState("");
  const [editCapabilities, setEditCapabilities] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [heartbeatingId, setHeartbeatingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [execRes, participantRes] = await Promise.all([
        fetch("/api/executors"),
        fetch("/api/participants"),
      ]);
      if (!execRes.ok) throw new Error(`HTTP ${execRes.status}`);
      const executorItems = (await execRes.json()) as ExecutorItem[];
      // participant 列表加载失败不阻断执行器列表(自管理字段缺省不展示)。
      const participantList = participantRes.ok
        ? ((await participantRes.json()) as ParticipantInfo[])
        : [];
      setParticipants(participantList);
      // 加载时按 name 关联 participant id(executor 注册时 name 即 agentName)。
      setItems(
        executorItems.map((ex) => ({
          ...ex,
          participantId: participantList.find((a) => a.name === ex.agentName)
            ?.id,
        })),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 按 participantId 取该执行器对应的 participant 注册信息;无 participantId 时返回 undefined。 */
  const participantById = useCallback(
    (participantId?: string) =>
      participantId
        ? participants.find((a) => a.id === participantId)
        : undefined,
    [participants],
  );

  /** 编辑/心跳前置检查:未绑定 token 或非自己的 participant 时给出提示(与任务面板
   *  无权限提示一致),返回 true 表示已拦截。 */
  const requireOwnParticipant = (participant: ParticipantInfo): boolean => {
    if (Object.keys(participantAuthHeaders()).length === 0) {
      setError("无权限,请先绑定 Participant Token 再操作");
      return true;
    }
    const boundId =
      typeof localStorage !== "undefined"
        ? localStorage.getItem(PARTICIPANT_ID_KEY)
        : null;
    if (!boundId || boundId !== participant.id) {
      setError("无权限,只能管理自己的 Participant 信息");
      return true;
    }
    return false;
  };

  const handleSubmit = async () => {
    setMessage(null);
    setError(null);
    if (!name.trim()) {
      setError("请填写 Participant 名字");
      return;
    }
    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        agentName: name.trim(),
        type,
        kind,
        device: device.trim() || undefined,
      };
      if (kind === "a2a") {
        if (!url.trim()) {
          setError("a2a 调用方式需要 gateway 地址");
          return;
        }
        payload.url = url.trim();
        payload.bin = name.trim();
      } else {
        if (!bin.trim()) {
          setError("cli 调用方式需要命令");
          return;
        }
        payload.bin = bin.trim();
        // 参数模板:空白分词,如 "-y -p {ticket}" → ["-y","-p","{ticket}"]
        const argList = args
          .trim()
          .split(/\s+/)
          .filter((a) => a.length > 0);
        if (argList.length > 0) payload.args = argList;
      }
      const res = await fetch("/api/executors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          message?: string;
        } | null;
        throw new Error(body?.message ?? `HTTP ${res.status}`);
      }
      setMessage(
        `已接入 Participant「${name.trim()}」,可在群组里定向到它发布任务`,
      );
      setName("");
      setBin("");
      setUrl("");
      setArgs("");
      setDevice("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "提交失败");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (item: ExecutorItem) => {
    if (item.builtin) return;
    if (!window.confirm(`删除执行器「${item.agentName}」?`)) return;
    setDeletingKey(item.key);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/api/executors/${item.key}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          message?: string;
        } | null;
        throw new Error(body?.message ?? `HTTP ${res.status}`);
      }
      setMessage(`已删除「${item.agentName}」`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
    } finally {
      setDeletingKey(null);
    }
  };

  /** 打开编辑对话框(仅自己的 participant):预填 name/device/capabilities。 */
  const startEdit = (participant: ParticipantInfo) => {
    if (requireOwnParticipant(participant)) return;
    setEditName(participant.name);
    setEditDevice(participant.device ?? "");
    // capabilities 逗号分隔展示,提交时再转数组。
    setEditCapabilities(participant.capabilities.join(", "));
    setEditingParticipant(participant);
  };

  /** PATCH /api/participants/:id 保存;401/403 → 无权限提示;成功后按 id 即时刷新该行。 */
  const handleSaveEdit = async () => {
    if (!editingParticipant) return;
    setSavingEdit(true);
    setMessage(null);
    setError(null);
    try {
      const capabilities = editCapabilities
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const res = await fetch(`/api/participants/${editingParticipant.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...participantAuthHeaders(),
        },
        body: JSON.stringify({
          name: editName.trim() || undefined,
          device: editDevice.trim() ? editDevice.trim() : null,
          capabilities,
        }),
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          setError("无权限,只能管理自己的 Participant 信息");
          setEditingParticipant(null);
          return;
        }
        const body = (await res.json().catch(() => null)) as {
          message?: string;
        } | null;
        throw new Error(body?.message ?? `HTTP ${res.status}`);
      }
      const updated = (await res.json()) as ParticipantInfo;
      setMessage(`已更新 Participant「${updated.name}」`);
      setEditingParticipant(null);
      // 按 id 更新本地 participants,行内立即刷新(改名也不影响匹配)。
      setParticipants((prev) =>
        prev.map((a) => (a.id === updated.id ? updated : a)),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSavingEdit(false);
    }
  };

  /** PUT /api/participants/:id/heartbeat 上报在线;成功后该行立即变在线。 */
  const handleHeartbeat = async (participant: ParticipantInfo) => {
    if (requireOwnParticipant(participant)) return;
    setHeartbeatingId(participant.id);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch(`/api/participants/${participant.id}/heartbeat`, {
        method: "PUT",
        headers: participantAuthHeaders(),
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          setError("无权限,只能上报自己的 Participant 在线状态");
          return;
        }
        const body = (await res.json().catch(() => null)) as {
          message?: string;
        } | null;
        throw new Error(body?.message ?? `HTTP ${res.status}`);
      }
      const { lastSeen } = (await res.json()) as { lastSeen: string };
      setParticipants((prev) =>
        prev.map((a) => (a.id === participant.id ? { ...a, lastSeen } : a)),
      );
      setMessage(`已上报「${participant.name}」在线`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "上报在线失败");
    } finally {
      setHeartbeatingId(null);
    }
  };

  const inputCls =
    "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]";

  return (
    <div className="mx-auto w-full max-w-4xl p-4 sm:p-6">
      <div className="mb-6">
        <h2 className="text-xl font-semibold">接入 Participant(参与者)</h2>
        <p className="text-muted-foreground text-sm">
          新增一个可被定向消息调度的执行器;提交后自动注册对应
          participant,凭据由后端管理。绑定身份后可编辑自己的 Participant
          信息并上报在线
        </p>
        <p className="text-muted-foreground mt-1 text-xs">
          术语澄清:这里的 Participant = 参与者身份(人 / 工具 / Bot
          统一注册),不是「AI 智能体」; 平台不内置 AI,思考发生在各 Participant
          自己的客户端。
        </p>
      </div>

      {message && (
        <p className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
          {message}
        </p>
      )}
      {error && (
        <p className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}

      {/* 新增表单 */}
      <div className="mb-8 rounded-lg border bg-card p-4 sm:p-5">
        <div className="mb-4 flex items-center gap-2 text-sm font-medium">
          <Bot className="size-4" />
          新增执行器
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="ex-name">名字</Label>
            <Input
              id="ex-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如 My CLI Participant"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ex-type">类型</Label>
            <select
              id="ex-type"
              value={type}
              onChange={(e) => setType(e.target.value)}
              className={inputCls}
            >
              {PARTICIPANT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label>调用方式</Label>
            <div className="flex items-center gap-4 pt-1.5">
              {(["cli", "a2a"] as const).map((k) => (
                <label key={k} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="radio"
                    name="kind"
                    checked={kind === k}
                    onChange={() => setKind(k)}
                  />
                  {k === "cli" ? "cli(本地命令)" : "a2a(远程 gateway)"}
                </label>
              ))}
            </div>
          </div>
          <div className="grid gap-1.5">
            {kind === "cli" ? (
              <>
                <Label htmlFor="ex-bin">命令</Label>
                <Input
                  id="ex-bin"
                  value={bin}
                  onChange={(e) => setBin(e.target.value)}
                  placeholder="如 atomcode"
                />
              </>
            ) : (
              <>
                <Label htmlFor="ex-url">Gateway 地址</Label>
                <Input
                  id="ex-url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="如 http://192.168.1.10:9900/"
                />
              </>
            )}
          </div>
          {kind === "cli" && (
            <div className="grid gap-1.5">
              <Label htmlFor="ex-args">参数模板(可选)</Label>
              <Input
                id="ex-args"
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                placeholder="如 -y -p {ticket}"
              />
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="ex-device">设备(可选)</Label>
            <Input
              id="ex-device"
              value={device}
              onChange={(e) => setDevice(e.target.value)}
              placeholder="如 mac-mini"
            />
          </div>
        </div>
        <div className="mt-4 flex justify-end">
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting && <Loader2 className="size-4 animate-spin" />}
            提交
          </Button>
        </div>
      </div>

      {/* 执行器列表(内置 + DB 配置),行内带 participant 自管理字段 */}
      <div className="rounded-lg border bg-card">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <span className="text-sm font-medium">执行器列表</span>
          <span className="text-xs text-muted-foreground">
            {loading ? "加载中…" : `共 ${items.length} 个`}
          </span>
        </div>
        {items.length === 0 && !loading ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            暂无执行器,请先在上方新增
          </p>
        ) : (
          <ul className="divide-y">
            {items.map((item) => {
              const participant = participantById(item.participantId);
              const lastSeen = participant?.lastSeen ?? null;
              const online =
                lastSeen != null &&
                Date.now() - Date.parse(lastSeen) < ONLINE_WINDOW_MS;
              return (
                <li
                  key={item.key}
                  className="flex items-start justify-between gap-2 px-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">
                        {item.agentName}
                      </span>
                      {item.builtin && (
                        <span className="inline-flex shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                          内置
                        </span>
                      )}
                      {/* 在线状态徽标:绿点在线 / 灰点离线 / 从未在线 */}
                      {participant && (
                        <span
                          className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs ${
                            online
                              ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200"
                              : "bg-muted text-muted-foreground"
                          }`}
                        >
                          <span
                            className={`size-1.5 rounded-full ${
                              online
                                ? "bg-emerald-500"
                                : "bg-muted-foreground/60"
                            }`}
                          />
                          {lastSeen == null
                            ? "从未在线"
                            : online
                              ? "在线"
                              : "离线"}
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 truncate text-xs text-muted-foreground">
                      {item.type} · {item.kind}
                      {participant?.device ? ` · ${participant.device}` : ""}
                      {item.label !== item.agentName ? ` · ${item.label}` : ""}
                      {item.kind === "a2a" && item.url ? ` · ${item.url}` : ""}
                      {!item.builtin && ` · ${item.bin}`}
                      {item.args.length > 0 ? ` · ${item.args.join(" ")}` : ""}
                    </div>
                    {/* capabilities 标签 chips */}
                    {participant && (
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        {participant.capabilities.map((cap) => (
                          <Badge key={cap} variant="secondary">
                            {cap}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {participant && (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => startEdit(participant)}
                        >
                          <Pencil className="size-4" />
                          编辑
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleHeartbeat(participant)}
                          disabled={heartbeatingId === participant.id}
                        >
                          <HeartPulse className="size-4" />
                          {heartbeatingId === participant.id
                            ? "上报中…"
                            : "上报在线"}
                        </Button>
                      </>
                    )}
                    {!item.builtin && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleDelete(item)}
                        disabled={deletingKey === item.key}
                        className="shrink-0"
                      >
                        <Trash2 className="size-4" />
                        删除
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* 编辑对话框(仅自己的 participant) */}
      <Dialog
        open={editingParticipant !== null}
        onOpenChange={(open) => {
          if (!open) setEditingParticipant(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑 Participant</DialogTitle>
            <DialogDescription>
              更新自己的注册信息:名字 / 设备 / 能力标签(逗号分隔)。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="edit-name">Participant 名字</Label>
              <Input
                id="edit-name"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="edit-device">设备</Label>
              <Input
                id="edit-device"
                value={editDevice}
                onChange={(e) => setEditDevice(e.target.value)}
                placeholder="如 mac-mini"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="edit-caps">能力标签(逗号分隔)</Label>
              <Input
                id="edit-caps"
                value={editCapabilities}
                onChange={(e) => setEditCapabilities(e.target.value)}
                placeholder="如 text-generation, code-review"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEditingParticipant(null)}
              disabled={savingEdit}
            >
              取消
            </Button>
            <Button onClick={handleSaveEdit} disabled={savingEdit}>
              {savingEdit && <Loader2 className="size-4 animate-spin" />}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
