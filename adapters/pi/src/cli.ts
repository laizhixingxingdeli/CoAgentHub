/**
 * 诊断 CLI 与检视者交互入口。派发仍由平台调度器走 agent-entry；
 * reviewer 命令只起 pi TUI，不调用 agent-entry。
 *
 *   tsx src/cli.ts doctor   —— 逐个探活 profile，顺便验证代理是否装上了
 *   tsx src/cli.ts models   —— 把可用模型清单打成 JSON（平台的资源池页用）
 *   tsx src/cli.ts audit    —— 对照上游目录查档案表里哪些条目已经过期
 *   tsx src/cli.ts reviewer —— 受控检视者会话
 *
 * audit 与 doctor 的区别：audit **不发一次真实任务**（不建 session、不调
 * session.prompt），只做静态对照，所以随便跑、可重复跑；doctor 要花 Prompt 钱。
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, getAgentDir } from "@earendil-works/pi-coding-agent";

import { installHttpDispatcher, proxySummary } from "./http.js";
import { registerPendingProviderExtensions, resolveProviderExtensionPaths } from "./provider-extensions.js";
import { auditProfiles, formatAuditReport } from "./profile-audit.js";
import { knownProfileIds, resolveProfile } from "./profiles.js";
import {
	reviewerClosedTools,
	reviewerEnvFromConfig,
	reviewerExtensionEntryPath,
} from "./reviewer-extension.js";
import { l3SourcePath, parseReviewerConfig } from "./reviewer-tools.js";
import { queryUsage, type UsageDependencies } from "./usage.js";

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(name);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

/** 契约 JSON 摊平成一段话。对照组没有平台，拿不到结构化契约，只能像交代人那样交代。 */
function flattenContract(raw: string): string {
	try {
		const spec = JSON.parse(raw) as {
			contract?: Record<string, unknown> & { intent?: string };
		};
		const c = spec.contract;
		if (!c?.intent) return raw;
		const block = (title: string, key: string) => {
			const items = c[key];
			return Array.isArray(items) && items.length > 0
				? `\n\n## ${title}\n${items.map((s) => `- ${String(s)}`).join("\n")}`
				: "";
		};
		return (
			c.intent +
			block("验收标准", "acceptance") +
			block("约束", "constraints") +
			block("不做什么", "nonGoals") +
			block("红线", "guardrails")
		);
	} catch {
		return raw; // 不是 JSON 就当纯文本任务
	}
}

/**
 * 对照组：**一个 agent、一个会话，从头做到尾**。
 *
 * 平台的价值主张是「比直接把活交给一个 agent 更好」，那对照组就必须是
 * 「直接把活交给一个 agent」。在这之前平台从来没和它比过 —— 所有对照都在比
 * "用哪个模型"，没有一个在比"拆成 L2/L1 这件事值不值"。
 *
 * 和「协调者与执行者用同一个模型」**不是一回事**：那个仍然拆两个会话、照付
 * 交接成本，只是两边碰巧同一个模型。这里测的是拆分本身。
 *
 * **pi 自己的代码是当前版本，而 agent 的 cwd 指向被测工作区** —— 两者必须
 * 分开，否则对照组和另外几臂就不是同一个起点了。
 */
