/**
 * 结束判定与失败诊断投影。**纯函数、无 IO、无副作用。**
 *
 * 为什么单独抽出来：`startRun` 里原先的结束判定是
 *
 *   platform_unreachable → structured_submit → upstream_failure → no_structured_result
 *
 * 一条三元链，而 `upstreamFailure` 的分类又挂在 `endedBy === "upstream_failure"` 上。
 * 于是**平台一抖就把上游证据一起吞了**：assistant 明明报了 `insufficient_quota`，
 * 只要期间有一次平台工具调用连不上，`endedBy` 变成 `platform_unreachable`，
 * 分类字段就整个不出现，调度器看到的是一次"平台故障"，换个时候重试同一候选，
 * 再撞一次配额。这两件事本来没有因果关系，只是被一条 if 绑在了一起。
 *
 * 所以这里把两件事拆开：
 *
 *  - **结束判定**（`selectEndedBy`）：语义一字不改，仍是原来的优先级。平台不可达
 *    优先于其它判断——没做结构化提交可能只是因为工具根本调不通，那时报
 *    `no_structured_result` 会让调度器拒绝重试一个其实该重试的情况。
 *  - **诊断投影**（`projectFailureOutcome`）：上游分类只看**有没有真实上游证据**
 *    （assistant 消息 `stopReason:"error"` 或 `prompt()` 抛出），与平台是否可达无关。
 *    平台故障只写 `runtimeDiagnostics.platform`，绝不凭空造出配额/限流一类的东西。
 *
 * 诊断里的文案必须已经脱敏：本模块不实现脱敏规则，只要求调用方给出 `redact`
 * （生产传共享传输的清理实现）。**没给 `redact` 就不带文案**——宁可少一句诊断，
 * 也不把可能带 URL userinfo / 代理地址 / token 的原文发出去。截断放在脱敏之后，
 * 否则截断点可能正好切在凭据中间，后半段绕过规则活下来。
 */

import { createRequire } from "node:module";

import type { UpstreamFailureClassification } from "./failure-classify.js";

/** 与 `AgentRunOutcome["endedBy"]` 同一组值；单独声明以免本模块依赖 runtime。 */
export type RunEndedBy =
	| "structured_submit"
	| "no_structured_result"
	| "upstream_failure"
	| "platform_unreachable";

/** 平台侧诊断：只报「连不上平台自己」这一条可判定事实。 */
export interface RuntimePlatformDiagnostic {
	code: "platform_unreachable";
}

/**
 * 上游诊断：类别来自 `classifyUpstreamFailure`，`message` 是**已脱敏且有界**的一句证据。
 * `category` 故意用 string：平台侧按字符串消费，不跟着本包的枚举版本漂移。
 */
export interface RuntimeUpstreamDiagnostic {
	category: string;
	message?: string;
}

export interface RuntimeDiagnostics {
	platform?: RuntimePlatformDiagnostic;
	upstream?: RuntimeUpstreamDiagnostic;
}

/** 脱敏函数：输入原文，输出可外发的文本。生产传共享传输的 `captureValue`。 */
export type RedactText = (text: string) => string;

/** 诊断文案上限。排障只需要一句，整段上游响应体不该进平台的状态文件。 */
export const RUNTIME_DIAGNOSTIC_MESSAGE_MAX_CHARS = 400;

/** 共享传输（.mjs）：脱敏规则的唯一实现，本模块只按名字调用，不复制一份。 */
const TRANSPORT_MODULE = "../../../scripts/langfuse-transport.mjs";
/** 送进脱敏的原文上限：诊断只要一句，但不先截断（截断点落在凭据中间会漏后半段）。 */
const REDACTION_INPUT_MAX_CHARS = RUNTIME_DIAGNOSTIC_MESSAGE_MAX_CHARS * 8;

interface CaptureValueModule {
	captureValue(
		value: unknown,
		config: Record<string, unknown>,
	): { value?: string; missing: boolean; truncated: boolean };
}

let cachedRedactor: RedactText | undefined;

/**
 * 生产脱敏器：复用共享传输的 `captureValue`（先脱敏再截断，规则含 URL userinfo、
 * 代理地址、token/密钥形状与 `*Token` 字段名）。
 *
 * 拿不到模块或它抛错时返回 `undefined`：调用方据此**不带文案**。
 * 不退回原文——诊断是可选增益，泄露是不可逆的。
 */
