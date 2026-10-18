/**
 * Langfuse 旁路观测：把 pi 每一次**真实 assistant 响应**映射成一条 GENERATION。
 *
 * 为什么单独一层：runtime.ts 已经够长了，而这一层要处理的东西（配置默认关闭、
 * 调用序号续跑、OTLP 属性映射、内容脱敏、旁路失败隔离）互相之间没有依赖顺序，
 * 混进 startRun 会让「模型结果」和「观测结果」两条路径的边界看不出来。
 * 观测只读：不返回 messages、不改事件、不改 outcome，任何失败都必须停在
 * 这一层内部——否则一次网络抖动就会变成一次任务失败。
 *
 * 计数只认「先有 context 请求、再有 assistant 响应」这一对：
 * subscribe 拿不到请求本身的输入（SDK 只在扩展的 context 钩子里给完整
 * transcript），而工具、agent_end、历史 session 消息都不是模型调用。
 * 尤其是 SDK 在 executor 抛错后合成的失败 assistant（pi-agent-core
 * agent.js handleRunFailure）没有任何 context 请求，把它算成模型响应
 * 会让复核数据凭空多出一次「上游已经回了话」。
 *
 * 调用序号不能靠 session 消息条数推算：SDK 重试与压缩都会改变活动消息，
 * 且 message_end 监听先于持久化。所以序号单独记高水位，进程重开、续跑同一
 * Attempt 都接着往后编。
 *
 * 为什么高水位不能只写在会话的 custom entry 里：pi 0.87.1 的 session-manager
 * 在首个 assistant 消息进入 fileEntries 之前不写会话文件，因此「已导出本次调用、
 * 但该 assistant 尚未持久化」这段窗口里，custom entry 会随进程一起消失，
 * 重开的进程从 0 重编并重发已导出的编号，Langfuse 里两次调用被合成一次。
 * 所以要有一个不依赖 assistant 持久化的本地 sidecar（见 langfuse-call-index.ts）。
 */

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createDurableCallIndex } from "./langfuse-call-index.ts";
import type { DurableCallIndex } from "./langfuse-call-index.ts";
import type { Role } from "./roles.js";

/** 共享传输（W-718 已接受）是 .mjs：本层只按名字调用，不复制它的任何实现。 */
const TRANSPORT_MODULE = "../../../scripts/langfuse-transport.mjs";

/**
 * 高水位 entry 的类型。只放 attemptId/callIndex 这类非内容元数据：
 * custom entry 不进入 LLM 上下文，因此不会被模型读回去，也不会污染复核正文。
 */
const CALL_INDEX_CUSTOM_TYPE = "coagent.langfuse.call-index.v1";

/** 输入投影的上界。transcript 可以到几十万字符，不设界会把内存和脱敏耗时都拖住。 */
const MAX_PROJECTED_MESSAGES = 64;
const MAX_PROJECTED_CHARS = 120_000;
const MAX_BLOCK_CHARS = 20_000;
const DEFAULT_FLUSH_TIMEOUT_MS = 5_000;

const SPAN_NAME = "coagent.llm.generation";

/** 只有这两个角色才逐调用观测；query/reviewer/solo 不属于本单范围。 */
const OBSERVED_ROLES: ReadonlySet<string> = new Set<Role>(["coordinator", "executor"]);

export interface LangfuseConfig {
	enabled: boolean;
	captureContent?: boolean;
	maxContentChars?: number;
	flushTimeoutMs?: number;
	[key: string]: unknown;
}

export interface LangfuseCapturedValue {
	value?: string;
	missing: boolean;
	truncated: boolean;
}

export interface LangfuseStableIds {
	traceId: string;
	spanId: string;
}

export interface LangfuseTransport {
	enqueueSpan(span: Record<string, unknown>): Promise<boolean>;
	flush(): Promise<boolean>;
}

/** 共享传输模块的调用面。按结构声明，避免依赖 .mjs 的类型声明。 */
export interface LangfuseTransportModule {
	loadConfig(opts?: { path?: string }): Promise<LangfuseConfig>;
	createTransport(config: LangfuseConfig): LangfuseTransport;
	captureValue(value: unknown, config: LangfuseConfig): LangfuseCapturedValue;
	stableIds(input: {
		missionId: string;
		attemptId?: string | null;
		callIndex?: number | null;
		eventKey?: string | null;
	}): LangfuseStableIds;
}

