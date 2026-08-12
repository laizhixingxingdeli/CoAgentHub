import { Bot, Loader2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * 接入 Agent(ticket: 网页 @executor 发布):管理执行器配置。
 *
 * 表单字段 = 名字 / 类型 / 调用方式(cli|a2a)/ 命令或 gateway 地址 / 参数模板
 * (cli,可空)/ 设备(可选)。提交调 POST /api/executors,server 自动注册对应
 * agent(token 后端生成,界面绝不出现任何 token/token_hash 字段)。
 *
 * 列表 = 内置执行器 + DB 配置(GET /api/executors 合并返回),内置项不可删除。
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
};

const AGENT_TYPES = [
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

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/executors");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setItems((await res.json()) as ExecutorItem[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSubmit = async () => {
    setMessage(null);
    setError(null);
    if (!name.trim()) {
      setError("请填写 Agent 名字");
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
      setMessage(`已接入 Agent「${name.trim()}」,可在群组里定向到它发布任务`);
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

  const inputCls =
    "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]";

  return (
    <div className="mx-auto w-full max-w-4xl p-4 sm:p-6">
      <div className="mb-6">
        <h2 className="text-xl font-semibold">接入 Agent</h2>
        <p className="text-muted-foreground text-sm">
          新增一个可被定向消息调度的执行器;提交后自动注册对应
          agent,凭据由后端管理
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
              placeholder="如 My CLI Agent"
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
              {AGENT_TYPES.map((t) => (
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

      {/* 执行器列表(内置 + DB 配置) */}
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
            {items.map((item) => (
              <li
                key={item.key}
                className="flex items-center justify-between gap-2 px-4 py-3"
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
                  </div>
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">
                    {item.type} · {item.kind}
                    {item.label !== item.agentName ? ` · ${item.label}` : ""}
                    {item.kind === "a2a" && item.url ? ` · ${item.url}` : ""}
                    {!item.builtin && ` · ${item.bin}`}
                    {item.args.length > 0 ? ` · ${item.args.join(" ")}` : ""}
                  </div>
                </div>
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
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
