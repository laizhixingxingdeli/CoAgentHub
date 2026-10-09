/**
 * PiRuntime —— RuntimePort 的 pi 实现。
 *
 * 平台侧看到的只有 AgentRunSpec / AgentRunOutcome。Pi 的类型、模型名、Provider
 * 都不越过这个文件。接第二个 runtime 就是另写一个同签名的 startRun。
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { createCoagentExtension } from "./extension.js";
import type { CoagentBriefInjected } from "./extension.js";
import { installHttpDispatcher } from "./http.js";
import { systemPrompt, toolAllowlist } from "./roles.js";
import type { Role } from "./roles.js";
import { PlatformClient } from "./platform-client.js";
import { PROFILE_TABLE_REVISION, resolveProfile } from "./profiles.js";
import {
	classifyUpstreamFailure,
	withFailure,
} from "./failure-classify.js";
import type { FailureDiagnostic, UpstreamFailureClassification } from "./failure-classify.js";
import { observationsForOrigin, originOf, recordTransport } from "./transport-evidence.js";
import { appendRateLimitSummary, startRateLimitProbe } from "./rate-limit-probe.js";
import { queryUsage } from "./usage.js";
import type { UsageRow } from "./usage.js";
import { registerPendingProviderExtensions, resolveProviderExtensionPaths } from "./provider-extensions.js";

/**
 * 平台传下来的 spec。字段刻意与平台的 AgentRunSpec 对齐——
 * `profile` 里只有不透明的 profileId，provider/model 由本包解析。
 */
export interface AgentRunSpec {
	role: Role;
	attemptId: string;
	missionId?: string;
	workItemId?: string;
	/** Mission worktree */
	cwd: string;
	profile: {
		endpoint?: string;
		profileId: string;
		reasoning?: string;
		/** 平台带下来的不透明身份键值。资源池里选模型建的候选靠它。 */
		facts?: { key: string; value: string }[];
	};
	instruction: string;
	/** 平台发的 run token + 端点：工具调用的身份来源。 */
	endpoint: { baseUrl: string; token: string };
	/** 续跑：上一次的会话文件路径。 */
	resumeRef?: string;
	sessionDir?: string;
	stream?: boolean;
}

export interface AgentRunOutcome {
	attemptId: string;
	/**
	 * 平台的 AttemptEndReason。
	 *
	 * `upstream_failure` 与 `no_structured_result` 必须分开：前者（限流/配额/
	 * 连不上）允许换候选重试，后者（跑完一轮却没提交）不允许——换一个再赌
	 * 一次只会烧配额，不产生新信息。混成一个结束码，调度器就没法分流。
	 */
	endedBy:
		| "structured_submit"
		| "no_structured_result"
		| "upstream_failure"
		| "platform_unreachable";
	submittedVia?: string;
	failureMessage?: string;
	/**
	 * 上游失败的结构化分类（本包新增，纯增字段）。
	 *
	 * 说清楚是哪一类失败、该不该换候选重试。平台侧据此分流：
	 * 该等的（限流/网络）、该换的（模型不存在）、该喊人的（凭据/合规）处置互相
	 * 矛盾，混在一个 `upstream_failure` 里就只能一律换候选去赌。
	 *
	 * 只在 `endedBy === "upstream_failure"` 时出现；旧调用方忽略它即可。
	 */
	upstreamFailure?: UpstreamFailureClassification;
	resumeRef?: string;
	/** 原始输出尾部，给平台的 Timeline 第三层。 */
	output?: string;
	/** 调过的工具名序列，给平台的 Timeline 第二层。 */
	toolNames?: string[];
	/**
	 * 这一跳**实际**解析到的身份（S13.3）。
	 *
	 * 平台侧只有不透明的 profileId；具体跑的是哪家、哪个模型，只有这一层知道。
	 * 报回去冻在 Attempt 上，改了 profiles.ts 之后历史归因才不会静默错位。
	 */
	resolvedProfile?: {
		revision: string;
		resolved: { key: string; value: string }[];
	};
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
		cost: number;
		quality: "reported";
	};
	toolCalls: number;
	/**
	 * 仅 `role === "query"` 时出现。
	 * - answered：跑完且无上游失败（endedBy 通常仍是 no_structured_result，
	 *   不得伪装 structured_submit——query 没有终端 coagent_* 可提交）。
	 * - failed：真实 failureMessage / upstream_failure。
	 */
	queryOutcome?: "answered" | "failed";
	/**
	 * Attempt 级上下文采集摘要 v1。仅终态出现一次。
	 * 可选：旧平台忽略该字段仍能完成。不含路径、正文、盐或凭据。
	 */
	contextMetrics?: AttemptContextMetricsV1;
}