async function solo() {
	const taskFile = arg("--task");
	const cwd = arg("--cwd");
	if (!taskFile || !cwd) {
		throw new Error(
			"用法：tsx src/cli.ts solo --task <契约.json> --cwd <被测工作区>\n" +
				"      [--profile <id>] [--provider <p> --model <m> --reasoning <lv>]\n" +
				"  静态表里没有的候选（平台候选池建的那种）必须给 --provider/--model。",
		);
	}
	const task = flattenContract(readFileSync(resolve(taskFile), "utf8"));
	const profileId = arg("--profile") ?? "coordinator-grok";

	// 运行时身份走 facts，和平台一模一样的机制。
	//
	// 不能只传 profileId：平台候选池里建出来的候选（在界面上选模型加的那种）
	// **根本不在静态表里**，身份全靠平台把 facts 带下来。对照组如果只认静态表，
	// 就跑不了那几个候选 —— 而它们恰恰是要拿来对照的。
	const provider = arg("--provider");
	const model = arg("--model");
	const facts = [
		...(provider ? [{ key: "provider", value: provider }] : []),
		...(model ? [{ key: "model", value: model }] : []),
		...(arg("--reasoning") ? [{ key: "reasoning", value: arg("--reasoning") as string }] : []),
	];

	const { startRun } = await import("./runtime.js");
	const started = Date.now();
	const outcome = await startRun({
		role: "solo",
		attemptId: `solo-${Date.now()}`,
		missionId: "solo",
		cwd: resolve(cwd),
		profile: { profileId, endpoint: "local", ...(facts.length > 0 ? { facts } : {}) },
		instruction: task,
		tools: [],
		// 没有平台可连。扩展里取简报那一步会失败 —— 它本来就设计成"取不到不阻断"。
		endpoint: { baseUrl: "http://127.0.0.1:1", token: "none" },
		stream: true,
	} as Parameters<typeof startRun>[0]);

	const u = outcome.usage;
	console.log(`\n${"=".repeat(64)}`);
	// endedBy 是平台的词汇表。solo 没有平台、也没有结构化提交这回事，
	// 所以 no_structured_result 在这里是**正常结束**，不是失败 —— 直接把那个
	// 英文枚举印出来会让人以为它挂了。
	const ended =
		outcome.endedBy === "no_structured_result"
			? "模型自行结束（solo 没有结构化提交这一步，属正常）"
			: outcome.endedBy;
	console.log(`对照组（单会话）  profile=${profileId}  结束方式=${ended}`);
	console.log(
		`耗时 ${Math.round((Date.now() - started) / 1000)}s  工具调用 ${outcome.toolNames?.length ?? 0} 次`,
	);
	console.log(
		`用量 in=${u.input} out=${u.output} cacheRead=${u.cacheRead} total=${u.total} cost=$${(u.cost ?? 0).toFixed(4)}`,
	);
}

async function doctor() {
	installHttpDispatcher();
	console.log(`代理：${proxySummary()}`);
	console.log(
		"（Node 内置 fetch 不读 HTTP_PROXY —— curl 能通不代表 SDK 能通，所以这里必须自己装 dispatcher）\n",
	);

	const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
	const runtime = await ModelRuntime.create();

	for (const profileId of knownProfileIds()) {
		const profile = resolveProfile(profileId);
		const label = `${profileId.padEnd(18)} ${profile.provider}/${profile.model}`;
		const model = runtime.getModel(profile.provider, profile.model);
		if (!model) {
			console.log(`✗ ${label}  —— 配置里找不到这个模型`);
			continue;
		}
		try {
			const { createAgentSession, SessionManager } = await import(
				"@earendil-works/pi-coding-agent"
			);
			const { session } = await createAgentSession({
				model,
				thinkingLevel: "off",
				modelRuntime: runtime,
				sessionManager: SessionManager.inMemory(),
				noTools: "all",
			});
			let failure: string | undefined;
			session.subscribe((event) => {
				if (event.type === "agent_end") {
					for (const message of (event as { messages?: unknown[] }).messages ?? []) {
						const m = message as { stopReason?: string; errorMessage?: string };
						if (m.stopReason === "error" && m.errorMessage) failure = m.errorMessage;
					}
				}
			});
			await session.prompt("回两个字：可用");
			session.dispose();
			console.log(failure ? `✗ ${label}  —— ${failure.slice(0, 110)}` : `✓ ${label}`);
		} catch (e) {
			console.log(`✗ ${label}  —— ${e instanceof Error ? e.message.slice(0, 110) : String(e)}`);
		}
	}
}

/**
 * 打印可用模型清单（JSON 一行）。
 *
 * **平台不认识模型**——它只会执行这条命令、把 JSON 原样转出去。
 * 哪些模型可用只有这一层知道，所以清单必须从这里出，
 * 而不是在平台侧再维护一份会过期的表。
 */
