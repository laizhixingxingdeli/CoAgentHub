/**
 * 检视者 CLI 工具合同。进程一律注入替身，不碰真平台仓。
 *
 * 跑法：node --import tsx --test src/reviewer-tools.spec.ts
 */

import assert from "node:assert/strict";
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { REVIEWER_TOOL_NAMES } from "./roles.js";
import {
	CREATE_NOT_PROVEN,
	LOCK_BUSY_HINT,
	LOCK_BUSY_MARK,
	NOT_EXECUTED,
	PROCESS_NOT_STARTED,
	createReviewerTools,
	isPathInside,
	parseReviewerConfig,
	resolveInsideRunsDir,
	reviewerConfirmToolNames,
	type PlatformCommand,
	type ReviewerConfigInput,
	type ReviewerProcessRuntime,
	type SyncProcessResult,
} from "./reviewer-tools.js";

const ROOT = join(tmpdir(), "r0a1-reviewer-tools-fake");

function sampleInput(overrides: Partial<ReviewerConfigInput> = {}): ReviewerConfigInput {
	return {
		hub: join(ROOT, "hub"),
		state: join(ROOT, "state.json"),
		reviewer: "rev-alice",
		confirmedBy: "bob",
		recipient: "l3-inbox",
		projectRepo: join(ROOT, "repo"),
		runsDir: join(ROOT, "runs"),
		...overrides,
	};
}

function recordingRuntime(opts?: {
	l3Source?: string;
	sync?: SyncProcessResult;
	pid?: number;
}): {
	calls: { kind: "sync" | "bg"; cmd: PlatformCommand; logPath?: string }[];
	writes: { path: string; content: string }[];
	runtime: ReviewerProcessRuntime;
} {
	const calls: { kind: "sync" | "bg"; cmd: PlatformCommand; logPath?: string }[] = [];
	const writes: { path: string; content: string }[] = [];
	return {
		calls,
		writes,
		runtime: {
			runSync(cmd) {
				calls.push({ kind: "sync", cmd });
				return opts?.sync ?? { status: 0, stdout: "ok", stderr: "" };
			},
			spawnBackground(cmd, logPath) {
				calls.push({ kind: "bg", cmd, logPath });
				return { pid: opts?.pid ?? 4242 };
			},
			readText() {
				if (opts && "l3Source" in opts && opts.l3Source !== undefined) return opts.l3Source;
				return "l3 merge --confirmed-by\n";
			},
			writeText(path, content) {
				writes.push({ path, content });
			},
			ensureDir() {},
		},
	};
}

function tuiCtx(confirmImpl?: (title: string, message: string) => Promise<boolean> | boolean): {
	ctx: ExtensionContext;
	seen: { title: string; message: string }[];
} {
	const seen: { title: string; message: string }[] = [];
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			confirm: async (title: string, message: string) => {
				seen.push({ title, message });
				if (confirmImpl) return await confirmImpl(title, message);
				return true;
			},
		},
	} as unknown as ExtensionContext;
	return { ctx, seen };
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("");
}

async function call(
	tool: { execute: Function },
	params: unknown,
	ctx: ExtensionContext,
) {
	return tool.execute("tid", params, undefined, undefined, ctx);
}

function findTool(tools: Array<{ name: string }>, name: string) {
	const tool = tools.find((t) => t.name === name);
	assert.ok(tool, `缺少工具 ${name}`);
	return tool;
}

const contract = {
	intent: "把按钮变绿",
	acceptance: ["按钮是绿的"],
	constraints: ["只改 css"],
	nonGoals: ["不改 API"],
	guardrails: ["不碰凭据"],
};