/**
 * 纯合同：query 不装配 PlatformClient / CoAgent extension / Mission brief；
 * Mission 角色（coordinator / executor / solo / independent_reviewer）仍然装配。
 * solo 与 independent_reviewer 在 extension 内跳过 brief 拉取，但 extension 本身仍注册。
 */
export function bindsPlatform(role: Role): boolean {
	return role !== "query";
}

/** 纯合同：把 query 跑次映射成 queryOutcome；非 query 返回 undefined。 */
export async function appendXaiQuotaReset(input: {
	provider: string;
	classification: UpstreamFailureClassification | undefined;
	failureMessage: string;
	query: () => Promise<UsageRow[]>;
}): Promise<string> {
	if (
		(input.provider !== "xai" && input.provider !== "xai-auth") ||
		input.classification?.category !== "quota_exhausted"
	) return input.failureMessage;
	const explicit403QuotaText = input.classification.basis === "text" &&
		/\b403\b/.test(input.failureMessage) && /credits|subscription/i.test(input.failureMessage);
	const structuredStatuses = input.classification.basis === "structured"
		? input.classification.evidence.flatMap((item) => [...item.matchAll(/(?:status=|status )([0-9]{3})\b/g)].map((match) => Number(match[1])))
		: [];
	const structured403 = input.classification.basis === "structured" &&
		structuredStatuses.length > 0 && structuredStatuses.at(-1) === 403;
	if (!explicit403QuotaText && !structured403) return input.failureMessage;
	try {
		const rows = await input.query();
		// usage 汇总可能混入其他 provider 的行（如 tenrouter 的回退行），
		// 只认 xai 自己的重置时间，否则会把别家的窗口当成本次失败的重置点。
		const resetAt = rows.find((row) => row.provider === "xai" && row.status === "ok" && row.resetAt && Number.isFinite(Date.parse(row.resetAt)))?.resetAt;
		return resetAt ? `${input.failureMessage} (quota resets at ${new Date(resetAt).toISOString()})` : input.failureMessage;
	} catch {
		return input.failureMessage;
	}
}

export function mapQueryOutcome(input: {
	role: Role;
	endedBy: AgentRunOutcome["endedBy"];
	failureMessage?: string;
}): AgentRunOutcome["queryOutcome"] {
	if (input.role !== "query") return undefined;
	if (input.endedBy === "upstream_failure" || input.failureMessage) return "failed";
	return "answered";
}

/** 结构化事件行的前缀。与平台侧 SpawnRuntime 里的常量必须一致。 */
const EVENT_PREFIX = "__COAGENT_EVENT__ ";

/**
 * 执行者没交结构化结果就结束时的中文提醒（同一会话只发一次）。
 * 提醒里只说动作、不重复长篇思考：已完成就提交、卡住就 report_blocked、没做完直接接着做。
 */
const EXECUTOR_NO_SUBMIT_REMINDER =
	"上一条回复已经结束，但本程尚未终结提交。任务已完成就调用 coagent_submit_execution_result 提交；无法继续就调用 coagent_report_blocked 并写明原因；还没做完就直接接着做，不要重复长篇思考。";

/**
 * 是否要给执行者同会话提醒一次：非 executor，或已提交/上游失败/平台不可达都不再提醒。
 * 单对象参数，纯函数；stopReason=length 时前缀「上一条回复超过输出上限被截断了。」。
 */
export function executorReminder(input: {
	role: Role;
	submitted: boolean;
	hasFailure: boolean;
	unreachable: boolean;
	stopReason?: string;
}): string | undefined {
	if (input.role !== "executor") return undefined;
	if (input.submitted || input.hasFailure || input.unreachable) return undefined;
	const base = EXECUTOR_NO_SUBMIT_REMINDER;
	if (input.stopReason === "length") {
		return "上一条回复超过输出上限被截断了。" + base;
	}
	return base;
}

/**
 * 跨 runtime 的命令活动分类（BUDGET-S4）。
 *
 * Hub 只认 activityClass === "command" 计次；adapter 允许认识自己的工具名，
 * 但不得让 Hub 硬编码 bash。capability 声明本 attempt 每条 tool.started 都带分类。
 */
export type ActivityClass = "command" | "other";

/** bash / powershell 为进程命令；其余（read/grep/coagent_* 等）一律 other。 */
export function classifyActivity(name: string): ActivityClass {
	return name === "bash" || name === "powershell" ? "command" : "other";
}

/** 订阅就绪后、任何工具循环之前同步发射一次。 */
export function commandActivityCapabilitiesEvent(): {
	t: "runtime.capabilities";
	commandActivityClassification: "v1";
} {
	return { t: "runtime.capabilities", commandActivityClassification: "v1" };
}

