/**
 * 检视者平台工具：v0 包 l3.ts / run-mission.ts 命令，不走 HTTP。
 *
 * 独立于 tools.ts 的 SPECS，避免把 reviewer 工具面并进 coordinator/executor。
 * 进程替身可注入，R0a2 复用同一套 argv 构造与执行接口。
 */

import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TSchema } from "typebox";

import { REVIEWER_TOOL_NAMES } from "./roles.js";

/** 只认平台 LockBusyError 文案里的这一句，其它非零退出不得说成撞锁。 */
export const LOCK_BUSY_MARK = "平台正被另一个进程占用";
export const LOCK_BUSY_HINT = "锁被占，稍后再试";
/** 确认失败 / 无 UI / 非 tui：零写入、零执行时的如实回报。 */
export const NOT_EXECUTED = "没有执行";
/** spawn 成功不等于 Mission 已创建。 */
export const CREATE_NOT_PROVEN = "尚未证明已创建";
/** spawnSync 根本没拉起进程时的如实前缀；不得改成数字退出码或撞锁。 */
export const PROCESS_NOT_STARTED = "进程没能启动";

const L3_SCRIPT = "src/l3.ts";
const RUN_MISSION_SCRIPT = "src/run-mission.ts";

export interface ReviewerConfigInput {
	hub: string;
	state: string;
	reviewer: string;
	confirmedBy: string;
	recipient: string;
	projectRepo: string;
	runsDir: string;
	/** 测试可覆盖；默认 process.execPath，避免 Windows 上走 shell 的 node.cmd。 */
	nodePath?: string;
}

export interface ReviewerConfig {
	hub: string;
	hubAbs: string;
	state: string;
	reviewer: string;
	confirmedBy: string;
	recipient: string;
	projectRepo: string;
	runsDir: string;
	runsDirAbs: string;
	nodePath: string;
}

export interface PlatformCommand {
	command: string;
	args: string[];
	cwd: string;
	shell: false;
}

export interface SyncProcessResult {
	status: number | null;
	stdout: string;
	stderr: string;
	/** 进程根本没启动时 spawnSync.error.message；不要把它改写成退出码。 */
	error?: string;
}

export interface BackgroundProcess {
	pid: number;
}

/**
 * 进程与文件替身。测试换成记录调用的假函数，绝不指向真平台仓。
 */
export interface ReviewerProcessRuntime {
	runSync(cmd: PlatformCommand): SyncProcessResult | Promise<SyncProcessResult>;
	spawnBackground(cmd: PlatformCommand, logPath: string): BackgroundProcess;
	readText(path: string): string;
	writeText(path: string, content: string): void;
	ensureDir(path: string): void;
}

const ContractSchema = Type.Object({
	intent: Type.String({ description: "要达成的结果和原因，写结果不写步骤。" }),
	acceptance: Type.Array(Type.String(), { description: "每条都能判真假。" }),
	constraints: Type.Array(Type.String(), { description: "范围和必须守的约束。" }),
	nonGoals: Type.Array(Type.String(), { description: "明确不做的。" }),
	guardrails: Type.Array(Type.String(), { description: "碰了就要停下来升级的红线。" }),
});

function requireField(name: string, value: unknown): string {
	if (typeof value !== "string") {
		throw new Error(`${name} 必须显式给出字符串，不得默认。`);
	}
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		throw new Error(`${name} 不能只是空白。`);
	}
	return trimmed;
}

function requireIdentity(name: string, value: unknown): string {
	const trimmed = requireField(name, value);
	if (trimmed.length > 128) {
		throw new Error(`${name} 经 trim 后必须是 1..128 字符。`);
	}
	return trimmed;
}

