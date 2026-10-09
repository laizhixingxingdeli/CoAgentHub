/**
 * 传输层证据采集。
 *
 * 为什么需要它：provider SDK（OpenAI / Anthropic）在出错时往往只把 HTTP 状态码
 * 和底层错误码吞成一句给人看的文案。比如 opencode-go 走 openai-completions，
 * 网络断了之后 assistant 消息里只剩 `errorMessage: "Connection error."` —— 里面
 * 既没有 429 也没有 ECONNREFUSED，靠文案分类等于猜。
 *
 * 但那次请求到底发生了什么是**有据可查的**：undici（Node fetch 的底座）会往
 * `node:diagnostics_channel` 发结构化事件：
 *
 *   - `undici:request:headers` → 真实的 HTTP statusCode（429 / 401 / 5xx）
 *   - `undici:request:error`   → 真实的底层错误码（ECONNREFUSED / ENOTFOUND / ETIMEDOUT）
 *
 * 这些是上游/网络栈真正返回的东西，不是文案。这里只**观察**，不拦截、不改写
 * 任何请求——对现有行为零影响，也没有新增依赖（node:diagnostics_channel 是内置模块）。
 */

import diagnostics_channel from "node:diagnostics_channel";
import type { TransportObservation } from "./failure-classify.js";

/** 一次 run 里最多留多少条观察，防止长跑把内存撑起来。 */
const MAX_OBSERVATIONS = 64;

export interface TransportRecorder {
	observations(): readonly TransportObservation[];
	stop(): void;
}

/**
 * 开始观察传输层。用完必须 `stop()`。
 *
 * 订阅是进程级的：本适配层一次 run 一个子进程（agent-entry），不存在并发 run
 * 混在一起的问题；即便如此，调用方仍应按 origin 过滤，避免把平台自己的调用
 * （同一个全局 dispatcher）算进来。
 */
export function recordTransport(): TransportRecorder {
	const observations: TransportObservation[] = [];
	const push = (observation: TransportObservation): void => {
		if (observations.length >= MAX_OBSERVATIONS) observations.shift();
		observations.push(observation);
	};

	const onHeaders = (message: unknown): void => {
		try {
			const m = message as {
				request?: { origin?: string };
				response?: { statusCode?: number };
			};
			const statusCode = m?.response?.statusCode;
			if (typeof statusCode !== "number") return;
			push({ kind: "response", origin: m?.request?.origin, statusCode });
		} catch {
			/* 观察失败绝不影响主流程 */
		}
	};
	const onError = (message: unknown): void => {
		try {
			const m = message as {
				request?: { origin?: string };
				error?: { code?: unknown; name?: string; message?: string };
			};
			const error = m?.error;
			push({
				kind: "error",
				origin: m?.request?.origin,
				errorCode: error?.code === undefined ? undefined : String(error.code),
				errorName: error?.name,
				message: typeof error?.message === "string" ? error.message : undefined,
			});
		} catch {
			/* 同上 */
		}
	};

	diagnostics_channel.subscribe("undici:request:headers", onHeaders);
	diagnostics_channel.subscribe("undici:request:error", onError);

	return {
		observations: () => observations,
		stop: () => {
			try {
				diagnostics_channel.unsubscribe("undici:request:headers", onHeaders);
			} catch {
				/* ignore */
			}
			try {
				diagnostics_channel.unsubscribe("undici:request:error", onError);
			} catch {
				/* ignore */
			}
		},
	};
}

/** 只留属于这个 origin 的观察（provider 那一次请求），把平台自身的调用排除掉。 */
export function observationsForOrigin(
	observations: readonly TransportObservation[],
	origin: string | undefined,
): readonly TransportObservation[] {
	if (!origin) return observations;
	return observations.filter((o) => o.origin === origin);
}

/** 从 baseUrl 取 origin，用来对上 provider 的请求。取不到返回 undefined（不过滤）。 */
export function originOf(baseUrl: string | undefined): string | undefined {
	if (!baseUrl) return undefined;
	try {
		return new URL(baseUrl).origin;
	} catch {
		return undefined;
	}
}
