/**
 * langfuse-observer 的两条综合验收：
 * 1) 用真实 observer factory 注册到 fake ExtensionAPI，驱动 context_with_system 与
 *    真实声明形状的 assistant start/end（外加工具/agent_end/无请求合成消息），
 *    断言「恰两条 GENERATION」、稳定关联、内容脱敏截断且不修改上下文；核心窗口是
 *    **首条 assistant 从未 appendMessage**（SDK 会话文件都还没写出来）时已导出的序号
 *    也必须已独立落盘，重开同一会话/Attempt 后编号前进且不重发历史。
 * 2) 默认关闭、角色/任务不匹配、依赖抛错/拒绝/超时时不抛、不产生未处理拒绝、
 *    flush 有界，序号落点不可用/损坏时关观测而不抛，并核对 runtime 的生产接线位置。
 *
 * 为什么第一条偏偏不 appendMessage：旧版本正是靠测试里补一次 appendMessage 让会话
 * 文件落盘，才掩盖了真实窗口——生产里首个 assistant 持久化之前进程就退出时没有
 * 任何 durable 记录。现在不再合法地制造这个假象。
 *
 * 一律用临时目录与合成配置：不读真实 ~/.coagent/langfuse.json、不连网、不连真实模型。
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { callIndexSidecarPath } from "./langfuse-call-index.ts";
import { createLangfuseObserver, createNoopLangfuseObserver } from "./langfuse-observer.ts";
import type { LangfuseConfig, LangfuseObserverDeps, LangfuseTransport } from "./langfuse-observer.ts";
import { captureValue, stableIds } from "../../../scripts/langfuse-transport.mjs";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const runtimeSrc = readFileSync(join(SRC_DIR, "runtime.ts"), "utf8");

const MISSION_ID = "LF1-observer-mission";
const ATTEMPT_ID = "attempt-observer-1";
const WORK_ITEM_ID = "W-719";
/** 合成哨兵：只用来判断有没有被原样发出去，不对应任何真实凭据。 */
const API_KEY_SENTINEL = "GK-observer-9f8e7d";
const PROXY_SENTINEL = "10.23.45.67";
const PASSWORD_SENTINEL = "hunter2-observer";

const syntheticConfig = (overrides: Partial<LangfuseConfig> = {}): LangfuseConfig => ({
	enabled: true,
	baseUrl: "http://127.0.0.1:3300",
	publicKey: "pk-lf-synthetic",
	secretKey: "sk-lf-synthetic",
	captureContent: true,
	maxContentChars: 120,
	flushTimeoutMs: 200,
	...overrides,
});

/** 捕获 span 的假传输；通过 deps 注入，绝不发真实请求。 */
function captureTransport(): { transport: LangfuseTransport; spans: Record<string, unknown>[] } {
	const spans: Record<string, unknown>[] = [];
	return {
		spans,
		transport: {
			enqueueSpan: (span) => {
				spans.push(span);
				return Promise.resolve(true);
			},
			flush: () => Promise.resolve(true),
		},
	};
}

/** fake ExtensionAPI：只记录注册进来的 handler，其它成员不属于本单被测范围。 */
function fakeExtensionApi(): { api: ExtensionAPI; handlers: Map<string, (event: unknown) => unknown> } {
	const handlers = new Map<string, (event: unknown) => unknown>();
	const api = {
		on: (type: string, handler: (event: unknown) => unknown) => {
			handlers.set(type, handler);
			return () => handlers.delete(type);
		},
	} as unknown as ExtensionAPI;
	return { api, handlers };
}

const assistantMessage = (overrides: Record<string, unknown> = {}) => ({
	role: "assistant",
	content: [{ type: "text", text: "ok" }],
	api: "openai-completions",
	provider: "synthetic-provider",
	model: "synthetic-model",
	usage: {
		input: 11,
		output: 7,
		cacheRead: 2,
		cacheWrite: 0,
		totalTokens: 20,
		cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
	},
	stopReason: "stop",
	timestamp: 1_750_000_000_000,
	...overrides,
});

const attr = (span: Record<string, unknown>, key: string): unknown => {
	const attributes = span.attributes as { key: string; value: Record<string, unknown> }[];
	return attributes.find((item) => item.key === key)?.value;
};
const attrString = (span: Record<string, unknown>, key: string): string | undefined => {
	const value = attr(span, key) as { stringValue?: string } | undefined;
	return value?.stringValue;
};

