/**
 * coagent_* 工具面。
 *
 * 每个工具 = 一份**面向模型的 schema + 说明** + 一次平台调用。没有别的。
 * 规则（没 Plan 不许建工作项、reject 必须说要改什么、执行者不能验收自己）
 * 全在平台侧，这里一条都不重复——重复就会有两份不一致的真相。
 *
 * S09.4：只有这些工具调用成功才改变平台状态。模型在回复里写"我做完了"，
 * 平台一个字都收不到。
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TSchema } from "typebox";
import type { PlatformClient } from "./platform-client.js";
import type { Role } from "./roles.js";

interface ToolSpec {
	name: string;
	label: string;
	description: string;
	promptSnippet: string;
	promptGuidelines?: string[];
	parameters: TSchema;
	/** 调用成功即表示这一程结束，turn 就地收尾，不再多花一轮。 */
	terminal?: boolean;
}

/* ============================ L2 / 协调者 ============================ */

/**
 * 工单上可选的结构化机器验收（VR1a / MODE-003）。
 *
 * create 与 revise 共用同一份，形状对齐平台 payloads.ts 的 WorkOrderValidationSpec：
 * 只认 commands / forbiddenPaths / diffSize 三个 key，平台侧多一个 key 就整份拒掉。
 */
const WORK_ORDER_VALIDATION = Type.Object({
	commands: Type.Array(
		Type.Object({
			argv: Type.Array(Type.String(), {
				description: "命令的 argv，逐段给。不接 shell 字符串，也不接 cwd。",
			}),
			timeoutMs: Type.Number({ description: "这条命令的超时毫秒数。" }),
		}),
		{ description: "执行者交卷后平台自己跑的命令。可以给空数组。" },
	),
	forbiddenPaths: Type.Optional(
		Type.Array(Type.String(), { description: "不许改动的路径；给了就按这份 denylist 检查。" }),
	),
	diffSize: Type.Optional(
		Type.Object({
			maxChangedFiles: Type.Optional(Type.Number({ description: "改动文件数上限。" })),
			maxChangedLines: Type.Optional(Type.Number({ description: "改动行数上限。" })),
		}),
	),
});

/**
 * 工单覆盖的契约验收标准序号（AC1）。
 *
 * create 与 revise 共用同一份：序号从 1 开始，对应 Mission Contract 的 acceptance
 * 顺序。这里只描述形状，哪些序号合法由平台判。
 */
const WORK_ORDER_CRITERIA = Type.Optional(
	Type.Array(Type.Number(), {
		description: "本工单覆盖的契约验收标准序号，从 1 开始（对应 Contract 的 acceptance 第几条）。",
	}),
);

/**
 * 交卷时逐条契约验收标准的结果（AC2）。
 */
const MISSION_CRITERIA = Type.Array(
	Type.Object({
		index: Type.Number({ description: "契约验收标准的序号，从 1 开始。" }),
		status: Type.Union(
			[
				Type.Literal("pass"),
				Type.Literal("fail"),
				Type.Literal("unverified"),
				Type.Literal("not_applicable"),
			],
			{ description: "pass / fail / unverified / not_applicable。" },
		),
		evidence: Type.String({
			description: "这一条的证据：命令、退出码、diff 位置。验不了的写为什么验不了。",
		}),
	}),
	{ description: "Contract 验收标准逐条的结果：一条对一条、顺序一致。" },
);

