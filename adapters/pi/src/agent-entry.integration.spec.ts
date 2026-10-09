/**
 * agent-entry → startRun → 新 SDK 会话的组合证据。
 *
 * 不是入口端到端实测：startRun 内部 `ModelRuntime.create()` 之后立刻
 * `getModel`，没有 registerProvider / modelsPath 注入点；不得改
 * agent-entry.ts，也不为测试给 runtime.ts 加接缝。因此拆成两段：
 * 1. 子进程跑 agent-entry（stdin spec → startRun），用故意不存在的
 *    provider/model，在建会话之前以「模型不可用」收尾；
 * 2. 本进程里给 ModelRuntime.create 打补丁注册本地假提供方，再调
 *    startRun，真建会话、真发请求，只打 127.0.0.1。
 *
 * 跑法：node --import tsx --test src/agent-entry.integration.spec.ts
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { installHttpDispatcher } from "./http.js";
import { startRun } from "./runtime.js";
import type { AgentRunSpec } from "./runtime.js";
import type { Role } from "./roles.js";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SRC_DIR, "..");
const ENTRY_PATH = join(SRC_DIR, "agent-entry.ts");
const entrySrc = readFileSync(ENTRY_PATH, "utf8");
const runtimeSrc = readFileSync(join(SRC_DIR, "runtime.ts"), "utf8");
const OUTCOME_PREFIX = "__COAGENT_OUTCOME__ ";

// 只打本机假服务：必须绕开环境代理，否则观察到的不是 127.0.0.1。
for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) {
	process.env[key] = "";
}
process.env.NO_PROXY = "127.0.0.1,localhost";
process.env.no_proxy = "127.0.0.1,localhost";
installHttpDispatcher();

const servers: http.Server[] = [];
const tempDirs: string[] = [];
after(() => {
	for (const server of servers) server.close();
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi1-agent-entry-"));
	tempDirs.push(dir);
	return dir;
}

/** 起一个本地 mock，返回固定响应，并把请求体记下来。 */
async function mockServer(
	handle: (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void,
): Promise<string> {
	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk) => chunks.push(chunk as Buffer));
		req.on("end", () => {
			handle(req, res, Buffer.concat(chunks).toString("utf8"));
		});
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const port = (server.address() as { port: number }).port;
	return `http://127.0.0.1:${port}/v1`;
}

function sseAssistantText(text: string): string {
	const first = {
		id: "x",
		object: "chat.completion.chunk",
		created: 1,
		model: "mock-model",
		choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
	};
	const last = {
		id: "x",
		object: "chat.completion.chunk",
		created: 1,
		model: "mock-model",
		choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
	};
	return `data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(last)}\n\ndata: [DONE]\n\n`;
}

/** 与 sseAssistantText 同形，但允许自定义 finish_reason（例如 length 表示被截断）。 */
function sseAssistantFinish(text: string, finishReason: string): string {
	const first = {
		id: "x",
		object: "chat.completion.chunk",
		created: 1,
		model: "mock-model",
		choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
	};
	const last = {
		id: "x",
		object: "chat.completion.chunk",
		created: 1,
		model: "mock-model",
		choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
	};
	return `data: ${JSON.stringify(first)}\n\ndata: ${JSON.stringify(last)}\n\ndata: [DONE]\n\n`;
}

function leadingSystemText(body: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return body;
	}
	const bag = parsed as { messages?: unknown; input?: unknown };
	const messages = bag.messages ?? bag.input;
	if (!Array.isArray(messages) || messages.length === 0) return body;
	const first = messages[0] as { role?: string; content?: unknown };
	if (typeof first.content === "string") return first.content;
	return JSON.stringify(first.content ?? first);
}

function childEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy"]) {
		env[key] = "";
	}
	env.NO_PROXY = "127.0.0.1,localhost";
	env.no_proxy = "127.0.0.1,localhost";
	// 子进程不得依赖真 key：即使目录里碰巧有同名模型，也不该打到付费端。
	for (const key of Object.keys(env)) {
		if (/API_KEY$/i.test(key)) delete env[key];
	}
	return env;
}

function parseOutcome(stdout: string): Record<string, unknown> {
	const line = stdout.split(/\r?\n/).find((row) => row.startsWith(OUTCOME_PREFIX));
	assert.ok(line, "stdout 必须有 __COAGENT_OUTCOME__ 行（不把整段 stdout 打出来，避免夹杂环境噪声）");
	return JSON.parse(line.slice(OUTCOME_PREFIX.length)) as Record<string, unknown>;
}