async function models() {
	installHttpDispatcher();
	const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
	const runtime = await ModelRuntime.create();
	const baseline = await runtime.getAvailable();
	let available = baseline;
	const paths = resolveProviderExtensionPaths("codebuddy");
	if (paths.length > 0) {
		try {
			const loader = new DefaultResourceLoader({
				cwd: process.cwd(),
				agentDir: getAgentDir(),
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noContextFiles: true,
				additionalExtensionPaths: paths,
			});
			await loader.reload();
			await registerPendingProviderExtensions(loader, runtime);
			available = await runtime.getAvailable();
		} catch {
			// Keep the baseline list when the optional provider extension cannot load.
		}
	}
	const rows = available.map((m: { provider: string; id: string }) => ({
		provider: m.provider,
		model: m.id,
		// 给界面直接用的显示名，省得前端再拼一次。
		label: `${m.provider}/${m.id}`,
	}));
	process.stdout.write(JSON.stringify(rows));
}

/**
 * 对照上游目录审计静态档案表：表里写的 provider/model 还在不在。
 *
 * 上游把 provider 整个改名后，档案表那一行会静默过期，症状却是任务跑几秒就死、
 * 报「模型不可用」——看着像候选质量不行。这条命令让它在派发**之前**暴露。
 *
 * 只读目录，不发 prompt；全对 exit 0，有过期 exit 1（好挂进 CI / 调度前的自检）。
 */
async function audit() {
	installHttpDispatcher();
	const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
	const runtime = await ModelRuntime.create();

	// 存在性看全量目录（getModels），「该改成什么」看有凭证的清单（getAvailable）。
	const catalog = runtime
		.getModels()
		.map((m: { provider: string; id: string }) => ({ provider: m.provider, model: m.id }));
	const available = (await runtime.getAvailable()).map((m: { provider: string; id: string }) => ({
		provider: m.provider,
		model: m.id,
	}));

	const profiles = knownProfileIds().map((profileId) => {
		const profile = resolveProfile(profileId);
		return { profileId, provider: profile.provider, model: profile.model };
	});

	const result = auditProfiles(profiles, catalog);
	console.log(formatAuditReport(result, available));
	// 用 exitCode 而不是 process.exit()：直接 exit 可能在管道里截断上面那段文本。
	process.exitCode = result.ok ? 0 : 1;
}

export interface ReviewerCliSpawnOptions {
	shell: false;
	stdio: "inherit";
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export interface ReviewerCliChild {
	on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
	on(event: "error", listener: (err: Error) => void): unknown;
}

export type ReviewerCliSpawn = (
	command: string,
	args: readonly string[],
	options: ReviewerCliSpawnOptions,
) => ReviewerCliChild;

export interface ReviewerCliDeps {
	spawn?: ReviewerCliSpawn;
	existsSync?: (path: string) => boolean;
	resolvePiCli?: () => string;
	extensionPath?: string;
	execPath?: string;
	stderr?: (message: string) => void;
	env?: NodeJS.ProcessEnv;
}

export interface ReviewerLaunch {
	command: string;
	args: string[];
	cwd: string;
	shell: false;
	stdio: "inherit";
	env: NodeJS.ProcessEnv;
}

const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

/**
 * 从本文件目录逐级向上找 node_modules/<name>/package.json。
 * 不用 createRequire：该包 exports 没有 ./package.json，"." 也只有 import、
 * 没有 require/default。不走 import.meta.resolve（那条路能拿到 dist/index.js
 * 再向上找 name 匹配的 package.json）；选文件系统查找是因为它与 Node 的
 * 包查找顺序一致，且完全不经过 exports。
 */
function findPiPackageJson(startDir: string): string {
	let dir = startDir;
	for (;;) {
		const candidate = join(dir, "node_modules", PI_PACKAGE_NAME, "package.json");
		if (existsSync(candidate)) {
			return candidate;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			throw new Error(
				`找不到 ${PI_PACKAGE_NAME} 的 package.json（从 ${startDir} 向上查找）。`,
			);
		}
		dir = parent;
	}
}

/** 从 pi 包 package.json 的 bin 解析，不写死版本号。 */
export function resolvePiCliBundle(fromFile: string = import.meta.url): string {
	const startDir = fromFile.startsWith("file:")
		? dirname(fileURLToPath(fromFile))
		: dirname(fromFile);
	const pkgPath = findPiPackageJson(startDir);
	const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
		name?: string;
		bin?: string | Record<string, string>;
	};
	if (pkg.name !== PI_PACKAGE_NAME) {
		throw new Error(
			`找到的 package.json name 是 ${JSON.stringify(pkg.name)}，不是 ${PI_PACKAGE_NAME}。`,
		);
	}
	const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.pi;
	if (!bin) {
		throw new Error("pi 包的 package.json 没有 bin.pi，无法解析 CLI bundle。");
	}
	const cliPath = resolve(dirname(pkgPath), bin);
	// 找不到就不把假路径交给 spawn：真用户起 reviewer 也会在这一步失败。
	if (!existsSync(cliPath)) {
		throw new Error(`pi CLI bundle 不存在：${cliPath}`);
	}
	return cliPath;
}