const COORDINATOR: ToolSpec[] = [
	{
		name: "coagent_get_mission",
		label: "Get Mission",
		description:
			"读取当前 Mission：用户意图、验收标准、约束、非目标、架构边界，以及当前 Plan 与所有 WorkItem 的状态。开工第一件事就调它。",
		promptSnippet: "读取 Mission Contract、Plan 与 WorkItem 现状",
		parameters: Type.Object({}),
	},
	{
		name: "coagent_get_project_context",
		label: "Get Project Context",
		description:
			"读取项目的长期知识：架构约束（红线）、Capability 索引、已有的架构决策。不传 slug 只给索引；要看某一份的正文就传它的 slug。**动手前先看一眼架构约束**——它是这个项目不可协商的东西。",
		promptSnippet: "读取项目的架构约束与 Capability 索引",
		parameters: Type.Object({
			slug: Type.Optional(
				Type.String({ description: "要看正文的那一份（Living Spec 或 ADR 的 slug）。不传则只返回索引。" }),
			),
		}),
	},
	{
		name: "coagent_get_contract",
		label: "Get Contract",
		description:
			"只读契约：意图、验收标准、约束、非目标、红线。调查中要回看验收标准或红线时用它，比 coagent_get_mission 便宜得多——后者会把全部工作项、尝试、时间线一起带回来。",
		promptSnippet: "只读契约（比读整个 Mission 便宜）",
		parameters: Type.Object({}),
	},
	{
		name: "coagent_get_work_item",
		label: "Get Work Item",
		description:
			"按 id 读一个工作项的细节：工单正文、状态、尝试与证据。coagent_get_mission 只给索引，要动手审某张单之前用这个把细节拿全。",
		promptSnippet: "按 id 读工作项细节（Mission 只给索引）",
		parameters: Type.Object({
			workItemId: Type.String({ description: "要看的工作项 id。" }),
		}),
	},
	{
		name: "coagent_get_validation_report",
		label: "Get Validation Report",
		description:
			"读平台对某个工作项跑出的**完整验证报告**（全文）：每条命令的 argv、退出码、输出与来源。工单提交的证据只给摘要。摘要不够时用这个——报告失败、要看失败细节、要核对计数与来源，都读全文，**不要为索取全文升级给 L3**：升级是用来定方向的，不是用来取数据的。不传 reportId 取该工作项最新一份报告。",
		promptSnippet: "读完整验证报告（摘要不够时，别为这个升级 L3）",
		parameters: Type.Object({
			workItemId: Type.String({ description: "要看验证报告的工作项 id。" }),
			reportId: Type.Optional(
				Type.String({ description: "指定某一份报告；不传取该工作项最新的一份。" }),
			),
		}),
	},
	{
		name: "coagent_update_findings",
		label: "Update Findings",
		description:
			"只把**调查发现**写回平台，不动方向和决策。调查途中每确认一件事就记一次——会话可能被压缩或换人接手，只有写回平台的才算数。方向定了之后用 coagent_update_plan 写完整的一份。",
		promptSnippet: "把这一步查到的事实写回平台",
		parameters: Type.Object({
			findings: Type.String({
				description: "查到的事实。引用具体文件与行号，不要泛泛而谈。",
			}),
			rejectedHypotheses: Type.Optional(
				Type.Array(Type.String(), {
					description: "已经排除的假设，以及排除的依据。防止后面绕回来重查一遍。",
				}),
			),
		}),
	},
	{
		name: "coagent_update_plan",
		label: "Update Plan",
		description:
			"把调查结论写回平台：发现、根因、被排除的假设、技术决策、实现方向、风险。**在创建任何 WorkItem 之前必须先调用它**。会话可能被压缩或换人接手，只有写回平台的才是权威。",
		promptSnippet: "把调查发现与技术方案写回平台（派发前必须先调）",
		parameters: Type.Object({
			findings: Type.String({
				description: "调查过程中查到的事实。引用具体文件与行号，不要泛泛而谈。",
			}),
			rootCause: Type.Optional(
				Type.String({ description: "根因。修复类任务必填；纯新增功能可留空。" }),
			),
			rejectedHypotheses: Type.Array(Type.String(), {
				description: "查过但被排除的假设，以及排除它的证据。这条防止后续尝试重走死路。",
			}),
			decisions: Type.Array(Type.String(), { description: "做出的技术决策，每条带一句理由。" }),
			direction: Type.String({ description: "实现方向：打算怎么改，为什么这样切。" }),
			risks: Type.Array(Type.String(), { description: "已知风险与不确定的地方。" }),
		}),
	},
	{
		name: "coagent_create_work_item",
		label: "Create Work Item",
		description:
			"创建一个可执行的工作项。判据：一个**没读过本次对话**的执行者，只拿这张工单就能动手并自证做完了。做不到就说明工单还不够。工作项要能独立验收——一张单塞满整个 Mission，失败时就只能整个重来。",
		promptSnippet: "创建一个 fresh 执行者可独立完成的工作项",
		parameters: Type.Object({
			title: Type.String({ description: "一行标题" }),
			objective: Type.String({ description: "要达成什么。写结果，不写步骤。" }),
			allowedScope: Type.Array(Type.String(), {
				description: "允许改动的文件/目录。越窄越好；不在清单里的地方执行者不许碰。",
			}),
			requiredBehaviour: Type.String({
				description:
					"改完之后系统应该表现成什么样；必要的实现提示。注意别把整份设计都写死——执行者需要判断空间，你写死的每一条错误都会被原样执行。",
			}),
			constraints: Type.Array(Type.String(), { description: "必须遵守的约束。" }),
			acceptance: Type.Array(Type.String(), { description: "验收标准，每条可判真假。" }),
			criteria: WORK_ORDER_CRITERIA,
			verification: Type.Array(Type.String(), {
				description: "执行者必须实际跑的验证命令。要具体到可复制粘贴。",
			}),
			doNot: Type.Array(Type.String(), { description: "明确禁止的动作。" }),
			contextRefs: Type.Array(Type.String(), {
				description: "最小充分上下文：相关文件路径、决策、前序结果。不要把全部历史塞进来。",
			}),
			validation: Type.Optional(WORK_ORDER_VALIDATION),
		}),
	},
	{
		name: "coagent_revise_work_order",
		label: "Revise Work Order",
		description:
			"修订一张已派发的工作项的工单正文，典型场景是执行者报 blocked、你换一种切法。body 是 workItemId 加**与创建时同一份**工单字段——平台整份替换，没给的字段就是没有；标题不在这里改，修订号由平台自己 +1。",
		promptSnippet: "修订工单正文（workItemId + 整份工单字段）",
		parameters: Type.Object({
			workItemId: Type.String({ description: "要修订的工作项 id。" }),
			objective: Type.String({ description: "要达成什么。写结果，不写步骤。" }),
			allowedScope: Type.Array(Type.String(), {
				description: "允许改动的文件/目录。越窄越好；不在清单里的地方执行者不许碰。",
			}),
			requiredBehaviour: Type.String({
				description:
					"改完之后系统应该表现成什么样；必要的实现提示。注意别把整份设计都写死——执行者需要判断空间。",
			}),
			constraints: Type.Array(Type.String(), { description: "必须遵守的约束。" }),
			acceptance: Type.Array(Type.String(), { description: "验收标准，每条可判真假。" }),
			criteria: WORK_ORDER_CRITERIA,
			verification: Type.Array(Type.String(), {
				description: "执行者必须实际跑的验证命令。要具体到可复制粘贴。",
			}),
			doNot: Type.Array(Type.String(), { description: "明确禁止的动作。" }),
			contextRefs: Type.Array(Type.String(), {
				description: "最小充分上下文：相关文件路径、决策、前序结果。不要把全部历史塞进来。",
			}),
			validation: Type.Optional(WORK_ORDER_VALIDATION),
		}),
	},
	{
		name: "coagent_retire_work_item",
		label: "Retire Work Item",
		description:
			"作废一个不再成立的工作项。典型场景：L3 改了契约，你照新契约另拆了一批工单，旧的那些已经没有意义了——作废它们，否则平台会把它们也跑一遍，做的是明确不要的那件事。**不要为了绕过一个难做的工单而作废它**；那种情况该升级给 L3。",
		promptSnippet: "作废一个不再成立的工作项",
		parameters: Type.Object({
			workItemId: Type.String({ description: "要作废的工作项 id。" }),
			reason: Type.String({
				description: "为什么它不再成立。写清楚被什么取代了，否则下一轮看到它的人会以为还要做。",
			}),
		}),
	},
	{
		name: "coagent_submit_contract_check",
		label: "Submit Contract Check",
		description:
			"派发前把与上游的契约核对结论写回平台：verdict=ok 表示这张单可以照契约动手，verdict=issues 时在 issues 里逐条列出对不上的地方。核对结论只影响你能怎么派，不会替你改契约。",
		promptSnippet: "派发前提交契约核对结论",
		parameters: Type.Object({
			verdict: Type.Union([Type.Literal("ok"), Type.Literal("issues")], {
				description: "ok：契约可直接动手；issues：契约有对不上的地方。",
			}),
			summary: Type.String({ description: "核对结论一句话。" }),
			issues: Type.Optional(
				Type.Array(Type.String(), { description: "verdict=issues 时逐条列出问题。" }),
			),
		}),
	},
	{
		name: "coagent_dispatch_work_item",
		label: "Dispatch Work Item",
		description:
			"把工作项交给平台派发给执行者。派发后本轮结束——执行者跑完，平台会重新唤醒你做技术验收。一次可以派发多个。",
		promptSnippet: "派发工作项，交还控制权等待执行结果",
		parameters: Type.Object({
			workItemIds: Type.Array(Type.String(), { description: '要派发的工作项 id，如 ["W-1","W-2"]' }),
		}),
		terminal: true,
	},
	{
		name: "coagent_review_execution_result",
		label: "Review Execution Result",
		description:
			"对某个工作项的执行结果做技术验收。执行者说「提交了」不等于「通过了」——只有你能接受技术结果。验收要看证据，不要看措辞：它说测试过了，证据里有命令和退出码吗？退出码是从管道里读的吗？acceptance 每一条都被某个证据覆盖了吗？",
		promptSnippet: "技术验收：accept 或 reject 某个执行结果",
		parameters: Type.Object({
			workItemId: Type.String(),
			verdict: Type.Union([Type.Literal("accept"), Type.Literal("reject")]),
			reasons: Type.Array(Type.String(), { description: "判断理由，逐条引用你看到的证据。" }),
			requiredChanges: Type.Array(Type.String(), {
				description: "reject 时必须填：下一次要改什么。accept 时留空数组。",
			}),
			// 方案 §11：评审按验收条逐条记，禁止只存一句总结。一句总结里「都过了」和「过了三条、
			// 第四条没法验」看起来一样——后者正是 L3 最需要看到的那条。
			acceptanceResults: Type.Array(
				Type.Object({
					criterion: Type.String({ description: "工单 acceptance 里的这一条，原文照抄，不要转述。" }),
					status: Type.Union([
						Type.Literal("pass"),
						Type.Literal("fail"),
						Type.Literal("unverified"),
						Type.Literal("not_applicable"),
					]),
					evidence: Type.Optional(
						Type.String({ description: "pass 时必填：哪条证据证明了它（命令 + 退出码、diff 的位置……）。" }),
					),
					note: Type.Optional(
						Type.String({ description: "unverified / not_applicable 时必填：为什么验不了 / 为什么不适用。" }),
					),
				}),
				{
					description:
						"工单 acceptance 逐条的验收结果：一条对一条、顺序一致。有一条 fail 就不能 accept；验不了的写 unverified 并说明，会原样送到 L3 眼前。工单没有 acceptance 时给空数组。",
				},
			),
		}),
	},
	{
		name: "coagent_escalate_to_l3",
		label: "Escalate to L3",
		description:
			"当技术发现影响到用户目标、验收标准或架构边界时升级给 L3。你不能自己改 Contract——发现 Contract 不成立时用这个工具，不要自行调整目标。",
		promptSnippet: "把影响 Contract/架构的问题升级给 L3",
		parameters: Type.Object({
			question: Type.String({ description: "需要 L3 拍板的那个问题，一句话。" }),
			why: Type.String({ description: "为什么这超出了你的权限——它动了 Contract 的哪一条。" }),
			optionsConsidered: Type.Array(Type.String(), { description: "你已经想过的选项及各自代价。" }),
		}),
		terminal: true,
	},
	{
		name: "coagent_submit_mission_result",
		label: "Submit Mission Result",
		description:
			"所有工作项都已验收通过后，提交 Mission 结果交回 L3 做最终检视。还有没验收的工作项时平台会拒绝——确实交不出来就用 outcome=blocked，如实说卡在哪。",
		promptSnippet: "提交 Mission 结果交回 L3",
		parameters: Type.Object({
			outcome: Type.Union([Type.Literal("delivered"), Type.Literal("blocked")]),
			summary: Type.String({ description: "做了什么、怎么验证的。给 L3 看。" }),
			acceptanceEvidence: Type.Array(Type.String(), {
				description: "逐条对应 Contract 的验收标准，每条指出是哪个证据满足了它。",
			}),
			criteria: MISSION_CRITERIA,
			memoryDelta: Type.Array(
				Type.Object({
					kind: Type.Union([Type.Literal("living_spec"), Type.Literal("adr")]),
					slug: Type.String({
						description:
							"Living Spec 用**稳定的 Capability 名**（如 scheduling、mission-lifecycle），不要用 Mission 名或日期——那会退化成每次改动一份永久文档。ADR 用 adr-NNNN-简短标题。",
					}),
					title: Type.String(),
					body: Type.Optional(Type.String({ description: "仅兼容旧交卷的整份正文；新提议使用 changes。" })),
					changes: Type.Optional(Type.Array(Type.Object({
						before: Type.String({ description: "现有文档中唯一匹配的原文；新文档用空字符串。" }),
						after: Type.String({ description: "替换后的局部正文，保留未改条款。" }),
					}))),
				}),
				{
					description:
						"文档只提精确差异 changes，不给整份正文；代码独立合入，不等待文档。检视者批准后由平台在没有 Mission 运行的空档独立提交。规则：只是修回既有行为 → 空数组；改变可观察行为 → 对应 Capability 的 Living Spec；长期取舍 → ADR。",
				},
			),
			openRisks: Type.Array(Type.String(), { description: "遗留风险与没验证到的部分。如实写。" }),
		}),
		terminal: true,
	},
];