/** hub 外：解析成绝对路径后，不得等于 hub，也不得在 hub 目录之下。 */
export function isPathInside(root: string, target: string): boolean {
	const rel = relative(resolve(root), resolve(target));
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

const SAFE_MISSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WIN_RESERVED_DEV = /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(\..*)?$/i;

function dirsEqual(a: string, b: string): boolean {
	const x = resolve(a);
	const y = resolve(b);
	// Windows 上文件系统大小写不敏感，只比字面值会把 C:\Runs 和 c:\runs 当成两处。
	return process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/**
 * 写 runsDir 之前校验 missionId：只接受安全文件名片段。
 * 第一道只看字符串；第二道见 resolveInsideRunsDir。两道都要，因为正则过了仍可能被 resolve 吃掉点段。
 */
export function assertSafeMissionId(raw: unknown): string {
	if (typeof raw !== "string") {
		throw new Error("missionId 必须是字符串。");
	}
	if (raw !== raw.trim()) {
		throw new Error("missionId 首尾不得有空白（Windows 会悄悄去掉结尾空格）。");
	}
	if (raw === "." || raw === ".." || raw.includes("..")) {
		throw new Error("missionId 不得为 . / ..，也不得含点段 ..。");
	}
	if (/[:/\\]/.test(raw) || /[\u0000-\u001f]/.test(raw)) {
		throw new Error("missionId 不得含路径分隔符、盘符冒号或控制字符。");
	}
	if (!SAFE_MISSION_ID.test(raw)) {
		throw new Error("missionId 必须匹配 ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$。");
	}
	if (raw.endsWith(".") || raw.endsWith(" ")) {
		throw new Error("missionId 不得以点或空格结尾（Windows 会悄悄去掉）。");
	}
	if (WIN_RESERVED_DEV.test(raw)) {
		throw new Error("missionId 不得使用 Windows 保留设备名（CON/NUL/COM1 等）。");
	}
	return raw;
}

/**
 * resolve(runsDir, 文件名) 之后：父目录必须恰好是 resolve 后的 runsDir，且结果不在 hub 下。
 */
export function resolveInsideRunsDir(runsDirAbs: string, hubAbs: string, fileName: string): string {
	const runs = resolve(runsDirAbs);
	const resolved = resolve(runs, fileName);
	if (!dirsEqual(dirname(resolved), runs)) {
		throw new Error(`目标文件会逃出 runsDir：${resolved}`);
	}
	if (isPathInside(hubAbs, resolved)) {
		throw new Error(`目标文件会落入 hub：${resolved}`);
	}
	return resolved;
}

export function parseReviewerConfig(input: ReviewerConfigInput): ReviewerConfig {
	const hub = requireField("hub", input.hub);
	const runsDir = requireField("runsDir", input.runsDir);
	const hubAbs = resolve(hub);
	const runsDirAbs = resolve(runsDir);
	if (isPathInside(hubAbs, runsDirAbs)) {
		throw new Error(`runsDir 必须在 hub 外：${runsDirAbs} 落在 ${hubAbs} 之下。`);
	}
	return {
		hub,
		hubAbs,
		state: requireField("state", input.state),
		reviewer: requireIdentity("reviewer", input.reviewer),
		confirmedBy: requireIdentity("confirmedBy", input.confirmedBy),
		recipient: requireField("recipient", input.recipient),
		projectRepo: requireField("projectRepo", input.projectRepo),
		runsDir,
		runsDirAbs,
		nodePath: input.nodePath?.trim() ? input.nodePath.trim() : process.execPath,
	};
}

export function createDefaultReviewerRuntime(): ReviewerProcessRuntime {
	return {
		runSync(cmd) {
			const r = spawnSync(cmd.command, cmd.args, {
				cwd: cmd.cwd,
				shell: false,
				encoding: "utf8",
			});
			return {
				status: r.status,
				stdout: r.stdout ?? "",
				stderr: r.stderr ?? "",
				...(r.error ? { error: r.error.message } : {}),
			};
		},
		spawnBackground(cmd, logPath) {
			mkdirSync(dirname(logPath), { recursive: true });
			const log = createWriteStream(logPath, { flags: "a" });
			const child = spawn(cmd.command, cmd.args, {
				cwd: cmd.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				detached: true,
			});
			child.stdout?.pipe(log);
			child.stderr?.pipe(log);
			child.unref();
			return { pid: child.pid ?? 0 };
		},
		readText(path) {
			return readFileSync(path, "utf8");
		},
		writeText(path, content) {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, content, "utf8");
		},
		ensureDir(path) {
			mkdirSync(path, { recursive: true });
		},
	};
}

export function nodeCommand(config: ReviewerConfig, args: string[]): PlatformCommand {
	return {
		command: config.nodePath,
		args,
		cwd: config.hubAbs,
		shell: false,
	};
}

export function formatCommand(cmd: PlatformCommand): string {
	return [
		`可执行文件: ${cmd.command}`,
		`argv: ${JSON.stringify(cmd.args)}`,
		`cwd: ${cmd.cwd}`,
		`shell: ${cmd.shell}`,
	].join("\n");
}

export function presentSyncResult(r: SyncProcessResult): string {
	const exit = r.status === null ? "null" : String(r.status);
	const lines: string[] = [];
	if (r.error) {
		lines.push(`${PROCESS_NOT_STARTED}: ${r.error}`);
		if (/ENOENT/i.test(r.error)) {
			lines.push("常见原因：可执行文件找不到，或 cwd 不存在。");
		}
	}
	lines.push(`退出码: ${exit}`);
	lines.push(`stdout:\n${r.stdout}`);
	lines.push(`stderr:\n${r.stderr}`);
	const text = lines.join("\n");
	const blob = `${r.stdout}\n${r.stderr}`;
	// status===null 时 null!==0 为真，不能据此当成撞锁，更不能补一个退出码。
	if (typeof r.status === "number" && r.status !== 0 && blob.includes(LOCK_BUSY_MARK)) {
		return `${text}\n${LOCK_BUSY_HINT}`;
	}
	return text;
}

export function l3SourcePath(hubAbs: string): string {
	return join(hubAbs, "src", "l3.ts");
}

/**
 * 旧平台会忽略未知参数并悄悄记成 human。
 * 终审前读源码里有没有 --confirmed-by；没有就拒绝，绝不降级。
 */
export function reviewerSignatureSupport(runtime: ReviewerProcessRuntime, hubAbs: string): {
	ok: boolean;
	detail: string;
} {
	const path = l3SourcePath(hubAbs);
	let src: string;
	try {
		src = runtime.readText(path);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, detail: `读不到平台 ${path}，无法确认支持 --confirmed-by（${msg}）。终审未执行。` };
	}
	if (!src.includes("--confirmed-by")) {
		return {
			ok: false,
			detail: `平台 ${path} 不含 --confirmed-by，终审工具已禁用。不会改成不带签名的调用。`,
		};
	}
	return { ok: true, detail: path };
}