/** tool_execution_start → tool.started，附带 activityClass。 */
export function toolStartedEvent(input: {
	name: string;
	callId: string;
	detail?: string;
}): {
	t: "tool.started";
	name: string;
	callId: string;
	detail?: string;
	activityClass: ActivityClass;
} {
	return {
		t: "tool.started",
		name: input.name,
		callId: input.callId,
		detail: input.detail,
		activityClass: classifyActivity(input.name),
	};
}

/** pi 的事件里 callId 的字段名在不同版本间有出入，挨个试。 */
function callIdOf(event: unknown): string {
	const e = event as { callId?: string; toolCallId?: string; id?: string };
	return e.callId ?? e.toolCallId ?? e.id ?? "?";
}

/**
 * 这次工具调用**具体在干什么**，压成一行。
 *
 * 平台侧只记工具名的话，一跳挂住之后留下来的尾巴是一串 `bash` —— 看得出它卡在
 * 某次 bash 上，看不出卡在**哪条命令**上，而那是唯一有用的那半。实测踩过一次：
 * 执行者干到一半静默五分钟被杀，能找回来的只有工具名，根因就查不下去了。
 *
 * 参数的字段名同样在版本间有出入，所以挨个试常见的几个，取第一个是非空字符串的。
 * 一个都取不到就返回 undefined —— 宁可没有，也不要编一个。
 */
function detailOf(event: unknown): string | undefined {
	const holder = event as { args?: unknown; input?: unknown; parameters?: unknown };
	const bag = (holder.args ?? holder.input ?? holder.parameters) as
		| Record<string, unknown>
		| undefined;
	if (!bag || typeof bag !== "object") return undefined;
	for (const key of ["command", "cmd", "filePath", "path", "pattern", "file"]) {
		const value = bag[key];
		if (typeof value === "string" && value.trim()) {
			const one = value.replace(/\s+/g, " ").trim();
			// 截断：这一行是给人扫一眼的，不是日志正文。整条命令仍在 agent
			// 自己的输出里。
			return one.length > 120 ? one.slice(0, 117) + "…" : one;
		}
	}
	return undefined;
}

const CONTEXT_METRICS_TOOL_KINDS = ["read", "grep", "find", "ls", "bash"] as const;
export type ContextMetricsToolKind = (typeof CONTEXT_METRICS_TOOL_KINDS)[number];
const CONTEXT_METRICS_TOOL_KIND_SET: ReadonlySet<string> = new Set(CONTEXT_METRICS_TOOL_KINDS);

const CONTEXT_METRICS_BRIEF_SOURCES = [
	"project_rules",
	"environment_notes",
	"contract",
	"plan",
	"final_review",
	"work_order",
] as const;
export type ContextMetricsBriefSource = (typeof CONTEXT_METRICS_BRIEF_SOURCES)[number];
const CONTEXT_METRICS_BRIEF_SOURCE_SET: ReadonlySet<string> = new Set(CONTEXT_METRICS_BRIEF_SOURCES);

export type ContextMetricsCoverage = "complete" | "partial" | "unknown";

const CONTEXT_METRICS_MAX_READ_BUCKETS = 64;
const CONTEXT_METRICS_MAX_INT = 1_000_000_000;
const CONTEXT_METRICS_MAX_JSON_BYTES = 32 * 1024;

export interface AttemptContextMetricsV1 {
	version: 1;
	coverage: ContextMetricsCoverage;
	brief?: {
		renderedUtf8Bytes: number;
		sources: {
			source: ContextMetricsBriefSource;
			estimatedTokens?: number;
			truncated: boolean;
		}[];
	};
	tools?: { kind: ContextMetricsToolKind; calls: number; returnedUtf8Bytes: number }[];
	reads?: { pathDigest: string; contentDigest: string; repeats: number }[];
}

type PendingTool = { kind: ContextMetricsToolKind; path?: string };

function boundedNonNegativeInt(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > CONTEXT_METRICS_MAX_INT) {
		return undefined;
	}
	return value;
}

function addBounded(current: number, delta: number): { value: number; overflow: boolean } {
	if (!Number.isFinite(delta) || delta < 0) return { value: current, overflow: true };
	const next = current + delta;
	if (!Number.isSafeInteger(next) || next > CONTEXT_METRICS_MAX_INT) {
		return { value: CONTEXT_METRICS_MAX_INT, overflow: true };
	}
	return { value: next, overflow: false };
}

function metricsCallIdOf(event: unknown): string | undefined {
	const e = event as { callId?: string; toolCallId?: string; id?: string };
	const id = e.callId ?? e.toolCallId ?? e.id;
	return typeof id === "string" && id.length > 0 ? id : undefined;
}

function toolKindOf(name: unknown): ContextMetricsToolKind | undefined {
	return typeof name === "string" && CONTEXT_METRICS_TOOL_KIND_SET.has(name)
		? (name as ContextMetricsToolKind)
		: undefined;
}