/* ============================= L1 / 执行者 ============================= */

const EXECUTOR: ToolSpec[] = [
	{
		name: "coagent_get_work_order",
		label: "Get Work Order",
		description:
			"读取本次指派给你的工单：目标、允许改动范围、约束、验收标准、验证命令、禁止事项。被打回重做时，上一次的 requiredChanges 也在里面。动手前第一件事。",
		promptSnippet: "读取本次工单",
		parameters: Type.Object({}),
	},
	{
		name: "coagent_get_context",
		label: "Get Context",
		description:
			"取工单 contextRefs 里那些**不在工作区里**的东西：契约正文、规划、上一次被打回的检视意见。contextRefs 里的文件路径不要用这个工具，直接 read 更快更准。只能取工单声明过的；确实缺别的就用 coagent_report_blocked 说清楚，不要自己去翻。",
		promptSnippet: "取契约/规划/检视意见这类工作区里没有的上下文",
		parameters: Type.Object({
			ref: Type.String({ description: "工单 contextRefs 里那个 ref 的原文。" }),
		}),
	},
	{
		name: "coagent_submit_evidence",
		label: "Submit Evidence",
		description:
			"提交一条可验证证据：跑过的测试、命令与退出码、类型检查、构建、diff 摘要、运行观察。「已修复/已完成」必须有证据支撑；没跑过的不要提交。",
		promptSnippet: "提交一条可验证证据",
		parameters: Type.Object({
			kind: Type.Union([
				Type.Literal("test"),
				Type.Literal("command"),
				Type.Literal("diff"),
				Type.Literal("typecheck"),
				Type.Literal("build"),
				Type.Literal("observation"),
			]),
			summary: Type.String({ description: "一句话说明这条证据证明了什么。" }),
			command: Type.Optional(Type.String({ description: "实际执行的命令原文。" })),
			exitCode: Type.Optional(
				Type.Number({
					description:
						"命令退出码。管道会吞掉退出码——`cmd | tail` 拿到的是 tail 的 0，要退出码就别接管道。",
				}),
			),
			output: Type.Optional(Type.String({ description: "关键输出片段（截断到能说明问题即可）。" })),
		}),
	},
	{
		name: "coagent_submit_execution_result",
		label: "Submit Execution Result",
		description:
			"提交本次执行结果。**这是唯一能让平台认为你做完了的动作**——把结果写在回复里不算数。提交前确认工单里每条 verification 都真的跑过了。",
		promptSnippet: "提交执行结果（唯一有效的完成信号）",
		promptGuidelines: [
			"coagent_submit_execution_result 是你的最后一个动作，调完就结束，不要再补一段自然语言总结。",
			"提交前逐条对照工单的 acceptance 与 verification；有一条没做到就如实写进 notes，或者改用 coagent_report_blocked。",
		],
		parameters: Type.Object({
			outcome: Type.Union([Type.Literal("completed"), Type.Literal("partial")]),
			summary: Type.String({ description: "改了什么、为什么这样改。" }),
			changedFiles: Type.Array(Type.String(), { description: "实际改动的文件路径。" }),
			evidenceIds: Type.Array(Type.String(), {
				description: "之前 coagent_submit_evidence 返回的证据 id。",
			}),
			notes: Type.String({
				description: "遗留问题、没验证到的部分、对工单本身的疑问。没有就写「无」。",
			}),
		}),
		terminal: true,
	},
	{
		name: "coagent_report_blocked",
		label: "Report Blocked",
		description:
			"当工单本身不成立时用这个：前提是错的、范围不够、验收标准无法满足。**不要自行重新定义目标**——报告上去，让 L2 重新拆。",
		promptSnippet: "报告工单不成立，交回 L2",
		parameters: Type.Object({
			reason: Type.String({ description: "工单哪里不成立，具体到证据。" }),
			whatWasTried: Type.Array(Type.String(), { description: "你已经试过什么，各自的结果。" }),
			needsFromUpstream: Type.String({ description: "需要 L2 补什么才能继续。" }),
		}),
		terminal: true,
	},
];