/**
 * 只读的会话元数据面（SessionManager 的这几条已核实）。
 * getSessionFile 只用来定位 sidecar 的目录与文件名；本层绝不读、也绝不改
 * SDK 的会话 JSONL 本身。
 */
export interface LangfuseSessionMetadataPort {
	getEntries(): unknown[];
	appendCustomEntry(customType: string, data?: unknown): string;
	getSessionFile?(): string | undefined;
}

export interface LangfuseObserverSubject {
	missionId?: string;
	workItemId?: string;
	attemptId: string;
	role: Role;
}

/** 已解析的 profile。reasoning 是解析结果里的已知值，不从消息里猜。 */
export interface LangfuseObserverProfile {
	provider: string;
	model: string;
	reasoning: string;
}

export interface LangfuseObserverDeps {
	/** 测试用临时配置路径；生产不传，走共享传输的默认位置。 */
	configPath?: string;
	loadConfig?: (opts?: { path?: string }) => Promise<LangfuseConfig>;
	createTransport?: (config: LangfuseConfig) => LangfuseTransport;
	captureValue?: (value: unknown, config: LangfuseConfig) => LangfuseCapturedValue;
	stableIds?: LangfuseTransportModule["stableIds"];
	/** 观测时刻（毫秒）。默认 Date.now，测试注入确定性时钟。 */
	now?: () => number;
	flushTimeoutMs?: number;
}

export interface LangfuseObserver {
	/** 是否真的在观测。关闭时不注册任何钩子、不读配置之后的字段。 */
	readonly enabled: boolean;
	readonly extensionFactory: ExtensionFactory;
	attachSessionManager(manager: LangfuseSessionMetadataPort): void;
	onEvent(event: unknown): void;
	flush(): Promise<void>;
}

interface PendingRequest {
	observedAt: number;
	input: LangfuseCapturedValue;
}

interface ActiveCall {
	callIndex: number;
	startedAt: number;
	firstResponseAt: number;
	input: LangfuseCapturedValue;
}

type AssistantLike = {
	role?: unknown;
	content?: unknown;
	provider?: unknown;
	model?: unknown;
	usage?: unknown;
	stopReason?: unknown;
	errorMessage?: unknown;
};

const str = (key: string, value: string) => ({ key, value: { stringValue: value } });
const int = (key: string, value: number) => ({ key, value: { intValue: value } });
const dbl = (key: string, value: number) => ({ key, value: { doubleValue: value } });
const bool = (key: string, value: boolean) => ({ key, value: { boolValue: value } });

/** OTLP 时间戳：纳秒字符串。用 BigInt 拼，避免 1e18 级数字在 double 里丢精度。 */
const nanos = (ms: number): string => `${BigInt(Math.trunc(Math.max(0, ms))) * 1_000_000n}`;

/** 只接受可证实的有限非负数；缺失就是缺失，不能填 0 装成已知。 */
const finiteNonNegative = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

function blockText(block: unknown): string {
	if (typeof block === "string") return block.slice(0, MAX_BLOCK_CHARS);
	if (!block || typeof block !== "object") return "";
	const record = block as { type?: unknown; text?: unknown; thinking?: unknown };
	if (typeof record.text === "string") return record.text.slice(0, MAX_BLOCK_CHARS);
	if (typeof record.thinking === "string") return record.thinking.slice(0, MAX_BLOCK_CHARS);
	// 工具调用等无正文块也只留形状，不缓存整个对象。
	return typeof record.type === "string" ? `[${record.type}]` : "";
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content.slice(0, MAX_BLOCK_CHARS);
	if (!Array.isArray(content)) return "";
	return content.map(blockText).join("");
}

/**
 * 输入投影：从最新一条往前收，超预算就停并记下丢弃条数。
 * 只保留角色与可见正文，不保存消息对象本身——SDK 的 transcript 会随着
 * 后续回合不断变长，留住引用等于间接留住整段会话。
 */