function cliFlag(argv: string[], name: string): string | undefined {
	const i = argv.indexOf(name);
	if (i < 0) return undefined;
	const value = argv[i + 1];
	if (value === undefined || value.startsWith("-")) return undefined;
	return value;
}

function requireCliFlag(argv: string[], name: string): string {
	const value = cliFlag(argv, name);
	if (value === undefined) {
		throw new Error(`缺少 ${name}。`);
	}
	return value;
}

function requireIdentityFlag(argv: string[], name: string): string {
	const value = cliFlag(argv, name);
	if (value === undefined) {
		throw new Error(
			`缺少 ${name}。必须显式给出 1..128 字符，不得默认 human、当前 OS 用户或模型名。`,
		);
	}
	return value;
}

export function prepareReviewerLaunch(
	argv: string[],
	deps: ReviewerCliDeps = {},
): ReviewerLaunch {
	const hub = requireCliFlag(argv, "--hub");
	const state = requireCliFlag(argv, "--state");
	const reviewer = requireIdentityFlag(argv, "--reviewer");
	const confirmedBy = requireIdentityFlag(argv, "--confirmed-by");
	const recipient = requireCliFlag(argv, "--recipient");
	const repo = requireCliFlag(argv, "--repo");
	const runsDir = requireCliFlag(argv, "--runs-dir");
	const model = cliFlag(argv, "--model");

	const input = {
		hub,
		state: resolve(state),
		reviewer,
		confirmedBy,
		recipient,
		projectRepo: resolve(repo),
		runsDir,
	};
	const cfg = parseReviewerConfig(input);
	const exists = deps.existsSync ?? existsSync;
	const l3 = l3SourcePath(cfg.hubAbs);
	if (!exists(l3)) {
		throw new Error(`hub 下必须有 src/l3.ts：找不到 ${l3}。`);
	}

	const piCli = (deps.resolvePiCli ?? resolvePiCliBundle)();
	const extensionPath = deps.extensionPath ?? reviewerExtensionEntryPath();
	const args = [
		piCli,
		"--no-extensions",
		"-e",
		extensionPath,
		"--tools",
		reviewerClosedTools().join(","),
	];
	if (model !== undefined) {
		args.push("--model", model);
	}

	// 只叠加路径/身份；沿用调用方环境给 pi 调模型，不新塞凭据。
	const overlay = reviewerEnvFromConfig({
		...input,
		hub: cfg.hubAbs,
		runsDir: cfg.runsDirAbs,
		state: cfg.state,
		projectRepo: cfg.projectRepo,
	});
	const baseEnv = deps.env ?? process.env;
	return {
		command: deps.execPath ?? process.execPath,
		args,
		cwd: resolve(cfg.projectRepo),
		shell: false,
		stdio: "inherit",
		env: { ...baseEnv, ...overlay },
	};
}