/* ================= 独立检视者（托管 HA，非交互式 reviewer） ================= */

const INDEPENDENT_REVIEWER: ToolSpec[] = [
	{
		name: "coagent_get_mission_review_bundle",
		label: "Get Mission Review Bundle",
		description:
			"读取本 Mission 的契约 revision、被审提交、L2 逐条结果与 ValidationReport 引用。检视第一件事。无身份参数——身份只来自 Run Token。",
		promptSnippet: "读取本 Mission 待检视材料（契约、交卷、L2 逐条结果、报告引用）",
		parameters: Type.Object({}),
	},
	{
		name: "coagent_submit_independent_review",
		label: "Submit Independent Review",
		description:
			"提交独立检视结论。这是唯一能让平台记下本次检视的动作。verdict 只能是 pass 或 send_back；reasons 必须非空。证据不足时 send_back 并写明缺什么。",
		promptSnippet: "提交独立检视结论（pass 或 send_back）",
		promptGuidelines: [
			"coagent_submit_independent_review 是你的最后一个动作，调完就结束。",
			"证据不足或对不上契约时 verdict=send_back，并在 reasons 里写明缺什么；不要猜成 pass。",
		],
		parameters: Type.Object({
			verdict: Type.Union([Type.Literal("pass"), Type.Literal("send_back")], {
				description: "pass：证据齐、结论可交；send_back：证据不足或结论不成立。",
			}),
			reasons: Type.Array(Type.String({ minLength: 1 }), {
				minItems: 1,
				description: "非空理由。证据不足时写明缺什么。",
			}),
		}),
		terminal: true,
	},
];

