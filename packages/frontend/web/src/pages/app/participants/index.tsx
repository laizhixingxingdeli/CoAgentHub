import {
  Bot,
  CheckCircle2,
  HeartPulse,
  Loader2,
  Pencil,
  Settings2,
  Trash2,
  XCircle,
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
import { Textarea } from "@/components/ui/textarea";
import { t } from "@/lib/i18n";

/**
 * 接入 Participant(ticket: 网页 @executor 发布):管理执行器配置。
 *
 * 表单字段 = 名字 / 调用方式(cli|a2a)/ 命令或 gateway 地址 / 参数模板
 * (cli,可空)/ 设备(可选)/ 模型(可选)/ 提示词(可选,协调者分工判断用)。
 * 提交调 POST /api/executors,server 自动注册对应 participant(token 认证已
 * 移除,界面绝不出现任何 token/token_hash 字段)。
 *
 * 命令(bin)字段带「检测」按钮:调 GET /api/executors/check-bin 探测命令在
 * 服务器上是否可执行。只读辅助功能:点击时查一次(不防抖),网络失败静默;
 * 输入变化后旧结果失效,未找到不阻断提交(可能先填一个之后才部署的命令)。
 *
 * 列表 = DB 配置(GET /api/executors;无代码内置、无迁移播种)。零配置时渲染空态
 * 引导(specs/no-builtin-executor-seeding.md R4),提示在本页表单新增。
 *
 * Participant 自管理(ticket: 补全 /participants 页):列表行同时带出 participant 注册信息
 * (GET /api/participants,按 name 匹配),展示 device / capabilities / 在线状态;
 * 绑定后自己的 participant 可编辑(PATCH)与上报在线(heartbeat)。
 */

/** check-bin 探测结果(与后端 GET /api/executors/check-bin 响应一致)。 */
type BinCheckResult = {
  found: boolean;
  resolvedPath: string | null;
};

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
  /** 默认分工说明(加入群组时作为该执行器分工说明的默认值);未配置为 null。 */
  prompt: string | null;
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

/**
 * 平台四件套 skill → capability 标签(R4:参与方页面同步状态)。
 * 与后端 COAGENTHUB_SKILL_CAPABILITIES 保持一致,展示「已装 / 未装」。
 */
const SKILL_SYNC_ITEMS = [
  { name: "executor", capability: "coagenthub-executor" },
  { name: "coordinator", capability: "coagenthub-coordinator" },
  { name: "bugfix", capability: "coagenthub-bugfix" },
  { name: "reviewer", capability: "coagenthub-reviewer" },
] as const;

/**
 * 参与方 skill 同步状态(数据源 participant.capabilities):已装 → 绿勾;
 * 未装 → 提示 + 可操作指引(在 agent 机器上 GET /api/skills/:name 并写盘、
 * 安装后上报),不只显示一个红叉。compact 模式只显示四枚状态徽标(指引放
 * title 悬停),完整模式额外列出未装项的操作指引。
 */
function SkillSyncStatus({
  capabilities,
  compact = false,
}: {
  capabilities: string[];
  compact?: boolean;
}) {
  const installed = (capability: string) => capabilities.includes(capability);
  return (
    <div className={compact ? "" : "grid gap-1"}>
      {!compact && (
        <span className="text-xs font-medium text-muted-foreground">
          {t("participants.skills.title")}
        </span>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {SKILL_SYNC_ITEMS.map(({ name, capability }) => {
          const ok = installed(capability);
          return (
            <span
              key={name}
              className={`flex items-center gap-1 text-xs ${
                ok
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-amber-600 dark:text-amber-500"
              }`}
              title={ok ? undefined : t("participants.skills.guide", { name })}
            >
              {ok ? (
                <CheckCircle2 className="size-3.5 shrink-0" />
              ) : (
                <XCircle className="size-3.5 shrink-0" />
              )}
              {name}
              <span className="text-muted-foreground">
                {ok
                  ? t("participants.skills.installed")
                  : t("participants.skills.notInstalled")}
              </span>
            </span>
          );
        })}
      </div>
      {!compact &&
        SKILL_SYNC_ITEMS.filter(({ capability }) => !installed(capability)).map(
          ({ name }) => (
            <p
              key={name}
              className="text-xs text-muted-foreground"
              data-testid={`skill-guide-${name}`}
            >
              {t("participants.skills.guide", { name })}
            </p>
          ),
        )}
    </div>
  );
}

/** 检测结果展示:找到 → 绿色对勾 + 等宽路径;未找到 → 轻量提示(不阻断提交)。 */
function BinCheckResultView({ result }: { result: BinCheckResult }) {
  if (result.found) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
        <CheckCircle2 className="size-3.5 shrink-0" />
        <span className="shrink-0">{t("participants.check.found")}</span>
        <code className="truncate font-mono text-muted-foreground">
          {result.resolvedPath}
        </code>
      </p>
    );
  }
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <XCircle className="size-3.5 shrink-0" />
      {t("participants.check.notFound")}
    </p>
  );
}

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
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);

  // 命令检测:checkingBin = 请求中;binCheckResult = 最近一次检测结果
  // (bin 输入变化后置 null,避免展示过期结果)。
  const [checkingBin, setCheckingBin] = useState(false);
  const [binCheckResult, setBinCheckResult] = useState<BinCheckResult | null>(
    null,
  );

  // 执行器编辑:对话框(bin/args/model/device/prompt/agentName)+ PATCH 保存
  const [editingExecutor, setEditingExecutor] = useState<ExecutorItem | null>(
    null,
  );
  const [editAgentName, setEditAgentName] = useState("");
  const [editBin, setEditBin] = useState("");
  const [editArgs, setEditArgs] = useState("");
  const [editModel, setEditModel] = useState("");
  const [editExecutorDevice, setEditExecutorDevice] = useState("");
  const [editPrompt, setEditPrompt] = useState("");
  const [editCheckingBin, setEditCheckingBin] = useState(false);
  const [editBinCheckResult, setEditBinCheckResult] =
    useState<BinCheckResult | null>(null);
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
  // 参与者行内改名(网页体验批次):renamingKey = 正在改名的执行器 key。
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");
  const [savingRename, setSavingRename] = useState(false);

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
        prompt: prompt.trim() || undefined,
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
      setPrompt("");
      setBinCheckResult(null);
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
    setHeartbeatingId(participant.id);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch(`/api/participants/${participant.id}/heartbeat`, {
        method: "PUT",
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

  /** 行内改名(网页体验批次):PATCH /api/participants/:id { name }。内置执行器
   *  名由 executor 配置驱动,不改(点击时提示「执行器名由配置管理」)。 */
  const startRename = (item: ExecutorItem) => {
    if (item.builtin) {
      setError(t("participants.renameBuiltinHint"));
      return;
    }
    const participant = participantById(item.participantId);
    if (!participant) {
      setError(t("participants.error.saveFailed"));
      return;
    }
    setRenamingKey(item.key);
    setRenameName(participant.name);
  };

  const handleSaveRename = async () => {
    const item = items.find((x) => x.key === renamingKey);
    const participant = item ? participantById(item.participantId) : undefined;
    const name = renameName.trim();
    if (!item || !participant || !name || savingRename) {
      return;
    }
    setSavingRename(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch(`/api/participants/${participant.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          message?: string;
        } | null;
        throw new Error(body?.message ?? `HTTP ${res.status}`);
      }
      const updated = (await res.json()) as ParticipantInfo;
      setMessage(t("participants.renamed", { name: updated.name }));
      setRenamingKey(null);
      // 按 id 更新本地 participants,行内立即刷新。
      setParticipants((prev) =>
        prev.map((a) => (a.id === updated.id ? updated : a)),
      );
    } catch (e) {
      setError(
        e instanceof Error ? e.message : t("participants.error.saveFailed"),
      );
    } finally {
      setSavingRename(false);
    }
  };

  /** 打开「编辑执行器」对话框(bin/args/model/device/prompt/agentName);内置项入口禁用。 */
  const startEditExecutor = (item: ExecutorItem) => {
    setEditingExecutor(item);
    setEditAgentName(item.agentName);
    setEditBin(item.bin);
    setEditArgs(item.args.join(" "));
    setEditModel(item.model ?? "");
    // device 属于 participant 注册信息,编辑时按 name 匹配预填。
    setEditExecutorDevice(participantById(item.participantId)?.device ?? "");
    setEditPrompt(item.prompt ?? "");
    setEditBinCheckResult(null);
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
        // 空字符串 = 清空(与后端 PATCH prompt 语义一致)。
        prompt: editPrompt.trim(),
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

  /** 调 check-bin 探测;空输入或请求失败返回 null(辅助功能,静默失败不打扰主流程)。 */
  const runBinCheck = async (value: string): Promise<BinCheckResult | null> => {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      const res = await fetch(
        `/api/executors/check-bin?bin=${encodeURIComponent(trimmed)}`,
      );
      if (!res.ok) return null;
      return (await res.json()) as BinCheckResult;
    } catch {
      return null;
    }
  };

  /** 新增表单的检测按钮:点击时查一次,不做防抖。 */
  const handleCheckBin = async () => {
    setCheckingBin(true);
    setBinCheckResult(null);
    const result = await runBinCheck(bin);
    setBinCheckResult(result);
    setCheckingBin(false);
  };

  /** 编辑执行器对话框的检测按钮:逻辑与新增表单一致。 */
  const handleEditCheckBin = async () => {
    setEditCheckingBin(true);
    setEditBinCheckResult(null);
    const result = await runBinCheck(editBin);
    setEditBinCheckResult(result);
    setEditCheckingBin(false);
  };

  return (
    <div className="mx-auto w-full max-w-[760px] p-4 sm:p-6">
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

      {/* 新增表单:白底圆角卡片,字段分组(名字+调用方式 / 命令 / 参数模板 /
          模型+设备 / 提示词) */}
      <div className="mb-8 rounded-lg border bg-card p-4 shadow-sm sm:p-5">
        <div className="mb-4 flex items-center gap-2 text-sm font-medium">
          <Bot className="size-4" />
          {t("participants.form.title")}
        </div>
        <div className="grid gap-4">
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
              {/* 分段控件:两个选项拼在一起、互斥选择,选中态高亮 */}
              <div
                role="radiogroup"
                className="grid grid-cols-2 gap-0.5 rounded-lg border bg-muted/50 p-0.5"
              >
                {(["cli", "a2a"] as const).map((k) => {
                  const active = kind === k;
                  return (
                    <button
                      key={k}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => setKind(k)}
                      className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                        active
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {k === "cli"
                        ? t("participants.form.invokeCli")
                        : t("participants.form.invokeA2a")}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="grid gap-1.5">
            {kind === "cli" ? (
              <>
                <Label htmlFor="ex-bin">{t("participants.form.command")}</Label>
                <div className="flex gap-2">
                  <Input
                    id="ex-bin"
                    value={bin}
                    onChange={(e) => {
                      setBin(e.target.value);
                      // 输入变化后旧检测结果失效,避免展示过期结果。
                      setBinCheckResult(null);
                    }}
                    placeholder={t("participants.form.commandPlaceholder")}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void handleCheckBin()}
                    disabled={checkingBin || !bin.trim()}
                    className="shrink-0"
                  >
                    {checkingBin && <Loader2 className="size-4 animate-spin" />}
                    {checkingBin
                      ? t("participants.form.checking")
                      : t("participants.form.check")}
                  </Button>
                </div>
                {binCheckResult && (
                  <BinCheckResultView result={binCheckResult} />
                )}
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

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="ex-model">{t("participants.form.model")}</Label>
              <Input
                id="ex-model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={t("participants.form.modelPlaceholder")}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="ex-device">{t("participants.form.device")}</Label>
              <Input
                id="ex-device"
                value={device}
                onChange={(e) => setDevice(e.target.value)}
                placeholder={t("participants.form.devicePlaceholder")}
              />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="ex-prompt">{t("participants.form.prompt")}</Label>
            <Textarea
              id="ex-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t("participants.form.promptPlaceholder")}
            />
            <p className="text-xs text-muted-foreground">
              {t("participants.form.promptHint")}
            </p>
          </div>
        </div>
        <div className="mt-4 flex justify-end">
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting && <Loader2 className="size-4 animate-spin" />}
            {t("common.submit")}
          </Button>
        </div>
      </div>

      {/* 执行器列表(仅 DB 配置),卡片行;行内带 participant 自管理字段 */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between px-1">
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
          <div
            data-testid="executors-empty-state"
            className="rounded-lg border border-dashed px-4 py-6 text-sm text-muted-foreground"
          >
            <p className="font-medium text-foreground">
              {t("participants.list.empty")}
            </p>
            <p className="mt-1">{t("participants.list.emptyHint")}</p>
          </div>
        ) : (
          items.map((item) => {
            const participant = participantById(item.participantId);
            const lastSeen = participant?.lastSeen ?? null;
            const online =
              lastSeen != null &&
              Date.now() - Date.parse(lastSeen) < ONLINE_WINDOW_MS;
            return (
              <div
                key={item.key}
                data-testid={`executor-row-${item.key}`}
                className="rounded-lg border bg-card p-4 shadow-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-3">
                    {/* 圆角方块头像:先固定一个背景色,不做角色色识别 */}
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <Bot className="size-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        {renamingKey === item.key ? (
                          <div className="flex min-w-0 flex-1 items-center gap-1.5">
                            <Input
                              autoFocus
                              value={renameName}
                              onChange={(e) => setRenameName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  void handleSaveRename();
                                } else if (e.key === "Escape") {
                                  setRenamingKey(null);
                                }
                              }}
                              aria-label={t("participants.renameInputAria")}
                              className="h-8 flex-1"
                            />
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={savingRename || !renameName.trim()}
                              onClick={() => void handleSaveRename()}
                            >
                              {savingRename
                                ? t("common.saving")
                                : t("participants.renameSave")}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setRenamingKey(null)}
                            >
                              {t("participants.renameCancel")}
                            </Button>
                          </div>
                        ) : (
                          <>
                            <span
                              className="truncate text-sm font-medium"
                              data-testid={`participant-name-${item.key}`}
                            >
                              {participant?.name ?? item.agentName}
                            </span>
                            <Pencil
                              data-testid={`rename-participant-${item.key}`}
                              className="size-3.5 shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
                              aria-label={t("participants.renameAria")}
                              onClick={() => startRename(item)}
                            />
                            {item.builtin && (
                              <Badge variant="secondary">
                                {t("common.builtin")}
                              </Badge>
                            )}
                            {item.kind === "a2a" && (
                              <Badge variant="outline">
                                {t("participants.badge.a2a")}
                              </Badge>
                            )}
                            {/* 在线状态:小圆点 + 文字(不是纯色块);无 participant
                                注册信息时不展示 */}
                            {participant && (
                              <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
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
                          </>
                        )}
                      </div>
                      {/* 元信息行:等宽字体展示 bin/url + device(参数模板/模型仍保留) */}
                      <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                        {item.kind === "a2a" && item.url ? item.url : item.bin}
                        {participant?.device ? ` ${participant.device}` : ""}
                        {item.args.length > 0 ? ` ${item.args.join(" ")}` : ""}
                        {item.model ? ` ${item.model}` : ""}
                      </p>
                      {/* 提示词摘要(超长省略号截断) */}
                      {item.prompt ? (
                        <p className="mt-1 truncate text-xs text-muted-foreground">
                          {item.prompt}
                        </p>
                      ) : null}
                      {/* capabilities 标签 chips */}
                      {participant && (
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          {participant.capabilities.map((cap) => (
                            <Badge key={cap} variant="secondary">
                              {cap}
                            </Badge>
                          ))}
                        </div>
                      )}
                      {/* R4:四 skill 同步状态(已装/未装),紧凑徽标,指引放 title */}
                      {participant && (
                        <div className="mt-1.5">
                          <SkillSyncStatus
                            capabilities={participant.capabilities}
                            compact
                          />
                        </div>
                      )}
                    </div>
                  </div>
                  {/* 操作按钮列(右侧) */}
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
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
                </div>
              </div>
            );
          })
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
              {/* R4:编辑时按当前文本实时反映四 skill 同步状态,未装给操作指引。
                  capabilities 仍是自由文本(逗号分隔),这里只是只读呈现。 */}
              <div className="mt-1">
                <SkillSyncStatus
                  capabilities={editCapabilities
                    .split(",")
                    .map((s) => s.trim())
                    .filter((s) => s.length > 0)}
                />
              </div>
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

      {/* 编辑执行器对话框(DB 配置;bin/args/model/device/prompt/agentName 可改) */}
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
              <div className="flex gap-2">
                <Input
                  id="edit-ex-bin"
                  value={editBin}
                  onChange={(e) => {
                    setEditBin(e.target.value);
                    // 输入变化后旧检测结果失效。
                    setEditBinCheckResult(null);
                  }}
                  placeholder={t("participants.form.commandPlaceholder")}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void handleEditCheckBin()}
                  disabled={editCheckingBin || !editBin.trim()}
                  className="shrink-0"
                >
                  {editCheckingBin && (
                    <Loader2 className="size-4 animate-spin" />
                  )}
                  {editCheckingBin
                    ? t("participants.form.checking")
                    : t("participants.form.check")}
                </Button>
              </div>
              {editBinCheckResult && (
                <BinCheckResultView result={editBinCheckResult} />
              )}
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
            <div className="grid gap-1.5">
              <Label htmlFor="edit-ex-prompt">
                {t("participants.form.prompt")}
              </Label>
              <Textarea
                id="edit-ex-prompt"
                value={editPrompt}
                onChange={(e) => setEditPrompt(e.target.value)}
                placeholder={t("participants.form.promptPlaceholder")}
              />
              <p className="text-xs text-muted-foreground">
                {t("participants.form.promptHint")}
              </p>
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