export async function runReviewerCommand(
	argv: string[],
	deps: ReviewerCliDeps = {},
): Promise<number> {
	const err = deps.stderr ?? ((message: string) => {
		console.error(message);
	});
	let launch: ReviewerLaunch;
	try {
		launch = prepareReviewerLaunch(argv, deps);
	} catch (e) {
		err(e instanceof Error ? e.message : String(e));
		return 1;
	}
	const spawnFn = deps.spawn ?? (spawn as unknown as ReviewerCliSpawn);
	try {
		const child = spawnFn(launch.command, launch.args, {
			shell: false,
			stdio: "inherit",
			cwd: launch.cwd,
			env: launch.env,
		});
		return await new Promise<number>((resolveExit) => {
			child.on("error", (error) => {
				err(error.message);
				resolveExit(1);
			});
			child.on("exit", (code) => {
				resolveExit(code ?? 1);
			});
		});
	} catch (e) {
		err(e instanceof Error ? e.message : String(e));
		return 1;
	}
}

export async function runUsageCommand(
	dependencies: UsageDependencies = {},
	write: (chunk: string) => void = (chunk) => process.stdout.write(chunk),
): Promise<void> {
	let rows;
	try {
		rows = await queryUsage(dependencies);
	} catch {
		rows = [{ provider: "xai" as const, status: "error" as const }];
	}
	write(`${JSON.stringify(rows)}\n`);
}

function isCliEntrypoint(): boolean {
	const self = fileURLToPath(import.meta.url);
	for (const token of process.argv.slice(1)) {
		try {
			const resolved = resolve(token);
			if (process.platform === "win32") {
				if (resolved.toLowerCase() === self.toLowerCase()) return true;
			} else if (resolved === self) {
				return true;
			}
		} catch {
			// argv 里不全是路径
		}
	}
	return false;
}

const USAGE = `用法：
  tsx src/cli.ts doctor   逐个探活 profile（会真发 prompt）
  tsx src/cli.ts models   打印可用模型清单（JSON）
  tsx src/cli.ts usage    打印用量信息（JSON）
  tsx src/cli.ts audit    对照上游目录查档案表哪些条目已过期（不发任务）
  tsx src/cli.ts solo --task <契约.json> --cwd <工作区> [--profile <id>]
                          对照组：一个 agent 一个会话干完，不拆 L2/L1
  tsx src/cli.ts reviewer --hub <hub> --state <state> --reviewer <name> --confirmed-by <name> --recipient <recipient> --repo <projectRepo> --runs-dir <平台仓外目录> [--model <model>]
                          检视者交互会话：只加载本扩展，不调用 agent-entry

派发不再走这里——由平台的调度器驱动 src/agent-entry.ts。`;

if (isCliEntrypoint()) {
const cmd = process.argv[2];
if (cmd === "usage") {
	runUsageCommand().catch(() => {
		process.stdout.write('[{"provider":"xai","status":"error"}]\n');
	});
} else if (cmd === "models") {
	models().catch((e) => {
		// 出错也要吐合法 JSON：调用方在解析，不在读日志。
		process.stdout.write(
			JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
		);
		process.exit(1);
	});
} else
if (cmd === "doctor") {
	doctor().catch((e) => {
		console.error(e instanceof Error ? e.stack : String(e));
		process.exit(1);
	});
} else
if (cmd === "audit") {
	audit().catch((e) => {
		console.error(e instanceof Error ? e.stack : String(e));
		process.exit(1);
	});
} else
if (cmd === "solo") {
	solo().catch((e) => {
		console.error(e instanceof Error ? e.stack : String(e));
		process.exit(1);
	});
} else
if (cmd === "reviewer") {
	runReviewerCommand(process.argv)
		.then((code) => {
			if (code !== 0) process.exit(code);
		})
		.catch((e) => {
			console.error(e instanceof Error ? e.stack : String(e));
			process.exit(1);
		});
} else {
	console.log(USAGE);
}
}
