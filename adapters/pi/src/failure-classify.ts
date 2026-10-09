/**
 * 上游失败分类。**纯函数、无 IO、无副作用。**
 *
 * 为什么需要它：一跳失败回来目前只有一句笼统的 `upstream_failure`，背后至少是
 * 五种处置互相矛盾的情况——模型不存在（该换候选）、限流/配额（该等退避）、
 * 凭据不对（等多久都没用，该喊人）、网络/代理断了（和模型无关，换个候选照样
 * 连不上）、模型回了但内容被合规挡下（不是候选健康问题）。混在一起，调度器
 * 只能一律换下一个候选去赌，赌错就把整个候选池烧一遍还查不出东西。
 *
 * ## 判定依据必须来自上游真实返回的东西
 *
 * 分类**优先**吃结构化证据，而不是错误文案：
 *
 *  - 模型存在性：`ModelRuntime.getModel(provider, model)` 是不是 undefined；
 *  - 凭据配置：`ModelRuntime.hasConfiguredAuth(provider)`；
 *  - HTTP 状态码：undici `undici:request:headers` 诊断通道给的真实 statusCode
 *    （429 / 401 / 403 / 5xx），即使 provider SDK 把状态码吞掉只留一句文案也拿得到；
 *  - 传输层错误码：undici `undici:request:error` / `undici:client:connectError`
 *    给的 `ECONNREFUSED` / `ENOTFOUND` / `ETIMEDOUT`（代理断、DNS 失败、连接被拒）；
 *  - provider 原生停止原因：assistant 消息的 `rawStopReason`（`refusal` /
 *    `content_filter` / `SAFETY`），以及 pi-ai 的结构化 `diagnostics`。
 *
 * 文案只作为**最后一道兜底**，并且会在结果里标成 `basis: "text"`。上游改一次
 * 措辞，文本兜底就会失效——那时分类结果是 `unknown`（`do_not_retry`），而不是
 * 静默退回"一律重试"。这正是这套分类和"只匹配文案"的分水岭：失效是**可见**的。
 *
 * 拿不准就报 `unknown`。不硬塞进某一类。
 */

/** 上游失败的类别。 */
export type UpstreamFailureCategory =
	/** provider/model 在上游目录里不存在（上游整段改名、模型下架）。 */
	| "model_not_found"
	/** 凭据缺失或不被接受（没配 / 配错）。等多久都不会好。 */
	| "credentials"
	/** 限流（429）。等退避后可能恢复。 */
	| "rate_limited"
	/** 配额/账单耗尽（402、insufficient_quota、billing）。等不回来。 */
	| "quota_exhausted"
	/** 网络/代理/DNS/连接这一层断了。和模型无关。 */
	| "network"
	/** 模型真的回了，但内容被合规/安全策略挡下。 */
	| "content_blocked"
	/** 兜底：结构化证据和文案都没命中。 */
	| "unknown";

/** 这一跳该拿它怎么办。 */
export type UpstreamFailureVerdict =
	/** 候选本身坏了：换一个候选重试。 */
	| "switch_candidate"
	/** 和模型无关的临时故障：等退避后重试同一候选，换候选没意义。 */
	| "retry_same"
	/** 确定性的、等也等不回来的：别重试，交给人/上层处理。 */
	| "do_not_retry";

export interface UpstreamFailureClassification {
	category: UpstreamFailureCategory;
	/** 处置建议。平台侧据此分流（本包不实现退避策略）。 */
	verdict: UpstreamFailureVerdict;
	/** 是否值得再跑一次（换候选或等退避都算）。 */
	retryable: boolean;
	/** 是否应该**换候选**重试。这是平台最关心的那一位。 */
	retryWithAnotherCandidate: boolean;
	/** 判定依据来自哪里：结构化证据 / 文案 / 无。 */
	basis: "structured" | "text" | "none";
	/** 人读的一句话理由，带上命中的证据。 */
	reason: string;
	/** 命中的结构化证据（可序列化），供平台侧排障。 */
	evidence: string[];
}

/** 传输层观察到的一条事实（由 undici 诊断通道捕获）。 */
export interface TransportObservation {
	kind: "response" | "error";
	/** 请求 origin，如 https://opencode.ai（用来只认 provider 那一次请求）。 */
	origin?: string;
	statusCode?: number;
	errorCode?: string;
	errorName?: string;
	message?: string;
}

/** pi-ai 结构化诊断里带的结构化错误信息。 */
export interface FailureDiagnosticError {
	name?: string;
	code?: string | number;
	message?: string;
}

/** pi-ai 结构化诊断（`AssistantMessage.diagnostics` 的结构子集）。 */
export interface FailureDiagnostic {
	type?: string;
	error?: FailureDiagnosticError;
	details?: Record<string, unknown>;
}