function hashSaltedUtf8(salt: Buffer, ...parts: string[]): string {
	const hash = createHash("sha256");
	hash.update(salt);
	for (const part of parts) hash.update(part, "utf8");
	return hash.digest("hex");
}

function beginSaltedHash(salt: Buffer): ReturnType<typeof createHash> {
	const hash = createHash("sha256");
	hash.update(salt);
	return hash;
}

function copyBrief(brief: CoagentBriefInjected): AttemptContextMetricsV1["brief"] | undefined {
	const renderedUtf8Bytes = boundedNonNegativeInt(brief.renderedUtf8Bytes);
	if (renderedUtf8Bytes === undefined || !Array.isArray(brief.sources)) return undefined;
	if (brief.sources.length > CONTEXT_METRICS_BRIEF_SOURCES.length) return undefined;
	const sources: NonNullable<AttemptContextMetricsV1["brief"]>["sources"] = [];
	const seen = new Set<string>();
	for (const item of brief.sources) {
		if (!item || typeof item !== "object") return undefined;
		const source = item.source;
		if (typeof source !== "string" || !CONTEXT_METRICS_BRIEF_SOURCE_SET.has(source) || seen.has(source)) {
			return undefined;
		}
		if (typeof item.truncated !== "boolean") return undefined;
		seen.add(source);
		const entry: NonNullable<AttemptContextMetricsV1["brief"]>["sources"][number] = {
			source: source as ContextMetricsBriefSource,
			truncated: item.truncated,
		};
		if (Object.prototype.hasOwnProperty.call(item, "estimatedTokens")) {
			const tokens = boundedNonNegativeInt(item.estimatedTokens);
			if (tokens === undefined) return undefined;
			entry.estimatedTokens = tokens;
		}
		sources.push(entry);
	}
	return { renderedUtf8Bytes, sources };
}

function resultLooksTruncated(result: unknown): boolean {
	if (!result || typeof result !== "object") return false;
	const details = (result as { details?: unknown }).details;
	if (!details || typeof details !== "object") return false;
	const bag = details as { truncated?: unknown; truncation?: unknown };
	if (bag.truncated === true) return true;
	if (bag.truncation === true) return true;
	if (bag.truncation && typeof bag.truncation === "object") {
		return (bag.truncation as { truncated?: unknown }).truncated === true;
	}
	return false;
}

/** 只抽取 SDK result.content 里可见的 text；image / 未知形状不推断。即时计字节并可选流式喂 hash，不缓存正文。 */
function observeResultContent(
	result: unknown,
	onText?: (text: string) => void,
): { bytes: number; fullyText: boolean } | undefined {
	if (!result || typeof result !== "object") return undefined;
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return undefined;
	let bytes = 0;
	let fullyText = true;
	for (const part of content) {
		if (!part || typeof part !== "object") {
			fullyText = false;
			continue;
		}
		const block = part as { type?: unknown; text?: unknown };
		if (block.type === "text" && typeof block.text === "string") {
			bytes += Buffer.byteLength(block.text, "utf8");
			onText?.(block.text);
		} else {
			fullyText = false;
		}
	}
	return { bytes, fullyText };
}

function utf8JsonBytes(value: unknown): number | undefined {
	try {
		return Buffer.byteLength(JSON.stringify(value), "utf8");
	} catch {
		return undefined;
	}
}

export interface AttemptContextCollector {
	onBriefInjected(brief: CoagentBriefInjected | undefined): void;
	onToolExecutionStart(event: unknown): void;
	onToolExecutionEnd(event: unknown): void;
	finalize(): AttemptContextMetricsV1;
}

/**
 * 每个 Attempt 一份采集器：随机盐、按 toolCallId 配对 start/end、终态才序列化 V1。
 * 不额外保存工具正文。测试可注入 salt 以断言摘要。
 */