test("parseReviewerConfig：身份必须显式 1..128，runsDir 不得在 hub 内", () => {
	assert.equal(parseReviewerConfig(sampleInput()).reviewer, "rev-alice");
	assert.throws(() => parseReviewerConfig(sampleInput({ reviewer: "  " })), /reviewer/);
	assert.throws(() => parseReviewerConfig(sampleInput({ confirmedBy: "" })), /confirmedBy/);
	assert.throws(
		() => parseReviewerConfig(sampleInput({ reviewer: "x".repeat(129) })),
		/128/,
	);
	assert.throws(
		() => parseReviewerConfig(sampleInput({ runsDir: join(sampleInput().hub, "inside") })),
		/hub 外/,
	);
	assert.doesNotThrow(() => parseReviewerConfig(sampleInput({ reviewer: " human " })));
	const cfg = parseReviewerConfig(sampleInput({ reviewer: " human ", confirmedBy: " 人 " }));
	assert.equal(cfg.reviewer, "human");
	assert.equal(cfg.confirmedBy, "人");
});

test("createReviewerTools 名称恰为 toolTable 全表，每项有 TypeBox schema", () => {
	const { runtime } = recordingRuntime();
	const tools = createReviewerTools(sampleInput(), runtime);
	assert.deepEqual(
		tools.map((t) => t.name),
		[...REVIEWER_TOOL_NAMES],
	);
	for (const tool of tools) {
		const schema = tool.parameters as unknown as { type?: string; properties?: unknown };
		assert.equal(schema.type, "object");
		assert.ok(schema.properties, `${tool.name} 要有 properties`);
	}
});

