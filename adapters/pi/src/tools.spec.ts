/**
 * coagent 工具表按角色的合同。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { TERMINAL_TOOLS, coagentToolNames, coagentTools } from "./tools.js";
import type { PlatformClient } from "./platform-client.js";

test("coagentToolNames(query) 为空；Mission 角色保持非空/空金样", () => {
	assert.deepEqual(coagentToolNames("query"), []);
	assert.deepEqual(coagentToolNames("solo"), []);
	assert.ok(coagentToolNames("coordinator").length > 0);
	assert.ok(coagentToolNames("executor").length > 0);
	assert.ok(coagentToolNames("coordinator").every((n) => n.startsWith("coagent_")));
	assert.ok(coagentToolNames("executor").every((n) => n.startsWith("coagent_")));
});

test("coagentTools(query) 返回空数组（不注册任何平台工具）", () => {
	const stub = {} as PlatformClient;
	assert.deepEqual(coagentTools("query", stub), []);
	assert.equal(coagentTools("solo", stub).length, 0);
	assert.ok(coagentTools("coordinator", stub).length > 0);
	assert.ok(coagentTools("executor", stub).length > 0);
});

test("评审工具必须逐条交代验收结果：acceptanceResults 必填，状态四选一", () => {
	const review = coagentTools("coordinator", {} as PlatformClient).find((t) => t.name === "coagent_review_execution_result");
	assert.ok(review, "协调者要有评审工具");
	const schema = review.parameters as unknown as {
		required?: string[];
		properties: Record<string, { items?: { required?: string[]; properties: Record<string, { anyOf?: { const: string }[] }> } }>;
	};
	assert.ok(schema.required?.includes("acceptanceResults"), "不能只写一句总结：逐条结果是必填的");
	const item = schema.properties.acceptanceResults?.items;
	assert.ok(item);
	assert.deepEqual([...(item.required ?? [])].sort(), ["criterion", "status"]);
	assert.deepEqual(
		(item.properties.status?.anyOf ?? []).map((s) => s.const).sort(),
		["fail", "not_applicable", "pass", "unverified"],
	);
	assert.ok("evidence" in item.properties && "note" in item.properties);
});

test("每个 coagent 工具都有 parameters schema（0.86+ 无 schema 会在注册时被拒）", () => {
	const stub = {} as PlatformClient;
	for (const role of ["coordinator", "executor"] as const) {
		for (const tool of coagentTools(role, stub)) {
			assert.ok(tool.parameters, `${role}/${tool.name} 必须有 parameters`);
		}
	}
});

function recordingClient() {
	const calls: { tool: string; body: unknown }[] = [];
	const client = {
		call: async (tool: string, body: unknown) => {
			calls.push({ tool, body });
			return { ok: true, text: "{}", json: {} };
		},
	} as PlatformClient;
	return { client, calls };
}

test("independent_reviewer 两个工具的 schema：verdict 取值、reasons 非空；submit 终端、bundle 非终端", () => {
	const tools = coagentTools("independent_reviewer", {} as PlatformClient);
	assert.deepEqual(
		tools.map((t) => t.name),
		["coagent_get_mission_review_bundle", "coagent_submit_independent_review"],
	);
	const bundle = tools.find((t) => t.name === "coagent_get_mission_review_bundle");
	const submit = tools.find((t) => t.name === "coagent_submit_independent_review");
	assert.ok(bundle && submit);
	assert.ok(bundle.parameters, "bundle 必须有 parameters");
	assert.ok(submit.parameters, "submit 必须有 parameters");

	const schema = submit.parameters as unknown as {
		required?: string[];
		properties: {
			verdict?: { anyOf?: { const: string }[] };
			reasons?: { minItems?: number; items?: { minLength?: number } };
		};
	};
	assert.ok(schema.required?.includes("verdict"));
	assert.ok(schema.required?.includes("reasons"));
	assert.deepEqual(
		(schema.properties.verdict?.anyOf ?? []).map((s) => s.const).sort(),
		["pass", "send_back"],
	);
	assert.equal(schema.properties.reasons?.minItems, 1);
	assert.equal(schema.properties.reasons?.items?.minLength, 1);

	assert.equal(TERMINAL_TOOLS.has("coagent_submit_independent_review"), true);
	assert.equal(TERMINAL_TOOLS.has("coagent_get_mission_review_bundle"), false);
});

test("coagent_submit_independent_review 参数不合法时不发请求", async () => {
	const { client, calls } = recordingClient();
	const submit = coagentTools("independent_reviewer", client).find(
		(t) => t.name === "coagent_submit_independent_review",
	);
	assert.ok(submit);
	const bad = [
		{},
		{ verdict: "accept", reasons: ["x"] },
		{ verdict: "pass" },
		{ verdict: "pass", reasons: [] },
		{ verdict: "send_back", reasons: [""] },
		{ verdict: "pass", reasons: ["  "] },
	];
	for (const params of bad) {
		const result = await submit.execute("c1", params as never, undefined, undefined, undefined as never);
		assert.equal(result.isError, true, `应拒绝 ${JSON.stringify(params)}`);
		assert.ok(!("terminate" in result && result.terminate), "非法参数不得 terminate");
	}
	assert.equal(calls.length, 0, "非法参数不得打到平台");
});

test("independent_reviewer 工具经 PlatformClient 调用且 body 不含身份字段", async () => {
	const { client, calls } = recordingClient();
	const tools = coagentTools("independent_reviewer", client);
	const bundle = tools.find((t) => t.name === "coagent_get_mission_review_bundle");
	const submit = tools.find((t) => t.name === "coagent_submit_independent_review");
	assert.ok(bundle && submit);

	const bundleResult = await bundle.execute(
		"c1",
		{ role: "independent_reviewer", missionId: "M1", attemptId: "A1" } as never,
		undefined,
		undefined,
		undefined as never,
	);
	assert.ok(!bundleResult.isError);
	assert.ok(!("terminate" in bundleResult && bundleResult.terminate));

	const submitResult = await submit.execute(
		"c2",
		{
			verdict: "pass",
			reasons: ["L2 逐条覆盖"],
			role: "coordinator",
			missionId: "M1",
			attemptId: "A1",
			workItemId: "W1",
		} as never,
		undefined,
		undefined,
		undefined as never,
	);
	assert.ok(!submitResult.isError);
	assert.equal(submitResult.terminate, true);

	assert.deepEqual(calls, [
		{ tool: "coagent_get_mission_review_bundle", body: {} },
		{
			tool: "coagent_submit_independent_review",
			body: { verdict: "pass", reasons: ["L2 逐条覆盖"] },
		},
	]);
});

test("协调者新工具与 validation：三工具只在协调者表；create/revise 共用一份可选 validation 并原样透传", async () => {
	const NEW_TOOLS = ["coagent_revise_work_order", "coagent_get_work_item", "coagent_submit_contract_check"];
	const coordinatorNames = coagentToolNames("coordinator");
	const executorNames = coagentToolNames("executor");
	for (const name of NEW_TOOLS) {
		assert.ok(coordinatorNames.includes(name), `协调者要有 ${name}`);
		assert.ok(!executorNames.includes(name), `执行者不该看到 ${name}`);
	}

	type Schema = {
		required?: string[];
		properties: Record<
			string,
			{ required?: string[]; items?: { required?: string[] }; properties?: Record<string, unknown> }
		>;
	};
	const byName = new Map(
		coagentTools("coordinator", {} as PlatformClient).map((t) => [t.name, t.parameters as unknown as Schema]),
	);
	const create = byName.get("coagent_create_work_item");
	const revise = byName.get("coagent_revise_work_order");
	assert.ok(create && revise);
	for (const [label, schema] of [
		["create", create],
		["revise", revise],
	] as const) {
		assert.ok(!schema.required?.includes("validation"), `${label}: validation 必须可选`);
		const validation = schema.properties.validation as unknown as Schema | undefined;
		assert.ok(validation, `${label}: 表里要有 validation`);
		assert.deepEqual(validation.required, ["commands"]);
		assert.deepEqual(Object.keys(validation.properties ?? {}).sort(), ["commands", "diffSize", "forbiddenPaths"]);
		const command = validation.properties.commands?.items as unknown as Schema | undefined;
		assert.ok(command);
		assert.deepEqual([...(command.required ?? [])].sort(), ["argv", "timeoutMs"]);
		assert.deepEqual(Object.keys(command.properties ?? {}).sort(), ["argv", "timeoutMs"]);
		const diffSize = validation.properties.diffSize?.properties as unknown as Record<string, unknown> | undefined;
		assert.deepEqual(Object.keys(diffSize ?? {}).sort(), ["maxChangedFiles", "maxChangedLines"]);
	}
	// 修订的是工单正文，标题不在修订体里（平台 server.ts 只解构 workItemId + 剩余 WorkOrder）。
	assert.ok(!("title" in revise.properties));
	assert.ok(revise.required?.includes("workItemId"));

	const { client, calls } = recordingClient();
	const tools = coagentTools("coordinator", client);
	const run = async (name: string, params: unknown) => {
		const tool = tools.find((t) => t.name === name);
		assert.ok(tool, `要有 ${name}`);
		return tool.execute("c1", params as never, undefined, undefined, undefined as never);
	};

	const orderBody = {
		objective: "让协调者能把新工具发给执行者",
		allowedScope: ["src/tools.ts"],
		requiredBehaviour: "工具表里能看到新工具",
		constraints: ["不增依赖"],
		acceptance: ["定向测试退出码 0"],
		verification: ["node --import tsx --test src/tools.test.ts"],
		doNot: ["不要跑全量测试"],
		contextRefs: ["src/tools.ts:25-133"],
	};
	const validationBody = {
		commands: [{ argv: ["node", "--import", "tsx", "--test", "src/tools.test.ts"], timeoutMs: 60000 }],
		forbiddenPaths: ["src/roles.ts"],
		diffSize: { maxChangedFiles: 2 },
	};

	const reviseResult = await run("coagent_revise_work_order", {
		workItemId: "W-2",
		...orderBody,
		validation: validationBody,
	});
	const getResult = await run("coagent_get_work_item", { workItemId: "W-2" });
	const checkResult = await run("coagent_submit_contract_check", {
		verdict: "issues",
		summary: "验收标准第二条无法判定",
		issues: ["acceptance[1] 没有可判真假的判据"],
	});
	assert.ok(!reviseResult.isError && !getResult.isError && !checkResult.isError);

	assert.deepEqual(calls, [
		{ tool: "coagent_revise_work_order", body: { workItemId: "W-2", ...orderBody, validation: validationBody } },
		{ tool: "coagent_get_work_item", body: { workItemId: "W-2" } },
		{
			tool: "coagent_submit_contract_check",
			body: {
				verdict: "issues",
				summary: "验收标准第二条无法判定",
				issues: ["acceptance[1] 没有可判真假的判据"],
			},
		},
	]);
});

test("协调者工具表的 criteria：create/revise 可选 number[]，submit 必填逐条结构，并原样透传", async () => {
	type Schema = {
		required?: string[];
		type?: string;
		items?: Schema & { properties?: Record<string, unknown>; anyOf?: { const: string }[] };
		properties?: Record<string, unknown>;
	};
	const byName = new Map(
		coagentTools("coordinator", {} as PlatformClient).map((t) => [t.name, t.parameters as unknown as Schema]),
	);
	const create = byName.get("coagent_create_work_item");
	const revise = byName.get("coagent_revise_work_order");
	const submit = byName.get("coagent_submit_mission_result");
	assert.ok(create && revise && submit);

	for (const [label, schema] of [
		["create", create],
		["revise", revise],
	] as const) {
		assert.ok(!schema.required?.includes("criteria"), `${label}: criteria 必须可选`);
		const criteria = schema.properties?.criteria as unknown as Schema | undefined;
		assert.ok(criteria, `${label}: 表里要有 criteria`);
		assert.equal(criteria.type, "array");
		assert.equal(criteria.items?.type, "number");
	}

	assert.ok(submit.required?.includes("criteria"), "submit: criteria 必填");
	const missionCriteria = submit.properties?.criteria as unknown as Schema | undefined;
	assert.ok(missionCriteria);
	assert.equal(missionCriteria.type, "array");
	const item = missionCriteria.items;
	assert.ok(item);
	assert.deepEqual(Object.keys(item.properties ?? {}).sort(), ["evidence", "index", "status"]);
	assert.deepEqual([...(item.required ?? [])].sort(), ["evidence", "index", "status"]);
	assert.deepEqual(
		((item.properties?.status as Schema | undefined)?.anyOf ?? []).map((s) => s.const).sort(),
		["fail", "not_applicable", "pass", "unverified"],
	);

	const { client, calls } = recordingClient();
	const tools = coagentTools("coordinator", client);
	const run = async (name: string, params: unknown) => {
		const tool = tools.find((t) => t.name === name);
		assert.ok(tool, `要有 ${name}`);
		return tool.execute("c1", params as never, undefined, undefined, undefined as never);
	};

	const orderBody = {
		objective: "工单带上契约验收序号",
		allowedScope: ["src/tools.ts"],
		requiredBehaviour: "criteria 原样透传",
		constraints: ["不增依赖"],
		acceptance: ["定向测试退出码 0"],
		criteria: [1, 2],
		verification: ["node --import tsx --test src/tools.test.ts"],
		doNot: ["不要跑全量测试"],
		contextRefs: ["src/tools.ts"],
	};
	const createResult = await run("coagent_create_work_item", { title: "criteria", ...orderBody });
	const reviseResult = await run("coagent_revise_work_order", { workItemId: "W-9", ...orderBody });
	const submitResult = await run("coagent_submit_mission_result", {
		outcome: "delivered",
		summary: "criteria 已接上",
		acceptanceEvidence: ["定向测试退出码 0"],
		criteria: [{ index: 1, status: "pass", evidence: "node --import tsx --test src/tools.test.ts 退出码 0" }],
		memoryDelta: [{ kind: "living_spec", slug: "demo", title: "Demo", changes: [{ before: "旧规则", after: "新规则" }] }],
		openRisks: [],
	});
	assert.ok(!createResult.isError && !reviseResult.isError && !submitResult.isError);

	assert.deepEqual(calls, [
		{ tool: "coagent_create_work_item", body: { title: "criteria", ...orderBody } },
		{ tool: "coagent_revise_work_order", body: { workItemId: "W-9", ...orderBody } },
		{
			tool: "coagent_submit_mission_result",
			body: {
				outcome: "delivered",
				summary: "criteria 已接上",
				acceptanceEvidence: ["定向测试退出码 0"],
				criteria: [{ index: 1, status: "pass", evidence: "node --import tsx --test src/tools.test.ts 退出码 0" }],
				memoryDelta: [{ kind: "living_spec", slug: "demo", title: "Demo", changes: [{ before: "旧规则", after: "新规则" }] }],
				openRisks: [],
			},
		},
	]);
});

test("协调者独占 coagent_get_validation_report：schema 必填 workItemId / 可选 reportId，body 只投影两个业务字段", async () => {
	const EXCLUSIVE = "coagent_get_validation_report";
	assert.ok(coagentToolNames("coordinator").includes(EXCLUSIVE));
	for (const role of ["executor", "solo", "query", "independent_reviewer"] as const) {
		assert.ok(!coagentToolNames(role).includes(EXCLUSIVE), `${role} 不该看到 ${EXCLUSIVE}`);
	}

	const schema = coagentTools("coordinator", {} as PlatformClient).find((t) => t.name === EXCLUSIVE)
		?.parameters as unknown as { required?: string[]; properties: Record<string, unknown> };
	assert.deepEqual(schema.required, ["workItemId"]);
	assert.deepEqual(Object.keys(schema.properties).sort(), ["reportId", "workItemId"]);

	const { client, calls } = recordingClient();
	const tool = coagentTools("coordinator", client).find((t) => t.name === EXCLUSIVE);
	assert.ok(tool);
	const withReport = await tool.execute(
		"c1",
		{
			workItemId: "W-7",
			reportId: "VR-3",
			role: "coordinator",
			missionId: "M1",
			attemptId: "A1",
		} as never,
		undefined,
		undefined,
		undefined as never,
	);
	const withoutReport = await tool.execute(
		"c2",
		{ workItemId: "W-7", role: "executor", missionId: "M1" } as never,
		undefined,
		undefined,
		undefined as never,
	);
	assert.ok(!withReport.isError && !withoutReport.isError);
	assert.ok(!("terminate" in withReport && withReport.terminate), "读报告不是终端工具");
	assert.deepEqual(calls, [
		{ tool: EXCLUSIVE, body: { workItemId: "W-7", reportId: "VR-3" } },
		{ tool: EXCLUSIVE, body: { workItemId: "W-7" } },
	]);
});

test("independent_reviewer 工具 HTTP 失败不 terminate", async () => {
	const client = {
		call: async () => ({ ok: false, text: "平台拒绝了这次调用（HTTP 500）", json: null }),
	} as PlatformClient;
	const submit = coagentTools("independent_reviewer", client).find(
		(t) => t.name === "coagent_submit_independent_review",
	);
	assert.ok(submit);
	const result = await submit.execute(
		"c1",
		{ verdict: "pass", reasons: ["ok"] } as never,
		undefined,
		undefined,
		undefined as never,
	);
	assert.equal(result.isError, true);
	assert.ok(!("terminate" in result && result.terminate));
});