export function createAttemptContextCollector(options?: { salt?: Buffer }): AttemptContextCollector {
	const salt = options?.salt ?? randomBytes(32);
	let lastBrief: AttemptContextMetricsV1["brief"] | undefined;
	let actualBriefCount = 0;
	let degraded = false;
	const calls: Record<ContextMetricsToolKind, number> = {
		read: 0,
		grep: 0,
		find: 0,
		ls: 0,
		bash: 0,
	};
	const returnedUtf8Bytes: Record<ContextMetricsToolKind, number> = {
		read: 0,
		grep: 0,
		find: 0,
		ls: 0,
		bash: 0,
	};
	const pending = new Map<string, PendingTool>();
	const readBuckets: { pathDigest: string; contentDigest: string; repeats: number }[] = [];
	const readIndex = new Map<string, number>();

	const bumpDegraded = () => {
		degraded = true;
	};

	const addCalls = (kind: ContextMetricsToolKind) => {
		const next = addBounded(calls[kind], 1);
		calls[kind] = next.value;
		if (next.overflow) bumpDegraded();
	};

	const addBytes = (kind: ContextMetricsToolKind, bytes: number) => {
		const next = addBounded(returnedUtf8Bytes[kind], bytes);
		returnedUtf8Bytes[kind] = next.value;
		if (next.overflow) bumpDegraded();
	};

	return {
		onBriefInjected(brief) {
			if (brief === undefined) return;
			const copied = copyBrief(brief);
			if (!copied) {
				bumpDegraded();
				return;
			}
			actualBriefCount += 1;
			lastBrief = copied;
			if (actualBriefCount > 1) bumpDegraded();
		},
		onToolExecutionStart(event) {
			const kind = toolKindOf((event as { toolName?: unknown }).toolName);
			if (!kind) return;
			addCalls(kind);
			const id = metricsCallIdOf(event);
			if (!id) {
				bumpDegraded();
				return;
			}
			let path: string | undefined;
			if (kind === "read") {
				const args = (event as { args?: unknown }).args;
				const rawPath =
					args && typeof args === "object" ? (args as { path?: unknown }).path : undefined;
				path = typeof rawPath === "string" ? rawPath : undefined;
				if (path === undefined) bumpDegraded();
			}
			if (pending.has(id)) bumpDegraded();
			pending.set(id, { kind, path });
		},
		onToolExecutionEnd(event) {
			const id = metricsCallIdOf(event);
			if (!id) {
				bumpDegraded();
				return;
			}
			const started = pending.get(id);
			if (!started) return;
			pending.delete(id);
			const { kind, path } = started;
			const isError = (event as { isError?: unknown }).isError === true;
			const result = (event as { result?: unknown }).result;
			if (isError) {
				bumpDegraded();
				return;
			}
			if (resultLooksTruncated(result)) bumpDegraded();
			let observed: { bytes: number; fullyText: boolean } | undefined;
			let contentDigest: string | undefined;
			try {
				if (kind === "read" && typeof path === "string") {
					const hash = beginSaltedHash(salt);
					observed = observeResultContent(result, (text) => {
						hash.update(text, "utf8");
					});
					if (observed) contentDigest = hash.digest("hex");
				} else {
					observed = observeResultContent(result);
				}
			} catch {
				bumpDegraded();
				return;
			}
			if (!observed) {
				bumpDegraded();
				return;
			}
			if (!observed.fullyText) bumpDegraded();
			addBytes(kind, observed.bytes);
			if (kind !== "read") return;
			if (typeof path !== "string" || contentDigest === undefined) {
				bumpDegraded();
				return;
			}
			const pathDigest = hashSaltedUtf8(salt, path);
			const key = `${pathDigest}:${contentDigest}`;
			const existing = readIndex.get(key);
			if (existing !== undefined) {
				const bucket = readBuckets[existing]!;
				const next = addBounded(bucket.repeats, 1);
				bucket.repeats = next.value;
				if (next.overflow) bumpDegraded();
				return;
			}
			if (readBuckets.length >= CONTEXT_METRICS_MAX_READ_BUCKETS) {
				bumpDegraded();
				return;
			}
			readIndex.set(key, readBuckets.length);
			readBuckets.push({ pathDigest, contentDigest, repeats: 1 });
		},
		finalize(): AttemptContextMetricsV1 {
			if (pending.size > 0) bumpDegraded();
			const tools: NonNullable<AttemptContextMetricsV1["tools"]> = [];
			for (const kind of CONTEXT_METRICS_TOOL_KINDS) {
				if (calls[kind] > 0) {
					tools.push({
						kind,
						calls: calls[kind],
						returnedUtf8Bytes: returnedUtf8Bytes[kind],
					});
				}
			}
			const reads = readBuckets.map((bucket) => ({
				pathDigest: bucket.pathDigest,
				contentDigest: bucket.contentDigest,
				repeats: bucket.repeats,
			}));
			const hasBrief = lastBrief !== undefined;
			const hasTools = tools.length > 0;
			const hasReads = reads.length > 0;
			if (!hasBrief && !hasTools && !hasReads) {
				return { version: 1, coverage: "unknown" };
			}
			const coverage: ContextMetricsCoverage =
				!degraded && hasBrief ? "complete" : "partial";
			const metrics: AttemptContextMetricsV1 = { version: 1, coverage };
			if (hasBrief) metrics.brief = lastBrief;
			if (coverage === "complete" || hasTools || calls.read > 0) {
				metrics.tools = coverage === "complete" || hasTools ? tools : [];
				metrics.reads = coverage === "complete" || hasReads || calls.read > 0 ? reads : [];
			} else if (hasReads) {
				metrics.reads = reads;
			}
			if (coverage === "complete" && (metrics.brief === undefined || metrics.tools === undefined || metrics.reads === undefined)) {
				metrics.coverage = "partial";
			}
			const bytes = utf8JsonBytes(metrics);
			if (bytes === undefined || bytes > CONTEXT_METRICS_MAX_JSON_BYTES) {
				return { version: 1, coverage: "unknown" };
			}
			return metrics;
		},
	};
}

