/**
 * CoAgent Pi Extension —— 把一个普通 pi 会话变成受控的 L2/L1 Agent。
 *
 * 只做四件事：
 *   1. 注册 coagent_* 工具（handler 薄到只有一次平台调用）
 *   2. before_agent_start 逐轮注入角色 system prompt（compact 之后依然生效）
 *   3. tool_call 做 Policy Gate
 *   4. 记录本轮是否发生过结构化提交
 *
 * 不含任何平台领域逻辑，也没有 fork pi —— 以上全部是 pi 现成的扩展点。
 */

import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { PlatformClient } from "./platform-client.js";
import { systemPrompt } from "./roles.js";
import type { Role } from "./roles.js";
import { TERMINAL_TOOLS, coagentTools } from "./tools.js";

const BRIEF_SOURCES = [
	"project_rules",
	"environment_notes",
	"contract",
	"plan",
	"final_review",
	"work_order",
] as const;

export type CoagentBriefSource = (typeof BRIEF_SOURCES)[number];

/** 执行者只需要 projectRules 里的这一节；整份 project.md 是协调者的东西。 */
const EXECUTOR_RULES_HEADING = "执行者红线";

const BRIEF_SOURCE_SET: ReadonlySet<string> = new Set(BRIEF_SOURCES);
const MAX_BRIEF_SOURCES = BRIEF_SOURCES.length;
const MAX_ESTIMATED_TOKENS = 1_000_000_000;

export type CoagentBriefInjected = {
	renderedUtf8Bytes: number;
	sources: {
		source: CoagentBriefSource;
		estimatedTokens?: number;
		truncated: boolean;
	}[];
};

export interface CoagentExtensionOptions {
	client: PlatformClient;
	role: Role;
	/** Mission worktree。越界的写操作会被挡。 */
	cwd: string;
	/** 本次 attempt 是否已经发生过结构化提交。 */
	completion: { submitted: boolean; via?: string };
	/** 每次实际注入简报后通知 runtime；无测得简报时为 undefined。 */
	onBriefInjected?: (brief: CoagentBriefInjected | undefined) => void;
}

/**
 * 会动仓库历史或当前分支的 git 操作。只挡明确高价值的，不做完整 shell sandbox。
 *
 * 保守优先：宁可挡一条无辜命令，也不放一条改历史的命令溜过去。
 * checkout/switch 不枚举分支名——切到任何分支都丢掉本工作项的工作区上下文，
 * 只有 ` -- <paths>` 这种还原路径的形态不算切分支。
 */
const DANGEROUS_GIT = [
	/\bgit\s+push\b/,
	/\bgit\s+commit\b(?![\w-])/,
	/\bgit\s+merge\b(?![\w-])/,
	/\bgit\s+rebase\b(?![\w-])/,
	/\bgit\s+cherry-pick\b/,
	// 分支名任意，含 -b/-B/-c/-C 新建切换；裸 checkout 目标有歧义也按切分支处理。
	// 只有紧跟 ` -- <paths>`（还原路径）这一形态放行。
	/\bgit\s+checkout\b(?![\w-])(?!\s+--\s)/,
	/\bgit\s+switch\b(?![\w-])/,
	// --hard 在本条命令任何位置都算，不限 origin/、不限参数顺序。
	/\bgit\s+reset\b(?![\w-])(?=[\s\S]*--hard\b)/,
	// 删分支：其他选项可以排在 -d/-D 前面。
	/\bgit\s+branch\b(?![\w-])(?=[\s\S]*\s(?:-[dD]|--delete)\b)/,
	/\bgit\s+stash\s+(?:drop|clear)\b/,
];