function projectTranscript(messages: readonly unknown[]): { text: string; dropped: number } {
	const kept: string[] = [];
	let budget = MAX_PROJECTED_CHARS;
	const start = Math.max(0, messages.length - MAX_PROJECTED_MESSAGES);
	let dropped = messages.length - (messages.length - start);
	for (let i = messages.length - 1; i >= start; i -= 1) {
		const message = messages[i] as AssistantLike | undefined;
		const role = typeof message?.role === "string" ? message.role : "unknown";
		const line = `${role}: ${contentText(message?.content)}`;
		if (line.length > budget) {
			dropped += i - start + 1;
			break;
		}
		budget -= line.length;
		kept.push(line);
	}
	kept.reverse();
	return { text: kept.join("\n"), dropped };
}

/**
 * 读共享传输模块。只有调用方没把**全部**依赖注入时才动态 import：
 * 测试注入齐了就不碰生产默认链路，也就能断言「不读真实配置文件」。
 */
async function resolveModule(
	deps: LangfuseObserverDeps,
): Promise<Partial<LangfuseTransportModule>> {
	if (deps.loadConfig && deps.createTransport && deps.captureValue && deps.stableIds) return {};
	return (await import(TRANSPORT_MODULE)) as LangfuseTransportModule;
}

/** 关闭态：不注册钩子、不读配置、不建传输，事件与 flush 都是空操作。 */
export function createNoopLangfuseObserver(): LangfuseObserver {
	return {
		enabled: false,
		extensionFactory: () => {
			// 故意不注册任何事件：关闭时连钩子都不该出现在扩展列表里。
		},
		attachSessionManager: () => {},
		onEvent: () => {},
		flush: async () => {},
	};
}

export interface CreateLangfuseObserverOptions {
	subject: LangfuseObserverSubject;
	profile: LangfuseObserverProfile;
	deps?: LangfuseObserverDeps;
}

/**
 * 建观测器。**从不 reject**：配置缺失、依赖加载失败、配置非法一律退化成 no-op，
 * 让 runtime 的模型路径拿到一个永远可调用的对象。
 */