function runAgentEntry(spec: AgentRunSpec): Promise<{ stdout: string; code: number | null }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--import", "tsx", ENTRY_PATH], {
			cwd: REPO_ROOT,
			env: childEnv(),
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		const out: Buffer[] = [];
		child.stdout.on("data", (chunk) => out.push(chunk as Buffer));
		child.stderr.on("data", () => {
			/* 失败栈留给进程自己的 stderr；断言只看 outcome，避免把环境噪声带进报告 */
		});
		child.on("error", reject);
		child.on("close", (code) => {
			resolve({ stdout: Buffer.concat(out).toString("utf8"), code });
		});
		child.stdin.end(JSON.stringify(spec), "utf8");
	});
}

let mockProviderSeq = 0;

async function withMockProviderOnCreate<T>(
	baseUrl: string,
	fn: (providerId: string) => Promise<T>,
): Promise<T> {
	const providerId = `pi1-mock-${mockProviderSeq++}`;
	const runtimeStatic = ModelRuntime as unknown as { create: typeof ModelRuntime.create };
	const originalCreate = runtimeStatic.create;
	runtimeStatic.create = async (options) => {
		const runtime = await originalCreate(options);
		runtime.registerProvider(providerId, {
			name: "PI1 Mock",
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
		return runtime;
	};
	try {
		return await fn(providerId);
	} finally {
		runtimeStatic.create = originalCreate;
	}
}

test("source/contract：agent-entry 从 stdin 解析 spec 并只通过 startRun 建会话", () => {
	assert.match(entrySrc, /import\s*\{\s*startRun\s*\}\s*from\s*["']\.\/runtime\.js["']/);
	assert.match(entrySrc, /JSON\.parse\(raw\)\s*as\s*AgentRunSpec/);
	assert.match(entrySrc, /startRun\(\s*\{\s*\.\.\.spec,\s*stream:\s*true\s*\}\s*\)/);
	assert.match(entrySrc, /__COAGENT_OUTCOME__/);
	assert.doesNotMatch(entrySrc, /createAgentSession/);
	assert.doesNotMatch(entrySrc, /session\.prompt/);
	assert.doesNotMatch(entrySrc, /registerProvider/);
});

test("source/contract：startRun 经 ModelRuntime.create / createAgentSession / session.prompt，无假提供方注入点", () => {
	assert.match(runtimeSrc, /const modelRuntime = await ModelRuntime\.create\(\)/);
	assert.match(runtimeSrc, /additionalExtensionPaths:\s*resolveProviderExtensionPaths\(profile\.provider\)/);
	assert.match(runtimeSrc, /noExtensions:\s*true[\s\S]*?noSkills:\s*true[\s\S]*?noPromptTemplates:\s*true[\s\S]*?noContextFiles:\s*true/);
	assert.match(runtimeSrc, /await resourceLoader\.reload\(\);\s*await registerPendingProviderExtensions\(resourceLoader, modelRuntime\);[\s\S]*?modelRuntime\.getModel\(profile\.provider, profile\.model\)/);
	assert.match(runtimeSrc, /SessionManager\.create\(/);
	assert.match(runtimeSrc, /const \{ session \} = await createAgentSession\(/);
	assert.match(runtimeSrc, /await session\.prompt\(spec\.instruction\)/);
	assert.doesNotMatch(runtimeSrc, /runtime\.registerProvider/);
	assert.doesNotMatch(runtimeSrc, /shouldStopAfterTurn/);
	assert.doesNotMatch(runtimeSrc, /session\.agent\.state\.messages\s*=/);
	assert.doesNotMatch(runtimeSrc, /ExtensionRunner/);
	assert.doesNotMatch(runtimeSrc, /agent_settled/);
	assert.doesNotMatch(runtimeSrc, /user_bash/);
});

test(
	"子进程跑 agent-entry：未知 facts 身份在建会话前失败，证明入口调用了 startRun",
	{ timeout: 60_000 },
	async () => {
		const cwd = scratchDir();
		const sessionDir = scratchDir();
		const { stdout, code } = await runAgentEntry({
			role: "query",
			attemptId: "pi1-entry-probe",
			cwd,
			sessionDir,
			profile: {
				profileId: "pi1-no-such",
				facts: [
					{ key: "provider", value: "coagent-pi1-no-such-provider" },
					{ key: "model", value: "no-such-model" },
					{ key: "reasoning", value: "off" },
				],
			},
			instruction: "不得发往真实提供方",
			endpoint: { baseUrl: "http://127.0.0.1:1", token: "none" },
		});
		assert.equal(code, 0, "agent-entry 失败也 exit 0，靠 stdout 的 outcome 说话");
		const outcome = parseOutcome(stdout);
		assert.equal(outcome.endedBy, "upstream_failure");
		assert.match(String(outcome.failureMessage ?? ""), /模型不可用/);
		assert.match(String(outcome.failureMessage ?? ""), /coagent-pi1-no-such-provider/);
	},
);

test(
	"startRun 在新 SDK 下用本地假提供方建会话并完成请求（不经 agent-entry 进程）",
	{ timeout: 60_000 },
	async () => {
		const bodies: string[] = [];
		const baseUrl = await mockServer((_req, res, body) => {
			bodies.push(body);
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end(sseAssistantText("pi1-sdk-ok"));
		});
		const cwd = scratchDir();
		const sessionDir = scratchDir();

		// startRun 的 emitEvent 无条件写 stdout（不受 spec.stream 控制）。
		// --test 下本文件跑在子进程里，测试结果经 process.stdout.write 以二进制报文回传运行器；
		// 若把 write 整体换成空函数，积压的结果报文（尤其是前一条子进程测试的 pass）会被一起吞掉，闸门就看不见失败。
		// 只过滤 startRun 的协议事件行；其余写入（尤其是 Buffer / 非字符串）原样交给原来的 write。
		const originalWrite = process.stdout.write.bind(process.stdout);
		const EVENT_PREFIX = "__COAGENT_EVENT__ ";
		process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
			if (typeof chunk === "string" && chunk.includes(EVENT_PREFIX)) {
				return true;
			}
			return (originalWrite as (chunk: unknown, ...rest: unknown[]) => boolean)(chunk, ...rest);
		}) as typeof process.stdout.write;
		let outcome: Awaited<ReturnType<typeof startRun>>;
		try {
			outcome = await withMockProviderOnCreate(baseUrl, async (providerId) =>
				startRun({
					role: "solo",
					attemptId: "pi1-session-probe",
					cwd,
					sessionDir,
					profile: {
						profileId: "pi1-mock",
						facts: [
							{ key: "provider", value: providerId },
							{ key: "model", value: "mock-model" },
							{ key: "reasoning", value: "off" },
						],
					},
					instruction: "回这六个字：pi1-sdk-ok",
					endpoint: { baseUrl: "http://127.0.0.1:1", token: "none" },
					stream: false,
				}),
			);
		} finally {
			process.stdout.write = originalWrite;
		}

		assert.ok(bodies.length > 0, "假提供方必须收到至少一次请求");
		// solo 的 before_agent_start 返回 systemPrompt("solo")（不含 COMMON/CoAgentHub）。
		const leading = leadingSystemText(bodies[0] ?? "");
		assert.match(leading, /你是一个编码 agent/);
		assert.match(leading, /独自完成下面这个任务/);
		assert.equal(outcome.attemptId, "pi1-session-probe");
		assert.equal(outcome.endedBy, "no_structured_result");
		assert.match(outcome.output ?? "", /pi1-sdk-ok/);
		assert.equal(outcome.queryOutcome, undefined);
	},
);

/** 静默 startRun 的协议事件行，其余写入原样交给原 write，避免吞掉测试报文。 */
async function runStartRun(
	spec: AgentRunSpec,
	modelBaseUrl: string,
): Promise<Awaited<ReturnType<typeof startRun>>> {
	const originalWrite = process.stdout.write.bind(process.stdout);
	const EVENT_PREFIX = "__COAGENT_EVENT__ ";
	process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
		if (typeof chunk === "string" && chunk.includes(EVENT_PREFIX)) return true;
		return (originalWrite as (chunk: unknown, ...rest: unknown[]) => boolean)(chunk, ...rest);
	}) as typeof process.stdout.write;
	try {
		return await withMockProviderOnCreate(modelBaseUrl, async (providerId) => {
			const profile = {
				...spec.profile,
				facts: spec.profile.facts.map((f) =>
					f.key === "provider" ? { ...f, value: providerId } : f,
				),
			};
			return startRun({ ...spec, profile });
		});
	} finally {
		process.stdout.write = originalWrite;
	}
}

/** 起本地假模型服务，按请求次数依次回 finish_reason。 */
async function mockModelServer(
	bodies: string[],
	finishReasons: string[],
): Promise<string> {
	return mockServer((_req, res, body) => {
		bodies.push(body);
		res.writeHead(200, { "content-type": "text/event-stream" });
		const reason = finishReasons[bodies.length - 1] ?? "stop";
		res.end(sseAssistantFinish("msg", reason));
	});
}

/** 构造 startRun 用的 spec，role/instruction/endpoint 可覆盖。 */
function execSpec(overrides: {
	role: Role;
	instruction: string;
	endpoint: string;
}): AgentRunSpec {
	return {
		role: overrides.role,
		attemptId: `pi1-${overrides.role}-${overrides.instruction}`,
		cwd: scratchDir(),
		sessionDir: scratchDir(),
		profile: {
			profileId: "pi1-mock",
			facts: [
				{ key: "provider", value: "PLACEHOLDER" },
				{ key: "model", value: "mock-model" },
				{ key: "reasoning", value: "off" },
			],
		},
		instruction: overrides.instruction,
		endpoint: { baseUrl: overrides.endpoint, token: "none" },
		stream: false,
	};
}

/**
 * 执行者首次无工具文字回复 finish_reason=length，第二次 finish_reason=stop，两次都不终结提交：
 * 假模型恰好收到两次请求，第二次请求体含中文提醒与「截断」，并保留第一次回复的上下文。
 */
test(
	"执行者未终结提交：length→stop 时在同一会话提醒 1 次，保留上下文，endedBy=no_structured_result",
	{ timeout: 60_000 },
	async () => {
		const bodies: string[] = [];
		// 模型假服务：第一次 length、第二次 stop，都不终结提交。
		const baseUrl = await mockModelServer(bodies, ["length", "stop"]);
		// 平台假服务：run/brief 返回 200（不把 endpoint 当不可达）。
		const platformBaseUrl = await mockServer((_req, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ projectId: "p", missionId: "m", status: "executing", workItem: { id: "W-11", title: "t", order: {} } }));
		});
		const spec = execSpec({ role: "executor", instruction: "把任务做完并提交", endpoint: platformBaseUrl });
		const outcome = await runStartRun(spec, baseUrl);

		// 恰好两次请求：第一次是 instruction，第二次是提醒。
		assert.equal(bodies.length, 2, "假模型必须恰好收到两次请求");
		const secondBody = JSON.parse(bodies[1] ?? "null") as { messages?: unknown[] } | null;
		// 第二次请求体必须含中文提醒与「截断」。
		assert.match(JSON.stringify(secondBody), /上一条回复/);
		assert.match(JSON.stringify(secondBody), /截断/);
		assert.match(JSON.stringify(secondBody), /coagent_submit_execution_result/);
		assert.match(JSON.stringify(secondBody), /coagent_report_blocked/);

		// 第二次请求的上下文里保留第一次的 user 指令，并带上这次的提醒（同会话连续两轮）。
		const secondMessages = secondBody?.messages;
		assert.ok(Array.isArray(secondMessages), "第二次请求体必须带 messages（保留上下文）");
		const firstUser = (secondMessages as unknown[]).find((m) => {
			const msg = m as { role?: string; content?: unknown };
			return msg.role === "user" && JSON.stringify(msg.content ?? "").includes("把任务做完并提交");
		});
		assert.ok(firstUser, "第二次请求必须保留第一次 user 指令的会话上下文");

		// 两次都未终结提交：endedBy=no_structured_result。
		assert.equal(outcome.endedBy, "no_structured_result");
		// 提醒后仍无终结提交：output 保留一行带触发提醒的 stopReason=length。
		assert.match(
			outcome.output ?? "",
			/\[runtime\] 会话没有终结提交，已在同一会话提醒 1 次（上一条回复 stopReason=length）/,
		);
	},
);

/**
 * 其他角色（solo）未终结提交时不提醒：假模型只收到一次请求。
 */
test(
	"非执行者（solo）未终结提交时不提醒：假模型只收到一次请求",
	{ timeout: 60_000 },
	async () => {
		const bodies: string[] = [];
		const baseUrl = await mockModelServer(bodies, ["stop"]);
		const spec = execSpec({ role: "solo", instruction: "回一句", endpoint: "http://127.0.0.1:1" });
		const outcome = await runStartRun(spec, baseUrl);

		assert.equal(bodies.length, 1, "solo 不应触发二次提醒请求");
		assert.equal(outcome.endedBy, "no_structured_result");
		assert.doesNotMatch(outcome.output ?? "", /\[runtime\] 会话没有终结提交/);
	},
);