test("综合 1：真实 observer factory 驱动 SDK 形状事件 → 恰两条 GENERATION、稳定关联/来源、脱敏截断、续跑序号前进", async () => {
	const dir = mkdtempSync(join(tmpdir(), "langfuse-observer-"));
	try {
		const { transport, spans } = captureTransport();
		let clock = 1_000;
		const deps: LangfuseObserverDeps = {
			loadConfig: async () => syntheticConfig(),
			createTransport: () => transport,
			captureValue,
			stableIds,
			now: () => (clock += 10),
		};

		const sessionManager = SessionManager.create(dir, dir);
		const observer = await createLangfuseObserver({
			subject: { missionId: MISSION_ID, workItemId: WORK_ITEM_ID, attemptId: ATTEMPT_ID, role: "executor" },
			profile: { provider: "resolved-provider", model: "resolved-model", reasoning: "medium" },
			deps,
		});
		assert.equal(observer.enabled, true);
		observer.attachSessionManager(sessionManager);

		const { api, handlers } = fakeExtensionApi();
		await observer.extensionFactory(api);
		const contextHandler = handlers.get("context_with_system");
		assert.ok(contextHandler, "必须注册 context_with_system 只读钩子");

		// —— 第一次响应：SDK 完整 transcript（含 system），正文里有凭据与超长文本 ——
		const firstMessages = [
			{ role: "system", content: [{ type: "text", text: "你是执行者" }], timestamp: 1 },
			{
				role: "user",
				content: [{ type: "text", text: `password=${PASSWORD_SENTINEL} apiKey=${API_KEY_SENTINEL} ${"长".repeat(400)}` }],
				timestamp: 2,
			},
		];
		const firstSnapshot = JSON.parse(JSON.stringify(firstMessages));
		const returned = contextHandler({ type: "context_with_system", messages: firstMessages });
		assert.equal(returned, undefined, "context hook 必须不返回 messages");
		assert.deepEqual(firstMessages, firstSnapshot, "context hook 不得修改原上下文");

		observer.onEvent({ type: "message_start", message: assistantMessage({ content: [{ type: "text", text: "a" }] }) });
		observer.onEvent({
			type: "message_end",
			message: assistantMessage({
				content: [{ type: "text", text: `apiKey: ${API_KEY_SENTINEL} ${"结".repeat(400)}` }],
			}),
		});

		// 工具 / agent_end / user 消息 / 历史会话回放都不是模型调用；没有 context 的
		// assistant（SDK 合成的失败消息）也不得冒充模型响应。
		observer.onEvent({ type: "tool_execution_start", toolName: "bash", toolCallId: "c1" });
		observer.onEvent({ type: "tool_execution_end", toolName: "bash", toolCallId: "c1" });
		observer.onEvent({ type: "agent_end", messages: [assistantMessage()] });
		observer.onEvent({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "hi" }] } });
		observer.onEvent({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "hi" }] } });
		observer.onEvent({
			type: "message_start",
			message: assistantMessage({ stopReason: "error", errorMessage: "synthetic failure" }),
		});
		observer.onEvent({
			type: "message_end",
			message: assistantMessage({ stopReason: "error", errorMessage: "synthetic failure" }),
		});
		assert.equal(spans.length, 1, "工具/agent_end/user/无请求合成消息不得新增 GENERATION");

		// —— 第二次响应：错误结尾、单次 usage 缺字段、assistant 不自报 provider/model ——
		contextHandler({
			type: "context_with_system",
			messages: [
				{ role: "system", content: [{ type: "text", text: "你是执行者" }], timestamp: 1 },
				{ role: "user", content: [{ type: "text", text: "继续" }], timestamp: 3 },
			],
		});
		observer.onEvent({ type: "message_start", message: assistantMessage({ content: [] }) });
		observer.onEvent({
			type: "message_end",
			message: assistantMessage({
				content: [{ type: "text", text: "partial" }],
				provider: undefined,
				model: undefined,
				stopReason: "error",
				errorMessage: `upstream rejected {"apiKey":"${API_KEY_SENTINEL}","proxy":"http://${PROXY_SENTINEL}:7890"}`,
				usage: {
					input: undefined,
					output: 9,
					cacheRead: null,
					cacheWrite: undefined,
					totalTokens: undefined,
					cost: { input: undefined, output: undefined, total: 0.004 },
				},
			}),
		});
		await observer.flush();

		// —— 关键窗口：故意不 appendMessage ——
		// 生产里 SDK 在首个 assistant 持久化之前不写会话文件，进程此时退出就没有
		// 任何会话记录。若序号只记在 custom entry 里，这里的高水位跟着消失，
		// 重开的进程会把已导出的 0/1 再发一遍。
		const sessionFile = sessionManager.getSessionFile();
		assert.ok(sessionFile, "SDK 必须给出会话文件路径");
		assert.equal(existsSync(sessionFile), false, "首条 assistant 未持久化时会话文件尚不存在（这正是旧实现丢失序号的窗口）");
		const sidecarFile = callIndexSidecarPath(sessionFile, ATTEMPT_ID);
		assert.equal(existsSync(sidecarFile), true, "已导出的调用编号必须在会话文件之外先落盘");
		// sidecar 只允许一条非内容元数据记录：不含正文、配置或凭据。
		const sidecarRecord = JSON.parse(readFileSync(sidecarFile, "utf8")) as Record<string, unknown>;
		assert.deepEqual(Object.keys(sidecarRecord).sort(), ["attemptId", "callIndex", "version"]);
		assert.equal(sidecarRecord.attemptId, ATTEMPT_ID);
		assert.equal(sidecarRecord.callIndex, 1, "高水位必须等于最后一条已导出调用的序号");
		assert.equal(readFileSync(sidecarFile, "utf8").includes(API_KEY_SENTINEL), false);

		assert.equal(spans.length, 2, "两次真实响应应恰形成两条 GENERATION");
		const [first, second] = spans;
		const expectedTrace = stableIds({ missionId: MISSION_ID, attemptId: ATTEMPT_ID }).traceId;
		for (const span of spans) {
			assert.equal(attrString(span, "langfuse.observation.type"), "GENERATION");
			assert.equal(span.traceId, expectedTrace);
			assert.equal(span.name, "coagent.llm.generation");
			assert.equal(attrString(span, "langfuse.trace.session_id"), MISSION_ID);
			assert.equal(attrString(span, "coagent.attempt_id"), ATTEMPT_ID);
			assert.equal(attrString(span, "coagent.work_item_id"), WORK_ITEM_ID);
			assert.equal(attrString(span, "coagent.role"), "executor");
			assert.equal(attrString(span, "coagent.reasoning"), "medium");
			assert.equal(attrString(span, "coagent.reasoning.source"), "resolved_profile");
			assert.match(attrString(span, "langfuse.observation.model.name") ?? "", /synthetic-model|resolved-model/);
			assert.equal(attrString(span, "coagent.generation.status"), "complete");
			assert.equal(attrString(span, "coagent.start.source"), "context_with_system hook observation");
			assert.equal(attrString(span, "coagent.end.source"), "message_end observation");
			assert.ok(Number(attr(span, "coagent.first_response_ms") ? (attr(span, "coagent.first_response_ms") as { intValue: number }).intValue : NaN) >= 0);
			assert.ok(typeof span.startTimeUnixNano === "string" && typeof span.endTimeUnixNano === "string");
		}
		assert.equal(attr(second, "coagent.call_index") ? (attr(second, "coagent.call_index") as { intValue: number }).intValue : -1, 1);
		assert.notEqual(first.spanId, second.spanId, "不同调用必须落在不同 span");

		// 调用模型来源：第一条 assistant 自报可证实，第二条缺失时回退解析结果并标来源。
		assert.equal(attrString(first, "coagent.provider_model.source"), "assistant_message");
		assert.equal(attrString(first, "coagent.model"), "synthetic-model");
		assert.equal(attrString(second, "coagent.provider_model.source"), "resolved_profile");
		assert.equal(attrString(second, "coagent.model"), "resolved-model");

		// 单条 usage / cost：只取可证实的有限非负数，不从累计 stats 取值。
		assert.deepEqual(JSON.parse(attrString(first, "langfuse.observation.usage_details") ?? "{}"), {
			input: 11,
			output: 7,
			cache_read_input_tokens: 2,
			cache_creation_input_tokens: 0,
			total: 20,
		});
		assert.deepEqual(JSON.parse(attrString(first, "langfuse.observation.cost_details") ?? "{}"), {
			input: 0.001,
			output: 0.002,
			total: 0.003,
		});
		assert.equal(attrString(first, "coagent.usage.source")?.includes("single response"), true);
		assert.equal(attrString(first, "coagent.cost.source")?.includes("not a provider invoice"), true);
		// 未知字段留空：不填 0，也不把 null 当成已知。
		assert.deepEqual(JSON.parse(attrString(second, "langfuse.observation.usage_details") ?? "{}"), { output: 9 });
		assert.deepEqual(JSON.parse(attrString(second, "langfuse.observation.cost_details") ?? "{}"), { total: 0.004 });

		// 错误来自该单 assistant 的 stopReason，正文同样脱敏。
		assert.equal(attrString(second, "coagent.stop_reason"), "error");
		assert.equal(attrString(second, "langfuse.observation.level"), "ERROR");
		const serialized = JSON.stringify(spans);
		for (const sentinel of [API_KEY_SENTINEL, PROXY_SENTINEL, PASSWORD_SENTINEL]) {
			assert.equal(serialized.includes(sentinel), false, `凭据/代理地址不得出现在 span：${sentinel}`);
		}

		// 内容：显式开启才带正文，且标出 missing/truncated 与输入来源。
		assert.equal(attrString(first, "coagent.input.source")?.includes("SDK-visible"), true);
		assert.equal((attr(first, "coagent.input.truncated") as { boolValue: boolean }).boolValue, true);
		assert.equal((attr(first, "coagent.output.truncated") as { boolValue: boolean }).boolValue, true);
		assert.ok((attrString(first, "langfuse.observation.input") ?? "").length > 0);
		assert.ok((attrString(first, "langfuse.observation.output") ?? "").length > 0);

		// —— 续跑：同一会话文件重开（此时会话文件仍不存在），序号前进且不重发历史 ——
		assert.equal(existsSync(sessionFile), false, "重开前会话文件仍不存在，恢复只能靠 sidecar");
		const resumedManager = SessionManager.open(sessionFile, dir, dir);
		const resumed = await createLangfuseObserver({
			subject: { missionId: MISSION_ID, workItemId: WORK_ITEM_ID, attemptId: ATTEMPT_ID, role: "executor" },
			profile: { provider: "resolved-provider", model: "resolved-model", reasoning: "medium" },
			deps,
		});
		resumed.attachSessionManager(resumedManager);
		const resumedApi = fakeExtensionApi();
		await resumed.extensionFactory(resumedApi.api);
		const resumedContext = resumedApi.handlers.get("context_with_system");
		assert.ok(resumedContext);
		resumedContext({ type: "context_with_system", messages: [{ role: "system", content: [{ type: "text", text: "s" }] }] });
		resumed.onEvent({ type: "message_start", message: assistantMessage() });
		resumed.onEvent({ type: "message_end", message: assistantMessage() });
		await resumed.flush();
		const appended = spans.slice(2);
		assert.equal(appended.length, 1, "续跑只应新增本次响应，不重发历史调用");
		assert.equal(
			(attr(appended[0], "coagent.call_index") as { intValue: number }).intValue,
			2,
			"序号必须从 sidecar 的耐久高水位继续，而不是按消息条数或从 0 重来",
		);
		// 重开后的预留同样先落盘：sidecar 升到 2，不需要任何 appendMessage。
		assert.equal((JSON.parse(readFileSync(sidecarFile, "utf8")) as { callIndex: number }).callIndex, 2);
		// 观测只写自己的 sidecar，不得创建或改动 SDK 会话文件。
		assert.equal(existsSync(sessionFile), false, "观测不得写 SDK 会话文件");

		// —— 向后兼容：只有 custom entry 的老会话（sidecar 不存在）也能接着编 ——
		const legacyDir = mkdtempSync(join(tmpdir(), "langfuse-observer-legacy-"));
		try {
			const legacyManager = SessionManager.create(legacyDir, legacyDir);
			legacyManager.appendCustomEntry("coagent.langfuse.call-index.v1", {
				attemptId: ATTEMPT_ID,
				callIndex: 6,
			});
			const legacyTransport = captureTransport();
			const legacy = await createLangfuseObserver({
				subject: { missionId: MISSION_ID, attemptId: ATTEMPT_ID, role: "executor" },
				profile: { provider: "resolved-provider", model: "resolved-model", reasoning: "medium" },
				deps: { ...deps, createTransport: () => legacyTransport.transport },
			});
			legacy.attachSessionManager(legacyManager);
			const legacyApi = fakeExtensionApi();
			await legacy.extensionFactory(legacyApi.api);
			legacyApi.handlers.get("context_with_system")?.({ type: "context_with_system", messages: [] });
			legacy.onEvent({ type: "message_start", message: assistantMessage() });
			legacy.onEvent({ type: "message_end", message: assistantMessage() });
			await legacy.flush();
			assert.equal(legacyTransport.spans.length, 1);
			assert.equal(
				(attr(legacyTransport.spans[0], "coagent.call_index") as { intValue: number }).intValue,
				7,
				"已有 custom 序号必须被兼容：取 max(custom high-water, sidecar) + 1",
			);
		} finally {
			rmSync(legacyDir, { recursive: true, force: true });
		}

		// —— 默认 metadata-only：不开启内容时绝不带正文 ——
		const metadataOnly = captureTransport();
		const metadataSession = SessionManager.create(mkdtempSync(join(tmpdir(), "langfuse-observer-meta-")), dir);
		const metadataObserver = await createLangfuseObserver({
			subject: { missionId: MISSION_ID, attemptId: "attempt-metadata", role: "coordinator" },
			profile: { provider: "resolved-provider", model: "resolved-model", reasoning: "high" },
			deps: {
				...deps,
				loadConfig: async () => syntheticConfig({ captureContent: false }),
				createTransport: () => metadataOnly.transport,
			},
		});
		metadataObserver.attachSessionManager(metadataSession);
		const metadataApi = fakeExtensionApi();
		await metadataObserver.extensionFactory(metadataApi.api);
		metadataApi.handlers.get("context_with_system")?.({
			type: "context_with_system",
			messages: [{ role: "user", content: [{ type: "text", text: `secret ${API_KEY_SENTINEL}` }] }],
		});
		metadataObserver.onEvent({ type: "message_start", message: assistantMessage() });
		metadataObserver.onEvent({ type: "message_end", message: assistantMessage() });
		await metadataObserver.flush();
		assert.equal(metadataOnly.spans.length, 1);
		const metadataSpan = metadataOnly.spans[0];
		assert.equal(attr(metadataSpan, "langfuse.observation.input"), undefined);
		assert.equal(attr(metadataSpan, "langfuse.observation.output"), undefined);
		assert.equal(attr(metadataSpan, "coagent.input.source"), undefined);
		assert.equal(attrString(metadataSpan, "langfuse.observation.type"), "GENERATION");
		assert.equal(JSON.stringify(metadataOnly.spans).includes(API_KEY_SENTINEL), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("综合 2：默认关闭/角色不匹配/依赖抛错或挂起时事件不抛、无未处理拒绝、flush 有界，且不改模型路径", async () => {
	const rejections: unknown[] = [];
	const onRejection = (reason: unknown) => rejections.push(reason);
	process.on("unhandledRejection", onRejection);
	const dir = mkdtempSync(join(tmpdir(), "langfuse-observer-off-"));
	try {
		let configReads = 0;

		// 默认关闭：配置不存在等价于 enabled:false。
		const disabled = await createLangfuseObserver({
			subject: { missionId: MISSION_ID, attemptId: ATTEMPT_ID, role: "executor" },
			profile: { provider: "p", model: "m", reasoning: "medium" },
			deps: {
				loadConfig: async () => {
					configReads += 1;
					return { enabled: false };
				},
			},
		});
		assert.equal(disabled.enabled, false);
		const disabledApi = fakeExtensionApi();
		await disabled.extensionFactory(disabledApi.api);
		assert.equal(disabledApi.handlers.size, 0, "关闭时不得注册任何钩子");
		disabled.onEvent({ type: "message_start", message: assistantMessage() });
		disabled.onEvent({ type: "message_end", message: assistantMessage() });
		await disabled.flush();

		// 非协调者/执行者、无 missionId：完全 no-op，连配置都不读。
		for (const subject of [
			{ missionId: MISSION_ID, attemptId: ATTEMPT_ID, role: "query" as const },
			{ missionId: MISSION_ID, attemptId: ATTEMPT_ID, role: "independent_reviewer" as const },
			{ attemptId: ATTEMPT_ID, role: "executor" as const },
		]) {
			const noop = await createLangfuseObserver({
				subject,
				profile: { provider: "p", model: "m", reasoning: "medium" },
				deps: {
					loadConfig: async () => {
						configReads += 1;
						return syntheticConfig();
					},
				},
			});
			assert.equal(noop.enabled, false);
			assert.doesNotThrow(() => noop.onEvent({ type: "message_end", message: assistantMessage() }));
			await noop.flush();
		}
		assert.equal(configReads, 1, "角色/missionId 不匹配时不应读配置");

		// 配置读取抛错 → no-op，不抛给调用者。
		const loadThrows = await createLangfuseObserver({
			subject: { missionId: MISSION_ID, attemptId: ATTEMPT_ID, role: "coordinator" },
			profile: { provider: "p", model: "m", reasoning: "high" },
			deps: {
				loadConfig: async () => {
					throw new Error("config read failed");
				},
			},
		});
		assert.equal(loadThrows.enabled, false);

		// 传输拒绝 / 抛错 / 挂起：事件调用绝不抛，flush 有界返回，无未处理拒绝。
		const enabledConfig = syntheticConfig({ flushTimeoutMs: 50 });
		for (const transport of [
			{ enqueueSpan: () => Promise.reject(new Error("enqueue rejected")), flush: () => Promise.reject(new Error("flush rejected")) },
			{
				enqueueSpan: () => {
					throw new Error("enqueue threw");
				},
				flush: () => Promise.resolve(false),
			},
			// 挂起：既不入队也不结束，flush 只能靠自己的期限返回。
			{ enqueueSpan: () => new Promise<boolean>(() => {}), flush: () => new Promise<boolean>(() => {}) },
		] as LangfuseTransport[]) {
			const manager = SessionManager.create(dir, dir);
			const observer = await createLangfuseObserver({
				subject: { missionId: MISSION_ID, attemptId: ATTEMPT_ID, role: "executor" },
				profile: { provider: "p", model: "m", reasoning: "medium" },
				deps: {
					loadConfig: async () => enabledConfig,
					createTransport: () => transport,
					captureValue,
					stableIds,
				},
			});
			assert.equal(observer.enabled, true);
			observer.attachSessionManager(manager);
			// 序号落点由真实 SessionManager 的临时会话路径给出（不读真实用户会话或凭据）。
			const { api, handlers } = fakeExtensionApi();
			await observer.extensionFactory(api);
			const handler = handlers.get("context_with_system");
			assert.ok(handler);
			const messages = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
			// 事件路径不抛；返回 undefined 意味着请求内容不被替换（工具/模型路径不变）。
			assert.equal(handler({ type: "context_with_system", messages }), undefined);
			assert.doesNotThrow(() => observer.onEvent({ type: "message_start", message: assistantMessage() }));
			assert.doesNotThrow(() => observer.onEvent({ type: "message_end", message: assistantMessage() }));
			assert.doesNotThrow(() => observer.onEvent({ type: "tool_execution_end", toolName: "bash", toolCallId: "c" }));
			const startedAt = Date.now();
			await observer.flush();
			assert.ok(Date.now() - startedAt < 2_000, "flush 必须自带上界，不能等挂起的传输");
		}

		// —— 序号耐久落点不可用：关观测、不抛、不改模型路径，且宁可不导出也不撞号 ——
		// 三种都验：无会话路径、sidecar 损坏、预留时写入失败（目录不存在，不靠权限模拟）。
		const corruptedDir = mkdtempSync(join(tmpdir(), "langfuse-observer-corrupt-"));
		try {
			const corruptedFile = join(corruptedDir, "corrupt.jsonl");
			writeFileSync(callIndexSidecarPath(corruptedFile, ATTEMPT_ID), "{\"version\":1", "utf8");
			const durableFailures: { label: string; manager: { getEntries(): unknown[]; appendCustomEntry(): string; getSessionFile?(): string | undefined } }[] = [
				{
					label: "无 getSessionFile",
					manager: { getEntries: () => [], appendCustomEntry: () => "id" },
				},
				{
					label: "sidecar 损坏",
					manager: { getEntries: () => [], appendCustomEntry: () => "id", getSessionFile: () => corruptedFile },
				},
				{
					label: "预留写入失败",
					manager: {
						getEntries: () => [],
						appendCustomEntry: () => "id",
						// 同目录不存在：临时文件写不进去，等价于磁盘/目录不可写。
						getSessionFile: () => join(corruptedDir, "no-such-dir", "session.jsonl"),
					},
				},
			];
			for (const failure of durableFailures) {
				const spans = captureTransport();
				const observer = await createLangfuseObserver({
					subject: { missionId: MISSION_ID, attemptId: ATTEMPT_ID, role: "executor" },
					profile: { provider: "p", model: "m", reasoning: "medium" },
					deps: {
						loadConfig: async () => enabledConfig,
						createTransport: () => spans.transport,
						captureValue,
						stableIds,
					},
				});
				assert.doesNotThrow(() => observer.attachSessionManager(failure.manager), `${failure.label}：attach 不得抛`);
				const failureApi = fakeExtensionApi();
				await observer.extensionFactory(failureApi.api);
				const messages = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
				// 返回 undefined：上下文不被替换，模型路径不受影响。
				assert.equal(
					failureApi.handlers.get("context_with_system")?.({ type: "context_with_system", messages }),
					undefined,
				);
				assert.doesNotThrow(() => observer.onEvent({ type: "message_start", message: assistantMessage() }), `${failure.label}：start 不得抛`);
				assert.doesNotThrow(() => observer.onEvent({ type: "message_end", message: assistantMessage() }), `${failure.label}：end 不得抛`);
				await observer.flush();
				assert.equal(observer.enabled, false, `${failure.label}：必须关掉本次观测`);
				assert.equal(spans.spans.length, 0, `${failure.label}：序号不能可靠落盘时不得导出记录`);
			}
		} finally {
			rmSync(corruptedDir, { recursive: true, force: true });
		}

		// no-op 观测器本身也可安全调用。
		const noop = createNoopLangfuseObserver();
		assert.equal(noop.enabled, false);
		noop.onEvent({ type: "message_end", message: assistantMessage() });
		await noop.flush();

		// 给拒绝的 promise 一个落地窗口，确认没有任何未处理拒绝。
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.deepEqual(rejections, [], "观测失败不得产生未处理拒绝");

		// —— runtime 生产接线：只读 factory 排在既有 factory 之后、subscribe 首调、
		//    sessionManager 之后 prompt 之前 attach、finally 里有界 flush ——
		assert.match(runtimeSrc, /createLangfuseObserver\(\{[\s\S]*?role: spec\.role[\s\S]*?\}\)/);
		const coagentFactoryIdx = runtimeSrc.indexOf("createCoagentExtension({");
		const observerFactoryIdx = runtimeSrc.indexOf("langfuseObserver.extensionFactory");
		assert.ok(coagentFactoryIdx >= 0 && observerFactoryIdx > coagentFactoryIdx, "观测 factory 必须排在 CoAgent factory 之后");
		const subscribeIdx = runtimeSrc.indexOf("const unsubscribe = session.subscribe((event) => {");
		const observerOnEventIdx = runtimeSrc.indexOf("langfuseObserver.onEvent(event)");
		const firstBranchIdx = runtimeSrc.indexOf('if (event.type === "message_update")');
		const capabilityIdx = runtimeSrc.indexOf("emitEvent(commandActivityCapabilitiesEvent())");
		assert.ok(subscribeIdx >= 0 && observerOnEventIdx > subscribeIdx);
		assert.ok(firstBranchIdx > observerOnEventIdx, "onEvent 必须是订阅回调里最先调用的");
		assert.ok(capabilityIdx > observerOnEventIdx);
		const attachIdx = runtimeSrc.indexOf("langfuseObserver.attachSessionManager(sessionManager)");
		const createSessionIdx = runtimeSrc.indexOf("const { session } = await createAgentSession({");
		const promptIdx = runtimeSrc.indexOf("await session.prompt(spec.instruction)");
		assert.ok(attachIdx > createSessionIdx, "attach 必须在 createAgentSession 之后");
		assert.ok(attachIdx < promptIdx, "attach 必须在 prompt 之前");
		assert.match(runtimeSrc, /finally\s*\{[\s\S]*?await langfuseObserver\.flush\(\)[\s\S]*?\}/);
		// 观测不得读真实认证文件或扩大环境透传。
		assert.doesNotMatch(runtimeSrc, /auth\.json|langfuse\.json|process\.env/);
	} finally {
		process.off("unhandledRejection", onRejection);
		rmSync(dir, { recursive: true, force: true });
	}
});