export function runtimeDiagnosticRedactor(): RedactText | undefined {
	if (cachedRedactor) return cachedRedactor;
	let capture: CaptureValueModule["captureValue"];
	try {
		// 用 require 解析同一个文件路径：本模块是 ESM，`createRequire` 让
		// 「模块不在 / 加载失败」变成可捕获的异常，而不是顶层 import 直接炸掉 runtime。
		const loaded = createRequire(import.meta.url)(TRANSPORT_MODULE) as Partial<CaptureValueModule>;
		if (typeof loaded?.captureValue !== "function") return undefined;
		capture = loaded.captureValue;
	} catch {
		return undefined;
	}
	const config = {
		enabled: true,
		captureContent: true,
		maxContentChars: REDACTION_INPUT_MAX_CHARS,
	};
	cachedRedactor = (text: string) => {
		const captured = capture(text, config);
		return typeof captured?.value === "string" ? captured.value : "";
	};
	return cachedRedactor;
}

export interface FailureOutcomeInput {
	/** 平台工具调用是否出现过连不上（`PlatformClient.sawUnreachable`）。 */
	platformUnreachable: boolean;
	/** 本程是否已结构化提交。 */
	submitted: boolean;
	/** 给人看的失败文案（assistant errorMessage 或 prompt() 抛出的 message）。 */
	failureMessage?: string;
	/**
	 * 上游分类。**调用方只在有真实上游证据时提供**：assistant 消息
	 * `stopReason:"error"`，或 `prompt()` 抛出。平台工具 error 不是模型错误，
	 * 不得走到这里。
	 */
	upstreamFailure?: UpstreamFailureClassification;
	/** 原始失败文案；本模块负责脱敏与截断后才放进诊断。 */
	upstreamMessage?: string;
	/** 脱敏实现。缺省时诊断里不带文案。 */
	redact?: RedactText;
}

export interface FailureOutcomeProjection {
	endedBy: RunEndedBy;
	/** 有真实上游证据时原样透出，**即使平台不可达**。 */
	upstreamFailure?: UpstreamFailureClassification;
	/** 两者都没有时整个字段缺席（成功 / 纯无结果）。 */
	runtimeDiagnostics?: RuntimeDiagnostics;
}

/**
 * 结束判定。优先级与历史上那条三元链完全一致：
 * 平台不可达 > 结构化提交 > 上游失败 > 跑完没提交。
 */
export function selectEndedBy(input: {
	platformUnreachable: boolean;
	submitted: boolean;
	failureMessage?: string;
}): RunEndedBy {
	if (input.platformUnreachable) return "platform_unreachable";
	if (input.submitted) return "structured_submit";
	if (input.failureMessage) return "upstream_failure";
	return "no_structured_result";
}

/** 脱敏 → 压成一行 → 有界截断。任何一步拿不到内容就返回 undefined。 */
function diagnosticMessage(
	raw: string | undefined,
	redact: RedactText | undefined,
): string | undefined {
	if (typeof raw !== "string" || raw.trim() === "") return undefined;
	if (!redact) return undefined;
	let text: string;
	try {
		text = redact(raw);
	} catch {
		// 脱敏失败等于「不知道里面有什么」：不带文案，绝不退回原文。
		return undefined;
	}
	if (typeof text !== "string") return undefined;
	const one = text.replace(/\s+/g, " ").trim();
	if (!one) return undefined;
	return one.length > RUNTIME_DIAGNOSTIC_MESSAGE_MAX_CHARS
		? `${one.slice(0, RUNTIME_DIAGNOSTIC_MESSAGE_MAX_CHARS - 1)}…`
		: one;
}

/**
 * 生产纯接缝：runtime 用它的结果填 `endedBy` / `upstreamFailure` / `runtimeDiagnostics`。
 *
 * 不变的部分：`endedBy` 的选择与调度语义；`structured_submit`、无结果与执行者提醒
 * 的行为都只看原有输入。
 * 变的部分：`upstreamFailure` 不再被 `endedBy` 遮住。
 */
export function projectFailureOutcome(input: FailureOutcomeInput): FailureOutcomeProjection {
	const endedBy = selectEndedBy(input);
	const projection: FailureOutcomeProjection = { endedBy };

	const diagnostics: RuntimeDiagnostics = {};
	if (input.platformUnreachable) diagnostics.platform = { code: "platform_unreachable" };

	if (input.upstreamFailure) {
		projection.upstreamFailure = input.upstreamFailure;
		const upstream: RuntimeUpstreamDiagnostic = { category: input.upstreamFailure.category };
		const message = diagnosticMessage(input.upstreamMessage, input.redact);
		if (message) upstream.message = message;
		diagnostics.upstream = upstream;
	}

	if (diagnostics.platform || diagnostics.upstream) projection.runtimeDiagnostics = diagnostics;
	return projection;
}
