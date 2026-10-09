/**
 * runtime query 分支纯合同：装配决策 + queryOutcome 映射。
 * BUDGET-S4：命令活动分类 + capability 发射顺序契约。
 * 不启真实 session / 不连网。
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { createHash } from "node:crypto";
import {
	bindsPlatform,
	classifyActivity,
	commandActivityCapabilitiesEvent,
	createAttemptContextCollector,
	mapQueryOutcome,
	appendXaiQuotaReset,
	toolStartedEvent,
} from "./runtime.js";
import type { AttemptContextMetricsV1 } from "./runtime.js";
import type { Role } from "./roles.js";
import { classifyUpstreamFailure } from "./failure-classify.js";
import { resolveProviderExtensionPaths, registerPendingProviderExtensions } from "./provider-extensions.js";
import { DefaultResourceLoader, ModelRuntime } from "@earendil-works/pi-coding-agent";

const runtimeSrc = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), "runtime.ts"),
	"utf8",
);

/** Test-only driver: same order as startRun (capability, then tool.started). */
function driveCommandActivityProtocol(
	sink: (event: Record<string, unknown>) => void,
	tools: Array<{ name: string; callId: string; detail?: string }> = [],
): void {
	sink(commandActivityCapabilitiesEvent());
	for (const tool of tools) {
		sink(toolStartedEvent(tool));
	}
}

function createFakeProviderPackage(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-provider-extension-"));
	mkdirSync(join(root, "src"));
	writeFileSync(join(root, "package.json"), JSON.stringify({ pi: { extensions: ["./src/index.js"] } }));
	writeFileSync(join(root, "src/index.js"), `export default function (pi) { pi.registerProvider("codebuddy", { models: [{ id: "fake-model", name: "Fake", api: "openai-completions", baseUrl: "http://127.0.0.1", reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 1024 }] }); }`);
	return root;
}