test("每个工具的 argv 映射到 l3.ts / run-mission.ts，node + shell:false + cwd=hub", async () => {
	const input = sampleInput();
	const cfg = parseReviewerConfig(input);
	const { runtime, calls } = recordingRuntime();
	const tools = createReviewerTools(input, runtime);
	const { ctx } = tuiCtx();

	const expectCmd = (args: string[]) => {
		const last = calls.at(-1);
		assert.ok(last, "应有一次进程调用");
		assert.equal(last.cmd.command, process.execPath);
		assert.equal(last.cmd.shell, false);
		assert.equal(last.cmd.cwd, cfg.hubAbs);
		assert.deepEqual(last.cmd.args, args);
	};

	await call(findTool(tools, "coagent_get_inbox"), {}, ctx);
	expectCmd(["src/l3.ts", "inbox", "--recipient", "l3-inbox", "--state", cfg.state]);

	await call(findTool(tools, "coagent_get_inbox"), { recipient: "other" }, ctx);
	expectCmd(["src/l3.ts", "inbox", "--recipient", "other", "--state", cfg.state]);

	await call(findTool(tools, "coagent_get_mission"), { missionId: "M1" }, ctx);
	expectCmd(["src/l3.ts", "show", "M1", "--state", cfg.state]);

	await call(findTool(tools, "coagent_get_plan_run"), {}, ctx);
	expectCmd(["src/l3.ts", "plan", "--state", cfg.state]);

	await call(findTool(tools, "coagent_get_plan_run"), { runPath: "/tmp/run.json" }, ctx);
	expectCmd(["src/l3.ts", "plan", "--run", "/tmp/run.json", "--state", cfg.state]);

	await call(findTool(tools, "coagent_get_runs"), { missionId: "M1" }, ctx);
	expectCmd(["src/l3.ts", "runs", "M1", "--state", cfg.state]);

	await call(findTool(tools, "coagent_answer_escalation"), { missionId: "M1", answer: "按契约做" }, ctx);
	expectCmd(["src/l3.ts", "answer", "M1", "--answer", "按契约做", "--state", cfg.state]);

	await call(findTool(tools, "coagent_revise_contract"), { missionId: "M1", contract }, ctx);
	expectCmd([
		"src/l3.ts",
		"revise",
		"M1",
		"--contract",
		join(cfg.runsDirAbs, "revise-M1.json"),
		"--state",
		cfg.state,
	]);

	await call(
		findTool(tools, "coagent_finalize_mission"),
		{ missionId: "M1", verdict: "merge", reason: "过了" },
		ctx,
	);
	expectCmd([
		"src/l3.ts",
		"merge",
		"M1",
		"--reason",
		"过了",
		"--as",
		"rev-alice",
		"--confirmed-by",
		"bob",
		"--state",
		cfg.state,
		"--repo",
		cfg.projectRepo,
	]);

	await call(findTool(tools, "coagent_cancel_mission"), { missionId: "M1", reason: "停" }, ctx);
	expectCmd(["src/l3.ts", "cancel", "M1", "--reason", "停", "--state", cfg.state]);

	await call(findTool(tools, "coagent_pause_mission"), { missionId: "M1" }, ctx);
	expectCmd(["src/l3.ts", "pause", "M1", "--state", cfg.state]);

	await call(findTool(tools, "coagent_resume_mission"), { missionId: "M1" }, ctx);
	expectCmd(["src/l3.ts", "resume", "M1", "--state", cfg.state]);

	await call(
		findTool(tools, "coagent_retire_work_item"),
		{ missionId: "M1", workItemId: "W-1", reason: "不做了" },
		ctx,
	);
	expectCmd([
		"src/l3.ts",
		"retire",
		"M1",
		"--item",
		"W-1",
		"--reason",
		"不做了",
		"--state",
		cfg.state,
	]);

	await call(findTool(tools, "coagent_ack_delivery"), { deliveryId: "D-1" }, ctx);
	expectCmd(["src/l3.ts", "ack", "D-1", "--state", cfg.state]);

	await call(
		findTool(tools, "coagent_plan_decide"),
		{
			escalationId: "E-1",
			action: "rescope",
			reason: "砍掉 F7",
			drop: ["F7", "F8"],
			runPath: "/tmp/plan.json",
		},
		ctx,
	);
	expectCmd([
		"src/l3.ts",
		"plan",
		"decide",
		"E-1",
		"--action",
		"rescope",
		"--reason",
		"砍掉 F7",
		"--as",
		"rev-alice",
		"--run",
		"/tmp/plan.json",
		"--state",
		cfg.state,
		"--drop",
		"F7,F8",
	]);

	await call(
		findTool(tools, "coagent_plan_decide"),
		{ escalationId: "E-2", action: "stop", reason: "看不懂" },
		ctx,
	);
	expectCmd([
		"src/l3.ts",
		"plan",
		"decide",
		"E-2",
		"--action",
		"stop",
		"--reason",
		"看不懂",
		"--as",
		"rev-alice",
		"--state",
		cfg.state,
	]);

	calls.length = 0;
	await call(
		findTool(tools, "coagent_create_mission"),
		{ projectId: "p", missionId: "M9", contract },
		ctx,
	);
	expectCmd([
		"src/run-mission.ts",
		join(cfg.runsDirAbs, "M9.json"),
		"--cwd",
		cfg.projectRepo,
		"--state",
		cfg.state,
		"--origin",
		cfg.recipient,
	]);
	assert.equal(calls.at(-1)?.kind, "bg");

	calls.length = 0;
	await call(
		findTool(tools, "coagent_create_mission"),
		{
			projectId: "p",
			missionId: "M10",
			contract,
			coordinator: ["c1", "c2"],
			executor: ["e1"],
		},
		ctx,
	);
	expectCmd([
		"src/run-mission.ts",
		join(cfg.runsDirAbs, "M10.json"),
		"--cwd",
		cfg.projectRepo,
		"--state",
		cfg.state,
		"--origin",
		cfg.recipient,
		"--coordinator",
		"c1,c2",
		"--executor",
		"e1",
	]);
});