export function createCoagentExtension(opts: CoagentExtensionOptions): ExtensionFactory {
	const { client, role, cwd, completion, onBriefInjected } = opts;
	const root = resolve(cwd);

	const insideWorktree = (p: unknown): boolean => {
		if (typeof p !== "string" || p.length === 0) return true;
		const abs = resolve(root, p);
		return abs === root || abs.startsWith(`${root}\\`) || abs.startsWith(`${root}/`);
	};

	return (pi: ExtensionAPI) => {
		for (const tool of coagentTools(role, client)) {
			pi.registerTool(tool);
		}

		/**
		 * 开跑简报（S09.1 [MUST]：托管 agent 启动时**直接获得**契约/工单/红线）。
		 *
		 * 取一次就缓存：before_agent_start 每轮都跑（compact 之后也跑），
		 * 每轮都去拉一次是白花的往返。
		 *
		 * 取不到不阻断——简报是"少走一轮弯路"，不是必需品：agent 手上还有
		 * coagent_get_mission / coagent_get_work_order 这条退路。
		 */
		let brief: string | undefined;
		let briefSources: CoagentBriefInjected["sources"] | undefined;
		let briefFetched = false;
		pi.on("before_agent_start", async () => {
			if (!briefFetched) {
				const loaded = await fetchBrief(client, role);
				brief = loaded.text;
				briefSources = loaded.sources;
				briefFetched = true;
			}
			const injected = brief ? `${systemPrompt(role)}\n\n${brief}` : systemPrompt(role);
			onBriefInjected?.(
				brief && briefSources !== undefined
					? {
							renderedUtf8Bytes: Buffer.byteLength(brief, "utf8"),
							sources: briefSources,
						}
					: undefined,
			);
			return { systemPrompt: injected };
		});

		pi.on("tool_call", async (event) => {
			const name = event.toolName;

			if (role === "coordinator" && (name === "edit" || name === "write")) {
				return { block: true, reason: "协调者不负责改代码。把它拆成工作项派给执行者。" };
			}

			if (name === "edit" || name === "write") {
				const path = event.input?.path;
				if (!insideWorktree(path)) {
					return {
						block: true,
						reason: `越界写入被挡：${String(path)} 不在本 Mission 的 worktree 内。`,
					};
				}
				if (typeof path === "string") {
					const normalized = path.replaceAll("\\", "/");
					if (normalized.includes(".coagent/") || normalized.endsWith("VIBE.md")) {
						return { block: true, reason: "L1 不得修改 .coagent Project Truth。需要改就报告给 L2。" };
					}
				}
			}

			if (name === "bash" || name === "powershell") {
				const command = String(event.input?.command ?? "");
				if (DANGEROUS_GIT.some((re) => re.test(command))) {
					// 提交不在这里开口子：一个工作项一个检查点由平台负责，agent 自己 commit 会绕过它。
					return {
						block: true,
						reason: `平台挡下了这条危险 git 操作：${command}。会改历史/切分支/推送的操作由平台统一处理，提交按工作项由平台做检查点，不要自己执行。`,
					};
				}
			}

			return undefined;
		});

		pi.on("tool_execution_end", async (event) => {
			const name = (event as { toolName?: string }).toolName ?? "";
			if (!TERMINAL_TOOLS.has(name)) return;
			// HTTP 失败时 execute 返回 isError，不能记成 structured_submit。
			// 只约束独立检视终端工具，避免改动协调者/执行者既有收尾行为。
			if (
				name === "coagent_submit_independent_review" &&
				(event as { isError?: boolean }).isError
			) {
				return;
			}
			completion.submitted = true;
			completion.via = name;
		});
	};
}

interface StartupBrief {
	role: string;
	projectId: string;
	missionId: string;
	status: string;
	projectRules?: string;
	contract?: { intent: string; acceptance: string[]; constraints: string[]; nonGoals: string[]; guardrails: string[] };
	contractRevision?: number;
	plan?: { findings: string; rootCause?: string; direction: string; rejectedHypotheses: string[]; decisions: string[]; risks: string[] };
	planRevision?: number;
	workItem?: { id: string; title: string; order?: Record<string, unknown>; previousRequiredChanges?: string[]; l3SendBackReasons?: string[]; question?: string; answer?: string };
	workItemsIndex?: unknown[];
	sinceLastHop?: { summary: string; validationReport?: unknown }[];
	contractCheck?: { contractRevision: number; verdict: string; summary: string; issues?: string[] };
	finalReview?: { verdict: string; reasons: string[] };
	contextBundle?: unknown;
}

function isBoundedNonNegInt(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= 0 &&
		value <= MAX_ESTIMATED_TOKENS
	);
}

/**
 * 只抽出可上报的来源桶。不读、不留 content / hash / 路径 / budget。
 * 不合法则整份视为旧平台/不可测。
 */