const SPECS: Record<Role, ToolSpec[]> = {
	coordinator: COORDINATOR,
	executor: EXECUTOR,
	// solo 是对照组：一个会话干完，**没有平台可报**，所以一个 coagent_* 都不给。
	// 给了它只会去调一个连不上的东西，测出来的就不是「直接问一个 agent」了。
	solo: [],
	// query 是只读检索臂：零平台工具，工具面由 roles.toolAllowlist 闭集定义。
	query: [],
	independent_reviewer: INDEPENDENT_REVIEWER,
};

/** 调用成功即表示这一程结束的工具名。 */
export const TERMINAL_TOOLS: ReadonlySet<string> = new Set(
	[...COORDINATOR, ...EXECUTOR, ...INDEPENDENT_REVIEWER]
		.filter((s) => s.terminal)
		.map((s) => s.name),
);

/**
 * 适配器侧先拒非法结论。
 * schema 拦一层；测试会直接调 execute，这里再拦一次才保证不发请求。
 * 只抽出 verdict/reasons，避免模型把 role/missionId/attemptId 塞进 body。
 */
function independentReviewSubmitBody(
	params: unknown,
):
	| { ok: true; body: { verdict: "pass" | "send_back"; reasons: string[] } }
	| { ok: false; text: string } {
	if (params === null || typeof params !== "object") {
		return { ok: false, text: "coagent_submit_independent_review 需要 verdict 与 reasons" };
	}
	const p = params as Record<string, unknown>;
	if (p.verdict !== "pass" && p.verdict !== "send_back") {
		return { ok: false, text: "verdict 必须是 pass 或 send_back" };
	}
	if (!Array.isArray(p.reasons) || p.reasons.length === 0) {
		return { ok: false, text: "reasons 必须是非空数组" };
	}
	if (p.reasons.some((r) => typeof r !== "string" || r.trim() === "")) {
		return { ok: false, text: "reasons 每一条必须是非空字符串" };
	}
	return { ok: true, body: { verdict: p.verdict, reasons: p.reasons as string[] } };
}