export async function startRun(spec: AgentRunSpec): Promise<AgentRunOutcome> {
	const sessionDir = spec.sessionDir ?? resolve(".coagent-runs/sessions");
	mkdirSync(sessionDir, { recursive: true });
	installHttpDispatcher();
	// 429 观察点要在 undici.install() 之后、建会话之前装：那之后谁再替换
	// globalThis.fetch，setter 都会再包一层，采集才不会被悄悄绕过去。
	const rateLimitProbe = startRateLimitProbe();

	const profile = resolveProfile(
		spec.profile.profileId,
		spec.profile.reasoning,
		spec.profile.facts,
	);
	const modelRuntime = await ModelRuntime.create();

	const completion = { submitted: false } as { submitted: boolean; via?: string };
	const contextCollector = createAttemptContextCollector();
	// query：不 new PlatformClient、不 createCoagentExtension、不 fetch brief。
	// 否则空/假 endpoint 会把 sawUnreachable 误判成 platform_unreachable。
	const bindPlatform = bindsPlatform(spec.role);
	const client = bindPlatform
		? new PlatformClient(spec.endpoint.baseUrl, spec.endpoint.token)
		: undefined;

	const resourceLoader = new DefaultResourceLoader({
		cwd: spec.cwd,
		agentDir: getAgentDir(),
		// 托管 agent 必须行为可复现：不吃用户本地的扩展/技能/上下文文件。
		noExtensions: true,
		additionalExtensionPaths: resolveProviderExtensionPaths(profile.provider),
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
		extensionFactories: bindPlatform
			? [
					createCoagentExtension({
						client: client!,
						role: spec.role,
						cwd: spec.cwd,
						completion,
						onBriefInjected: (brief) => contextCollector.onBriefInjected(brief),
					}),
				]
			: [],
		// query 无 CoAgent extension，角色说明走 loader 覆盖，不拉 Mission brief。
		...(spec.role === "query"
			? { systemPromptOverride: () => systemPrompt("query") }
			: {}),
	});
	await resourceLoader.reload();
	await registerPendingProviderExtensions(resourceLoader, modelRuntime);

	// 凭证是否配置：结构化事实，用来把「模型不存在」和「凭据缺失」分开。
	const authConfigured = modelRuntime.hasConfiguredAuth(profile.provider);
	const model = modelRuntime.getModel(profile.provider, profile.model);
	if (!model) {
		const available = (await modelRuntime.getAvailable()).map((m) => `${m.provider}/${m.id}`);
		const missingCodeBuddyExtension = profile.provider === "codebuddy"
			&& resolveProviderExtensionPaths(profile.provider).length === 0;
		const installHint = missingCodeBuddyExtension
			? "。请在 pi 安装 pi-codebuddy-oauth 并执行 /login codebuddy"
			: "";
		// 模型不存在（上游整段改名/下架）在派发前就能结构化判定，不必等一句文案。
		// 分类挂在异常上带出去，agent-entry 收尾时写进 outcome。
		throw withFailure(
			new Error(
				`模型不可用：${profile.provider}/${profile.model}。可用的有：${available.join(", ")}${installHint}`,
			),
			classifyUpstreamFailure({
				modelExists: false,
				provider: profile.provider,
				model: profile.model,
				authConfigured,
			}),
		);
	}

	const sessionManager = spec.resumeRef
		? SessionManager.open(spec.resumeRef, sessionDir, spec.cwd)
		: SessionManager.create(spec.cwd, sessionDir);

	// query 的 tools 只来自 adapter 闭集（toolAllowlist('query')），不并入 Hub allowlist。
	const { session } = await createAgentSession({
		cwd: spec.cwd,
		model,
		thinkingLevel: profile.reasoning,
		modelRuntime,
		resourceLoader,
		sessionManager,
		tools: toolAllowlist(spec.role),
	});

	let toolCalls = 0;
	// 工具名序列：Timeline 第二层要的是结构化动作，不是一大段文字。
	const toolNames: string[] = [];
	let failureMessage: string | undefined;
	// 结构化失败证据：stopReason / rawStopReason / diagnostics。分类优先吃这些。
	let lastErrorAssistant:
		| { stopReason?: string; rawStopReason?: string; diagnostics?: FailureDiagnostic[] }
		| undefined;
	// 最近一次 assistant 消息的 stopReason；length 表示上一条回复被输出上限截断。
	let lastAssistantStopReason: string | undefined;
	// prompt() 抛出来的异常（例如「No API key found」），同样带结构化字段。
	let thrown: { name?: string; code?: string | number; status?: number; message?: string } | undefined;
	// 原始输出只留尾部。一次执行能吐几十万字符，全带回去会把平台的状态文件
	// 撑爆；而排障看的几乎总是最后那一段。
	const OUTPUT_TAIL = 16_000;
	let output = "";
	const absorb = (text: string) => {
		output = (output + text).slice(-OUTPUT_TAIL);
	};
	/**
	 * 结构化事件行（S11.4）。
	 *
	 * 平台侧要的是**结构化动作序列**，不是一段"· read"这样的装饰文本。
	 * 早先只打印装饰文本，于是平台那边 tool.started 这一支从来没进过——
	 * 界面上工具调用只能当普通文字显示，用量也只能在整跳结束时才拿到一次。
	 *
	 * 这是协议，不是给人看的，所以**不受 spec.stream 控制**：
	 * stream 关掉时平台照样要拿到事件。
	 */
	const emitEvent = (payload: Record<string, unknown>) => {
		// 独占一行：平台侧按行切，前后不加换行的话会和模型正文黏在一起。
		process.stdout.write("\n" + EVENT_PREFIX + JSON.stringify(payload) + "\n");
	};
	/** 取当前累计用量。每次工具边界报一次，界面上的 token 才会边跑边涨。 */
	const snapshotUsage = () => {
		try {
			const stats = session.getSessionStats();
			return { ...stats.tokens, cost: stats.cost, quality: "reported" as const };
		} catch {
			return undefined;
		}
	};

	const unsubscribe = session.subscribe((event) => {
		if (event.type === "message_update") {
			const inner = event.assistantMessageEvent;
			if (inner.type === "text_delta") {
				absorb(inner.delta);
				if (spec.stream) process.stdout.write(inner.delta);
			}
		} else if (event.type === "tool_execution_start") {
			toolCalls++;
			const name = (event as { toolName?: string }).toolName ?? "?";
			toolNames.push(name);
			// 工具调用也进原始输出：只看文本会漏掉"它到底干了什么"这一半。
			absorb(`\n[tool] ${name}\n`);
			// 只发结构化事件，不再打印「· name」那行装饰文本：平台侧会把事件
			// 渲染成芯片，两个都发就成了同一件事显示两遍。
			// activityClass：Hub 按跨 runtime 合同计 command，不认工具名表。
			emitEvent(
				toolStartedEvent({
					name,
					callId: callIdOf(event),
					detail: detailOf(event),
				}),
			);
			// 只计 SDK 可见的 start/end；不从 usage / 事件名倒推正文。
			contextCollector.onToolExecutionStart(event);
			// 工具边界是天然的心跳点：在这里报一次累计用量，界面上的 token
			// 才会边跑边涨，而不是整跳结束才一次性蹦出一个数。
			const usage = snapshotUsage();
			if (usage) emitEvent({ t: "usage", usage });
		} else if (event.type === "tool_execution_end") {
			contextCollector.onToolExecutionEnd(event);
			emitEvent({
				t: "tool.completed",
				name: (event as { toolName?: string }).toolName ?? "?",
				callId: callIdOf(event),
			});
		} else if (event.type === "agent_end") {
			// 上游失败在这里露头：assistant 消息带 stopReason:"error"。
			// 不抓的话 prompt() 照常 resolve，症状会伪装成「模型什么都没干」。
			for (const message of (event as { messages?: unknown[] }).messages ?? []) {
				const m = message as {
					role?: string;
					stopReason?: string;
					errorMessage?: string;
					rawStopReason?: string;
					diagnostics?: FailureDiagnostic[];
				};
				// 最后一条 assistant 消息的 stopReason 决定提醒措辞（length 表示被截断）。
				if (m.role === "assistant" && m.stopReason) {
					lastAssistantStopReason = m.stopReason;
				}
				if (m.stopReason === "error" && m.errorMessage) {
					failureMessage = m.errorMessage;
					lastErrorAssistant = {
						stopReason: m.stopReason,
						rawStopReason: m.rawStopReason,
						diagnostics: m.diagnostics,
					};
				}
			}
		}
	});

	// 命令活动分类能力：subscribe 就绪后、prompt/工具循环之前同步声明一次。
	// 零工具 hop（含 query）也必须有，否则 Hub 无法区分「0 command」与「遗留未分类」。
	emitEvent(commandActivityCapabilitiesEvent());

	// 传输层证据要在真正发请求之前开始观察：provider SDK 把 429/ECONNREFUSED
	// 吞成一句文案时，这里是唯一还能拿到真实状态码/错误码的地方。
	const transport = recordTransport();
	// 执行者没交结构化结果就结束：在同一会话再问一次，模型手上的上下文和已做的
	// 改动都还在——「忘了提交」基本当场就交，「想满被截断」可以接着做。每程最多一次。
	let remindedStopReason: string | undefined;
	let reminded = false;
	try {
		await session.prompt(spec.instruction);
		const reminder = executorReminder({
			role: spec.role,
			submitted: completion.submitted,
			hasFailure: !!failureMessage,
			unreachable: !!client?.sawUnreachable,
			stopReason: lastAssistantStopReason,
		});
		if (reminder) {
			reminded = true;
			remindedStopReason = lastAssistantStopReason;
			await session.prompt(reminder);
		}
	} catch (e) {
		failureMessage = e instanceof Error ? e.message : String(e);
		if (e instanceof Error) {
			thrown = {
				name: e.name,
				message: e.message,
				code: (e as { code?: string | number }).code,
				status: (e as { status?: number }).status,
			};
		}
	} finally {
		transport.stop();
		rateLimitProbe.stop();
	}

	const stats = session.getSessionStats();
	unsubscribe();

	// 提醒过一次但仍没交结构化结果：在 output 留一行，排障时不必翻会话文件。
	// 只以 reminded 和 !completion.submitted 门控，不因第二轮 failureMessage 或不可达抹掉提醒痕迹。
	if (reminded && !completion.submitted) {
		absorb(
			`\n[runtime] 会话没有终结提交，已在同一会话提醒 1 次（上一条回复 stopReason=${remindedStopReason ?? "unknown"}）\n`,
		);
	}

	const resumeRef = session.sessionFile;
	session.dispose();

	// 顺序有讲究：**连不上平台**要优先于其它判断。没做结构化提交可能
	// 只是因为工具根本调不通——那时报 no_structured_result 会让调度器
	// 拒绝重试一个其实该重试的情况。
	// query 不创建 client，不会因假 endpoint 误判 platform_unreachable；
	// 也没有终端提交，成功时 endedBy 保持 no_structured_result（不伪装 structured_submit）。
	const endedBy = client?.sawUnreachable
		? ("platform_unreachable" as const)
		: completion.submitted
			? ("structured_submit" as const)
			: failureMessage
				? ("upstream_failure" as const)
				: ("no_structured_result" as const);

	// 只加分辨能力，不改既有的 endedBy 判定：分类挂在新增字段上。
	const upstreamFailure =
		endedBy === "upstream_failure" && failureMessage
			? classifyUpstreamFailure({
					modelExists: true,
					provider: profile.provider,
					model: profile.model,
					authConfigured,
					stopReason: lastErrorAssistant?.stopReason,
					rawStopReason: lastErrorAssistant?.rawStopReason,
					diagnostics: lastErrorAssistant?.diagnostics,
					transport: observationsForOrigin(transport.observations(), originOf(model.baseUrl)),
					thrown,
					errorMessage: failureMessage,
				})
			: undefined;

	if (endedBy === "upstream_failure" && failureMessage && upstreamFailure?.category === "quota_exhausted") {
		failureMessage = await appendXaiQuotaReset({
			provider: profile.provider,
			classification: upstreamFailure,
			failureMessage,
			query: async () => queryUsage({ runtime: modelRuntime as never, timeoutMs: 5000 }),
		});
	}

	// 摘要挂在分类**之后**：这段中文是给人看的，不能反过来被分类的正则吃到。
	if (endedBy === "upstream_failure" && failureMessage && upstreamFailure?.category === "rate_limited") {
		failureMessage = appendRateLimitSummary(failureMessage, rateLimitProbe.summary());
	}

	const queryOutcome = mapQueryOutcome({
		role: spec.role,
		endedBy,
		failureMessage:
			endedBy === "upstream_failure"
				? failureMessage
				: endedBy === "platform_unreachable"
					? "agent 连不上平台"
					: undefined,
	});

	return {
		attemptId: spec.attemptId,
		endedBy,
		submittedVia: completion.via,
		failureMessage:
			endedBy === "upstream_failure"
				? failureMessage
				: endedBy === "platform_unreachable"
					? "agent 连不上平台"
					: undefined,
		upstreamFailure,
		resumeRef,
		output,
		toolNames,
		resolvedProfile: {
			revision: PROFILE_TABLE_REVISION,
			// 键名由适配层与用例层约定；kernel 不解释它们。
			resolved: [
				{ key: "provider", value: profile.provider },
				{ key: "model", value: profile.model },
				{ key: "reasoning", value: profile.reasoning },
			],
		},
		usage: { ...stats.tokens, cost: stats.cost, quality: "reported" },
		toolCalls,
		...(queryOutcome ? { queryOutcome } : {}),
		contextMetrics: contextCollector.finalize(),
	};
}