test("要确认的五个工具：拒绝 / 非 tui / 无 UI / confirm 抛错时零写入零执行", async () => {
	const names = reviewerConfirmToolNames();
	assert.deepEqual(
		[...names].sort(),
		[
			"coagent_answer_escalation",
			"coagent_cancel_mission",
			"coagent_create_mission",
			"coagent_finalize_mission",
			"coagent_revise_contract",
		].sort(),
	);

	const paramsOf: Record<string, unknown> = {
		coagent_answer_escalation: { missionId: "M1", answer: "全文答复XYZ" },
		coagent_revise_contract: { missionId: "M1", contract },
		coagent_finalize_mission: { missionId: "M1", verdict: "merge", reason: "理由全文ABC" },
		coagent_cancel_mission: { missionId: "M1", reason: "叫停理由Q" },
		coagent_create_mission: { projectId: "p", missionId: "M1", contract },
	};

	const blockedCtx = (): ExtensionContext[] => [
		tuiCtx(async () => false).ctx,
		{ mode: "print", hasUI: false, ui: { confirm: async () => true } } as unknown as ExtensionContext,
		{ mode: "json", hasUI: false, ui: { confirm: async () => true } } as unknown as ExtensionContext,
		{ mode: "rpc", hasUI: true, ui: { confirm: async () => true } } as unknown as ExtensionContext,
		{ mode: "tui", hasUI: false, ui: { confirm: async () => true } } as unknown as ExtensionContext,
		tuiCtx(async () => {
			throw new Error("confirm boom");
		}).ctx,
	];

	for (const name of names) {
		for (const ctx of blockedCtx()) {
			const rec = recordingRuntime();
			const tools = createReviewerTools(sampleInput(), rec.runtime);
			const result = await call(findTool(tools, name), paramsOf[name], ctx);
			assert.match(textOf(result), new RegExp(NOT_EXECUTED));
			assert.equal(rec.calls.length, 0, `${name} 不得起进程`);
			assert.equal(rec.writes.length, 0, `${name} 不得写文件`);
		}
	}
});

test("rpc 即使 hasUI 也不得调用 confirm", async () => {
	let confirmCalled = false;
	const ctx = {
		mode: "rpc",
		hasUI: true,
		ui: {
			confirm: async () => {
				confirmCalled = true;
				return true;
			},
		},
	} as unknown as ExtensionContext;
	const rec = recordingRuntime();
	const tools = createReviewerTools(sampleInput(), rec.runtime);
	await call(
		findTool(tools, "coagent_create_mission"),
		{ projectId: "p", missionId: "M1", contract },
		ctx,
	);
	assert.equal(confirmCalled, false);
	assert.equal(rec.calls.length, 0);
	assert.equal(rec.writes.length, 0);
});

test("确认框含完整 argv 与契约/答复/理由全文；其余工具不弹确认", async () => {
	const rec = recordingRuntime();
	const tools = createReviewerTools(sampleInput(), rec.runtime);

	const answer = tuiCtx();
	await call(
		findTool(tools, "coagent_answer_escalation"),
		{ missionId: "M1", answer: "答复全文UNIQUE-ANS" },
		answer.ctx,
	);
	assert.equal(answer.seen.length, 1);
	assert.match(answer.seen[0].message, /src\/l3\.ts/);
	assert.match(answer.seen[0].message, /UNIQUE-ANS/);
	assert.match(answer.seen[0].message, /"answer"/);

	const revise = tuiCtx();
	await call(findTool(tools, "coagent_revise_contract"), { missionId: "M1", contract }, revise.ctx);
	assert.match(revise.seen[0].message, /把按钮变绿/);
	assert.match(revise.seen[0].message, /src\/l3\.ts/);

	const fin = tuiCtx();
	await call(
		findTool(tools, "coagent_finalize_mission"),
		{ missionId: "M1", verdict: "send-back", reason: "理由全文UNIQUE-RSN" },
		fin.ctx,
	);
	assert.match(fin.seen[0].message, /UNIQUE-RSN/);
	assert.match(fin.seen[0].message, /--as/);
	assert.match(fin.seen[0].message, /--confirmed-by/);

	const cancel = tuiCtx();
	await call(
		findTool(tools, "coagent_cancel_mission"),
		{ missionId: "M1", reason: "叫停UNIQUE-CAN" },
		cancel.ctx,
	);
	assert.match(cancel.seen[0].message, /UNIQUE-CAN/);

	const create = tuiCtx();
	await call(
		findTool(tools, "coagent_create_mission"),
		{ projectId: "p", missionId: "M1", contract },
		create.ctx,
	);
	assert.match(create.seen[0].message, /src\/run-mission\.ts/);
	assert.match(create.seen[0].message, /把按钮变绿/);
	assert.match(create.seen[0].message, /M1\.json/);

	const boom = tuiCtx(async () => {
		throw new Error("不应确认");
	});
	await call(findTool(tools, "coagent_pause_mission"), { missionId: "M1" }, boom.ctx);
	await call(findTool(tools, "coagent_resume_mission"), { missionId: "M1" }, boom.ctx);
	await call(
		findTool(tools, "coagent_retire_work_item"),
		{ missionId: "M1", workItemId: "W-1", reason: "x" },
		boom.ctx,
	);
	await call(findTool(tools, "coagent_ack_delivery"), { deliveryId: "D-1" }, boom.ctx);
	await call(
		findTool(tools, "coagent_plan_decide"),
		{ escalationId: "E-1", action: "skip", reason: "做不出来" },
		boom.ctx,
	);
	await call(findTool(tools, "coagent_get_inbox"), {}, boom.ctx);
	assert.equal(boom.seen.length, 0);
});

