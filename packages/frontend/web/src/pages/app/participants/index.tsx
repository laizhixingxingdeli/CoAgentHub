import {
  Bot,
  HeartPulse,
  Loader2,
  Pencil,
  Settings2,
  Trash2,
} from "lucide-react";
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
import { participantIdentityHeaders } from "@/lib/api-client";
import { t } from "@/lib/i18n";

/**
 * 接入 Participant(ticket: 网页 @executor 发布):管理执行器配置。
 *
 * 表单字段 = 名字 / 调用方式(cli|a2a)/ 命令或 gateway 地址 / 参数模板
 * (cli,可空)/ 设备(可选)。提交调 POST /api/executors,server 自动注册对应
 * participant(token 认证已移除,界面绝不出现任何 token/token_hash 字段)。
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
  /** 执行器默认模型(args 模板 {model} 占位);未配置为 null。 */
  model: string | null;
  builtin: boolean;
  /** 加载时按 name 匹配到的 participant id;渲染按 id 取 participant(改名后仍能对应)。 */
  participantId?: string;
};

/** Participant 注册信息(GET /api/participants):自管理字段 + 在线状态。 */
type ParticipantInfo = {
  id: string;
  name: string;
  device: string | null;
  capabilities: string[];
  lastSeen: string | null;
};

/** 在线判定(与后端 T13 约定一致):lastSeen 距今 < 60s 视为在线。 */
const ONLINE_WINDOW_MS = 60_000;