/** 分类的输入。全部字段都是"上游真的返回了什么"，没有猜测。 */
export interface FailureEvidence {
	/** 上游目录里有没有 provider/model（`getModel` 结果）。 */
	modelExists: boolean;
	provider: string;
	model: string;
	/** provider 配没配凭证（`hasConfiguredAuth`）。 */
	authConfigured: boolean;
	/** assistant 消息的标准化停止原因。 */
	stopReason?: string;
	/** provider 原生停止原因（`rawStopReason`）。 */
	rawStopReason?: string;
	/** pi-ai 结构化诊断。 */
	diagnostics?: readonly FailureDiagnostic[];
	/** 传输层结构化观察（undici 诊断通道捕获）。 */
	transport?: readonly TransportObservation[];
	/** 抛出的异常的结构化字段（name/code/status）。 */
	thrown?: FailureDiagnosticError & { status?: number };
	/** 错误文案。**只作最后的兜底**，不单独决定类别。 */
	errorMessage?: string;
}

/* ============================ 结构化信号表 ============================ */

/** 传输/网络层错误码：代理断、DNS 失败、连接被拒、超时、连接被重置。 */
const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
	"ENOTFOUND",
	"EAI_AGAIN",
	"ECONNREFUSED",
	"ECONNRESET",
	"ECONNABORTED",
	"ETIMEDOUT",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"EPIPE",
	"EPROTO",
	"ERR_SOCKET_CONNECTION_TIMEOUT",
	"ERR_TLS_CERT_ALTNAME_INVALID",
	"ERR_SSL_WRONG_VERSION_NUMBER",
]);

/** provider 原生停止原因里表示"内容被合规/安全策略挡下"的那些。 */
const SAFETY_STOP_REASONS: ReadonlySet<string> = new Set([
	"refusal",
	"content_filter",
	"sensitive",
	"safety",
	"recitation",
	"blocklist",
	"prohibited_content",
	"spii",
	"image_safety",
	"model_armor",
	"content_blocked",
	"blocked",
]);