test("终审强制成对 --as / --confirmed-by；平台不含该参数或理由为空则拒绝", async () => {
	const { ctx } = tuiCtx();

	const ok = recordingRuntime();
	const okTools = createReviewerTools(sampleInput(), ok.runtime);
	await call(
		findTool(okTools, "coagent_finalize_mission"),
		{ missionId: "M1", verdict: "merge" },
		ctx,
	);
	const args = ok.calls[0]?.cmd.args ?? [];
	const asAt = args.indexOf("--as");
	const byAt = args.indexOf("--confirmed-by");
	assert.ok(asAt >= 0 && byAt >= 0);
	assert.equal(args[asAt + 1], "rev-alice");
	assert.equal(args[byAt + 1], "bob");
	assert.ok(!args.includes("human") || args[asAt + 1] !== "human");

	const old = recordingRuntime({ l3Source: "function main() { /* 旧平台 */ }" });
	const oldTools = createReviewerTools(sampleInput(), old.runtime);
	const refused = await call(
		findTool(oldTools, "coagent_finalize_mission"),
		{ missionId: "M1", verdict: "merge" },
		ctx,
	);
	assert.match(textOf(refused), new RegExp(NOT_EXECUTED));
	assert.match(textOf(refused), /--confirmed-by/);
	assert.equal(old.calls.length, 0);

	const empty = recordingRuntime();
	const emptyTools = createReviewerTools(sampleInput(), empty.runtime);
	for (const verdict of ["send-back", "abandon"] as const) {
		const r = await call(
			findTool(emptyTools, "coagent_finalize_mission"),
			{ missionId: "M1", verdict, reason: "   " },
			ctx,
		);
		assert.match(textOf(r), new RegExp(NOT_EXECUTED));
		assert.match(textOf(r), /--reason/);
	}
	assert.equal(empty.calls.length, 0);
});

test("撞锁只认 LockBusyError 文本并附加提示；其它非零退出原样且不说撞锁", async () => {
	const { ctx } = tuiCtx();

	const busy = recordingRuntime({
		sync: {
			status: 1,
			stdout: "",
			stderr: `✗ ${LOCK_BUSY_MARK}（pid 9）。`,
		},
	});
	const busyTools = createReviewerTools(sampleInput(), busy.runtime);
	const busyText = textOf(await call(findTool(busyTools, "coagent_pause_mission"), { missionId: "M1" }, ctx));
	assert.match(busyText, /退出码: 1/);
	assert.match(busyText, new RegExp(LOCK_BUSY_HINT));

	const other = recordingRuntime({
		sync: { status: 2, stdout: "nope", stderr: "磁盘满了" },
	});
	const otherTools = createReviewerTools(sampleInput(), other.runtime);
	const otherText = textOf(await call(findTool(otherTools, "coagent_pause_mission"), { missionId: "M1" }, ctx));
	assert.match(otherText, /退出码: 2/);
	assert.match(otherText, /磁盘满了/);
	assert.ok(!otherText.includes(LOCK_BUSY_HINT));
});