export async function createLangfuseObserver(
	options: CreateLangfuseObserverOptions,
): Promise<LangfuseObserver> {
	const { subject, profile } = options;
	const deps = options.deps ?? {};

	// 角色与 missionId 先判：不满足就完全不必读配置，也避免任何人以为
	// 「配好了就所有角色都会被观测」。
	if (!OBSERVED_ROLES.has(subject.role)) return createNoopLangfuseObserver();
	const missionId = subject.missionId;
	if (typeof missionId !== "string" || missionId.length === 0) {
		return createNoopLangfuseObserver();
	}
	if (typeof subject.attemptId !== "string" || subject.attemptId.length === 0) {
		return createNoopLangfuseObserver();
	}

	try {
		const module = await resolveModule(deps);
		const loadConfig = deps.loadConfig ?? module.loadConfig;
		const createTransport = deps.createTransport ?? module.createTransport;
		const captureValue = deps.captureValue ?? module.captureValue;
		const stableIds = deps.stableIds ?? module.stableIds;
		if (!loadConfig || !createTransport || !captureValue || !stableIds) {
			return createNoopLangfuseObserver();
		}

		const config = await loadConfig(
			deps.configPath ? { path: deps.configPath } : undefined,
		);
		if (!config || config.enabled !== true) return createNoopLangfuseObserver();

		const transport = createTransport(config);
		const now = deps.now ?? (() => Date.now());
		const flushTimeoutMs =
			deps.flushTimeoutMs ??
			finiteNonNegative(config.flushTimeoutMs) ??
			DEFAULT_FLUSH_TIMEOUT_MS;

		let enabled = true;
		let highWater = -1;
		let metadata: LangfuseSessionMetadataPort | undefined;
		/** 序号耐久落点；取不到会话路径或读写失败时关观测。 */
		let callIndex: DurableCallIndex | undefined;
		let pendingRequest: PendingRequest | undefined;
		let activeCall: ActiveCall | undefined;

		/**
		 * 观测量失败（例如会话元数据写不进去）就整体关掉本次观测。
		 * 关掉而不是继续：没有可靠序号就会撞号，撞号的 span 在 Langfuse 里
		 * 是同一个 observation，复核时两次调用会被合成一次。
		 */
		const disable = () => {
			enabled = false;
			pendingRequest = undefined;
			activeCall = undefined;
			// 只清自己可能留下的临时文件；已落盘的高水位必须保留，
			// 否则重开的进程会把导出的编号再发一遍。
			callIndex?.dispose();
			callIndex = undefined;
		};

		const capture = (value: unknown) => {
			try {
				return captureValue(value, config);
			} catch {
				return { missing: true, truncated: false };
			}
		};

		const enqueue = (span: Record<string, unknown>) => {
			try {
				// 不 await：入队失败只影响观测，绝不能挡住订阅或工具循环。
				void Promise.resolve(transport.enqueueSpan(span)).catch(() => {});
			} catch {
				// 共享传输自身已吞错；这里只防它被替换成会抛的实现。
			}
		};

		const usageAttributes = (message: AssistantLike | undefined) => {
			const usage = message?.usage as
				| {
						input?: unknown;
						output?: unknown;
						cacheRead?: unknown;
						cacheWrite?: unknown;
						totalTokens?: unknown;
						cost?: {
							input?: unknown;
							output?: unknown;
							cacheRead?: unknown;
							cacheWrite?: unknown;
							total?: unknown;
						};
				  }
				| undefined;
			if (!usage || typeof usage !== "object") return [];

			const attributes: { key: string; value: Record<string, unknown> }[] = [];
			const usageDetails: Record<string, number> = {};
			const input = finiteNonNegative(usage.input);
			const output = finiteNonNegative(usage.output);
			const cacheRead = finiteNonNegative(usage.cacheRead);
			const cacheWrite = finiteNonNegative(usage.cacheWrite);
			const total = finiteNonNegative(usage.totalTokens);
			if (input !== undefined) usageDetails.input = input;
			if (output !== undefined) usageDetails.output = output;
			if (cacheRead !== undefined) usageDetails.cache_read_input_tokens = cacheRead;
			if (cacheWrite !== undefined) usageDetails.cache_creation_input_tokens = cacheWrite;
			if (total !== undefined) usageDetails.total = total;

			if (Object.keys(usageDetails).length > 0) {
				attributes.push(str("langfuse.observation.usage_details", JSON.stringify(usageDetails)));
				// 来源写在属性里：SDK 的单次计量不是 provider 账单，复核时必须能区分。
				attributes.push(
					str("coagent.usage.source", "assistant_message.usage (single response, SDK-reported)"),
				);
			}

			const costDetails: Record<string, number> = {};
			const cost = usage.cost;
			const costInput = finiteNonNegative(cost?.input);
			const costOutput = finiteNonNegative(cost?.output);
			const costTotal = finiteNonNegative(cost?.total);
			if (costInput !== undefined) costDetails.input = costInput;
			if (costOutput !== undefined) costDetails.output = costOutput;
			if (costTotal !== undefined) costDetails.total = costTotal;
			if (Object.keys(costDetails).length > 0) {
				attributes.push(str("langfuse.observation.cost_details", JSON.stringify(costDetails)));
				attributes.push(
					str("coagent.cost.source", "sdk.usage.cost (SDK-computed, not a provider invoice)"),
				);
			}
			return attributes;
		};

		const emitCall = (call: ActiveCall, endedAt: number | undefined, message?: AssistantLike) => {
			let ids: LangfuseStableIds;
			try {
				ids = stableIds({ missionId, attemptId: subject.attemptId, callIndex: call.callIndex });
			} catch {
				disable();
				return;
			}
			const attributes: { key: string; value: Record<string, unknown> }[] = [
				str("langfuse.observation.type", "GENERATION"),
				str("langfuse.trace.session_id", missionId),
				str("coagent.mission_id", missionId),
				str("coagent.attempt_id", subject.attemptId),
				str("coagent.role", subject.role),
				int("coagent.call_index", call.callIndex),
				str("coagent.reasoning", profile.reasoning),
				str("coagent.reasoning.source", "resolved_profile"),
				str("coagent.start.source", "context_with_system hook observation"),
			];
			if (typeof subject.workItemId === "string" && subject.workItemId.length > 0) {
				attributes.push(str("coagent.work_item_id", subject.workItemId));
			}

			// provider/model：优先单条 assistant 自报（可证实），缺失回退解析结果。
			const messageProvider =
				typeof message?.provider === "string" && message.provider ? message.provider : undefined;
			const messageModel =
				typeof message?.model === "string" && message.model ? message.model : undefined;
			const provider = messageProvider ?? profile.provider;
			const model = messageModel ?? profile.model;
			attributes.push(str("coagent.provider", provider));
			attributes.push(str("coagent.model", model));
			attributes.push(
				str(
					"coagent.provider_model.source",
					messageProvider && messageModel ? "assistant_message" : "resolved_profile",
				),
			);
			attributes.push(str("langfuse.observation.model.name", model));

			// 输入：仅 captureContent 时带正文；来源明确标成 SDK 可见上下文。
			if (config.captureContent === true) {
				attributes.push(str("coagent.input.source", "context_with_system (SDK-visible, no hidden context)"));
				attributes.push(bool("coagent.input.missing", call.input.missing));
				attributes.push(bool("coagent.input.truncated", call.input.truncated));
				if (call.input.missing === false && typeof call.input.value === "string") {
					attributes.push(str("langfuse.observation.input", call.input.value));
				}
			}

			if (endedAt === undefined) {
				// 已开始但没有 end：只标 incomplete，不编造最终响应/usage/时刻。
				attributes.push(str("coagent.generation.status", "incomplete"));
				attributes.push(str("langfuse.observation.level", "WARNING"));
				enqueue({
					traceId: ids.traceId,
					spanId: ids.spanId,
					name: SPAN_NAME,
					startTimeUnixNano: nanos(call.startedAt),
					attributes,
				});
				return;
			}

			attributes.push(str("coagent.generation.status", "complete"));
			attributes.push(str("coagent.end.source", "message_end observation"));
			attributes.push(str("coagent.first_response.source", "message_start (SDK stream start, not network start)"));
			attributes.push(int("coagent.first_response_ms", Math.max(0, call.firstResponseAt - call.startedAt)));

			const stopReason = typeof message?.stopReason === "string" ? message.stopReason : undefined;
			if (stopReason) attributes.push(str("coagent.stop_reason", stopReason));
			if (stopReason === "error") {
				attributes.push(str("langfuse.observation.level", "ERROR"));
				// 错误正文同样走脱敏/截断；关闭内容时不发正文，只留可判定的事实。
				if (config.captureContent === true) {
					const errorText = capture(message?.errorMessage);
					attributes.push(bool("coagent.error.missing", errorText.missing));
					attributes.push(bool("coagent.error.truncated", errorText.truncated));
					if (errorText.missing === false && typeof errorText.value === "string") {
						attributes.push(str("langfuse.observation.status_message", errorText.value));
					}
				}
			}

			if (config.captureContent === true) {
				const output = capture(message?.content);
				attributes.push(bool("coagent.output.missing", output.missing));
				attributes.push(bool("coagent.output.truncated", output.truncated));
				if (output.missing === false && typeof output.value === "string") {
					attributes.push(str("langfuse.observation.output", output.value));
				}
			}

			attributes.push(...usageAttributes(message));

			enqueue({
				traceId: ids.traceId,
				spanId: ids.spanId,
				name: SPAN_NAME,
				startTimeUnixNano: nanos(call.startedAt),
				endTimeUnixNano: nanos(endedAt),
				attributes,
			});
		};

		/**
		 * 预留序号：先把高水位耐久落盘，返回成功之后调用方才能记住 activeCall 并导出。
		 * 顺序不能反：先导出后落盘等于回到「窗口丢失」的老问题——进程一死，
		 * 已导出的编号就没人知道。
		 * 落盘失败就关掉观测（见 disable 的理由），并让本次调用不被导出。
		 */
		const reserveCallIndex = (): number | undefined => {
			const durable = callIndex;
			if (!durable) {
				disable();
				return undefined;
			}
			const next = highWater + 1;
			try {
				durable.write(next);
			} catch {
				disable();
				return undefined;
			}
			// custom entry 继续写：向后兼容的恢复来源，人也能在会话里看到序号。
			// 但它不再是耐久依据，写失败不该影响已经 durable 的序号。
			try {
				metadata?.appendCustomEntry(CALL_INDEX_CUSTOM_TYPE, {
					attemptId: subject.attemptId,
					callIndex: next,
				});
			} catch {
				// 忽略：sidecar 已经落盘。
			}
			highWater = next;
			return next;
		};

		const onAssistantStart = (message: AssistantLike | undefined) => {
			if (!message || message.role !== "assistant") return;
			const request = pendingRequest;
			pendingRequest = undefined;
			// 没有 context 请求的 assistant：SDK 合成的失败消息，不冒充模型响应。
			if (!request) return;
			if (activeCall) emitCall(activeCall, undefined);
			const callIndex = reserveCallIndex();
			if (callIndex === undefined) return;
			activeCall = {
				callIndex,
				startedAt: request.observedAt,
				firstResponseAt: now(),
				input: request.input,
			};
		};

		const onAssistantEnd = (message: AssistantLike | undefined) => {
			if (!message || message.role !== "assistant") return;
			const call = activeCall;
			activeCall = undefined;
			if (!call) return;
			emitCall(call, now(), message);
		};

		const extensionFactory: ExtensionFactory = (pi) => {
			if (!enabled) return;
			pi.on("context_with_system", (event) => {
				try {
					const messages = Array.isArray(event?.messages) ? event.messages : [];
					let input: LangfuseCapturedValue = { missing: false, truncated: false };
					if (config.captureContent === true) {
						const projected = projectTranscript(messages);
						const captured = capture(projected.text);
						input = {
							missing: captured.missing,
							truncated: captured.truncated || projected.dropped > 0,
							...(typeof captured.value === "string" ? { value: captured.value } : {}),
						};
					}
					pendingRequest = { observedAt: now(), input };
				} catch {
					// 只采集：投影失败就当这次没有输入，不影响请求。
				}
				// 必须不返回 messages：返回就会被当作替换后的请求发出去。
				return undefined;
			});
		};

		return {
			get enabled() {
				return enabled;
			},
			extensionFactory,
			attachSessionManager(manager) {
				if (!enabled) return;
				try {
					metadata = manager;
					let max = -1;
					for (const entry of manager.getEntries()) {
						const record = entry as { type?: unknown; customType?: unknown; data?: unknown };
						if (record?.type !== "custom" || record.customType !== CALL_INDEX_CUSTOM_TYPE) continue;
						const data = record.data as { attemptId?: unknown; callIndex?: unknown } | undefined;
						// 只认同一 Attempt 的高水位：别的尝试的序号与本条 trace 无关。
						if (data?.attemptId !== subject.attemptId) continue;
						const index = data.callIndex;
						if (typeof index === "number" && Number.isInteger(index) && index > max) max = index;
					}

					// sidecar 是耐久依据：会话文件此时可能还不存在（首个 assistant 未持久化），
					// 这没关系——sidecar 只借用它的路径做定位，不依赖它已经写出来。
					const sessionFile = manager.getSessionFile?.();
					if (typeof sessionFile !== "string" || sessionFile.length === 0) {
						// 没有可靠落点就不观测：宁可没有数据，也不要撞号的数据。
						disable();
						return;
					}
					const durable = createDurableCallIndex({ sessionFile, attemptId: subject.attemptId });
					// read 在损坏 / identity 不匹配时抛，被外层 catch 接住 → 关观测。
					const persisted = durable.read();
					callIndex = durable;
					highWater = Math.max(max, persisted);
				} catch {
					disable();
				}
			},
			onEvent(event) {
				if (!enabled) return;
				try {
					const record = event as { type?: unknown; message?: AssistantLike };
					if (record?.type === "message_start") onAssistantStart(record.message);
					else if (record?.type === "message_end") onAssistantEnd(record.message);
					// 其余事件（工具、agent_end、user/system 消息、历史会话）都不是模型调用。
				} catch {
					disable();
				}
			},
			async flush() {
				if (!enabled) return;
				// 只清临时文件残留，不清高水位记录。
				callIndex?.dispose();
				try {
					// 已开始但没等到 end 的调用：标 incomplete 后一并发出，不补任何结论。
					if (activeCall) {
						const call = activeCall;
						activeCall = undefined;
						emitCall(call, undefined);
					}
					let timer: ReturnType<typeof setTimeout> | undefined;
					const deadline = new Promise<boolean>((resolve) => {
						timer = setTimeout(() => resolve(false), flushTimeoutMs);
						timer.unref?.();
					});
					try {
						await Promise.race([Promise.resolve(transport.flush()), deadline]);
					} finally {
						if (timer) clearTimeout(timer);
					}
				} catch {
					// flush 失败只是观测没落盘，不能影响已经产生的模型结果。
				}
			},
		};
	} catch {
		return createNoopLangfuseObserver();
	}
}