function textResult(text: string, details: Record<string, unknown> = {}, isError = false) {
	return {
		content: [{ type: "text" as const, text }],
		details,
		...(isError ? { isError: true } : {}),
	};
}

function notExecuted(reason: string) {
	return textResult(reason, { executed: false }, true);
}

/**
 * RPC 的 hasUI 也是 true，所以必须三者同时成立才算能确认。
 * 不满足时连 confirm 都不调，避免远端弹框被当成授权。
 */
export async function confirmIfTui(
	ctx: ExtensionContext,
	title: string,
	message: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
	if (ctx.mode !== "tui") {
		return { ok: false, reason: `${NOT_EXECUTED}：当前模式是 ${String(ctx.mode)}，要确认的动作只在 tui 下执行。` };
	}
	if (!ctx.hasUI) {
		return { ok: false, reason: `${NOT_EXECUTED}：没有 UI，不能确认。` };
	}
	const confirm = ctx.ui?.confirm;
	if (typeof confirm !== "function") {
		return { ok: false, reason: `${NOT_EXECUTED}：没有 confirm，不能确认。` };
	}
	try {
		const yes = await confirm.call(ctx.ui, title, message);
		if (yes !== true) {
			return { ok: false, reason: `${NOT_EXECUTED}：用户拒绝了确认。` };
		}
		return { ok: true };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, reason: `${NOT_EXECUTED}：确认过程出错（${msg}）。` };
	}
}