test("下发：确认后才写 mission.json；立即返回；带 missionId/日志/PID/尚未证明已创建", async () => {
	const input = sampleInput();
	const cfg = parseReviewerConfig(input);
	let finished = false;
	const never = new Promise<void>(() => {});
	const writes: { path: string; content: string }[] = [];
	const calls: { kind: string }[] = [];
	const runtime: ReviewerProcessRuntime = {
		runSync() {
			calls.push({ kind: "sync" });
			throw new Error("下发不得同步等待 run-mission");
		},
		spawnBackground() {
			calls.push({ kind: "bg" });
			void never.then(() => {
				finished = true;
			});
			return { pid: 777 };
		},
		readText: () => "--confirmed-by",
		writeText(path, content) {
			writes.push({ path, content });
		},
		ensureDir() {},
	};
	const tools = createReviewerTools(input, runtime);
	const { ctx, seen } = tuiCtx();
	const result = await call(
		findTool(tools, "coagent_create_mission"),
		{ projectId: "p", missionId: "M42", contract },
		ctx,
	);
	const text = textOf(result);
	assert.equal(finished, false);
	assert.equal(calls.filter((c) => c.kind === "sync").length, 0);
	assert.equal(calls.filter((c) => c.kind === "bg").length, 1);
	assert.equal(writes.length, 1);
	assert.equal(writes[0].path, join(cfg.runsDirAbs, "M42.json"));
	assert.match(writes[0].content, /M42/);
	assert.match(writes[0].content, /把按钮变绿/);
	assert.match(text, /M42/);
	assert.match(text, /777/);
	assert.match(text, new RegExp(CREATE_NOT_PROVEN));
	assert.match(text, /M42\.run\.log/);
	assert.ok(seen[0].message.includes(writes[0].content.trim()) || seen[0].message.includes("把按钮变绿"));

	const denied = recordingRuntime();
	const deniedTools = createReviewerTools(input, denied.runtime);
	const { ctx: noCtx } = tuiCtx(async () => false);
	await call(
		findTool(deniedTools, "coagent_create_mission"),
		{ projectId: "p", missionId: "M42", contract },
		noCtx,
	);
	assert.equal(denied.writes.length, 0);
	assert.equal(denied.calls.length, 0);
});

test("merge 不传 reason 时 argv 不含 --reason；cancel 同理", async () => {
	const rec = recordingRuntime();
	const tools = createReviewerTools(sampleInput(), rec.runtime);
	const { ctx } = tuiCtx();
	await call(findTool(tools, "coagent_finalize_mission"), { missionId: "M1", verdict: "merge" }, ctx);
	assert.ok(!rec.calls[0].cmd.args.includes("--reason"));
	await call(findTool(tools, "coagent_cancel_mission"), { missionId: "M1" }, ctx);
	assert.ok(!rec.calls[1].cmd.args.includes("--reason"));
});

test("resolveInsideRunsDir 拒绝逃出 runsDir 的文件名；合法文件在 hub 外的 runsDir 内", () => {
	const input = sampleInput();
	const cfg = parseReviewerConfig(input);
	assert.throws(
		() => resolveInsideRunsDir(cfg.runsDirAbs, cfg.hubAbs, "../hub/x.json"),
		/逃出|落入/,
	);
	const ok = resolveInsideRunsDir(cfg.runsDirAbs, cfg.hubAbs, "M1.json");
	assert.equal(ok, join(cfg.runsDirAbs, "M1.json"));
	assert.equal(dirname(ok), cfg.runsDirAbs);
	assert.equal(isPathInside(cfg.hubAbs, ok), false);
	assert.equal(isPathInside(cfg.runsDirAbs, ok), true);
});

