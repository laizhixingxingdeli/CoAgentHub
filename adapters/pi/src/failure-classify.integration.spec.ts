/**
 * src/failure-classify.ts + src/transport-evidence.ts 的**集成**测试。
 *
 * 跑法：npx tsx --test src/failure-classify.integration.spec.ts
 *
 * 为什么要这一层：单元测试喂的是夹具，证明的是"分类函数按输入判对了"。但真正
 * 要证的是**证据本身能从真实请求里拿到**——provider SDK 把 429 / ECONNREFUSED
 * 吞成一句文案的时候，undici 诊断通道到底给不给真实状态码/错误码。
 *
 * 所以这里起一个本地 mock HTTP server + 一个注册进 ModelRuntime 的 mock provider，
 * 真发一次请求，再用 recordTransport() 收证据、喂给分类器。**触发的是本地
 * mock，不是真的限流或封号**，可以随便重复跑、离线跑。
 *
 * 覆盖：429（限流）、401（凭据被拒）、content_filter（内容合规）、假域名 DNS。
 */

import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
	createAgentSession,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

import { classifyUpstreamFailure, type FailureDiagnostic } from "./failure-classify.js";
import { installHttpDispatcher } from "./http.js";
import { observationsForOrigin, originOf, recordTransport } from "./transport-evidence.js";

// 本测试只打本机 localhost 和一个保证解析不了的假域名：必须绕开环境里的代理，
// 否则请求走代理，观察到的就不是本机网络栈的行为（实测：走代理时 DNS 失败被
// 代理转成 ECONNRESET，而不是 ENOTFOUND）。必须在 installHttpDispatcher() 之前设好。
const proxyKeys = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"];
const originalProxyEnv = new Map(proxyKeys.map((key) => [key, process.env[key]]));
for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) {
	process.env[key] = "";
}
process.env.NO_PROXY = "127.0.0.1,localhost";
process.env.no_proxy = "127.0.0.1,localhost";
installHttpDispatcher();