async function runL3(
	runtime: ReviewerProcessRuntime,
	cmd: PlatformCommand,
) {
	const r = await runtime.runSync(cmd);
	return textResult(presentSyncResult(r), {
		exitCode: r.status,
		stdout: r.stdout,
		stderr: r.stderr,
		command: cmd,
	}, r.status !== 0);
}

function optionalFlag(flag: string, value: string | undefined): string[] {
	return value !== undefined && value.length > 0 ? [flag, value] : [];
}

const CONFIRM_TOOLS = new Set([
	"coagent_create_mission",
	"coagent_answer_escalation",
	"coagent_revise_contract",
	"coagent_finalize_mission",
	"coagent_cancel_mission",
]);

export function reviewerConfirmToolNames(): readonly string[] {
	return [...CONFIRM_TOOLS];
}

export function createReviewerTools(
	input: ReviewerConfigInput,
	runtime: ReviewerProcessRuntime = createDefaultReviewerRuntime(),
) {
	const config = parseReviewerConfig(input);

	const specs: Array<{
		name: (typeof REVIEWER_TOOL_NAMES)[number];
		label: string;
		description: string;
		promptSnippet: string;
		parameters: TSchema;
		execute: (
			params: Record<string, unknown>,
			ctx: ExtensionContext,
		) => Promise<ReturnType<typeof textResult>>;
	}> = [
		{
			name: "coagent_get_inbox",
			label: "Get Inbox",
			description: "列出待取的投递。recipient 缺省用配置里的收件人。",
			promptSnippet: "读取检视者收件箱",
			parameters: Type.Object({
				recipient: Type.Optional(Type.String({ description: "覆盖配置里的收件人。" })),
			}),
			async execute(params) {
				const recipient = typeof params.recipient === "string" && params.recipient.trim()
					? params.recipient.trim()
					: config.recipient;
				const cmd = nodeCommand(config, [
					L3_SCRIPT,
					"inbox",
					"--recipient",
					recipient,
					"--state",
					config.state,
				]);
				return runL3(runtime, cmd);
			},
		},
		{
			name: "coagent_get_mission",
			label: "Get Mission",
			description: "看契约、计划、工作项、改动、交卷内容（对应 l3 show）。",
			promptSnippet: "读取 Mission 全貌（含改动与记忆正文）",
			parameters: Type.Object({
				missionId: Type.String({ description: "Mission id" }),
			}),
			async execute(params) {
				const cmd = nodeCommand(config, [
					L3_SCRIPT,
					"show",
					String(params.missionId),
					"--state",
					config.state,
				]);
				return runL3(runtime, cmd);
			},
		},
		{
			name: "coagent_get_plan_run",
			label: "Get Plan Run",
			description: "方案运行交接面。不传 runPath 时沿用平台「最新记录」规则。不启动方案。",
			promptSnippet: "读取方案运行交接面",
			parameters: Type.Object({
				runPath: Type.Optional(Type.String({ description: "方案运行记录路径。不传则用平台默认。" })),
			}),
			async execute(params) {
				const runPath = typeof params.runPath === "string" ? params.runPath.trim() : "";
				const cmd = nodeCommand(config, [
					L3_SCRIPT,
					"plan",
					...optionalFlag("--run", runPath || undefined),
					"--state",
					config.state,
				]);
				return runL3(runtime, cmd);
			},
		},
		{
			name: "coagent_get_runs",
			label: "Get Runs",
			description: "同一任务的历次运行横着比。",
			promptSnippet: "读取同一任务的历次运行",
			parameters: Type.Object({
				missionId: Type.String({ description: "Mission id" }),
			}),
			async execute(params) {
				const cmd = nodeCommand(config, [
					L3_SCRIPT,
					"runs",
					String(params.missionId),
					"--state",
					config.state,
				]);
				return runL3(runtime, cmd);
			},
		},
		{
			name: "coagent_answer_escalation",
			label: "Answer Escalation",
			description: "答复协调者的升级。要用户在确认框里点头。",
			promptSnippet: "答复升级（需确认）",
			parameters: Type.Object({
				missionId: Type.String(),
				answer: Type.String({ description: "答复全文。" }),
			}),
			async execute(params, ctx) {
				const missionId = String(params.missionId);
				const answer = String(params.answer);
				const cmd = nodeCommand(config, [
					L3_SCRIPT,
					"answer",
					missionId,
					"--answer",
					answer,
					"--state",
					config.state,
				]);
				const message = `${formatCommand(cmd)}\n\n答复全文:\n${answer}`;
				const gate = await confirmIfTui(ctx, "答复升级", message);
				if (!gate.ok) return notExecuted(gate.reason);
				return runL3(runtime, cmd);
			},
		},
		{
			name: "coagent_revise_contract",
			label: "Revise Contract",
			description: "发布新契约。确认后才在 hub 外写入契约文件，再调 l3 revise。",
			promptSnippet: "发布新契约（需确认；确认后才写文件）",
			parameters: Type.Object({
				missionId: Type.String(),
				contract: ContractSchema,
			}),
			async execute(params, ctx) {
				let missionId: string;
				let file: string;
				try {
					missionId = assertSafeMissionId(params.missionId);
					file = resolveInsideRunsDir(config.runsDirAbs, config.hubAbs, `revise-${missionId}.json`);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return notExecuted(`${NOT_EXECUTED}：${msg}`);
				}
				const contract = params.contract;
				const body = `${JSON.stringify({ contract }, null, 2)}\n`;
				const cmd = nodeCommand(config, [
					L3_SCRIPT,
					"revise",
					missionId,
					"--contract",
					file,
					"--state",
					config.state,
				]);
				const message = `${formatCommand(cmd)}\n\nmissionId: ${missionId}\n契约全文:\n${body}`;
				const gate = await confirmIfTui(ctx, "发布新契约", message);
				if (!gate.ok) return notExecuted(gate.reason);
				runtime.ensureDir(config.runsDirAbs);
				runtime.writeText(file, body);
				return runL3(runtime, cmd);
			},
		},
		{
			name: "coagent_finalize_mission",
			label: "Finalize Mission",
			description:
				"终审：merge / send-back / abandon。强制成对传 --as 与 --confirmed-by。平台不支持签名则拒绝，不降级。",
			promptSnippet: "终审放行/打回/放弃（需确认；双身份签名）",
			parameters: Type.Object({
				missionId: Type.String(),
				verdict: Type.Union([
					Type.Literal("merge"),
					Type.Literal("send-back"),
					Type.Literal("abandon"),
				]),
				reason: Type.Optional(Type.String({ description: "send-back / abandon 必填非空。" })),
			}),
			async execute(params, ctx) {
				const missionId = String(params.missionId);
				const verdict = String(params.verdict);
				const reasonRaw = typeof params.reason === "string" ? params.reason : undefined;
				const reason = reasonRaw !== undefined ? reasonRaw.trim() : "";
				if ((verdict === "send-back" || verdict === "abandon") && reason.length === 0) {
					return notExecuted(`${NOT_EXECUTED}：${verdict} 必须给非空 --reason。`);
				}
				const support = reviewerSignatureSupport(runtime, config.hubAbs);
				if (!support.ok) {
					return notExecuted(`${NOT_EXECUTED}：${support.detail}`);
				}
				const cmd = nodeCommand(config, [
					L3_SCRIPT,
					verdict,
					missionId,
					...optionalFlag("--reason", reason || undefined),
					"--as",
					config.reviewer,
					"--confirmed-by",
					config.confirmedBy,
					"--state",
					config.state,
					"--repo",
					config.projectRepo,
				]);
				const message = [
					formatCommand(cmd),
					`检视者 --as: ${config.reviewer}`,
					`确认人 --confirmed-by: ${config.confirmedBy}`,
					`裁决: ${verdict}`,
					`理由全文:\n${reasonRaw ?? "（无）"}`,
					"这是不可逆的终审动作。",
				].join("\n");
				const gate = await confirmIfTui(ctx, "终审 Mission", message);
				if (!gate.ok) return notExecuted(gate.reason);
				return runL3(runtime, cmd);
			},
		},
		{
			name: "coagent_cancel_mission",
			label: "Cancel Mission",
			description: "叫停 Mission（终态）。要用户在确认框里点头。",
			promptSnippet: "叫停 Mission（需确认）",
			parameters: Type.Object({
				missionId: Type.String(),
				reason: Type.Optional(Type.String()),
			}),
			async execute(params, ctx) {
				const missionId = String(params.missionId);
				const reason = typeof params.reason === "string" ? params.reason.trim() : "";
				const cmd = nodeCommand(config, [
					L3_SCRIPT,
					"cancel",
					missionId,
					...optionalFlag("--reason", reason || undefined),
					"--state",
					config.state,
				]);
				const message = `${formatCommand(cmd)}\n\n叫停影响: Mission 进入终态，释放改动名额。在途那一跳会正常收尾，之后不再调度。\n理由全文:\n${typeof params.reason === "string" ? params.reason : "（无）"}`;
				const gate = await confirmIfTui(ctx, "叫停 Mission", message);
				if (!gate.ok) return notExecuted(gate.reason);
				return runL3(runtime, cmd);
			},
		},
		{
			name: "coagent_pause_mission",
			label: "Pause Mission",
			description: "暂停。阶段不变，调度器不碰。",
			promptSnippet: "暂停 Mission",
			parameters: Type.Object({
				missionId: Type.String(),
			}),
			async execute(params) {
				const cmd = nodeCommand(config, [
					L3_SCRIPT,
					"pause",
					String(params.missionId),
					"--state",
					config.state,
				]);
				return runL3(runtime, cmd);
			},
		},
		{
			name: "coagent_resume_mission",
			label: "Resume Mission",
			description: "只恢复标志。CLI 指明需另跑 run-mission 才推进。",
			promptSnippet: "恢复 Mission（不自动继续跑）",
			parameters: Type.Object({
				missionId: Type.String(),
			}),
			async execute(params) {
				const cmd = nodeCommand(config, [
					L3_SCRIPT,
					"resume",
					String(params.missionId),
					"--state",
					config.state,
				]);
				return runL3(runtime, cmd);
			},
		},
		{
			name: "coagent_retire_work_item",
			label: "Retire Work Item",
			description: "作废一个工作项。草稿只要求叫停 Mission 才确认，本工具不弹确认。",
			promptSnippet: "作废工作项",
			parameters: Type.Object({
				missionId: Type.String(),
				workItemId: Type.String(),
				reason: Type.String(),
			}),
			async execute(params) {
				const cmd = nodeCommand(config, [
					L3_SCRIPT,
					"retire",
					String(params.missionId),
					"--item",
					String(params.workItemId),
					"--reason",
					String(params.reason),
					"--state",
					config.state,
				]);
				return runL3(runtime, cmd);
			},
		},
		{
			name: "coagent_ack_delivery",
			label: "Ack Delivery",
			description: "确认收到投递。ack 改状态但按草稿不确认。",
			promptSnippet: "确认收到投递",
			parameters: Type.Object({
				deliveryId: Type.String(),
			}),
			async execute(params) {
				const cmd = nodeCommand(config, [
					L3_SCRIPT,
					"ack",
					String(params.deliveryId),
					"--state",
					config.state,
				]);
				return runL3(runtime, cmd);
			},
		},
		{
			name: "coagent_plan_decide",
			label: "Plan Decide",
			description: "方案升级单四选一。--as 为检视者身份。夜里要能自己定，不弹确认。",
			promptSnippet: "处理方案升级单（不确认）",
			parameters: Type.Object({
				escalationId: Type.String(),
				action: Type.Union([
					Type.Literal("rerun_isolated"),
					Type.Literal("skip"),
					Type.Literal("rescope"),
					Type.Literal("stop"),
				]),
				reason: Type.String(),
				drop: Type.Optional(Type.Array(Type.String(), { description: "rescope 时要拿掉的 featureId。" })),
				runPath: Type.Optional(Type.String()),
			}),
			async execute(params) {
				const drop = Array.isArray(params.drop)
					? params.drop.map((id) => String(id).trim()).filter(Boolean)
					: [];
				const runPath = typeof params.runPath === "string" ? params.runPath.trim() : "";
				const cmd = nodeCommand(config, [
					L3_SCRIPT,
					"plan",
					"decide",
					String(params.escalationId),
					"--action",
					String(params.action),
					"--reason",
					String(params.reason),
					"--as",
					config.reviewer,
					...optionalFlag("--run", runPath || undefined),
					"--state",
					config.state,
					...(drop.length > 0 ? ["--drop", drop.join(",")] : []),
				]);
				return runL3(runtime, cmd);
			},
		},
		{
			name: "coagent_create_mission",
			label: "Create Mission",
			description:
				"确认后把 mission.json 写到 hub 外 runsDir，后台 spawn run-mission，立即返回。spawn 成功不等于已创建。",
			promptSnippet: "下发 Mission（需确认；确认后才写文件、后台启动）",
			parameters: Type.Object({
				projectId: Type.String(),
				missionId: Type.String(),
				contract: ContractSchema,
				routing: Type.Optional(Type.Any()),
				coordinator: Type.Optional(Type.Array(Type.String(), { description: "仅指定时传 --coordinator。" })),
				executor: Type.Optional(Type.Array(Type.String(), { description: "仅指定时传 --executor。" })),
			}),
			async execute(params, ctx) {
				if (isPathInside(config.hubAbs, config.runsDirAbs)) {
					return notExecuted(`${NOT_EXECUTED}：runsDir 必须在 hub 外。`);
				}
				let missionId: string;
				let missionFile: string;
				let logPath: string;
				try {
					missionId = assertSafeMissionId(params.missionId);
					missionFile = resolveInsideRunsDir(config.runsDirAbs, config.hubAbs, `${missionId}.json`);
					logPath = resolveInsideRunsDir(config.runsDirAbs, config.hubAbs, `${missionId}.run.log`);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return notExecuted(`${NOT_EXECUTED}：${msg}`);
				}
				const spec: Record<string, unknown> = {
					projectId: params.projectId,
					missionId,
					contract: params.contract,
				};
				if (params.routing !== undefined) spec.routing = params.routing;
				const body = `${JSON.stringify(spec, null, 2)}\n`;
				const coordinator = Array.isArray(params.coordinator)
					? params.coordinator.map((id) => String(id).trim()).filter(Boolean)
					: [];
				const executor = Array.isArray(params.executor)
					? params.executor.map((id) => String(id).trim()).filter(Boolean)
					: [];
				const cmd = nodeCommand(config, [
					RUN_MISSION_SCRIPT,
					missionFile,
					"--cwd",
					config.projectRepo,
					"--state",
					config.state,
					"--origin",
					config.recipient,
					...(coordinator.length > 0 ? ["--coordinator", coordinator.join(",")] : []),
					...(executor.length > 0 ? ["--executor", executor.join(",")] : []),
				]);
				const message = `${formatCommand(cmd)}\n\nmission.json 全文:\n${body}`;
				const gate = await confirmIfTui(ctx, "下发 Mission", message);
				if (!gate.ok) return notExecuted(gate.reason);
				runtime.ensureDir(config.runsDirAbs);
				runtime.writeText(missionFile, body);
				const spawned = runtime.spawnBackground(cmd, logPath);
				const text = [
					`Mission ${missionId} 启动已请求`,
					`pid: ${spawned.pid}`,
					`日志: ${logPath}`,
					`契约: ${missionFile}`,
					`${CREATE_NOT_PROVEN}，看日志或 inbox / show。`,
				].join("\n");
				return textResult(text, {
					missionId,
					logPath,
					pid: spawned.pid,
					missionFile,
					provenCreated: false,
				});
			},
		},
	];

	return specs.map((spec) =>
		defineTool({
			name: spec.name,
			label: spec.label,
			description: spec.description,
			promptSnippet: spec.promptSnippet,
			parameters: spec.parameters,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				return spec.execute(params as Record<string, unknown>, ctx);
			},
		}),
	);
}

export function reviewerToolNames(): string[] {
	return [...REVIEWER_TOOL_NAMES];
}