test("恶意 missionId 在确认前拒绝：零写入、零 spawn、不弹框；合法路径在 hub 外 runsDir 内", async () => {
	const badIds = [
		"../hub/evil",
		"..\\hub\\evil",
		"foo/bar",
		"foo\\bar",
		"C:evil",
		"M1.",
		"CON",
		"con",
		"NUL",
		"nul.txt",
		"COM1",
		"lpt9",
		".",
		"..",
		"foo/../x",
		"foo..bar",
		"a\u0000b",
		"",
		" leading",
	];
	for (const missionId of badIds) {
		for (const name of ["coagent_create_mission", "coagent_revise_contract"] as const) {
			const rec = recordingRuntime();
			const tools = createReviewerTools(sampleInput(), rec.runtime);
			const { ctx, seen } = tuiCtx(async () => true);
			const params =
				name === "coagent_create_mission"
					? { projectId: "p", missionId, contract }
					: { missionId, contract };
			const result = await call(findTool(tools, name), params, ctx);
			assert.match(textOf(result), new RegExp(NOT_EXECUTED), `${name} ${JSON.stringify(missionId)} 应拒绝`);
			assert.equal(seen.length, 0, `${name} ${JSON.stringify(missionId)} 不得弹确认框`);
			assert.equal(rec.calls.length, 0, `${name} ${JSON.stringify(missionId)} 不得起进程`);
			assert.equal(rec.writes.length, 0, `${name} ${JSON.stringify(missionId)} 不得写文件`);
		}
	}

	const rec = recordingRuntime();
	const input = sampleInput();
	const cfg = parseReviewerConfig(input);
	const tools = createReviewerTools(input, rec.runtime);
	const { ctx } = tuiCtx();
	const created = await call(
		findTool(tools, "coagent_create_mission"),
		{ projectId: "p", missionId: "Mgood", contract },
		ctx,
	);
	const createdText = textOf(created);
	assert.match(createdText, /Mgood\.json/);
	assert.match(createdText, /Mgood\.run\.log/);
	assert.equal(rec.writes.length, 1);
	assert.equal(rec.writes[0].path, join(cfg.runsDirAbs, "Mgood.json"));
	assert.equal(dirname(rec.writes[0].path), cfg.runsDirAbs);
	assert.equal(isPathInside(cfg.hubAbs, rec.writes[0].path), false);
	assert.equal(isPathInside(cfg.runsDirAbs, rec.writes[0].path), true);
	const logPath = rec.calls.find((c) => c.kind === "bg")?.logPath;
	assert.equal(logPath, join(cfg.runsDirAbs, "Mgood.run.log"));
	assert.equal(isPathInside(cfg.hubAbs, logPath ?? ""), false);
	assert.equal(isPathInside(cfg.runsDirAbs, logPath ?? ""), true);

	const revised = recordingRuntime();
	const reviseTools = createReviewerTools(input, revised.runtime);
	await call(findTool(reviseTools, "coagent_revise_contract"), { missionId: "Mgood", contract }, ctx);
	assert.equal(revised.writes[0].path, join(cfg.runsDirAbs, "revise-Mgood.json"));
	assert.equal(isPathInside(cfg.hubAbs, revised.writes[0].path), false);
	assert.equal(isPathInside(cfg.runsDirAbs, revised.writes[0].path), true);
});

test("同步调用进程没能启动时如实报告原因，不造退出码、不说撞锁", async () => {
	const rec = recordingRuntime({
		sync: {
			status: null,
			stdout: "",
			stderr: "",
			error: "spawn node ENOENT",
		},
	});
	const tools = createReviewerTools(sampleInput(), rec.runtime);
	const { ctx } = tuiCtx();
	const text = textOf(await call(findTool(tools, "coagent_get_inbox"), {}, ctx));
	assert.match(text, new RegExp(PROCESS_NOT_STARTED));
	assert.match(text, /ENOENT/);
	assert.match(text, /退出码: null/);
	assert.match(text, /可执行文件找不到|cwd 不存在/);
	assert.ok(!text.includes(LOCK_BUSY_HINT));
	assert.doesNotMatch(text, /退出码: \d+/);
});