function extractSafeSources(data: unknown): CoagentBriefInjected["sources"] | undefined {
	if (data === null || typeof data !== "object") return undefined;
	const bundle = (data as { contextBundle?: unknown }).contextBundle;
	if (bundle === null || typeof bundle !== "object") return undefined;
	const entries = (bundle as { entries?: unknown }).entries;
	if (!Array.isArray(entries) || entries.length > MAX_BRIEF_SOURCES) return undefined;

	const omitted = new Set<string>();
	const report = (bundle as { budgetReport?: unknown }).budgetReport;
	if (report !== null && typeof report === "object") {
		const raw = (report as { omittedSources?: unknown }).omittedSources;
		if (Array.isArray(raw)) {
			for (const item of raw) {
				if (typeof item === "string") omitted.add(item);
			}
		}
	}

	const seen = new Set<string>();
	const sources: CoagentBriefInjected["sources"] = [];
	for (const item of entries) {
		if (item === null || typeof item !== "object") return undefined;
		const rec = item as Record<string, unknown>;
		const source = rec.source;
		if (typeof source !== "string" || !BRIEF_SOURCE_SET.has(source)) return undefined;
		if (seen.has(source)) return undefined;
		seen.add(source);

		const entry: CoagentBriefInjected["sources"][number] = {
			source: source as CoagentBriefSource,
			truncated: rec.truncated === true || omitted.has(source),
		};
		if (Object.prototype.hasOwnProperty.call(rec, "estimatedTokens") && rec.estimatedTokens !== undefined) {
			if (!isBoundedNonNegInt(rec.estimatedTokens)) return undefined;
			entry.estimatedTokens = rec.estimatedTokens;
		}
		sources.push(entry);
	}
	return sources;
}

/**
 * 按 Markdown 标题截出一节：从该标题起，到**同级或更高级**标题为止。
 * 子标题（级别更低）属于这一节，原样保留。
 *
 * 截不到返回 undefined —— 调用方据此决定不渲染，**不回退成整份规则**：
 * 回退就等于把「只给执行者红线」这个决定悄悄撤掉。
 */
function extractRulesSection(rules: string, title: string): string | undefined {
	const lines = rules.split(/\r?\n/);
	let level = 0;
	const start = lines.findIndex((line) => {
		const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line.trim());
		if (!m) return false;
		if (m[2] !== title) return false;
		level = m[1].length;
		return true;
	});
	if (start < 0) return undefined;
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		const m = /^(#{1,6})\s/.exec(lines[i].trim());
		if (m && m[1].length <= level) {
			end = i;
			break;
		}
	}
	const text = lines.slice(start, end).join("\n").trim();
	return text.length > 0 ? text : undefined;
}

/**
 * 取 contextBundle 里 environment_notes 的实际内容。没有就是没有，不编。
 * content 可能是字符串、字符串数组或结构化对象。
 */
function environmentNotes(data: StartupBrief): string | undefined {
	const bundle = data.contextBundle;
	if (bundle === null || typeof bundle !== "object") return undefined;
	const entries = (bundle as { entries?: unknown }).entries;
	if (!Array.isArray(entries)) return undefined;
	const entry = entries.find(
		(item) =>
			item !== null &&
			typeof item === "object" &&
			(item as { source?: unknown }).source === "environment_notes",
	);
	if (!entry) return undefined;
	const content = (entry as { content?: unknown }).content;
	const items = Array.isArray(content) ? content : [content];
	const rendered = items
		.map((item) => {
			if (typeof item === "string") return item.trim();
			if (item === undefined || item === null) return "";
			return JSON.stringify(item);
		})
		.filter((item) => item.length > 0)
		.map((item) => `- ${item}`)
		.join("\n");
	return rendered.length > 0 ? rendered : undefined;
}

/**
 * 把简报渲染成一段 Markdown 塞进 system prompt。
 *
 * 为什么不让模型自己调工具取：那等于把"要不要看架构红线"变成模型的选择题。
 * 执行者的工具表里根本没有取红线的口——不在这里给，它就永远看不到。
 */
