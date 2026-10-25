/**
 * 1.3.0 最终工具闭包：走平台 loader / excludeTools，不靠源码字符串。
 *
 * 跑法：node --import tsx --test src/sdk-tool-closure.spec.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	createAgentSession,
	createCodemodeExtension,
	createMcpExtension,
	createToolSearchExtension,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { createCoagentExtension } from "./extension.js";
import { PlatformClient } from "./platform-client.js";
import { createControlledResourceLoader } from "./runtime.js";
import { EXCLUDED_EXPANSION_TOOLS, QUERY_TOOLS, toolAllowlist } from "./roles.js";

const EXPANSION = ["mcp__evil__ping", "list_mcp_resources", "codemode", "tool_search", "llama_expand", "project_evil"];

function scratch(): string {
	return mkdtempSync(join(tmpdir(), "pi130-closure-"));
}

function writeHostileWorkspace(cwd: string, agentDir: string): string {
	mkdirSync(join(cwd, ".pi", "skills", "evil"), { recursive: true });
	mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
	writeFileSync(join(cwd, ".pi", "skills", "evil", "SKILL.md"), "# evil skill\n");
	writeFileSync(join(cwd, "AGENTS.md"), "project context must not load\n");
	writeFileSync(
		join(cwd, ".pi", "extensions", "project-evil.js"),
		"export default function (pi) { pi.registerTool({ name: 'project_evil', description: 'no', parameters: { type: 'object', properties: {} }, async execute() { return { content: [{ type: 'text', text: 'no' }] }; } }); }\n",
	);
	writeFileSync(
		join(cwd, ".pi", "settings.json"),
		JSON.stringify({
			extensions: ["builtin:mcp", "builtin:codemode", "builtin:tool-search", "builtin:llama.cpp", "./extensions/project-evil.js"],
		}),
	);
	writeFileSync(
		join(cwd, ".pi", "mcp.json"),
		JSON.stringify({ mcpServers: { evil: { command: "definitely-not-a-real-mcp", args: [], enabled: false } } }),
	);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ extensions: ["builtin:mcp", "builtin:codemode", "builtin:tool-search", "builtin:llama.cpp"] }),
	);
	writeFileSync(
		join(agentDir, "mcp.json"),
		JSON.stringify({ mcpServers: { evil: { command: "definitely-not-a-real-mcp", args: [], enabled: false } } }),
	);
	const disk = join(cwd, "disk-expand.js");
	writeFileSync(
		disk,
		`export default function (pi) {
  for (const name of ["mcp__evil__ping", "list_mcp_resources"]) {
    pi.registerTool({
      name,
      description: name,
      exposure: "codemode",
      parameters: { type: "object", properties: {} },
      async execute() { return { content: [{ type: "text", text: name }] }; },
    });
  }
}
`,
	);
	return disk;
}

function builtinFactories() {
	return [
		{ name: "mcp", factory: createMcpExtension(), builtin: true as const },
		{ name: "codemode", factory: createCodemodeExtension(), builtin: true as const },
		{ name: "tool-search", factory: createToolSearchExtension(), builtin: true as const },
		{
			name: "llama.cpp",
			builtin: true as const,
			factory: (pi: { registerTool: (tool: unknown) => void }) => {
				pi.registerTool({
					name: "llama_expand",
					description: "no",
					parameters: { type: "object", properties: {} },
					async execute() {
						return { content: [{ type: "text", text: "no" }] };
					},
				});
			},
		},
	];
}

async function openSession(
	cwd: string,
	agentDir: string,
	loader: ReturnType<typeof createControlledResourceLoader>,
	tools: string[],
	excludeTools?: string[],
): Promise<AgentSession> {
	const runtime = await ModelRuntime.create({
		modelsPath: null,
		refreshOnCreate: false,
		authPath: join(agentDir, "auth.json"),
	});
	runtime.registerProvider("probe", {
		name: "Probe",
		baseUrl: "http://127.0.0.1:9",
		apiKey: "probe-not-a-secret",
		api: "openai-completions",
		models: [
			{
				id: "m",
				name: "M",
				api: "openai-completions",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1000,
				maxTokens: 100,
			},
		],
	});
	const model = runtime.getModel("probe", "m");
	assert.ok(model, "假模型必须能从隔离 runtime 取出");
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		model,
		thinkingLevel: "off",
		modelRuntime: runtime,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(cwd),
		tools,
		...(excludeTools ? { excludeTools } : {}),
	});
	return session;
}

function assertNoExpansion(names: string[], label: string): void {
	for (const banned of EXPANSION) {
		assert.equal(names.includes(banned), false, `${label} 不得含 ${banned}`);
	}
	assert.equal(names.some((name) => name.startsWith("mcp__")), false, `${label} 不得含 mcp__`);
}

test("query 最终工具闭包： hostile 工作区与 -e builtin/MCP 注册后仍恰为 read/grep/find/ls", async () => {
	const cwd = scratch();
	const agentDir = scratch();
	const disk = writeHostileWorkspace(cwd, agentDir);
	try {
		const loader = createControlledResourceLoader({
			cwd,
			agentDir,
			additionalExtensionPaths: [
				"builtin:mcp",
				"builtin:codemode",
				"builtin:tool-search",
				"builtin:llama.cpp",
				disk,
			],
			extensionFactories: builtinFactories(),
			systemPromptOverride: () => "query",
		});
		await loader.reload();
		const loaded = loader.getExtensions().extensions;
		assert.equal(loaded.some((extension) => extension.path.startsWith("builtin:")), false);
		assert.equal(loader.getSkills().skills.length, 0);
		assert.equal(loader.getAgentsFiles().agentsFiles.length, 0);
		const registered = loaded.flatMap((extension) => [...extension.tools.keys()]);
		assert.ok(registered.includes("mcp__evil__ping"), "磁盘扩展必须真的注册了 MCP 工具，否则会话断言是空的");
		assert.equal(registered.includes("project_evil"), false);

		const session = await openSession(cwd, agentDir, loader, [...QUERY_TOOLS], [...EXCLUDED_EXPANSION_TOOLS]);
		try {
			assert.deepEqual(session.getActiveToolNames(), [...QUERY_TOOLS]);
			assert.deepEqual(session.getCallableToolNames(), [...QUERY_TOOLS]);
			assert.deepEqual(session.getAllTools().map((tool) => tool.name), [...QUERY_TOOLS]);
			assertNoExpansion(session.getCallableToolNames(), "callable");
			assertNoExpansion(session.getAllTools().map((tool) => tool.name), "all");
		} finally {
			session.dispose();
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("executor 最终工具闭包：平台工具仍在，MCP/builtin 扩权不在", async () => {
	const cwd = scratch();
	const agentDir = scratch();
	const disk = writeHostileWorkspace(cwd, agentDir);
	try {
		const allow = toolAllowlist("executor");
		const loader = createControlledResourceLoader({
			cwd,
			agentDir,
			additionalExtensionPaths: ["builtin:mcp", disk],
			extensionFactories: [
				...builtinFactories(),
				createCoagentExtension({
					client: new PlatformClient("http://127.0.0.1:1", "none"),
					role: "executor",
					cwd,
					completion: { submitted: false },
				}),
			],
		});
		await loader.reload();
		const session = await openSession(cwd, agentDir, loader, allow, [...EXCLUDED_EXPANSION_TOOLS]);
		try {
			const active = session.getActiveToolNames();
			assert.deepEqual(new Set(active), new Set(allow));
			assert.equal(active.length, allow.length);
			assert.ok(active.includes("coagent_get_work_order"));
			assert.ok(active.includes("coagent_submit_execution_result"));
			assert.ok(active.includes("bash") && active.includes("edit") && active.includes("write"));
			assertNoExpansion(session.getCallableToolNames(), "callable");
			assertNoExpansion(session.getAllTools().map((tool) => tool.name), "all");
			assert.equal(session.getAllTools().some((tool) => tool.name.startsWith("coagent_")), true);
		} finally {
			session.dispose();
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	}
});
