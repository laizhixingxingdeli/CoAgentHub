/**
 * 托管独立检视者扩展：注册两个平台工具、成功才记 structured_submit。
 * 不启真实 session / 不连网。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createCoagentExtension } from "./extension.js";
import type { CoagentBriefInjected } from "./extension.js";
import type { PlatformClient } from "./platform-client.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { systemPrompt } from "./roles.js";

function stubPi() {
	const tools: { name: string; execute: (...args: never[]) => Promise<{ isError?: boolean; terminate?: boolean }> }[] =
		[];
	const handlers: Record<string, (event?: unknown) => unknown | Promise<unknown>> = {};
	const api = {
		registerTool(tool: { name: string }) {
			tools.push(tool as (typeof tools)[number]);
		},
		on(event: string, handler: (event?: unknown) => unknown) {
			handlers[event] = handler;
			return () => {};
		},
	} as unknown as ExtensionAPI;
	return { tools, handlers, api };
}

function recordingClient(impl?: Partial<PlatformClient>) {
	const gets: string[] = [];
	const calls: { tool: string; body: unknown }[] = [];
	const client = {
		get: async (path: string) => {
			gets.push(path);
			return undefined;
		},
		call: async (tool: string, body: unknown) => {
			calls.push({ tool, body });
			return { ok: true, text: "{}", json: {} };
		},
		sawUnreachable: false,
		...impl,
	} as PlatformClient;
	return { client, gets, calls };
}

test("independent_reviewer 扩展恰好注册两个约定平台工具", async () => {
	const { client } = recordingClient();
	const { tools, api } = stubPi();
	const completion = { submitted: false as boolean, via: undefined as string | undefined };
	await createCoagentExtension({
		client,
		role: "independent_reviewer",
		cwd: process.cwd(),
		completion,
	})(api);
	assert.deepEqual(
		tools.map((t) => t.name),
		["coagent_get_mission_review_bundle", "coagent_submit_independent_review"],
	);
});

test("independent_reviewer 不拉 run/brief", async () => {
	const { client, gets } = recordingClient();
	const { handlers, api } = stubPi();
	await createCoagentExtension({
		client,
		role: "independent_reviewer",
		cwd: process.cwd(),
		completion: { submitted: false },
	})(api);
	const prompt = await handlers.before_agent_start?.();
	assert.equal(gets.length, 0, "独立检视者不打 run/brief");
	assert.ok(
		typeof prompt === "object" &&
			prompt &&
			"systemPrompt" in prompt &&
			String((prompt as { systemPrompt: string }).systemPrompt).includes("独立检视"),
	);
});

test("成功提交独立检视后 completion 记 structured_submit 所需标志", async () => {
	const { client } = recordingClient();
	const { tools, handlers, api } = stubPi();
	const completion = { submitted: false as boolean, via: undefined as string | undefined };
	await createCoagentExtension({
		client,
		role: "independent_reviewer",
		cwd: process.cwd(),
		completion,
	})(api);
	const submit = tools.find((t) => t.name === "coagent_submit_independent_review");
	assert.ok(submit);
	const result = await submit.execute(
		"c1" as never,
		{ verdict: "pass", reasons: ["齐"] } as never,
		undefined as never,
		undefined as never,
		undefined as never,
	);
	assert.ok(!result.isError);
	assert.equal(result.terminate, true);
	await handlers.tool_execution_end?.({
		type: "tool_execution_end",
		toolCallId: "c1",
		toolName: "coagent_submit_independent_review",
		result,
		isError: false,
	});
	assert.equal(completion.submitted, true);
	assert.equal(completion.via, "coagent_submit_independent_review");
});

test("HTTP 失败不计为结构化提交", async () => {
	const { client } = recordingClient({
		call: async () => ({ ok: false, text: "平台拒绝了这次调用（HTTP 500）", json: null }),
	});
	const { tools, handlers, api } = stubPi();
	const completion = { submitted: false as boolean, via: undefined as string | undefined };
	await createCoagentExtension({
		client,
		role: "independent_reviewer",
		cwd: process.cwd(),
		completion,
	})(api);
	const submit = tools.find((t) => t.name === "coagent_submit_independent_review");
	assert.ok(submit);
	const result = await submit.execute(
		"c1" as never,
		{ verdict: "send_back", reasons: ["缺报告"] } as never,
		undefined as never,
		undefined as never,
		undefined as never,
	);
	assert.equal(result.isError, true);
	await handlers.tool_execution_end?.({
		type: "tool_execution_end",
		toolCallId: "c1",
		toolName: "coagent_submit_independent_review",
		result,
		isError: true,
	});
	assert.equal(completion.submitted, false);
	assert.equal(completion.via, undefined);
});

test("coordinator/executor 扩展仍注册各自平台工具（回归）", async () => {
	const { client } = recordingClient();
	for (const role of ["coordinator", "executor"] as const) {
		const { tools, api } = stubPi();
		await createCoagentExtension({
			client,
			role,
			cwd: process.cwd(),
			completion: { submitted: false },
		})(api);
		assert.ok(tools.length > 0, `${role} 仍应注册平台工具`);
		assert.ok(!tools.some((t) => t.name === "coagent_submit_independent_review"));
		assert.ok(!tools.some((t) => t.name === "coagent_get_mission_review_bundle"));
	}
});

// 与 .coagent/project.md 同形：有「执行者红线」及其子标题，前后各有别的章节。
const PROJECT_MD = [
	"# coagent-pi",
	"",
	"## Purpose",
	"",
	"适配器的用途说明，与执行者无关。",
	"",
	"## 与平台的边界",
	"",
	"规则写在平台里，这条也不该到执行者那儿。",
	"",
	"## 执行者红线",
	"",
	"写代码时必须遵守。",
	"",
	"### 测试",
	"",
	"- 全量：node --import tsx --test src/*.test.ts",
	"- 「已修复 / 已完成」必须有可验证证据。",
	"",
	"### 仓库",
	"",
	"- 提交进仓库的内容（blob）一律是 LF。",
	"",
	"## 结构",
	"",
	"- src/roles.ts：角色提示词，执行者不看这一节。",
].join("\n");

const SECRET_RULES = "不要泄露 FAKESECRET_k3l4m5n6o7p8q9r0s1t2 路径 C:\\Users\\admin\\.ssh\\id_rsa";
const SECRET_ORDER = {
	objective: "用凭据 sk-live-fake-credential-123 读 /etc/shadow",
};

function executorBriefWithBundle() {
	return {
		role: "executor",
		projectId: "proj-1",
		missionId: "PLAN-secret-mission",
		status: "executing",
		projectRules: PROJECT_MD,
		workItem: {
			id: "W-1",
			title: "do it",
			order: SECRET_ORDER,
		},
		contextBundle: {
			role: "executor",
			entries: [
				{
					source: "project_rules",
					estimatedTokens: 12,
					hash: "deadbeef",
					reason: "rules",
					content: SECRET_RULES,
				},
				{
					source: "environment_notes",
					estimatedTokens: 3,
					content: ["Windows 11，shell 用 Git Bash", "C:\Users\admin\.ssh\id_rsa"],
					reason: "env",
				},
				{
					source: "work_order",
					estimatedTokens: 8,
					content: { id: "W-1", title: "do it", order: SECRET_ORDER },
					reason: "wo",
				},
			],
			budgetReport: {
				budget: 999,
				estimatedBefore: 23,
				estimatedAfter: 23,
				omittedSources: [],
				overflow: false,
				remainingOverBudget: 0,
			},
		},
	};
}

function briefFromPrompt(role: "executor" | "coordinator", prompt: unknown): string {
	assert.ok(typeof prompt === "object" && prompt && "systemPrompt" in prompt);
	const full = String((prompt as { systemPrompt: string }).systemPrompt);
	const prefix = `${systemPrompt(role)}\n\n`;
	assert.ok(full.startsWith(prefix), "systemPrompt 应前置角色说明再追简报");
	return full.slice(prefix.length);
}

test("多轮 before_agent_start 仅 fetch 一次且每轮通知一次，字节与来源按实际渲染和 bundle.entries 映射", async () => {
	const payload = executorBriefWithBundle();
	const { client, gets } = recordingClient({
		get: async (path: string) => {
			gets.push(path);
			return payload;
		},
	});
	const injected: (CoagentBriefInjected | undefined)[] = [];
	const { handlers, api } = stubPi();
	await createCoagentExtension({
		client,
		role: "executor",
		cwd: process.cwd(),
		completion: { submitted: false },
		onBriefInjected: (brief) => {
			injected.push(brief);
		},
	})(api);

	const first = await handlers.before_agent_start?.();
	const second = await handlers.before_agent_start?.();
	assert.deepEqual(gets, ["run/brief"]);
	assert.equal(injected.length, 2);

	const rendered = briefFromPrompt("executor", first);
	assert.equal(briefFromPrompt("executor", second), rendered);
	const expectedBytes = Buffer.byteLength(rendered, "utf8");
	assert.ok(expectedBytes > rendered.length, "含中文的 UTF-8 字节数应大于 string.length");

	for (const notice of injected) {
		assert.ok(notice);
		assert.equal(notice.renderedUtf8Bytes, expectedBytes);
		assert.deepEqual(
			notice.sources.map((s) => s.source),
			["project_rules", "environment_notes", "work_order"],
		);
		assert.deepEqual(notice.sources, [
			{ source: "project_rules", estimatedTokens: 12, truncated: false },
			{ source: "environment_notes", estimatedTokens: 3, truncated: false },
			{ source: "work_order", estimatedTokens: 8, truncated: false },
		]);
	}
});

test("无 contextBundle 的旧平台或无实际简报不报告 brief；solo/检视者不请求", async () => {
	{
		const { client, gets } = recordingClient({
			get: async (path: string) => {
				gets.push(path);
				return {
					role: "executor",
					projectId: "p",
					missionId: "m",
					status: "executing",
					projectRules: "old platform rules",
				};
			},
		});
		const injected: (CoagentBriefInjected | undefined)[] = [];
		const { handlers, api } = stubPi();
		await createCoagentExtension({
			client,
			role: "executor",
			cwd: process.cwd(),
			completion: { submitted: false },
			onBriefInjected: (brief) => injected.push(brief),
		})(api);
		const prompt = await handlers.before_agent_start?.();
		assert.deepEqual(gets, ["run/brief"]);
		assert.deepEqual(injected, [undefined]);
		// 旧平台没有「执行者红线」标题：按新行为不渲染规则，也不回退成整份 projectRules。
		assert.equal(briefFromPrompt("executor", prompt).includes("old platform rules"), false);
	}

	{
		const { client, gets } = recordingClient();
		const injected: (CoagentBriefInjected | undefined)[] = [];
		const { handlers, api } = stubPi();
		await createCoagentExtension({
			client,
			role: "executor",
			cwd: process.cwd(),
			completion: { submitted: false },
			onBriefInjected: (brief) => injected.push(brief),
		})(api);
		await handlers.before_agent_start?.();
		assert.deepEqual(gets, ["run/brief"]);
		assert.deepEqual(injected, [undefined]);
	}

	for (const role of ["solo", "independent_reviewer"] as const) {
		const { client, gets } = recordingClient({
			get: async (path: string) => {
				gets.push(path);
				return executorBriefWithBundle();
			},
		});
		const injected: (CoagentBriefInjected | undefined)[] = [];
		const { handlers, api } = stubPi();
		await createCoagentExtension({
			client,
			role,
			cwd: process.cwd(),
			completion: { submitted: false },
			onBriefInjected: (brief) => injected.push(brief),
		})(api);
		await handlers.before_agent_start?.();
		assert.equal(gets.length, 0, `${role} 不打 run/brief`);
		assert.deepEqual(injected, [undefined]);
	}
});

test("回调序列化不含原文/路径/假凭据，不传预算；无回调时行为不变", async () => {
	const payload = executorBriefWithBundle();
	const { client, gets } = recordingClient({
		get: async (path: string) => {
			gets.push(path);
			return payload;
		},
	});
	const injected: (CoagentBriefInjected | undefined)[] = [];
	const { handlers, api } = stubPi();
	await createCoagentExtension({
		client,
		role: "executor",
		cwd: process.cwd(),
		completion: { submitted: false },
		onBriefInjected: (brief) => injected.push(brief),
	})(api);
	await handlers.before_agent_start?.();
	assert.deepEqual(gets, ["run/brief"]);
	const dumped = JSON.stringify(injected);
	assert.equal(dumped.includes(SECRET_RULES), false);
	assert.equal(dumped.includes("sk-live-fake-credential-123"), false);
	assert.equal(dumped.includes("id_rsa"), false);
	assert.equal(dumped.includes("/etc/shadow"), false);
	assert.equal(dumped.includes("deadbeef"), false);
	assert.equal(dumped.includes("budget"), false);
	assert.equal(dumped.includes("estimatedBefore"), false);
	assert.ok(injected[0]);
	assert.equal("budget" in injected[0], false);
	assert.equal("content" in injected[0], false);

	const { client: clientNoCb, gets: getsNoCb } = recordingClient({
		get: async (path: string) => {
			getsNoCb.push(path);
			return payload;
		},
	});
	const { handlers: handlersNoCb, api: apiNoCb } = stubPi();
	await createCoagentExtension({
		client: clientNoCb,
		role: "executor",
		cwd: process.cwd(),
		completion: { submitted: false },
	})(apiNoCb);
	const prompt = await handlersNoCb.before_agent_start?.();
	assert.deepEqual(getsNoCb, ["run/brief"]);
	assert.ok(briefFromPrompt("executor", prompt).includes("W-1"));
});

test("非法 source / 重复 / 超范围 estimatedTokens 不报告 brief；omittedSources 只标 truncated", async () => {
	const base = executorBriefWithBundle();

	async function noticeFor(bundle: unknown): Promise<CoagentBriefInjected | undefined> {
		const { client } = recordingClient({
			get: async () => ({ ...base, contextBundle: bundle }),
		});
		const injected: (CoagentBriefInjected | undefined)[] = [];
		const { handlers, api } = stubPi();
		await createCoagentExtension({
			client,
			role: "executor",
			cwd: process.cwd(),
			completion: { submitted: false },
			onBriefInjected: (brief) => injected.push(brief),
		})(api);
		await handlers.before_agent_start?.();
		return injected[0];
	}

	assert.equal(await noticeFor({ entries: [{ source: "secrets", estimatedTokens: 1 }] }), undefined);
	assert.equal(
		await noticeFor({
			entries: [
				{ source: "project_rules", estimatedTokens: 1 },
				{ source: "project_rules", estimatedTokens: 2 },
			],
		}),
		undefined,
	);
	assert.equal(
		await noticeFor({ entries: [{ source: "project_rules", estimatedTokens: -1 }] }),
		undefined,
	);
	assert.equal(
		await noticeFor({ entries: [{ source: "project_rules", estimatedTokens: 1.5 }] }),
		undefined,
	);

	const truncated = await noticeFor({
		entries: [{ source: "project_rules", estimatedTokens: 12, truncated: true }],
	});
	assert.deepEqual(truncated?.sources, [{ source: "project_rules", estimatedTokens: 12, truncated: true }]);

	const omitted = await noticeFor({
		entries: [{ source: "work_order", estimatedTokens: 8 }],
		budgetReport: { omittedSources: ["environment_notes"], budget: 1 },
	});
	assert.deepEqual(omitted?.sources, [{ source: "work_order", estimatedTokens: 8, truncated: false }]);
	assert.equal(JSON.stringify(omitted).includes("budget"), false);
	assert.equal(JSON.stringify(omitted).includes("environment_notes"), false);
});

async function executorBriefText(briefBody: unknown): Promise<string> {
	const { client } = recordingClient({ get: async () => briefBody });
	const { handlers, api } = stubPi();
	await createCoagentExtension({
		client,
		role: "executor",
		cwd: process.cwd(),
		completion: { submitted: false },
	})(api);
	return briefFromPrompt("executor", await handlers.before_agent_start?.());
}

test("执行者简报只含「执行者红线」及其子标题，其余章节与整份 projectRules 都不注入", async () => {
	const brief = await executorBriefText(executorBriefWithBundle());

	assert.ok(brief.includes("## 执行者红线"), "应含『执行者红线』标题");
	assert.ok(brief.includes("### 测试"), "应保留红线下的子标题一节");
	assert.ok(brief.includes("### 仓库"), "应保留红线下的另一个子标题一节");
	assert.ok(brief.includes("必须有可验证证据"), "应保留子标题下的正文");
	for (const other of ["## Purpose", "## 结构", "## 与平台的边界"]) {
		assert.ok(!brief.includes(other), `执行者简报不得含其他章节 ${other}`);
	}
	assert.ok(!brief.includes(SECRET_RULES), "不得以整份 projectRules 回退");
	assert.ok(brief.includes("W-1"), "工单仍要在");
});

test("executor 的 bash git commit 被拦，reason 说明提交由平台按工作项做检查点", async () => {
	const { client } = recordingClient();
	const { handlers, api } = stubPi();
	await createCoagentExtension({
		client,
		role: "executor",
		cwd: process.cwd(),
		completion: { submitted: false },
	})(api);
	const result = (await handlers.tool_call?.({ type: "tool_call", toolName: "bash", input: { command: "git commit -m example" } })) as
		| { block?: boolean; reason?: string }
		| undefined;
	assert.equal(result?.block, true);
	assert.ok(result?.reason?.includes("平台"), "reason 应说明平台按工作项做检查点");
	assert.ok(result?.reason?.includes("检查点"), "reason 应出现『检查点』");
});

test("平台给了 environment_notes 就把实际内容渲染进简报", async () => {
	const brief = await executorBriefText(executorBriefWithBundle());

	assert.ok(brief.includes("Windows 11，shell 用 Git Bash"), "应渲染环境提示实际内容");
	assert.ok(brief.includes("id_rsa"), "第二条环境提示也要渲染");
});


test("续跑简报透传已有差距与增量，协调者和执行者材料不串角色", async () => {
 const payload = {
  role: "coordinator", projectId: "P", missionId: "M", status: "executing",
  plan: { findings: "已核实接口", rootCause: "返回形状不一致", direction: "接线", decisions: ["保留兼容"], risks: ["待验证迁移"], rejectedHypotheses: [] },
  contractCheck: { contractRevision: 2, verdict: "ok", summary: "当前版本已核对" },
  workItemsIndex: [{ id: "W-1", status: "rejected", criteria: [1] }],
  sinceLastHop: [{ summary: "仅边界断言失败", validationReport: { passed: false, submittedAttemptId: "W-1.exec-1" } }],
  workItem: { id: "W-1", title: "接线", order: { orderRevision: "r2", allowedScope: ["src/a.ts"], doNot: ["不改协议"] }, previousRequiredChanges: ["修复边界断言"], l3SendBackReasons: ["保留已验收成果"], question: "边界是什么", answer: "空输入返回空数组" },
 };
 for (const role of ["coordinator", "executor"] as const) {
  const { client, gets } = recordingClient({ get: async (path: string) => { gets.push(path); return payload; } });
  const { handlers, api } = stubPi();
  await createCoagentExtension({ client, role, cwd: process.cwd(), completion: { submitted: false } })(api);
  const prompt = briefFromPrompt(role, await handlers.before_agent_start?.());
  assert.deepEqual(gets, ["run/brief"], "不得为已有增量另取详情");
  if (role === "coordinator") {
   for (const text of ["已核实接口", "返回形状不一致", "保留兼容", "当前版本已核对", "工作项索引", "仅边界断言失败", "W-1.exec-1"]) assert.ok(prompt.includes(text), text);
   assert.ok(!prompt.includes("修复边界断言"));
  } else {
   for (const text of ["修复边界断言", "保留已验收成果", "空输入返回空数组", "r2", "不改协议"]) assert.ok(prompt.includes(text), text);
   assert.ok(!prompt.includes("仅边界断言失败"), "不向执行者泄漏协调者机器验证投影");
   assert.ok(!prompt.includes("当前版本已核对"));
  }
 }
});