async function fetchBrief(
	client: PlatformClient,
	role: Role,
): Promise<{ text: string; sources: CoagentBriefInjected["sources"] | undefined }> {
	// solo **没有平台**：它一个 coagent_* 都没有，也不该有。
	// independent_reviewer 用 bundle 工具自己取材料，不走 run/brief（那是协调者/执行者简报）。
	// 两者都不要打 brief：失败会把 client.sawUnreachable 翻成 true，把一次正常跑报成 platform_unreachable。
	if (role === "solo" || role === "independent_reviewer") return { text: "", sources: undefined };
	const data = await client.get<StartupBrief>("run/brief");
	if (!data) return { text: "", sources: undefined };

	const lines: string[] = ["# 本次任务（平台在你开口之前就给了你）", ""];
	lines.push(`项目 ${data.projectId} · Mission ${data.missionId} · 当前阶段 ${data.status}`);

	// 协调者管全局，看整份规则；执行者只拿「执行者红线」那一节 —— 整份
	// project.md 比工单本身还长，每跳塞一遍是在反复付这份钱。
	if (role === "coordinator") {
		if (data.projectRules) {
			lines.push("", "## 架构红线（项目级，不可协商）", "", data.projectRules.trim());
		}
	} else {
		const redLines = data.projectRules
			? extractRulesSection(data.projectRules, EXECUTOR_RULES_HEADING)
			: undefined;
		if (redLines) lines.push("", redLines);
	}

	const envNotes = environmentNotes(data);
	if (envNotes) lines.push("", "## 平台环境提示（本次运行环境）", "", envNotes);

	if (role === "coordinator") {
		if (data.contract) {
			lines.push("", `## 契约 r${data.contractRevision ?? 1}`, "", data.contract.intent);
			const block = (title: string, items: string[]) => {
				if (items?.length) lines.push("", `**${title}**`, ...items.map((i) => `- ${i}`));
			};
			block("验收标准", data.contract.acceptance);
			block("约束", data.contract.constraints);
			block("非目标", data.contract.nonGoals);
			block("本 Mission 的红线", data.contract.guardrails);
		}
		if (data.plan) {
			lines.push("", `## 已有规划 r${data.planRevision}`, "", `方向：${data.plan.direction}`);
			if (data.plan.rootCause) lines.push("", "**已确认根因**", data.plan.rootCause);
			if (data.plan.findings) lines.push("", "**已确认的发现**", data.plan.findings);
			if (data.plan.decisions?.length) lines.push("", "**已有决策**", ...data.plan.decisions.map((d) => `- ${d}`));
			if (data.plan.risks?.length) lines.push("", "**未解决风险**", ...data.plan.risks.map((r) => `- ${r}`));
			if (data.plan.rejectedHypotheses?.length) {
				lines.push("", "**已排除的假设**（别再绕回去查一遍）");
				lines.push(...data.plan.rejectedHypotheses.map((h) => `- ${h}`));
			}
		}
		if (data.contractCheck) lines.push("", "## 当前契约核对", JSON.stringify(data.contractCheck));
		if (data.workItemsIndex?.length) lines.push("", "## 工作项索引", ...data.workItemsIndex.map((item) => JSON.stringify(item)));
		if (data.sinceLastHop?.length) {
			lines.push("", "## 上一跳以来的变化", ...data.sinceLastHop.map((entry) => `- ${entry.summary}${entry.validationReport === undefined ? "" : "\n机器验证：" + JSON.stringify(entry.validationReport)}`));
		}
		if (data.finalReview?.verdict === "send_back") {
			lines.push("", "## L3 把它打回了，理由", "", ...data.finalReview.reasons.map((r) => `- ${r}`));
		}
	} else if (data.workItem) {
		lines.push("", `## 你的工单 ${data.workItem.id}：${data.workItem.title}`);
		const item = data.workItem;
		if (item.previousRequiredChanges?.length) lines.push("", "## 本轮必须修复的差距", ...item.previousRequiredChanges.map((change) => `- ${change}`));
		if (item.l3SendBackReasons?.length) lines.push("", "## L3 打回理由", ...item.l3SendBackReasons.map((reason) => `- ${reason}`));
		if (item.answer !== undefined) lines.push("", "## 已答复的阻塞", `问题：${item.question ?? "未提供"}`, `答复：${item.answer}`);
		const order = data.workItem.order;
		if (order) {
			lines.push("", "```json", JSON.stringify(order, null, 2), "```");
		}
	}

	lines.push(
		"",
		"以上是平台直接交给你的，**不用再调工具去取**。",
		"需要更细的现状（工作项、尝试、时间线）再去读。",
	);
	const text = lines.join("\n");
	if (!text) return { text: "", sources: undefined };
	return { text, sources: extractSafeSources(data) };
}