test("CodeBuddy allowlisted extension registers fake provider model", async () => {
	const packageDir = createFakeProviderPackage();
	const cwd = mkdtempSync(join(tmpdir(), "pi-provider-cwd-"));
	const agentDir = mkdtempSync(join(tmpdir(), "pi-provider-agent-"));
	try {
		const paths = resolveProviderExtensionPaths("codebuddy", packageDir);
		assert.equal(paths.length, 1);
		const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, additionalExtensionPaths: paths });
		await loader.reload();
		const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, authPath: join(agentDir, "auth.json") });
		await registerPendingProviderExtensions(loader, runtime);
		assert.ok(runtime.getModel("codebuddy", "fake-model"));
	} finally {
		rmSync(packageDir, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("non-CodeBuddy provider does not load any disk extension", async () => {
	const packageDir = createFakeProviderPackage();
	const cwd = mkdtempSync(join(tmpdir(), "pi-provider-cwd-"));
	const agentDir = mkdtempSync(join(tmpdir(), "pi-provider-agent-"));
	try {
		const paths = resolveProviderExtensionPaths("other", packageDir);
		assert.deepEqual(paths, []);
		const loader = new DefaultResourceLoader({ cwd, agentDir, noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, additionalExtensionPaths: paths });
		await loader.reload();
		assert.equal(loader.getExtensions().extensions.length, 0);
	} finally {
		rmSync(packageDir, { recursive: true, force: true });
		rmSync(cwd, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("xAI quota reset message enhancement is gated, safe, and failure-tolerant", async () => {
	const classification = {
		category: "quota_exhausted", verdict: "do_not_retry", retryable: false,
		retryWithAnotherCandidate: false, basis: "structured", reason: "quota", evidence: ["undici:headers status=403"],
	} as const;
	const original = "403 You have run out of credits or need a Grok subscription";
	const secrets = ["secret-token", "private-user-id", "999.25"];
	let calls = 0;
	const query = async () => {
		calls++;
		return [{ provider: "xai" as const, status: "ok" as const, resetAt: "2030-01-02T03:04:05.000Z" }];
	};
	const success = await appendXaiQuotaReset({ provider: "xai-auth", classification, failureMessage: original, query });
	assert.equal(success, `${original} (quota resets at 2030-01-02T03:04:05.000Z)`);
	for (const secret of secrets) assert.equal(success.includes(secret), false);
	assert.equal(calls, 1);

	for (const overrides of [
		{ provider: "openai" },
		{ provider: "xai", classification: { ...classification, basis: "text" as const }, failureMessage: "403 forbidden" },
		{ provider: "xai", classification: undefined },
	]) {
		const before = calls;
		const result = await appendXaiQuotaReset({ provider: "xai", classification, failureMessage: original, query, ...overrides });
		assert.equal(result, overrides.failureMessage ?? original);
		assert.equal(calls, before);
	}
	for (const badQuery of [
		async () => [],
		async () => [{ provider: "xai" as const, status: "no_auth" as const }],
		async () => [{ provider: "xai" as const, status: "ok" as const, resetAt: "not-a-date" }],
		async () => { throw new Error(secrets.join(" ")); },
	]) {
		const result = await appendXaiQuotaReset({ provider: "xai", classification, failureMessage: original, query: badQuery });
		assert.equal(result, original);
		for (const secret of secrets) assert.equal(result.includes(secret), false);
	}

	// usage 汇总会带出 tenrouter 等 provider 的行；xAI 失败的重置时间只能取自 xAI 自己的行。
	const mixed = await appendXaiQuotaReset({
		provider: "xai",
		classification,
		failureMessage: original,
		query: async () => [
			{ provider: "xai" as const, status: "error" as const },
			{ provider: "tenrouter" as const, status: "ok" as const, resetAt: "2030-01-02T03:04:05.000Z" },
		],
	});
	assert.equal(mixed, original);
});

test("appendXaiQuotaReset：结构化 403 分类允许无 403 文案，其他状态不查用量", async () => {
	const classified = (statusCode: number) => classifyUpstreamFailure({
		modelExists: true,
		provider: "xai",
		model: "grok",
		authConfigured: true,
		transport: [{ kind: "response", statusCode }],
		errorMessage: "You have run out of credits or need a Grok subscription",
	});
	const query = async () => [{ provider: "xai" as const, status: "ok" as const, resetAt: "2030-01-02T03:04:05.000Z" }];
	const quota403 = classified(403);
	assert.equal(quota403.category, "quota_exhausted");
	assert.equal(quota403.basis, "structured");
	assert.equal(await appendXaiQuotaReset({ provider: "xai", classification: quota403, failureMessage: "classified quota", query }), "classified quota (quota resets at 2030-01-02T03:04:05.000Z)");
	for (const status of [402, 500]) {
		const failure = classified(status);
		let calls = 0;
		assert.equal(await appendXaiQuotaReset({ provider: "xai", classification: failure, failureMessage: "classified failure", query: async () => { calls++; return query(); } }), "classified failure");
		assert.equal(calls, 0);
	}
	const conflicting402 = classifyUpstreamFailure({
		modelExists: true, provider: "xai", model: "grok", authConfigured: true,
		transport: [{ kind: "response", statusCode: 402 }],
		errorMessage: "403 You have run out of credits or need a Grok subscription",
	});
	assert.equal(conflicting402.category, "quota_exhausted");
	let conflictingCalls = 0;
	const conflictingMessage = "403 You have run out of credits or need a Grok subscription";
	assert.equal(await appendXaiQuotaReset({ provider: "xai", classification: conflicting402, failureMessage: conflictingMessage, query: async () => { conflictingCalls++; return query(); } }), conflictingMessage);
	assert.equal(conflictingCalls, 0);
});

test("bindsPlatform：query 不装配 platform extension；Mission roles 仍装配", () => {
	assert.equal(bindsPlatform("query"), false);
	for (const role of ["coordinator", "executor", "solo"] as const) {
		assert.equal(bindsPlatform(role), true, `${role} 必须仍装配 platform binding`);
	}
});

test("mapQueryOutcome：成功 => answered，且不依赖 structured_submit", () => {
	assert.equal(
		mapQueryOutcome({
			role: "query",
			endedBy: "no_structured_result",
		}),
		"answered",
	);
	// 即便误出现 structured_submit，只要没有 failure，仍记 answered（不得靠它伪装成功语义）
	assert.equal(
		mapQueryOutcome({
			role: "query",
			endedBy: "structured_submit",
			failureMessage: undefined,
		}),
		"answered",
	);
});

test("mapQueryOutcome：真实 failure / upstream_failure => failed", () => {
	assert.equal(
		mapQueryOutcome({
			role: "query",
			endedBy: "upstream_failure",
			failureMessage: "model blew up",
		}),
		"failed",
	);
	assert.equal(
		mapQueryOutcome({
			role: "query",
			endedBy: "no_structured_result",
			failureMessage: "should not happen but treat as failed",
		}),
		"failed",
	);
});

test("mapQueryOutcome：非 query 角色不产生 queryOutcome", () => {
	for (const role of ["coordinator", "executor", "solo"] as Role[]) {
		assert.equal(
			mapQueryOutcome({
				role,
				endedBy: "structured_submit",
			}),
			undefined,
		);
		assert.equal(
			mapQueryOutcome({
				role,
				endedBy: "no_structured_result",
			}),
			undefined,
		);
		assert.equal(
			mapQueryOutcome({
				role,
				endedBy: "upstream_failure",
				failureMessage: "x",
			}),
			undefined,
		);
	}
});

test("classifyActivity：bash / powershell => command；其余 => other", () => {
	assert.equal(classifyActivity("bash"), "command");
	assert.equal(classifyActivity("powershell"), "command");
	for (const name of [
		"read",
		"edit",
		"write",
		"grep",
		"find",
		"ls",
		"coagent_submit",
		"coagent_brief",
		"coagent_anything",
		"unknown_tool",
	]) {
		assert.equal(classifyActivity(name), "other", `${name} 必须是 other`);
	}
});

test("commandActivityCapabilitiesEvent：固定 v1 capability 载荷", () => {
	assert.deepEqual(commandActivityCapabilitiesEvent(), {
		t: "runtime.capabilities",
		commandActivityClassification: "v1",
	});
});

test("toolStartedEvent：activityClass 来自 classifyActivity", () => {
	const bash = toolStartedEvent({ name: "bash", callId: "c1", detail: "ls" });
	assert.equal(bash.t, "tool.started");
	assert.equal(bash.name, "bash");
	assert.equal(bash.callId, "c1");
	assert.equal(bash.detail, "ls");
	assert.equal(bash.activityClass, "command");
	assert.equal(bash.activityClass, classifyActivity("bash"));

	const read = toolStartedEvent({ name: "read", callId: "c2" });
	assert.equal(read.activityClass, "other");
	assert.equal(read.activityClass, classifyActivity("read"));

	const coagent = toolStartedEvent({ name: "coagent_submit", callId: "c3" });
	assert.equal(coagent.activityClass, "other");
	assert.equal(coagent.activityClass, classifyActivity("coagent_submit"));
});

test("driveCommandActivityProtocol：capability 先于任何 tool.started；零工具仍发 capability", () => {
	const zero: Record<string, unknown>[] = [];
	driveCommandActivityProtocol((e) => zero.push(e));
	assert.equal(zero.length, 1);
	assert.deepEqual(zero[0], {
		t: "runtime.capabilities",
		commandActivityClassification: "v1",
	});

	const withTools: Record<string, unknown>[] = [];
	driveCommandActivityProtocol((e) => withTools.push(e), [
		{ name: "bash", callId: "1" },
		{ name: "read", callId: "2" },
		{ name: "edit", callId: "3" },
	]);
	assert.equal(withTools[0]?.t, "runtime.capabilities");
	assert.equal(withTools[0]?.commandActivityClassification, "v1");
	assert.equal(withTools.length, 4);
	for (let i = 1; i < withTools.length; i++) {
		assert.equal(withTools[i]?.t, "tool.started");
		assert.ok(
			withTools[i]?.activityClass === "command" || withTools[i]?.activityClass === "other",
		);
	}
	assert.equal(withTools[1]?.activityClass, "command");
	assert.equal(withTools[2]?.activityClass, "other");
	assert.equal(withTools[3]?.activityClass, "other");
});

test("source/contract：capability 在 subscribe 之后、prompt 之前同步发射", () => {
	const subscribeIdx = runtimeSrc.indexOf("session.subscribe(");
	const unsubAssignIdx = runtimeSrc.indexOf("const unsubscribe = session.subscribe(");
	const capEmitIdx = runtimeSrc.indexOf("emitEvent(commandActivityCapabilitiesEvent())");
	const promptIdx = runtimeSrc.indexOf("await session.prompt(");

	assert.ok(subscribeIdx >= 0, "必须有 session.subscribe");
	assert.ok(unsubAssignIdx >= 0, "subscribe 必须赋给 unsubscribe");
	assert.ok(capEmitIdx >= 0, "必须 emit commandActivityCapabilitiesEvent");
	assert.ok(promptIdx >= 0, "必须有 session.prompt");
	assert.ok(
		unsubAssignIdx < capEmitIdx,
		"capability 发射必须在 session.subscribe 安装之后",
	);
	assert.ok(capEmitIdx < promptIdx, "capability 发射必须在 session.prompt 之前");

	// 仅此一处 capability 同步声明（exactly once 路径）
	const capMatches = runtimeSrc.match(
		/emitEvent\(\s*commandActivityCapabilitiesEvent\(\)\s*\)/g,
	);
	assert.equal(capMatches?.length, 1, "startRun 内 capability 只应同步发射一次");
});

test("source/contract：tool.started 经 helper 附带 activityClass", () => {
	assert.match(
		runtimeSrc,
		/toolStartedEvent\(\s*\{[\s\S]*?name[\s\S]*?callId[\s\S]*?detail[\s\S]*?\}\s*\)/,
		"tool_execution_start 必须走 toolStartedEvent helper",
	);
	assert.match(
		runtimeSrc,
		/activityClass:\s*classifyActivity\(input\.name\)/,
		"toolStartedEvent 必须用 classifyActivity 填 activityClass",
	);
	// tool.started 载荷不得再手写裸 emit 绕过 helper（除 helper 自身）
	const bareToolStarted = [
		...runtimeSrc.matchAll(/emitEvent\(\s*\{[^}]*t:\s*["']tool\.started["'][^}]*\}/g),
	];
	assert.equal(
		bareToolStarted.length,
		0,
		"不得绕过 toolStartedEvent 直接 emit tool.started",
	);
});

test("bindsPlatform：independent_reviewer 装配 platform extension", () => {
	assert.equal(bindsPlatform("independent_reviewer"), true);
});

test("mapQueryOutcome：independent_reviewer 不产生 queryOutcome", () => {
	assert.equal(
		mapQueryOutcome({
			role: "independent_reviewer",
			endedBy: "structured_submit",
		}),
		undefined,
	);
});

test("source/contract：independent_reviewer 走 toolAllowlist(spec.role) 与 completion.submitted → structured_submit", () => {
	assert.match(runtimeSrc, /tools:\s*toolAllowlist\(spec\.role\)/);
	assert.match(runtimeSrc, /createCoagentExtension\(\{[\s\S]*role:\s*spec\.role/);
	assert.match(
		runtimeSrc,
		/completion\.submitted[\s\S]*\?[\s\S]*"structured_submit"/,
	);
});

const DIGEST_RE = /^[0-9a-f]{64}$/;
const FAKE_CREDENTIAL = "AKIAIOSFODNN7EXAMPLE";
const SECRET_BODY = `password=hunter2 token=${FAKE_CREDENTIAL} /tmp/secrets.env`;

function saltedDigest(salt: Buffer, ...parts: string[]): string {
	const hash = createHash("sha256");
	hash.update(salt);
	for (const part of parts) hash.update(part, "utf8");
	return hash.digest("hex");
}

function startEvent(
	toolName: string,
	toolCallId: string,
	args?: Record<string, unknown>,
): Record<string, unknown> {
	return { type: "tool_execution_start", toolName, toolCallId, args: args ?? {} };
}

function endEvent(
	toolName: string,
	toolCallId: string,
	opts: {
		text?: string | string[];
		content?: unknown;
		isError?: boolean;
		truncated?: boolean;
		result?: unknown;
	} = {},
): Record<string, unknown> {
	const texts = opts.text === undefined ? [] : Array.isArray(opts.text) ? opts.text : [opts.text];
	const content =
		opts.content !== undefined
			? opts.content
			: texts.map((text) => ({ type: "text", text }));
	const result =
		opts.result !== undefined
			? opts.result
			: {
					content,
					details: opts.truncated ? { truncation: { truncated: true } } : {},
			  };
	return {
		type: "tool_execution_end",
		toolName,
		toolCallId,
		result,
		isError: opts.isError === true,
	};
}

const VALID_BRIEF = {
	renderedUtf8Bytes: 42,
	sources: [
		{ source: "project_rules" as const, estimatedTokens: 10, truncated: false },
		{ source: "work_order" as const, truncated: false },
	],
};

function assertNoLeak(metrics: AttemptContextMetricsV1, ...secrets: string[]): void {
	const json = JSON.stringify(metrics);
	assert.ok(Buffer.byteLength(json, "utf8") <= 32 * 1024);
	for (const secret of secrets) {
		assert.equal(json.includes(secret), false, `must not leak ${secret}`);
	}
	assert.equal(json.includes("salt"), false);
	assert.doesNotMatch(json, /"path"\s*:/);
}

function drive(collector: ReturnType<typeof createAttemptContextCollector>, events: unknown[]): AttemptContextMetricsV1 {
	for (const event of events) {
		const type = (event as { type?: string }).type;
		if (type === "tool_execution_start") collector.onToolExecutionStart(event);
		else if (type === "tool_execution_end") collector.onToolExecutionEnd(event);
	}
	return collector.finalize();
}

test("contextMetrics：无观测 → unknown，且不含 brief/tools/reads", () => {
	const metrics = createAttemptContextCollector().finalize();
	assert.deepEqual(metrics, { version: 1, coverage: "unknown" });
	assert.equal("brief" in metrics, false);
	assert.equal("tools" in metrics, false);
	assert.equal("reads" in metrics, false);
});

test("contextMetrics：旧平台 undefined 简报不报 brief", () => {
	const collector = createAttemptContextCollector();
	collector.onBriefInjected(undefined);
	const metrics = collector.finalize();
	assert.equal(metrics.coverage, "unknown");
	assert.equal("brief" in metrics, false);
});

test("contextMetrics：一次合法简报 + 空工具 → complete", () => {
	const collector = createAttemptContextCollector();
	collector.onBriefInjected(VALID_BRIEF);
	const metrics = collector.finalize();
	assert.equal(metrics.coverage, "complete");
	assert.deepEqual(metrics.brief, VALID_BRIEF);
	assert.deepEqual(metrics.tools, []);
	assert.deepEqual(metrics.reads, []);
});

test("contextMetrics：多次简报注入 → partial，保留最后一次实际简报", () => {
	const collector = createAttemptContextCollector();
	collector.onBriefInjected(VALID_BRIEF);
	collector.onBriefInjected({
		renderedUtf8Bytes: 99,
		sources: [{ source: "plan", truncated: true }],
	});
	const metrics = collector.finalize();
	assert.equal(metrics.coverage, "partial");
	assert.deepEqual(metrics.brief, {
		renderedUtf8Bytes: 99,
		sources: [{ source: "plan", truncated: true }],
	});
});

test("contextMetrics：两次同路径同内容 read 聚为 repeats=2", () => {
	const salt = Buffer.from("attempt-salt-aaaaaaaaaaaaaaaaaa");
	const collector = createAttemptContextCollector({ salt });
	collector.onBriefInjected(VALID_BRIEF);
	const metrics = drive(collector, [
		startEvent("read", "c1", { path: "src/a.ts" }),
		endEvent("read", "c1", { text: "hello" }),
		startEvent("read", "c2", { path: "src/a.ts" }),
		endEvent("read", "c2", { text: "hello" }),
	]);
	assert.equal(metrics.coverage, "complete");
	assert.deepEqual(metrics.tools, [{ kind: "read", calls: 2, returnedUtf8Bytes: 10 }]);
	assert.equal(metrics.reads?.length, 1);
	assert.equal(metrics.reads?.[0]?.repeats, 2);
	assert.equal(metrics.reads?.[0]?.pathDigest, saltedDigest(salt, "src/a.ts"));
	assert.equal(metrics.reads?.[0]?.contentDigest, saltedDigest(salt, "hello"));
	assert.match(metrics.reads?.[0]?.pathDigest ?? "", DIGEST_RE);
	assert.match(metrics.reads?.[0]?.contentDigest ?? "", DIGEST_RE);
	assertNoLeak(metrics, "src/a.ts", "hello");
});

test("contextMetrics：同路径改内容 read 分桶", () => {
	const salt = Buffer.from("attempt-salt-bbbbbbbbbbbbbbbbbb");
	const collector = createAttemptContextCollector({ salt });
	collector.onBriefInjected(VALID_BRIEF);
	const metrics = drive(collector, [
		startEvent("read", "c1", { path: "src/a.ts" }),
		endEvent("read", "c1", { text: "v1" }),
		startEvent("read", "c2", { path: "src/a.ts" }),
		endEvent("read", "c2", { text: "v2" }),
	]);
	assert.equal(metrics.coverage, "complete");
	assert.equal(metrics.reads?.length, 2);
	assert.equal(metrics.reads?.[0]?.pathDigest, metrics.reads?.[1]?.pathDigest);
	assert.notEqual(metrics.reads?.[0]?.contentDigest, metrics.reads?.[1]?.contentDigest);
	assert.equal(metrics.reads?.[0]?.repeats, 1);
	assert.equal(metrics.reads?.[1]?.repeats, 1);
	assert.equal(metrics.reads?.[0]?.contentDigest, saltedDigest(salt, "v1"));
	assert.equal(metrics.reads?.[1]?.contentDigest, saltedDigest(salt, "v2"));
});

test("contextMetrics：五类工具按可见 text UTF-8 计数，非 read 不分桶", () => {
	const collector = createAttemptContextCollector();
	collector.onBriefInjected(VALID_BRIEF);
	const metrics = drive(collector, [
		startEvent("read", "r1", { path: "f.ts" }),
		endEvent("read", "r1", { text: "ä" }),
		startEvent("grep", "g1", { pattern: "x" }),
		endEvent("grep", "g1", { text: "hit" }),
		startEvent("find", "f1", { pattern: "*.ts" }),
		endEvent("find", "f1", { text: "" }),
		startEvent("ls", "l1", { path: "." }),
		endEvent("ls", "l1", { text: ["a", "b"] }),
		startEvent("bash", "b1", { command: "pwd" }),
		endEvent("bash", "b1", { text: "/tmp" }),
		startEvent("edit", "e1", { path: "f.ts" }),
		endEvent("edit", "e1", { text: SECRET_BODY }),
	]);
	assert.equal(metrics.coverage, "complete");
	assert.deepEqual(metrics.tools, [
		{ kind: "read", calls: 1, returnedUtf8Bytes: 2 },
		{ kind: "grep", calls: 1, returnedUtf8Bytes: 3 },
		{ kind: "find", calls: 1, returnedUtf8Bytes: 0 },
		{ kind: "ls", calls: 1, returnedUtf8Bytes: 2 },
		{ kind: "bash", calls: 1, returnedUtf8Bytes: 4 },
	]);
	assert.equal(metrics.reads?.length, 1);
	assertNoLeak(metrics, SECRET_BODY, FAKE_CREDENTIAL, "f.ts", "/tmp", "hunter2");
});

test("contextMetrics：失败 / 缺失结果不猜字节；截断与无 end 为 partial", () => {
	const collector = createAttemptContextCollector();
	collector.onBriefInjected(VALID_BRIEF);
	collector.onToolExecutionStart(startEvent("bash", "ok", { command: "echo" }));
	collector.onToolExecutionEnd(endEvent("bash", "ok", { text: "hi" }));
	collector.onToolExecutionStart(startEvent("bash", "err", { command: "false" }));
	collector.onToolExecutionEnd(endEvent("bash", "err", { text: "boom", isError: true }));
	collector.onToolExecutionStart(startEvent("grep", "miss", { pattern: "x" }));
	collector.onToolExecutionEnd(endEvent("grep", "miss", { result: {} }));
	collector.onToolExecutionStart(startEvent("read", "cut", { path: "big.ts" }));
	collector.onToolExecutionEnd(
		endEvent("read", "cut", { text: "visible-head", truncated: true }),
	);
	collector.onToolExecutionStart(startEvent("ls", "hang", { path: "." }));
	const metrics = collector.finalize();
	assert.equal(metrics.coverage, "partial");
	const bash = metrics.tools?.find((t) => t.kind === "bash");
	const grep = metrics.tools?.find((t) => t.kind === "grep");
	const read = metrics.tools?.find((t) => t.kind === "read");
	const ls = metrics.tools?.find((t) => t.kind === "ls");
	assert.deepEqual(bash, { kind: "bash", calls: 2, returnedUtf8Bytes: 2 });
	assert.deepEqual(grep, { kind: "grep", calls: 1, returnedUtf8Bytes: 0 });
	assert.deepEqual(read, { kind: "read", calls: 1, returnedUtf8Bytes: 12 });
	assert.deepEqual(ls, { kind: "ls", calls: 1, returnedUtf8Bytes: 0 });
	assert.equal(metrics.reads?.length, 1);
	assertNoLeak(metrics, "boom", "visible-head", "big.ts");
});

test("contextMetrics：image / 未知 content 不推断，coverage 降 partial", () => {
	const collector = createAttemptContextCollector();
	collector.onBriefInjected(VALID_BRIEF);
	collector.onToolExecutionStart(startEvent("read", "img", { path: "x.png" }));
	collector.onToolExecutionEnd(
		endEvent("read", "img", {
			content: [{ type: "image", mimeType: "image/png", data: "aaaa" }],
		}),
	);
	const metrics = collector.finalize();
	assert.equal(metrics.coverage, "partial");
	assert.deepEqual(metrics.tools, [{ kind: "read", calls: 1, returnedUtf8Bytes: 0 }]);
});

test("contextMetrics：无 brief 但有工具观测 → partial 且不报 brief", () => {
	const collector = createAttemptContextCollector();
	collector.onBriefInjected(undefined);
	const metrics = drive(collector, [
		startEvent("grep", "g1"),
		endEvent("grep", "g1", { text: "x" }),
	]);
	assert.equal(metrics.coverage, "partial");
	assert.equal("brief" in metrics, false);
	assert.deepEqual(metrics.tools, [{ kind: "grep", calls: 1, returnedUtf8Bytes: 1 }]);
});

test("contextMetrics：read 超 64 桶 → partial 且 reads.length===64", () => {
	const collector = createAttemptContextCollector();
	collector.onBriefInjected(VALID_BRIEF);
	for (let i = 0; i < 65; i++) {
		const id = `r${i}`;
		collector.onToolExecutionStart(startEvent("read", id, { path: `f${i}.ts` }));
		collector.onToolExecutionEnd(endEvent("read", id, { text: `body-${i}` }));
	}
	const metrics = collector.finalize();
	assert.equal(metrics.coverage, "partial");
	assert.equal(metrics.reads?.length, 64);
	assert.equal(metrics.tools?.[0]?.calls, 65);
});

test("contextMetrics：每 Attempt 单独随机盐，序列化无盐/路径/正文", () => {
	const a = createAttemptContextCollector();
	const b = createAttemptContextCollector();
	a.onBriefInjected(VALID_BRIEF);
	b.onBriefInjected(VALID_BRIEF);
	const ma = drive(a, [
		startEvent("read", "c1", { path: SECRET_BODY }),
		endEvent("read", "c1", { text: SECRET_BODY }),
	]);
	const mb = drive(b, [
		startEvent("read", "c1", { path: SECRET_BODY }),
		endEvent("read", "c1", { text: SECRET_BODY }),
	]);
	assert.notEqual(ma.reads?.[0]?.pathDigest, mb.reads?.[0]?.pathDigest);
	assert.notEqual(ma.reads?.[0]?.contentDigest, mb.reads?.[0]?.contentDigest);
	assert.match(ma.reads?.[0]?.pathDigest ?? "", DIGEST_RE);
	assertNoLeak(ma, SECRET_BODY, FAKE_CREDENTIAL, "hunter2");
	assertNoLeak(mb, SECRET_BODY, FAKE_CREDENTIAL);
});

test("contextMetrics：不从 usage 猜结果", () => {
	const collector = createAttemptContextCollector();
	collector.onBriefInjected(VALID_BRIEF);
	collector.onToolExecutionStart(startEvent("bash", "c1"));
	collector.onToolExecutionEnd({
		type: "tool_execution_end",
		toolName: "bash",
		toolCallId: "c1",
		isError: false,
		result: { content: [{ type: "text", text: "ok" }], details: {}, usage: { input: 99, output: 99, total: 198 } },
	});
	const metrics = collector.finalize();
	assert.deepEqual(metrics.tools, [{ kind: "bash", calls: 1, returnedUtf8Bytes: 2 }]);
	assert.equal(JSON.stringify(metrics).includes("198"), false);
});

test("source/contract：startRun 每 Attempt 建采集器、接 onBriefInjected、终态带 contextMetrics", () => {
	assert.match(runtimeSrc, /const contextCollector = createAttemptContextCollector\(\)/);
	assert.match(
		runtimeSrc,
		/onBriefInjected:\s*\(brief\)\s*=>\s*contextCollector\.onBriefInjected\(brief\)/,
	);
	assert.match(runtimeSrc, /contextCollector\.onToolExecutionStart\(event\)/);
	assert.match(runtimeSrc, /contextCollector\.onToolExecutionEnd\(event\)/);
	assert.match(runtimeSrc, /contextMetrics:\s*contextCollector\.finalize\(\)/);
	assert.match(runtimeSrc, /randomBytes\(/);
	assert.match(runtimeSrc, /createHash\(["']sha256["']\)/);
	assert.doesNotMatch(runtimeSrc, /cacheRead[\s\S]{0,80}returnedUtf8Bytes/);
	assert.doesNotMatch(runtimeSrc, /\btextParts\b/);
});

test("contextMetrics：重复未配对 toolCallId 两个 start 一个 end 不可能 complete", () => {
	const salt = Buffer.from("attempt-salt-cccccccccccccccccc");
	const collector = createAttemptContextCollector({ salt });
	collector.onBriefInjected(VALID_BRIEF);
	const metrics = drive(collector, [
		startEvent("read", "same", { path: "src/a.ts" }),
		startEvent("read", "same", { path: "src/a.ts" }),
		endEvent("read", "same", { text: "hello" }),
	]);
	assert.equal(metrics.coverage, "partial");
	assert.notEqual(metrics.coverage, "complete");
	assert.deepEqual(metrics.tools, [{ kind: "read", calls: 2, returnedUtf8Bytes: 5 }]);
	assert.equal(metrics.reads?.length, 1);
	assert.equal(metrics.reads?.[0]?.repeats, 1);
	assert.equal(metrics.reads?.[0]?.contentDigest, saltedDigest(salt, "hello"));
	assertNoLeak(metrics, "src/a.ts", "hello");
});

test("contextMetrics：多 text 块流式计数与摘要，不缓存正文", () => {
	const salt = Buffer.from("attempt-salt-dddddddddddddddddd");
	const collector = createAttemptContextCollector({ salt });
	collector.onBriefInjected(VALID_BRIEF);
	const metrics = drive(collector, [
		startEvent("read", "c1", { path: "src/a.ts" }),
		endEvent("read", "c1", { text: ["α", "hello", "世界"] }),
	]);
	const expectedBytes =
		Buffer.byteLength("α", "utf8") +
		Buffer.byteLength("hello", "utf8") +
		Buffer.byteLength("世界", "utf8");
	assert.equal(metrics.coverage, "complete");
	assert.deepEqual(metrics.tools, [{ kind: "read", calls: 1, returnedUtf8Bytes: expectedBytes }]);
	assert.equal(metrics.reads?.[0]?.pathDigest, saltedDigest(salt, "src/a.ts"));
	assert.equal(metrics.reads?.[0]?.contentDigest, saltedDigest(salt, "α", "hello", "世界"));
	assertNoLeak(metrics, "α", "hello", "世界", "src/a.ts");
});

test("contextMetrics：大结果即时计数与摘要且序列化不含正文", () => {
	const salt = Buffer.from("attempt-salt-eeeeeeeeeeeeeeeeee");
	const collector = createAttemptContextCollector({ salt });
	collector.onBriefInjected(VALID_BRIEF);
	const big = "密".repeat(50_000);
	const metrics = drive(collector, [
		startEvent("read", "c1", { path: "/tmp/huge.bin" }),
		endEvent("read", "c1", { text: big }),
		startEvent("bash", "b1"),
		endEvent("bash", "b1", { text: big }),
	]);
	const bytes = Buffer.byteLength(big, "utf8");
	assert.equal(metrics.coverage, "complete");
	assert.deepEqual(metrics.tools, [
		{ kind: "read", calls: 1, returnedUtf8Bytes: bytes },
		{ kind: "bash", calls: 1, returnedUtf8Bytes: bytes },
	]);
	assert.equal(metrics.reads?.[0]?.contentDigest, saltedDigest(salt, big));
	assertNoLeak(metrics, big, "/tmp/huge.bin", "密");
	assert.ok(Buffer.byteLength(JSON.stringify(metrics), "utf8") < 4096);
});

test("contextMetrics：遍历 content 抛错仍 partial 且不猜字节", () => {
	const collector = createAttemptContextCollector();
	collector.onBriefInjected(VALID_BRIEF);
	collector.onToolExecutionStart(startEvent("grep", "g1"));
	collector.onToolExecutionEnd({
		type: "tool_execution_end",
		toolName: "grep",
		toolCallId: "g1",
		isError: false,
		result: {
			content: [
				{
					type: "text",
					get text() {
						throw new Error("cannot materialize");
					},
				},
			],
		},
	});
	const metrics = collector.finalize();
	assert.equal(metrics.coverage, "partial");
	assert.deepEqual(metrics.tools, [{ kind: "grep", calls: 1, returnedUtf8Bytes: 0 }]);
});
