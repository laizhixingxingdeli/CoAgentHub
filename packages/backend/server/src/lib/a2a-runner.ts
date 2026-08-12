/**
 * A2A(Agent-to-Agent)执行器运行器:通过远端 A2A gateway 调用其他设备上的
 * agent(如 Windows 192.168.31.180 上的 hermes / win-hermes),server 侧
 * 不 spawn 任何本地进程。纯全局 fetch(Node 18+),不引入新依赖。
 *
 * 协议:JSON-RPC 1.0(该 gateway 实测),method=message/send,同步返回最终
 * 状态(一次调用即 TASK_STATE_COMPLETED + 回复文本,无需轮询)。
 *
 * 与 executor-runner.ts 的 runExecutor 保持相同的 ExecutorRunResult 形状,
 * executor-task.ts 的回传逻辑可原样复用:agent 最终回复文本 → stdout(exit 0);
 * 错误/超时 → stderr + 非零 code(timedOut 标记与 spawn 超时一致)。
 */

/** 默认超时:30 分钟(env EXECUTOR_TIMEOUT_MS 覆盖,单位毫秒)。 */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export interface A2ARunOptions {
  /** A2A gateway 基地址(如 http://host:9900/),POST 到该地址,method 在 body。 */
  url: string;
  /** Bearer token(Authorization 头),从 env 读(COAGENTHUB_WIN_A2A_TOKEN),不硬编码。 */
  token: string;
  /** 发给远端 agent 的提示词(直接作为 message 的 text part)。 */
  prompt: string;
  /** 超时(毫秒);默认 30 分钟。 */
  timeoutMs?: number;
}

/**
 * 发起一次 A2A message/send 调用并等同步终态。
 * 不抛异常:任何失败(网络/HTTP/JSON-RPC error/非完成状态)都折叠成
 * ExecutorRunResult{ code≠0, stderr },由调用方按普通失败回传。
 */
export async function runA2AExecutor(opts: A2ARunOptions): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  const { url, token, prompt } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // 超时用 AbortController 中止在途请求,与 runExecutor 的 SIGKILL 语义一致。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
        // jsonrpc "1.0":该 hermes gateway 为 JSON-RPC 1.0(实测)。
        body: JSON.stringify({
          jsonrpc: "1.0",
          id: `coagenthub-${Date.now()}`,
          method: "message/send",
          params: {
            message: {
              role: "user",
              parts: [{ kind: "text", text: prompt }],
            },
          },
        }),
        signal: controller.signal,
      });
    } catch (e) {
      const err = e as Error;
      if (controller.signal.aborted) {
        return { code: null, stdout: "", stderr: "执行超时", timedOut: true };
      }
      return {
        code: 1,
        stdout: "",
        stderr: `A2A 调用失败: ${err.message}`,
        timedOut: false,
      };
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return {
        code: res.status,
        stdout: "",
        stderr: `A2A gateway HTTP ${res.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`,
        timedOut: false,
      };
    }

    const payload = (await res.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!payload || typeof payload !== "object") {
      return {
        code: 1,
        stdout: "",
        stderr: "A2A 响应不是合法 JSON",
        timedOut: false,
      };
    }
    if (payload.error) {
      const err = payload.error as Record<string, unknown>;
      const msg =
        typeof err?.message === "string"
          ? err.message
          : JSON.stringify(payload.error);
      return {
        code: 1,
        stdout: "",
        stderr: `A2A JSON-RPC 错误: ${msg}`,
        timedOut: false,
      };
    }

    const reply = extractReplyText(payload.result);
    const state = extractTaskState(payload.result).toLowerCase();
    // 仅 COMPLETED 视为成功(stdout=最终回复文本);空 state = 无 Task 包装的
    // 同步 Message 响应,视为已完成。A2A 规范 TaskState 枚举带 TASK_STATE_
    // 前缀(TASK_STATE_COMPLETED),兼容两种形态。其余任何状态(FAILED/
    // REJECTED/…)一律 stderr + 非零 code,与 runExecutor 失败语义一致。
    const completed =
      state === "" ||
      state === "completed" ||
      state === "task_state_completed" ||
      state.endsWith("_completed");
    if (!completed) {
      return {
        code: 1,
        stdout: "",
        stderr: reply || `A2A 任务状态: ${state}`,
        timedOut: false,
      };
    }
    return { code: 0, stdout: reply, stderr: "", timedOut: false };
  } finally {
    clearTimeout(timer);
  }
}

/** 取 agent 最终回复文本:兼容 result.message、result.status.message 与 result
 *  直接是 message 三种形状(A2A 规范 Task 的回复在 status.message)。 */
function extractReplyText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const r = result as Record<string, unknown>;
  // 优先 status.message(A2A Task 形状:result.status.message.parts),再回退
  // result.message 与裸 message。
  const status = r.status;
  const statusMsg =
    status && typeof status === "object"
      ? (status as Record<string, unknown>).message
      : null;
  const message = (statusMsg ?? r.message ?? r) as Record<
    string,
    unknown
  > | null;
  if (!message || typeof message !== "object") return "";
  const parts = Array.isArray(message.parts)
    ? (message.parts as Array<Record<string, unknown>>)
    : [];
  const texts = parts
    .filter((p) => p && typeof p === "object" && typeof p.text === "string")
    .map((p) => p.text as string);
  if (typeof message.text === "string") texts.unshift(message.text);
  return texts.join("\n").trim();
}

/** 取任务状态(A2A TaskState.state,如 completed/failed):优先 result.status.state
 *  (A2A Task 形状),兼容 result.state.state 与裸字符串 result.state;无 state 视为
 *  同步 Message 响应(已完成),返回空串。 */
function extractTaskState(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const r = result as Record<string, unknown>;
  const status = r.status;
  if (status && typeof status === "object") {
    const s = status as Record<string, unknown>;
    if (typeof s.state === "string") return s.state;
  }
  const state = r.state;
  if (state && typeof state === "object") {
    const s = state as Record<string, unknown>;
    if (typeof s.state === "string") return s.state;
  }
  return typeof state === "string" ? state : "";
}