const servers: http.Server[] = [];
const configDirs: string[] = [];
after(async () => {
	for (const server of servers) server.close();
	await Promise.all(configDirs.map((dir) => rm(dir, { recursive: true, force: true })));
	for (const [key, value] of originalProxyEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

/** 起一个本地 mock server，返回固定响应，返回 (baseUrl, close)。 */
async function mockServer(
	handle: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<string> {
	const server = http.createServer((req, res) => {
		console.info(`[integration] local mock request ${req.method} ${req.url}`);
		handle(req, res);
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const port = (server.address() as { port: number }).port;
	return `http://127.0.0.1:${port}/v1`;
}

let providerSeq = 0;

/** 注册一个指向 baseUrl 的 mock provider，真跑一次，返回 assistant 消息与传输观察。 */
async function runOnce(baseUrl: string): Promise<{
	assistant:
		| { stopReason?: string; errorMessage?: string; rawStopReason?: string; diagnostics?: FailureDiagnostic[] }
		| undefined;
	transport: ReturnType<ReturnType<typeof recordTransport>["observations"]>;
}> {
	installHttpDispatcher();
	const isolatedDir = await mkdtemp(path.join(os.tmpdir(), "coagent-pi-test-"));
	configDirs.push(isolatedDir);
	const runtime = await ModelRuntime.create();
	const providerId = `mock-provider-${providerSeq++}`;
	runtime.registerProvider(providerId, {
		name: "Mock",
		baseUrl,
		apiKey: "mock-key",
		api: "openai-completions",
		models: [
			{
				id: "mock-model",
				name: "Mock Model",
				api: "openai-completions",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100_000,
				maxTokens: 1_000,
			},
		],
	});
	const model = runtime.getModel(providerId, "mock-model")!;

	const { session } = await createAgentSession({
		model,
		thinkingLevel: "off",
		modelRuntime: runtime,
		sessionManager: SessionManager.inMemory(),
		agentDir: isolatedDir,
		cwd: isolatedDir,
		noTools: "all",
	});

	let assistant: Awaited<ReturnType<typeof runOnce>>["assistant"];
	session.subscribe((event) => {
		if (event.type !== "agent_end") return;
		for (const message of (event as { messages?: unknown[] }).messages ?? []) {
			const m = message as {
				role?: string;
				stopReason?: string;
				errorMessage?: string;
				rawStopReason?: string;
				diagnostics?: FailureDiagnostic[];
			};
			if (m.role === "assistant" && m.stopReason === "error") assistant = m;
		}
	});

	const recorder = recordTransport();
	try {
		await session.prompt("回两个字：可用");
	} catch {
		/* 失败正是我们要观察的 */
	} finally {
		recorder.stop();
	}
	session.dispose();

	// 只留 provider 那一次请求的观察，排除平台自身的调用。
	const transport = observationsForOrigin(recorder.observations(), originOf(model.baseUrl));
	return { assistant, transport };
}

test("真发一次 429 请求：undici 给出真实 statusCode=429，分类为限流", { timeout: 60_000 }, async () => {
	const baseUrl = await mockServer((_req, res) => {
		res.writeHead(429, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { message: "Rate limit reached, please retry later", type: "rate_limit_exceeded" } }));
	});

	const { assistant, transport } = await runOnce(baseUrl);

	assert.ok(
		transport.some((o) => o.kind === "response" && o.statusCode === 429),
		`undici 必须给出 429，实际：${JSON.stringify(transport)}`,
	);

	const c = classifyUpstreamFailure({
		modelExists: true,
		provider: "mock",
		model: "mock-model",
		authConfigured: true,
		stopReason: assistant?.stopReason,
		rawStopReason: assistant?.rawStopReason,
		diagnostics: assistant?.diagnostics,
		transport,
		errorMessage: assistant?.errorMessage,
	});
	assert.equal(c.category, "rate_limited");
	assert.equal(c.basis, "structured");
	assert.equal(c.retryable, true);
	assert.equal(c.retryWithAnotherCandidate, false);
});

test("真发一次 401 请求：凭据被拒，不重试", { timeout: 60_000 }, async () => {
	const baseUrl = await mockServer((_req, res) => {
		res.writeHead(401, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" } }));
	});

	const { assistant, transport } = await runOnce(baseUrl);
	assert.ok(transport.some((o) => o.kind === "response" && o.statusCode === 401));

	const c = classifyUpstreamFailure({
		modelExists: true,
		provider: "mock",
		model: "mock-model",
		authConfigured: true,
		stopReason: assistant?.stopReason,
		transport,
		errorMessage: assistant?.errorMessage,
	});
	assert.equal(c.category, "credentials");
	assert.equal(c.basis, "structured");
	assert.equal(c.retryable, false);
});

test("模型回了但 finish_reason=content_filter：rawStopReason 是结构化信号", { timeout: 60_000 }, async () => {
	const baseUrl = await mockServer((_req, res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write(
			`data: ${JSON.stringify({
				id: "x",
				object: "chat.completion.chunk",
				created: 1,
				model: "mock-model",
				choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }],
			})}\n\n`,
		);
		res.write("data: [DONE]\n\n");
		res.end();
	});

	const { assistant, transport } = await runOnce(baseUrl);
	assert.equal(assistant?.rawStopReason, "content_filter", "provider 原生停止原因必须带回来");

	const c = classifyUpstreamFailure({
		modelExists: true,
		provider: "mock",
		model: "mock-model",
		authConfigured: true,
		stopReason: assistant?.stopReason,
		rawStopReason: assistant?.rawStopReason,
		transport,
		errorMessage: assistant?.errorMessage,
	});
	assert.equal(c.category, "content_blocked");
	assert.equal(c.basis, "structured");
	assert.equal(c.retryable, false);
});

test("真发一次 DNS 解析不了的请求：undici 给出 ENOTFOUND，分类为网络", { timeout: 60_000 }, async () => {
	const { assistant, transport } = await runOnce("https://no-such-host-coagent-test.invalid/v1");

	assert.ok(
		transport.some((o) => o.kind === "error" && o.errorCode === "ENOTFOUND"),
		`undici 必须给出 ENOTFOUND，实际：${JSON.stringify(transport)}`,
	);

	const c = classifyUpstreamFailure({
		modelExists: true,
		provider: "mock",
		model: "mock-model",
		authConfigured: true,
		stopReason: assistant?.stopReason,
		transport,
		errorMessage: assistant?.errorMessage,
	});
	assert.equal(c.category, "network");
	assert.equal(c.basis, "structured");
	assert.equal(c.retryWithAnotherCandidate, false);
});