function normalizeKey(value: string): string {
	return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function normalizeCode(code: string | number | undefined): string {
	return code === undefined ? "" : String(code).trim().toUpperCase();
}

function isNetworkCode(code: string | number | undefined): boolean {
	const c = normalizeCode(code);
	if (!c) return false;
	return NETWORK_ERROR_CODES.has(c) || c.startsWith("UND_ERR_");
}

/** HTTP 状态码 → 类别。没把握的状态码返回 undefined，交给下一层。 */
function categoryFromHttpStatus(
	status: number,
): { category: UpstreamFailureCategory; reason: string } | undefined {
	if (status === 401 || status === 407) {
		return { category: "credentials", reason: `HTTP ${status}：凭据缺失或不被接受` };
	}
	if (status === 403) {
		return { category: "credentials", reason: `HTTP ${status}：请求被拒（权限/凭据）` };
	}
	if (status === 402) {
		return { category: "quota_exhausted", reason: `HTTP ${status}：配额/账单耗尽` };
	}
	if (status === 429) {
		return { category: "rate_limited", reason: `HTTP ${status}：限流` };
	}
	if (status === 408) {
		return { category: "network", reason: `HTTP ${status}：请求超时` };
	}
	if (status >= 500 && status <= 599) {
		return { category: "network", reason: `HTTP ${status}：上游服务端临时故障` };
	}
	return undefined;
}

/** 类别 → 处置。集中在一处，避免判定和处置分散后互相矛盾。 */
function verdictFor(category: UpstreamFailureCategory): {
	verdict: UpstreamFailureVerdict;
	retryable: boolean;
	retryWithAnotherCandidate: boolean;
} {
	switch (category) {
		case "model_not_found":
			return { verdict: "switch_candidate", retryable: true, retryWithAnotherCandidate: true };
		case "rate_limited":
			return { verdict: "retry_same", retryable: true, retryWithAnotherCandidate: false };
		case "network":
			return { verdict: "retry_same", retryable: true, retryWithAnotherCandidate: false };
		case "credentials":
		case "quota_exhausted":
		case "content_blocked":
		case "unknown":
			return { verdict: "do_not_retry", retryable: false, retryWithAnotherCandidate: false };
	}
}

/* ============================ 文案兜底（最后一道） ============================ */

/**
 * 文案兜底。**只在没有结构化证据时用**，结果会标 `basis: "text"`。
 *
 * 顺序有讲究：先判"配额/账单耗尽"再判"限流"，因为 "usage limit reached"
 * 既像限流又像耗尽，而耗尽等不回来。宁可少重试，不要白烧候选池。
 */
const TEXT_PATTERNS: readonly { category: UpstreamFailureCategory; pattern: RegExp }[] = [
	{
		category: "quota_exhausted",
		pattern: /insufficient_quota|out of budget|quota exceeded|billing|usage limit reached|available balance|GoUsageLimitError|FreeUsageLimitError/i,
	},
	{
		category: "credentials",
		pattern: /no api key|api key not found|invalid api key|incorrect api key|unauthorized|authentication (failed|error)|invalid_request_error.*key|\b401\b|\b403\b/i,
	},
	{
		category: "model_not_found",
		pattern: /model not found|no such model|does not exist|unknown model|模型不可用|未知 profileId/i,
	},
	{
		category: "content_blocked",
		pattern: /content_filter|refus(ed|al)|safety|blocked by|敏感|合规/i,
	},
	{
		category: "rate_limited",
		pattern: /\b429\b|rate.?limit|too many requests|overloaded/i,
	},
	{
		category: "network",
		pattern: /connection error|fetch failed|getaddrinfo|econnrefused|enotfound|eai_again|etimedout|socket hang up|other side closed|timed? ?out|network.?error|连接被拒|连不上/i,
	},
];

function isXaiProvider(provider: string): boolean {
	return provider.trim().toLowerCase() === "xai" || provider.trim().toLowerCase() === "xai-auth";
}

function hasXaiCreditMessage(message: string | undefined): boolean {
	return !!message && /run out of credits|need a Grok subscription/i.test(message);
}

function categoryFromText(errorMessage: string): UpstreamFailureCategory | undefined {
	for (const { category, pattern } of TEXT_PATTERNS) {
		if (pattern.test(errorMessage)) return category;
	}
	return undefined;
}

/* ================================ 主函数 ================================ */

/**
 * 把结构化证据（其次才是文案）归到一类，并给出"该不该换候选重试"。
 *
 * 判定优先级（从强到弱）：
 *  1. 模型存在性 / 凭据配置（pre-flight，结构化，最确定）；
 *  2. HTTP 状态码（undici 真实 statusCode / 诊断里的 status / 异常上的 status）；
 *  3. provider 原生停止原因 / 诊断里的安全类型（内容合规）；
 *  4. 传输层错误码（undici / 异常 code）；
 *  5. 文案兜底；
 *  6. `unknown`。
 */
export function classifyUpstreamFailure(evidence: FailureEvidence): UpstreamFailureClassification {
	const structured: string[] = [];

	// 1) pre-flight：模型不存在 / 凭据没配。这两条最确定，优先。
	if (!evidence.modelExists) {
		structured.push(`getModel(${evidence.provider}/${evidence.model})=undefined`);
		return finish("model_not_found", "structured", structured, `${evidence.provider}/${evidence.model} 不在上游目录里`);
	}
	structured.push(`getModel(${evidence.provider}/${evidence.model})=found`);

	if (!evidence.authConfigured) {
		structured.push(`hasConfiguredAuth(${evidence.provider})=false`);
		return finish("credentials", "structured", structured, `${evidence.provider} 没有配凭证`);
	}
	structured.push(`hasConfiguredAuth(${evidence.provider})=true`);

	// 2) 收集结构化状态码：传输层 response > 诊断 details.status > 异常 status。
	const statusHits: { status: number; via: string }[] = [];
	for (const obs of evidence.transport ?? []) {
		if (obs.kind === "response" && typeof obs.statusCode === "number") {
			statusHits.push({ status: obs.statusCode, via: `undici:headers status=${obs.statusCode}` });
		}
	}
	for (const diag of evidence.diagnostics ?? []) {
		const status =
			typeof diag.error?.code === "number"
				? diag.error.code
				: numericDetail(diag.details, ["status", "statusCode", "httpStatus"]);
		if (typeof status === "number") statusHits.push({ status, via: `diagnostic ${diag.type ?? "?"} status=${status}` });
	}
	if (typeof evidence.thrown?.status === "number") {
		statusHits.push({ status: evidence.thrown.status, via: `thrown.status=${evidence.thrown.status}` });
	}
	if (typeof evidence.thrown?.code === "number") {
		statusHits.push({ status: evidence.thrown.code, via: `thrown.code=${evidence.thrown.code}` });
	}

	// 取最后一个"出错"的状态码（重试之后最后一次才是最终结果）。2xx 不是错。
	const errorStatus = [...statusHits].reverse().find((h) => h.status >= 400);
	if (errorStatus) {
		if (errorStatus.status === 403 && isXaiProvider(evidence.provider) && hasXaiCreditMessage(evidence.errorMessage)) {
			structured.push(errorStatus.via);
			return finish("quota_exhausted", "structured", structured, "xAI HTTP 403：额度或订阅不足");
		}
		const mapped = categoryFromHttpStatus(errorStatus.status);
		if (mapped) {
			structured.push(errorStatus.via);
			return finish(mapped.category, "structured", structured, mapped.reason);
		}
		// 状态码存在但不在已知映射里 —— 记下来，但不硬塞。
		structured.push(`${errorStatus.via}（未映射）`);
	}

	// 3) 内容合规：模型真的回了，但被 provider 的安全策略挡下。
	const rawStop = evidence.rawStopReason ? normalizeKey(evidence.rawStopReason) : "";
	if (rawStop && SAFETY_STOP_REASONS.has(rawStop)) {
		structured.push(`rawStopReason=${evidence.rawStopReason}`);
		return finish("content_blocked", "structured", structured, `provider 以 ${evidence.rawStopReason} 拦下了内容`);
	}
	const safetyDiag = (evidence.diagnostics ?? []).find((d) =>
		d.type ? /safety|content_filter|refusal|blocked/i.test(d.type) : false,
	);
	if (safetyDiag) {
		structured.push(`diagnostic type=${safetyDiag.type}`);
		return finish("content_blocked", "structured", structured, `诊断记录显示内容被拦（${safetyDiag.type}）`);
	}

	// 4) 传输层错误码：代理/DNS/连接。和模型无关。
	const transportError = [...(evidence.transport ?? [])]
		.reverse()
		.find((obs) => obs.kind === "error" && obs.errorCode);
	if (transportError && isNetworkCode(transportError.errorCode)) {
		structured.push(`undici:request:error code=${transportError.errorCode}`);
		return finish("network", "structured", structured, `传输层错误 ${transportError.errorCode}（与模型无关）`);
	}
	if (isNetworkCode(evidence.thrown?.code)) {
		structured.push(`thrown.code=${evidence.thrown?.code}`);
		return finish("network", "structured", structured, `传输层错误 ${evidence.thrown?.code}（与模型无关）`);
	}
	const diagNetwork = (evidence.diagnostics ?? []).find((d) => {
		if (d.type && /transport|connection|network/i.test(d.type)) return true;
		return isNetworkCode(d.error?.code);
	});
	if (diagNetwork) {
		const code = diagNetwork.error?.code ?? diagNetwork.type;
		structured.push(`diagnostic ${diagNetwork.type ?? "?"} code=${code}`);
		return finish("network", "structured", structured, `传输层/网络诊断（${code}）`);
	}

	// 5) 文案兜底。到这一步已经没有结构化证据了，如实标 basis=text。
	if (evidence.errorMessage) {
		if (isXaiProvider(evidence.provider) && /\b403\b/.test(evidence.errorMessage) && hasXaiCreditMessage(evidence.errorMessage)) {
			return finish("quota_exhausted", "text", structured, "由 xAI 403 额度/订阅错误文案推断");
		}
		const category = categoryFromText(evidence.errorMessage);
		if (category) {
			return {
				...verdictFor(category),
				category,
				basis: "text",
				reason: `由错误文案推断（上游改了措辞就会失效）：${truncate(evidence.errorMessage)}`,
				evidence: structured,
			};
		}
	}

	// 6) 兜底：不硬塞，也不一律重试。
	return finish(
		"unknown",
		"none",
		structured,
		evidence.errorMessage ? `无法归类：${truncate(evidence.errorMessage)}` : "无法归类：没有可用的失败证据",
	);
}

function finish(
	category: UpstreamFailureCategory,
	basis: UpstreamFailureClassification["basis"],
	evidence: string[],
	reason: string,
): UpstreamFailureClassification {
	return { ...verdictFor(category), category, basis, reason, evidence };
}

function numericDetail(details: Record<string, unknown> | undefined, keys: string[]): number | undefined {
	if (!details) return undefined;
	for (const key of keys) {
		const value = details[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return undefined;
}

function truncate(text: string, max = 160): string {
	const one = text.replace(/\s+/g, " ").trim();
	return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/* ====================== 把分类挂在抛出的异常上 ====================== */

/**
 * 抛出的异常也要能把分类带出去（模型不存在这一条在 startRun 里就 throw 了，
 * 拿不到 outcome）。用 Symbol 挂，不污染异常的 JSON/日志。
 */
const FAILURE_BRAND = Symbol.for("coagent.upstreamFailure");

export function withFailure<E extends Error>(
	error: E,
	failure: UpstreamFailureClassification,
): E {
	(error as unknown as Record<symbol, unknown>)[FAILURE_BRAND] = failure;
	return error;
}

export function failureOf(error: unknown): UpstreamFailureClassification | undefined {
	if (!error || typeof error !== "object") return undefined;
	const value = (error as Record<symbol, unknown>)[FAILURE_BRAND];
	return value as UpstreamFailureClassification | undefined;
}