test("默认 runtime：后台 spawn 立即返回，日志接到假进程 stdout", async () => {
	const root = mkdtempSync(join(tmpdir(), "r0a1-bg-"));
	const hub = join(root, "hub");
	const runsDir = join(root, "runs");
	const doneFile = join(root, "exited.marker");
	mkdirSync(join(hub, "src"), { recursive: true });
	mkdirSync(runsDir, { recursive: true });
	const marker = "R0A1_FAKE_RUN_LINE";
	// 真平台用裸 node 跑 .ts（Node 24 类型剥离），测试不得给子进程注入 tsx。
	// 临时 hub 没有 package.json，Node 把 .ts 当 CJS；CJS 不支持顶层 await，故用 require + setTimeout，不写类型。
	writeFileSync(
		join(hub, "src", "run-mission.ts"),
		[
			'const { writeFileSync } = require("node:fs");',
			`console.log(${JSON.stringify(marker)});`,
			"setTimeout(() => {",
			`  writeFileSync(${JSON.stringify(doneFile)}, "exited");`,
			"}, 1500);",
			"",
		].join("\n"),
		"utf8",
	);

	let pid = 0;
	try {
		const input = sampleInput({
			hub,
			state: join(root, "state.json"),
			projectRepo: join(root, "repo"),
			runsDir,
		});
		const cfg = parseReviewerConfig(input);
		assert.equal(isPathInside(cfg.hubAbs, cfg.runsDirAbs), false);
		const tools = createReviewerTools(input);
		const { ctx, seen } = tuiCtx(async () => true);
		const result = await call(
			findTool(tools, "coagent_create_mission"),
			{ projectId: "p", missionId: "Mproc1", contract },
			ctx,
		);
		assert.equal(seen.length, 1);
		const text = textOf(result);
		assert.match(text, /Mproc1/);
		assert.match(text, new RegExp(CREATE_NOT_PROVEN));
		const pidMatch = text.match(/pid: (\d+)/);
		assert.ok(pidMatch);
		pid = Number(pidMatch[1]);
		assert.ok(pid > 0);
		// 假进程 1.5s 后才写标记；工具已返回且标记还不在，证明没有等它退出。不用 kill(pid, 0)。
		assert.equal(existsSync(doneFile), false, "工具返回时假进程退出标记不应已存在");

		const missionFile = join(cfg.runsDirAbs, "Mproc1.json");
		const logPath = join(cfg.runsDirAbs, "Mproc1.run.log");
		assert.equal(existsSync(missionFile), true);
		assert.equal(isPathInside(cfg.hubAbs, missionFile), false);
		assert.equal(isPathInside(cfg.runsDirAbs, missionFile), true);
		assert.equal(isPathInside(cfg.hubAbs, logPath), false);
		assert.equal(isPathInside(cfg.runsDirAbs, logPath), true);

		const deadline = Date.now() + 8000;
		while (Date.now() < deadline) {
			if (existsSync(doneFile)) break;
			await new Promise((r) => setTimeout(r, 50));
		}
		assert.equal(existsSync(doneFile), true, "假进程应在超时前写出退出标记");
		// 管道刷新可能略晚于标记文件，标记出现后再轮询日志。
		const logDeadline = Date.now() + 3000;
		let log = "";
		while (Date.now() < logDeadline) {
			if (existsSync(logPath)) {
				log = readFileSync(logPath, "utf8");
				if (log.includes(marker)) break;
			}
			await new Promise((r) => setTimeout(r, 50));
		}
		assert.ok(log.includes(marker), `日志应含假进程 stdout，实际: ${JSON.stringify(log)}`);
	} finally {
		if (pid > 0) {
			try {
				process.kill(pid);
			} catch {
				/* already gone */
			}
		}
		rmSync(root, { recursive: true, force: true });
	}
});

test("每个检视者工具都有 parameters schema（0.86+ 无 schema 会在注册时被拒）", () => {
	const rec = recordingRuntime();
	const tools = createReviewerTools(sampleInput(), rec.runtime);
	assert.equal(tools.length, REVIEWER_TOOL_NAMES.length);
	for (const tool of tools) {
		assert.ok(tool.parameters, `${tool.name} 必须有 parameters`);
	}
});