export default function ExecutorsPage() {
  const [items, setItems] = useState<ExecutorItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // 表单状态
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"cli" | "a2a">("cli");
  const [bin, setBin] = useState("");
  const [url, setUrl] = useState("");
  const [args, setArgs] = useState("");
  const [model, setModel] = useState("");
  const [device, setDevice] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);

  // 执行器编辑:对话框(bin/args/model/device/agentName)+ PATCH 保存
  const [editingExecutor, setEditingExecutor] = useState<ExecutorItem | null>(
    null,
  );
  const [editAgentName, setEditAgentName] = useState("");
  const [editBin, setEditBin] = useState("");
  const [editArgs, setEditArgs] = useState("");
  const [editModel, setEditModel] = useState("");
  const [editExecutorDevice, setEditExecutorDevice] = useState("");
  const [savingExecutorEdit, setSavingExecutorEdit] = useState(false);

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
      setError(
        e instanceof Error ? e.message : t("participants.error.loadFailed"),
      );
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

  /** 编辑/心跳前置检查:未绑定身份时给出提示(全信模型下任意身份都可管理任意
   *  participant),返回 true 表示已拦截。 */
  const requireBoundIdentity = (): boolean => {
    if (Object.keys(participantIdentityHeaders()).length === 0) {
      setError(t("participants.error.identityRequired"));
      return true;
    }
    return false;
  };

  const handleSubmit = async () => {
    setMessage(null);
    setError(null);
    if (!name.trim()) {
      setError(t("participants.error.nameRequired"));
      return;
    }
    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        agentName: name.trim(),
        kind,
        device: device.trim() || undefined,
        model: model.trim() || undefined,
      };
      if (kind === "a2a") {
        if (!url.trim()) {
          setError(t("participants.error.gatewayRequired"));
          return;
        }
        payload.url = url.trim();
        payload.bin = name.trim();
      } else {
        if (!bin.trim()) {
          setError(t("participants.error.commandRequired"));
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
      setMessage(t("participants.connected", { name: name.trim() }));
      setName("");
      setBin("");
      setUrl("");
      setArgs("");
      setModel("");
      setDevice("");
      await load();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : t("participants.error.submitFailed"),
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (item: ExecutorItem) => {
    if (item.builtin) return;
    if (
      !window.confirm(
        t("participants.confirm.delete", { name: item.agentName }),
      )
    )
      return;
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
      setMessage(t("participants.deleted", { name: item.agentName }));
      await load();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : t("participants.error.deleteFailed"),
      );
    } finally {
      setDeletingKey(null);
    }
  };

  /** 打开编辑对话框(全信模型:任意身份都可管理任意 participant)。 */
  const startEdit = (participant: ParticipantInfo) => {
    if (requireBoundIdentity()) return;
    setEditName(participant.name);
    setEditDevice(participant.device ?? "");
    // capabilities 逗号分隔展示,提交时再转数组。
    setEditCapabilities(participant.capabilities.join(", "));
    setEditingParticipant(participant);
  };

  /** PATCH /api/participants/:id 保存;成功后按 id 即时刷新该行。 */
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
          ...participantIdentityHeaders(),
        },
        body: JSON.stringify({
          name: editName.trim() || undefined,
          device: editDevice.trim() ? editDevice.trim() : null,
          capabilities,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          message?: string;
        } | null;
        throw new Error(body?.message ?? `HTTP ${res.status}`);
      }
      const updated = (await res.json()) as ParticipantInfo;
      setMessage(t("participants.updated", { name: updated.name }));
      setEditingParticipant(null);
      // 按 id 更新本地 participants,行内立即刷新(改名也不影响匹配)。
      setParticipants((prev) =>
        prev.map((a) => (a.id === updated.id ? updated : a)),
      );
    } catch (e) {
      setError(
        e instanceof Error ? e.message : t("participants.error.saveFailed"),
      );
    } finally {
      setSavingEdit(false);
    }
  };

  /** PUT /api/participants/:id/heartbeat 上报在线;成功后该行立即变在线。 */
  const handleHeartbeat = async (participant: ParticipantInfo) => {
    if (requireBoundIdentity()) return;
    setHeartbeatingId(participant.id);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch(`/api/participants/${participant.id}/heartbeat`, {
        method: "PUT",
        headers: participantIdentityHeaders(),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          message?: string;
        } | null;
        throw new Error(body?.message ?? `HTTP ${res.status}`);
      }
      const { lastSeen } = (await res.json()) as { lastSeen: string };
      setParticipants((prev) =>
        prev.map((a) => (a.id === participant.id ? { ...a, lastSeen } : a)),
      );
      setMessage(t("participants.heartbeatSent", { name: participant.name }));
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("participants.error.heartbeatFailed"),
      );
    } finally {
      setHeartbeatingId(null);
    }
  };

  /** 打开「编辑执行器」对话框(bin/args/model/device/agentName);内置项入口禁用。 */
  const startEditExecutor = (item: ExecutorItem) => {
    setEditingExecutor(item);
    setEditAgentName(item.agentName);
    setEditBin(item.bin);
    setEditArgs(item.args.join(" "));
    setEditModel(item.model ?? "");
    // device 属于 participant 注册信息,编辑时按 name 匹配预填。
    setEditExecutorDevice(participantById(item.participantId)?.device ?? "");
  };

  /** PATCH /api/executors/:key 保存;成功后重新加载列表即时刷新。 */
  const handleSaveExecutorEdit = async () => {
    if (!editingExecutor) return;
    setSavingExecutorEdit(true);
    setMessage(null);
    setError(null);
    try {
      const payload: Record<string, unknown> = {
        agentName: editAgentName.trim() || undefined,
        bin: editBin.trim() || undefined,
        model: editModel.trim() || null,
        device: editExecutorDevice.trim() || null,
      };
      // 参数模板:空白分词(与新增表单一致)。
      const argList = editArgs
        .trim()
        .split(/\s+/)
        .filter((a) => a.length > 0);
      if (argList.length > 0) payload.args = argList;
      else payload.args = [];

      const res = await fetch(`/api/executors/${editingExecutor.key}`, {
        method: "PATCH",
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
        t("participants.executorUpdated", {
          name: editAgentName.trim() || editingExecutor.agentName,
        }),
      );
      setEditingExecutor(null);
      await load();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : t("participants.error.saveFailed"),
      );
    } finally {
      setSavingExecutorEdit(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-4xl p-4 sm:p-6">
      <div className="mb-6">
        <h2 className="text-xl font-semibold">{t("participants.title")}</h2>
        <p className="text-muted-foreground text-sm">
          {t("participants.subtitle")}
        </p>
        <p className="text-muted-foreground mt-1 text-xs">
          {t("participants.terminology")}
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
          {t("participants.form.title")}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor="ex-name">{t("participants.form.name")}</Label>
            <Input
              id="ex-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("participants.form.namePlaceholder")}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>{t("participants.form.invoke")}</Label>
            <div className="flex items-center gap-4 pt-1.5">
              {(["cli", "a2a"] as const).map((k) => (
                <label key={k} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="radio"
                    name="kind"
                    checked={kind === k}
                    onChange={() => setKind(k)}
                  />
                  {k === "cli"
                    ? t("participants.form.invokeCli")
                    : t("participants.form.invokeA2a")}
                </label>
              ))}
            </div>
          </div>
          <div className="grid gap-1.5">
            {kind === "cli" ? (
              <>
                <Label htmlFor="ex-bin">{t("participants.form.command")}</Label>
                <Input
                  id="ex-bin"
                  value={bin}
                  onChange={(e) => setBin(e.target.value)}
                  placeholder={t("participants.form.commandPlaceholder")}
                />
              </>
            ) : (
              <>
                <Label htmlFor="ex-url">{t("participants.form.gateway")}</Label>
                <Input
                  id="ex-url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder={t("participants.form.gatewayPlaceholder")}
                />
              </>
            )}
          </div>
          {kind === "cli" && (
            <div className="grid gap-1.5">
              <Label htmlFor="ex-args">{t("participants.form.args")}</Label>
              <Input
                id="ex-args"
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                placeholder={t("participants.form.argsPlaceholder")}
              />
            </div>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="ex-device">{t("participants.form.device")}</Label>
            <Input
              id="ex-device"
              value={device}
              onChange={(e) => setDevice(e.target.value)}
              placeholder={t("participants.form.devicePlaceholder")}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="ex-model">{t("participants.form.model")}</Label>
            <Input
              id="ex-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={t("participants.form.modelPlaceholder")}
            />
          </div>
        </div>
        <div className="mt-4 flex justify-end">
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting && <Loader2 className="size-4 animate-spin" />}
            {t("common.submit")}
          </Button>
        </div>
      </div>

      {/* 执行器列表(内置 + DB 配置),行内带 participant 自管理字段 */}
      <div className="rounded-lg border bg-card">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <span className="text-sm font-medium">
            {t("participants.list.title")}
          </span>
          <span className="text-xs text-muted-foreground">
            {loading
              ? t("common.loading")
              : t("participants.list.count", { count: items.length })}
          </span>
        </div>
        {items.length === 0 && !loading ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            {t("participants.list.empty")}
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
                          {t("common.builtin")}
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
                            ? t("common.neverOnline")
                            : online
                              ? t("common.online")
                              : t("common.offline")}
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
                      {item.model ? ` · ${item.model}` : ""}
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
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => startEditExecutor(item)}
                      disabled={item.builtin}
                      title={
                        item.builtin
                          ? t("participants.editExecutor.builtinDisabled")
                          : undefined
                      }
                      className="shrink-0"
                    >
                      <Settings2 className="size-4" />
                      {t("participants.editExecutor.action")}
                    </Button>
                    {participant && (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => startEdit(participant)}
                        >
                          <Pencil className="size-4" />
                          {t("common.edit")}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleHeartbeat(participant)}
                          disabled={heartbeatingId === participant.id}
                        >
                          <HeartPulse className="size-4" />
                          {heartbeatingId === participant.id
                            ? t("participants.reporting")
                            : t("participants.heartbeat")}
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
                        {t("common.delete")}
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
            <DialogTitle>{t("participants.edit.title")}</DialogTitle>
            <DialogDescription>{t("participants.edit.desc")}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="edit-name">{t("participants.edit.name")}</Label>
              <Input
                id="edit-name"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="edit-device">
                {t("participants.edit.device")}
              </Label>
              <Input
                id="edit-device"
                value={editDevice}
                onChange={(e) => setEditDevice(e.target.value)}
                placeholder={t("participants.edit.devicePlaceholder")}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="edit-caps">{t("participants.edit.caps")}</Label>
              <Input
                id="edit-caps"
                value={editCapabilities}
                onChange={(e) => setEditCapabilities(e.target.value)}
                placeholder={t("participants.edit.capsPlaceholder")}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEditingParticipant(null)}
              disabled={savingEdit}
            >
              {t("common.cancel")}
            </Button>
            <Button onClick={handleSaveEdit} disabled={savingEdit}>
              {savingEdit && <Loader2 className="size-4 animate-spin" />}
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 编辑执行器对话框(DB 配置;bin/args/model/device/agentName 可改) */}
      <Dialog
        open={editingExecutor !== null}
        onOpenChange={(open) => {
          if (!open) setEditingExecutor(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("participants.editExecutor.title")}</DialogTitle>
            <DialogDescription>
              {t("participants.editExecutor.desc")}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="edit-ex-name">
                {t("participants.form.name")}
              </Label>
              <Input
                id="edit-ex-name"
                value={editAgentName}
                onChange={(e) => setEditAgentName(e.target.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="edit-ex-bin">
                {t("participants.form.command")}
              </Label>
              <Input
                id="edit-ex-bin"
                value={editBin}
                onChange={(e) => setEditBin(e.target.value)}
                placeholder={t("participants.form.commandPlaceholder")}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="edit-ex-args">
                {t("participants.form.args")}
              </Label>
              <Input
                id="edit-ex-args"
                value={editArgs}
                onChange={(e) => setEditArgs(e.target.value)}
                placeholder={t("participants.form.argsPlaceholder")}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="edit-ex-model">
                {t("participants.form.model")}
              </Label>
              <Input
                id="edit-ex-model"
                value={editModel}
                onChange={(e) => setEditModel(e.target.value)}
                placeholder={t("participants.form.modelPlaceholder")}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="edit-ex-device">
                {t("participants.form.device")}
              </Label>
              <Input
                id="edit-ex-device"
                value={editExecutorDevice}
                onChange={(e) => setEditExecutorDevice(e.target.value)}
                placeholder={t("participants.form.devicePlaceholder")}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEditingExecutor(null)}
              disabled={savingExecutorEdit}
            >
              {t("common.cancel")}
            </Button>
            <Button
              onClick={handleSaveExecutorEdit}
              disabled={savingExecutorEdit}
            >
              {savingExecutorEdit && (
                <Loader2 className="size-4 animate-spin" />
              )}
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