export function coagentTools(role: Role, client: PlatformClient) {
	return SPECS[role].map((spec) =>
		defineTool({
			name: spec.name,
			label: spec.label,
			description: spec.description,
			promptSnippet: spec.promptSnippet,
			promptGuidelines: spec.promptGuidelines,
			parameters: spec.parameters,
			async execute(_toolCallId, params) {
				let body: unknown = params;
				if (spec.name === "coagent_get_mission_review_bundle") {
					// 无身份参数；丢掉模型可能塞进来的 missionId 等字段。
					body = {};
				} else if (spec.name === "coagent_submit_independent_review") {
					const prepared = independentReviewSubmitBody(params);
					if (!prepared.ok) {
						return {
							content: [{ type: "text" as const, text: prepared.text }],
							details: {},
							isError: true,
						};
					}
					body = prepared.body;
				} else if (spec.name === "coagent_get_validation_report") {
					// 只投影两个业务字段：模型多写的 role/missionId 等不能进请求体。
					const p = (params ?? {}) as Record<string, unknown>;
					const projected: { workItemId: unknown; reportId?: unknown } = { workItemId: p.workItemId };
					if (p.reportId !== undefined) projected.reportId = p.reportId;
					body = projected;
				}
				const result = await client.call(spec.name, body);
				if (!result.ok) {
					// 平台拒绝的原因原样回给模型：它写的是「下一步该干什么」。
					return { content: [{ type: "text" as const, text: result.text }], details: {}, isError: true };
				}
				return {
					content: [{ type: "text" as const, text: result.text }],
					details: (result.json ?? {}) as Record<string, unknown>,
					...(spec.terminal ? { terminate: true } : {}),
				};
			},
		}),
	);
}

export function coagentToolNames(role: Role): string[] {
	return SPECS[role].map((spec) => spec.name);
}
