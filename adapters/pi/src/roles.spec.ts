/**
 * query 角色 / 工具面 / system prompt 合同。
 *
 * 跑法：node --import tsx --test src/roles.spec.ts
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { QUERY_TOOLS, REVIEWER_TOOL_NAMES, systemPrompt, toolAllowlist } from "./roles.js";
import { coagentToolNames } from "./tools.js";

test("query allowlist 恰四项只读工具，无 bash/edit/write/powershell/coagent_*", () => {
	const tools = toolAllowlist("query");
	assert.deepEqual(tools, ["read", "grep", "find", "ls"]);
	assert.deepEqual(tools, [...QUERY_TOOLS]);
	for (const banned of ["bash", "edit", "write", "powershell"]) {
		assert.ok(!tools.includes(banned), `query 不得含 ${banned}`);
	}
	assert.ok(
		tools.every((t) => !t.startsWith("coagent_")),
		"query allowlist 不得含 coagent_*",
	);
});

test("query 不与 coagent 合并：coagentToolNames(query) 为空且 allowlist 长度仍为 4", () => {
	assert.deepEqual(coagentToolNames("query"), []);
	assert.equal(toolAllowlist("query").length, 4);
});

test("coordinator/executor/solo allowlist 金样保持现状", () => {
	const coordinator = toolAllowlist("coordinator");
	const executor = toolAllowlist("executor");
	const solo = toolAllowlist("solo");

	assert.deepEqual(coordinator.slice(0, 5), ["read", "grep", "find", "ls", "bash"]);
	assert.ok(coordinator.includes("coagent_get_mission"));
	assert.ok(coordinator.includes("coagent_submit_mission_result"));
	assert.ok(!coordinator.includes("edit") && !coordinator.includes("write"));
	assert.deepEqual(
		coordinator.slice(5),
		coagentToolNames("coordinator"),
		"coordinator 仍是 builtin + coagent_* 合并",
	);

	assert.deepEqual(executor.slice(0, 7), [
		"read",
		"grep",
		"find",
		"ls",
		"edit",
		"write",
		"bash",
	]);
	assert.ok(executor.includes("coagent_get_work_order"));
	assert.ok(executor.includes("coagent_submit_execution_result"));
	assert.deepEqual(executor.slice(7), coagentToolNames("executor"));

	assert.deepEqual(solo, ["read", "grep", "find", "ls", "edit", "write", "bash"]);
	assert.deepEqual(coagentToolNames("solo"), []);
	assert.ok(solo.every((t) => !t.startsWith("coagent_")));
});

test("query system prompt 是短只读说明，不含 Mission / coagent_* 指令", () => {
	const prompt = systemPrompt("query");
	assert.ok(prompt.length > 0);
	assert.ok(/只读|read/i.test(prompt), "应说明只读");
	for (const forbidden of [
		"coagent_get",
		"coagent_submit",
		"coagent_update",
		"coagent_dispatch",
		"只有 coagent_* 工具调用会改变平台状态",
		"写回平台的才是事实",
		"L2 协调者",
		"L1 执行者",
	]) {
		assert.ok(!prompt.includes(forbidden), `query prompt 不得含「${forbidden}」`);
	}
});

test("Mission roles system prompt 仍含既有平台指令（回归）", () => {
	const coordinator = systemPrompt("coordinator");
	const executor = systemPrompt("executor");
	assert.ok(coordinator.includes("coagent_get_mission"));
	assert.ok(coordinator.includes("只有 coagent_* 工具调用会改变平台状态"));
	assert.ok(executor.includes("coagent_get_work_order"));
	assert.ok(executor.includes("coagent_submit_execution_result"));
	assert.ok(!systemPrompt("solo").includes("coagent_"));
});

test("协调者说明：逐条填 acceptanceResults、照抄原文、未验证写原因、有 fail 不能 accept", () => {
	const prompt = systemPrompt("coordinator");
	assert.match(prompt, /acceptanceResults/);
	assert.match(prompt, /照抄原文/);
	assert.match(prompt, /unverified/);
	assert.match(prompt, /有一条 fail 就不能 accept/);
});

test("reviewer allowlist 恰为只读四件加 toolTable 检视者工具，无 bash/powershell/edit/write", () => {
	const tools = toolAllowlist("reviewer");
	assert.deepEqual(tools.slice(0, 4), ["read", "grep", "find", "ls"]);
	assert.deepEqual(tools.slice(4), [...REVIEWER_TOOL_NAMES]);
	assert.equal(tools.length, 4 + REVIEWER_TOOL_NAMES.length);
	for (const banned of ["bash", "powershell", "edit", "write"]) {
		assert.ok(!tools.includes(banned), `reviewer 不得含 ${banned}`);
	}
	assert.ok(!coagentToolNames("coordinator").includes("coagent_create_mission"));
	assert.ok(!coagentToolNames("executor").includes("coagent_finalize_mission"));
});

test("reviewer system prompt 含 v0 实有工具名与检视者经验，不含草稿里没有命令的工具", () => {
	const prompt = systemPrompt("reviewer");
	assert.match(prompt, /## 检视者经验/);
	assert.match(prompt, /5–15%/);
	assert.match(prompt, /假红/);
	assert.match(prompt, /fetch failed/);
	assert.match(prompt, /bad port/);
	assert.match(prompt, /rerun_isolated/);
	assert.match(prompt, /不靠重试放行/);
	assert.match(prompt, /ADR-0004/);
	assert.match(prompt, /已知不稳/);
	const rerunOrder = "先核对相关性并隔离复跑，再全量复跑，最后依据整轮结果下结论";
	assert.ok(prompt.includes(rerunOrder), "检视者经验须写明隔离→全量→下结论的顺序");
	const isolatedAt = prompt.indexOf("隔离复跑");
	const fullAt = prompt.indexOf("全量复跑");
	const concludeAt = prompt.indexOf("下结论");
	assert.ok(isolatedAt >= 0 && fullAt > isolatedAt && concludeAt > fullAt, "复跑顺序必须是隔离复跑 → 全量复跑 → 下结论");
	for (const name of REVIEWER_TOOL_NAMES) {
		assert.ok(prompt.includes(name), `prompt 应含 ${name}`);
	}
	assert.ok(!prompt.includes("你手上有 bash") && !prompt.includes("调 bash"));
});

test("independent_reviewer allowlist 恰为只读四件加两个平台工具，不含写工具与终审工具", () => {
	const tools = toolAllowlist("independent_reviewer");
	assert.deepEqual(new Set(tools), new Set([
		"read",
		"grep",
		"find",
		"ls",
		"coagent_get_mission_review_bundle",
		"coagent_submit_independent_review",
	]));
	assert.equal(tools.length, 6);
	assert.deepEqual(coagentToolNames("independent_reviewer"), [
		"coagent_get_mission_review_bundle",
		"coagent_submit_independent_review",
	]);
	for (const banned of [
		"bash",
		"powershell",
		"edit",
		"write",
		"coagent_finalize_mission",
		"coagent_revise_contract",
		"coagent_create_mission",
		"coagent_update_plan",
		"coagent_create_work_item",
		"coagent_dispatch_work_item",
		"coagent_update_findings",
		"coagent_review_execution_result",
		"coagent_submit_mission_result",
		"coagent_submit_execution_result",
		"coagent_submit_evidence",
		"coagent_report_blocked",
	]) {
		assert.ok(!tools.includes(banned), `independent_reviewer 不得含 ${banned}`);
	}
	for (const name of REVIEWER_TOOL_NAMES) {
		assert.ok(!tools.includes(name), `不得复用交互式 ${name}`);
	}
});

test("independent_reviewer system prompt 只读独立检视，不复用交互式 reviewer", () => {
	const prompt = systemPrompt("independent_reviewer");
	assert.match(prompt, /独立检视/);
	assert.ok(prompt.includes("coagent_get_mission_review_bundle"));
	assert.ok(prompt.includes("coagent_submit_independent_review"));
	assert.match(prompt, /\bpass\b/);
	assert.match(prompt, /send_back/);
	assert.match(prompt, /不修代码/);
	assert.match(prompt, /不改 L2/);
	assert.ok(!prompt.includes("coagent_finalize_mission"));
	assert.ok(!prompt.includes("coagent_create_mission"));
	assert.ok(!prompt.includes("coagent_revise_contract"));
	assert.ok(!prompt.includes("## 检视者经验"));
	assert.ok(!prompt.includes("你直接和用户对话"));
});

test("协调者提示词含 pr1 新增四段要点且不含旧工单时限文字", () => {
	const prompt = systemPrompt("coordinator");
	// 第一段：开工先核对契约
	assert.ok(prompt.includes("按任务复杂度调整工单详细程度"));
	assert.ok(prompt.includes("不填写长模板"));
	assert.ok(prompt.includes("文件数量是建议"));
	assert.ok(prompt.includes("拆单仍增加执行会话与交接成本"));
	assert.ok(prompt.includes("修复验证"));
	assert.ok(prompt.includes("先核实真实接口"));
	assert.ok(prompt.includes("先调查并确定方案"));
	assert.ok(prompt.includes("不设搜索次数或探索时长硬门禁"));
	for (const role of ["executor", "reviewer", "independent_reviewer"] as const) {
		assert.ok(!systemPrompt(role).includes("按任务复杂度调整工单详细程度"));
	}
	assert.ok(prompt.includes("开工先核对契约"), "应含『开工先核对契约』");
	assert.ok(prompt.includes("每一跳都要以结构化动作结束"), "应含结构化动作结束");
	// 第二段：工单标准
	assert.ok(prompt.includes("工单标准"), "应含『工单标准』");
	assert.ok(prompt.includes("contextRefs 写明要读的文件和行段"), "应含 contextRefs 说明");
	// 第三段：测试尽量少 / 验收省着读
	assert.ok(prompt.includes("测试尽量少"), "应含『测试尽量少』");
	assert.ok(prompt.includes("验收省着读"), "应含『验收省着读』");
	assert.ok(prompt.includes("全量测试只在交卷前跑一次"), "应含全量测试只在交卷前跑一次");
	// 旧工单时限文字应已移除
	assert.ok(
		!prompt.includes("一张工单要能在半小时内做完"),
		"协调者提示词不得再含『一张工单要能在半小时内做完』",
	);
	// PR2：协调者在首次派工前先写完整改动设计
	assert.ok(prompt.includes("先把整个改动捋顺，再派工"), "应含『先把整个改动捋顺，再派工』");
	// PR3：派工前的五步原文
	assert.ok(prompt.includes("定测试接缝"), "应含『定测试接缝』");
	assert.ok(prompt.includes("先加新形式、旧的照旧能用"), "应含『先加新形式、旧的照旧能用』");
});

test("协调者 issues 自动升级：issue 写进 issues、当跳结束不派工，且原有升级场景说明保留", () => {
	const prompt = systemPrompt("coordinator");
	assert.ok(prompt.includes("平台会自动把 issues 升级给 L3"), "应写明 issues 自动升级");
	assert.ok(prompt.includes("不要再调 coagent_escalate_to_l3"), "应写明不要再调升级工具");
	assert.ok(prompt.includes("要 L3 裁决的问题、证据和推荐做法都写进 issues"), "应写明问题/证据/推荐写进 issues");
	assert.ok(prompt.includes("这一跳不派工、直接结束"), "应写明当跳不派工、直接结束");
	// 其他升级场景不变：契约本身不成立、执行中卡在契约问题上。
	assert.ok(
		prompt.includes("技术发现动到它们时，\n用 coagent_escalate_to_l3，不要自行调整目标。"),
		"契约问题升级说明应保留",
	);
	assert.ok(prompt.includes("若卡住的是契约本身，用 coagent_escalate_to_l3 升级"), "执行阻塞升级说明应保留");
});

test("协调者提示词：验证报告摘要不够时读全文，不为索取全文升级 L3", () => {
	const prompt = systemPrompt("coordinator");
	assert.ok(prompt.includes("coagent_get_validation_report"), "应点名读全文的工具");
	assert.ok(prompt.includes("摘要不够"), "应写明摘要不够时才读全文");
	assert.ok(prompt.includes("不要为索取全文升级给 L3"), "应写明不要为索取全文升级");
});

test("执行者提示词含『只执行，不分析』且限定只读/只跑工单命令", () => {
	const prompt = systemPrompt("executor");
	assert.ok(prompt.includes("只执行，不分析"), "应含『只执行，不分析』");
	assert.ok(!prompt.includes("加起来不超过 5 次"));
	assert.ok(prompt.includes("不设搜索次数硬上限"));
	assert.ok(prompt.includes("不能自行改接口契约"));
	assert.ok(prompt.includes("一次写清不符事实"));
	assert.ok(
		prompt.includes("只跑工单 verification 列出的命令，原样复制"),
		"应含『只跑工单 verification 列出的命令，原样复制』",
	);
	assert.ok(!prompt.includes("一张工单要能在半小时内做完"), "执行者提示词本就没这行，回归确认不出现");
});
