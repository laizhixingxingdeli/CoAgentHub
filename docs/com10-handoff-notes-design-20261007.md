# COM10 有界代码事实交接与评审包调查报告（2026-10-07）

范围：**只读调查 + 工单草案**。本文件不实现任何草案、不改 `src` / `test` / `.coagent`、不冻结任何规则、不启动服务或 agent。

基线：完整 HEAD `6a4c1d871e9882d84b99d5ec0b6fa290aae3e6a9`（下称 `6a4c1d8`）。

本报告三类信息严格区分（格式参照 `docs/com9-recovery-paths-design-20261007.md:1–19`）：

- **当前源码事实**：对着 `6a4c1d8` 读出来的 `文件:行` / 符号。
- **历史 HTTP 事实**：对运行中平台 `http://127.0.0.1:3101` 的只读 `GET`（`/api/missions/<id>`、`/api/missions/<id>/activity`）读到的落库记录。**它证明过去某一轮发生过什么，不证明现在的代码会怎么做，也不证明总体比例。**
- **待 L3 冻结建议**：本报告提出的路径与草案，一律「未验证、未实施」。

核对方式：只读源码 + 只读 HTTP 两个 URL。未读 `.coagent-state.json`、未读任何会话记录文件、未跑 `node --test`、未改任何生产/测试文件。

---

## 0. 结论速览

协调者每跳从开跑简报拿到六到九个固定来源（`src/application/context-builder.ts:18–30` 的 `COORDINATOR_SOURCE_ORDER` 加 `work_items_index` / `since_last_hop` / `contract_check`），**其中唯一能承载代码事实的字段是 `plan.findings` 的自由文本**——`PlanBody`（`src/kernel/payloads.ts:208–215`）六个字段全是字符串或字符串数组，没有「文件:行 / 符号 / 签名 / 接缝」这种结构化槽位。COM6 的历史 plan 显示协调者确实把行段写进了 `findings`（见 §3.2），但这依赖每个模型自发选择，平台不校验、不投影、不随 revision 失效。

`since_last_hop` 目前只有 ≤200 字符的短摘要加可选的机器验证简版（`src/application/platform/agent-view-helpers.ts:65–66, 96–170`），**没有任何 diff 内容**；`coagent_get_work_item` 返回的是 20 KiB 有裁剪的工作项详情（同文件 `:257`、`:629–709`），也不是完整输出。于是评审跳要判断「这次到底改了什么」，只能自己 `read` 一遍——这正是 L3 契约实测里「评审加派发 17 跳、40.5 次读代码调用」的形状（§4，上层测量，本票未复算）。

建议**分阶段组合**，两件事可分开冻结：

| 草案 | 一句话 | 解决什么 | 依赖 |
|---|---|---|---|
| **A** | `plan.codeMap`：首跳把代码地图以短引用写进规划的固定字段，随简报带出 | 跨跳重复读代码（首跳规划派发 24 跳 / 41 次读代码调用） | 无 |
| **B** | `reviewPackage`：交卷后平台在 `since_last_hop` 给有界 diff 摘要（带上限与截断标注） | 评审跳先读 diff 再读代码（17 跳 / 40.5 次） | 无 |
| **C** | A+B 落地后的复测（跨跳重复读比例、每跳读代码调用次数、每跳 prompt token） | 证明 A/B 真的省钱 | **依赖 A/B；真实运行需 L3 另授权** |

---

## 1. 基线

| 项 | 值 |
|---|---|
| 完整 HEAD | `6a4c1d8` |
| 报告面向 | COM10：有界代码事实交接与评审包 |
| 只读源码清单 | `src/kernel/payloads.ts`、`src/application/platform/planning.ts`、`src/application/platform/startup-brief.ts`、`src/application/context-builder.ts`、`src/application/platform/agent-view-helpers.ts`、`src/application/platform/types.ts`、`src/api/server.ts`、`src/application/orchestrator.ts`、`src/application/workspace.ts`、`src/application/platform/standard-validation.ts`、`test/stall-paths.test.ts`、`test/context-builder.test.ts` |
| 只读 HTTP | `/api/missions/COM6-wake-brief-20261007`、`/api/missions/COM6-wake-brief-20261007/activity` |

---

## 2. 现状：协调者每跳拿到什么

### 2.1 来源装配路径

`getStartupBrief` → `coordinatorStartupSources`（`src/application/platform/startup-brief.ts:113–125`，协调者分支）→ `buildContextBundle`（同文件 `:140–160`，`src/application/context-builder.ts:285–313`）→ `projectStartupBriefFields`（`:340–356`）投影成旧简报字段。适配层在模型开口之前自己取：`GET /api/run/brief`（`src/api/server.ts:2113–2125`），**不是工具**——模型没有「要不要看红线」这个选择。

### 2.2 九个来源、现有上限与尺寸

**读这张表的口径**：「source JSON 字节」是 JSON 序列化后的 UTF-8 字节；「估 token」是 `src/application/context-builder.ts:202–209` 的 `estimateTokens` = `ceil(UTF-8 字节 / 4)`，**这是平台自己的估算，不是真实分词结果**；「实际渲染」指模型侧真实计入的 token，**未知**，不由本表给出。二者不能互相替代。

| 来源（source 名） | 内容与取值位置 | 现有上限 | 是否硬限 | 已知尺寸 |
|---|---|---|---|---|
| `project_rules` | `.coagent/project.md` 全文，经 `readProjectMemory(...).projectProfile`（`startup-brief.ts:60–61`） | **无裁剪**（不在 `OPTIONAL_DROP_ORDER` 里） | 无硬上限 | 当前本地 16021 UTF-8 字节 ≈ 4006 估 token。**这是当前本地文件的事实，不是 COM6 历史 brief 的实际渲染值** |
| `environment_notes` | win32 两条静默坑（`startup-brief.ts:185–200`） | 无条数/字节上限 | 无硬上限；是**可选裁剪源**第二顺位 | 两条，量级百字节 |
| `classification` | 从 `mission.routed` 事件投影，`keepTrueOrUnknownLeaves`（`startup-brief.ts:69–100`） | **2000 字符**后加「（已截断）」 | 有硬截（在装配处，不在 bundle 处） | 仅协调者；无 `mission.routed` 时缺省不占位 |
| `contract` | `mission.contract` + `contractRevision`（`revisionEntry`，`context-builder.ts:262–273`） | 无裁剪 | 无硬上限 | COM6 历史实例：contract JSON **4874 字节** |
| `plan` | `mission.plan`（`PlanBody`）+ `planRevision` | 无裁剪（但**是第一顺位可选丢弃源**） | 无硬上限 | COM6 历史实例：plan JSON **2927 字节** |
| `final_review` | `mission.finalReview`（L3 打回理由） | 无裁剪 | 无硬上限 | 随 Mission 而定 |
| `work_items_index` | `agentWorkItemIndex` → `{id,title,status,attempts,lastReviewVerdict,criteria,validationReport?}`（`agent-view-helpers.ts:69–81, 205–215`；类型 `context-builder.ts:41–53`） | 无条数/字节上限 | 无硬上限 | 条目数 = 工作项数 |
| `since_last_hop` | `summarizeSinceLastHop` 的短摘要数组（`agent-view-helpers.ts:96–170`） | **单条 summary ≤200 字符**（`SINCE_LAST_HOP_SUMMARY_CAP`，同文件 `:65–66`） | 单条有硬截；**条目数无上限**（= 上一跳之后的事件数） | `redactSecrets` 后截断 |
| `contract_check` | 当前 `contractRevision` 最近一次 `contract_check.submitted`（`startup-brief.ts:126–136`） | 无裁剪 | 无硬上限 | 无当前修订核对时不给键 |

`source_order` 的其余四项简要交代：

- `environment_notes`：只在 win32 非空（非 win32 返回空数组但仍占位），位置在 `project_rules` 之后，是**唯二可被预算整条丢掉**的来源之一。
- `classification`：位置在 `contract` 之前；缺省时**不占位**（`context-builder.ts:294–296`），所以「没有分类阶段」和「分类为空」在 bundle 里形状不同。
- `final_review`：打回重跑时最该先看到的东西（`REASON.final_review`，`context-builder.ts:161`），不可裁。
- `contract_check`：契约改版后旧修订事件被跳过；**仅在存在时给键**（`context-builder.ts:350–356`），保证无核对时旧简报键集合一字不变。

### 2.3 `coagent_get_work_item` 返回什么

- 入口：`src/api/server.ts:1270–1281`。**只有协调者**能调（非协调者 403 `ACTION_DENIED`，因为 executor 在 `enforceAgentPolicy` 旧兼容回退下会落到放行，故此处显式 fail-closed）。
- 返回体：`AgentWorkItemView`（`src/application/platform/types.ts:605–625`），由 `buildAgentWorkItemView`（`agent-view-helpers.ts:616`…）构造：

```
workItemId, title, status, orderRevision,
order（冻结工单，可能按 orderCap 收紧）,
executionResult（仅最新一次交卷正文）,
reviews[] { verdict, reasons[], requiredChanges[] },
evidenceSummary[] { attemptId, kind, summary, command?, exitCode?, outputTail },
submissionSummaries[]（早于最新的仅存元数据，标「旧正文未保存」）,
criteria（覆盖的 acceptance 序号，无关联为 '—'）,
validationReport?（最近一次交卷的机器验证简版）,
truncated（是否为收紧后的结果）
```

- **它是 20 KiB 有裁剪的详情，不是完整输出**：`MAX_AGENT_WORK_ITEM_BYTES = 20 * 1024`（`agent-view-helpers.ts:257`）；完整版超限后按 `:690–700` 的 `levels × maxTail(1000/500/250/100/0)` 逐级收紧，仍超限走 `buildFallback`（`:711`…）只保索引字段与历史提交摘要，并始终标 `truncated`。所有外显文本先 `redactSecrets` / `redactSecretsDeep`（`:623–637`）。
- **完整机器验证报告另有独立入口** `coagent_get_validation_report`（`src/api/server.ts:1283`…，同样只给协调者）。所以评审跳不需要靠 `get_work_item` 拿到完整 VR 正文——**草案 B 不必、也不应把完整 VR 塞进 `since_last_hop`**。

### 2.4 执行者侧（对照）

`EXECUTOR_SOURCE_ORDER = ['project_rules','environment_notes','work_order']`（`context-builder.ts:26–30`）。执行者拿到的是冻结工单 + 红线 + 环境说明；`contextRefs` 保持引用、正文按需 `coagent_get_context` / `read`（`context-builder.ts:162–163` 的 `REASON.work_order`）。`work_items_index` / `since_last_hop` 明确不进执行者（`test/context-builder.test.ts:269–315` 有投影断言）。

---

## 3. 哪些代码事实没有跨跳保存

### 3.1 结构缺口：`PlanBody` 只有自由文本

```ts
// src/kernel/payloads.ts:208–215
export interface PlanBody {
  readonly findings: string;
  readonly rootCause?: string;
  readonly rejectedHypotheses: readonly string[];
  readonly decisions: readonly string[];
  readonly direction: string;
  readonly risks: readonly string[];
}
```

六个字段全是字符串 / 字符串数组。**没有**以下槽位：

| 代码事实 | 是否有结构化字段 | 现在只能落在哪 |
|---|---|---|
| 接缝位置（`文件:行` / 符号） | 无 | `findings` / `direction` 自由文本 |
| 函数签名 | 无 | 同上，且没有长度与形状约束 |
| 测试接缝（哪个测试文件、哪条断言钉住它） | 无 | 同上 |
| 已核实的行段（读到哪、核到哪个 revision） | 无 | 同上；**没有 revision 戳**，旧行段和现状无法区分 |
| 读代码路径序列（本跳 read/grep 过哪些路径） | 无 | 只留在活动事件里，不进简报 |

后果：行段是否跨跳存活，取决于模型自己写不写、写在哪、以及下一个人会不会被 `updatePlan` 整份替换掉。

### 3.2 自由文本**可以**保存行段——COM6 历史实例

COM6 落库的 `plan.findings`（历史 HTTP 事实，plan JSON 2927 字节）原文片段：

> `orchestrator.ts:263–267 FRESH_SESSION_PREFIX 与 :335–345 COM1 简报优先正文矛盾；:316、:738、:1204 仍要求执行者默认取工单。所有位置在契约范围内。当前独立 worktree HEAD 8dd677f 且干净。定向 node --test test/orchestrator.test.ts test/stall-paths.test.ts exit 0，53 pass、0 skip。orchestrator.test.ts:83–150 harness、:205–267 两角色脚本、:1130–1150 instructions 断言可复用；standard-redispatch.ts:88–91 partial 自动接续无需 ValidationEngine。`

这证明**「行段 + 测试接缝 + 已跑过的命令」写进 `findings` 是能跨跳传下去的**。缺口不是「存不下」，而是「没有结构 → 不可校验、不可投影、不可失效」。

### 3.3 `updateFindings` / `updatePlan` 的语义差异（草案 A 必须钉死这一点）

- `updateFindings`（`src/application/platform/planning.ts:4–33`）：只补发现。`findings` 追加（`\n\n—— 第 N 次补充\n`），其余字段**沿用上一版**（`rootCause: previous?.rootCause`、`direction: previous?.direction ?? ''`…），`planRevision + 1`，事件带 `findingsOnly: true`。**所以已写进去的行段不会被「补充发现」撞掉。**
- `updatePlan`（同文件 `:35–46`）：**整份替换** `mission.updatePlan(plan)`。

结论：草案 A 里 `plan.codeMap` 若在 `updatePlan` 调用中缺省，就会被整份替换清掉。因此 A 必须明确缺省语义（见 §7.1），并要求 `updateFindings` 路径**保留** `codeMap` 不动。

### 3.4 `since_last_hop` 没有 diff

`summarizeSinceLastHop`（`agent-view-helpers.ts:96–170`）按事件原序压短摘要，覆盖 `execution_result.submitted`、`blocked.reported`、`escalation.answered`、`validation.reported`、各类 `final_review.*`。`execution_result.submitted` 那一条只给 `outcome`、改动**文件数量**、工单修订和最近一条证据概要——**没有变更文件清单、没有增删行、没有任何片段**。评审跳要知道「改了什么」，只能回到 `read` / `get_work_item`。

### 3.5 现有的「diff / baseline」接缝（草案 B 可直接复用）

- `WorkspaceService.diff(missionId, baseRevision, projectRoot) → { stat, files }`（声明 `src/application/workspace.ts:175–189`，实现 `:581–607`）：`git diff --name-only/--stat` **加** `git ls-files --others --exclude-standard`（实现处的注释明确：不把未跟踪文件算进去，检视者会在没看过的内容上签字）。**这是 Mission 级、只有 stat 与文件清单，没有 hunk。**
- `recordStandardValidationBaseline` / `workItemValidationBaseline`（`src/application/platform/standard-validation.ts:44–71`）：**可信的 per-work-item baseline HEAD**，空值直接 `VALIDATION_BASELINE_REQUIRED` 拒绝；读取时按 `workItemId` 倒序取最后一条。这是 B 生成「相对什么」的现成接缝，**不能用 Mission 的 `workspaceRef.baseRevision` 顶替**（`src/kernel/payloads.ts:171` 明确禁止用 baseRevision 冒充 current HEAD）。
- `worktree add -b <branch> <cwd> <baseRevision>`（`src/application/workspace.ts:360`）+ `pinnedBase` 校验（`:327–339`）：分叉基线的可信来源形状。

---

## 4. L3 契约实测数据（**引用上层测量，本票未复算**）

以下全部来自本工单所引 Contract 的 L3 实测说明，**本报告只作引用，未重新测量、未重新计算**：

- 2026-10-04 → 10-07，共 **16 个 Mission / 100 跳**；COM1–COM5 期间未加载。
- 每跳 **13.5 轮**模型调用。
- 首轮前缀中位 **15.4k token**（09-26 为 9.1k、09-30 为 12.2k）。
- 输出仅占 **1.3%**；固定前缀每轮**重读 36%**。
- 工具返回占比：`read` **49%**、`get_mission` **17%**、`bash` **13%**、`get_work_item` **11%**、`grep` **8%**。
- **跨跳文件重复 48%**。
- 首跳规划派发：**24 跳，41 次读代码调用 / 约 102 万 prompt token / $0.69**。
- 评审加派发：**17 跳，40.5 次读代码调用 / 约 93 万 prompt token / $0.77**。

读法：`read` 近半 + 跨跳重复 48% ⇒ 重复读代码是主项；首跳与评审跳的读代码调用次数几乎相同（41 vs 40.5）⇒ 两类跳都需要，方案不能只覆盖其中一类（这直接支撑 A+B 组合而不是二选一）。

---

## 5. COM6 只读 HTTP 实例

（历史 HTTP 事实。URL：`/api/missions/COM6-wake-brief-20261007` 与其 `/activity`。不输出活动全文。）

- Mission：`200` / **56180 字节** / `completed`。**本票复核**同一 URL 返回 `200` / **56237 字节**（两次取数时间不同、字节数不同；差异不归因，仅如实记录）。
- Activity：`200` / **127262 字节** / **204 条事件**；本票复核同为 `200` / **127262 字节**。
- contract JSON **4874 字节**、plan JSON **2927 字节**；plan 已保存自由文本行段（见 §3.2）。
- coord-2：`ended 10:34:13.778`，`read` 9 次 / 51082 字节、`grep` 5 次 / 11981 字节、`bash` 2 次 / 6097 字节；`input 37058 + cacheRead 329728 = 366786` prompt tokens。
- coord-3：`ended 10:47:33.197`，`read` 1 次 / 3188 字节、`bash` 1 次 / 5987 字节；`21704 + 70912 = 92616` prompt tokens。
- coord-3 的工具序列：`get_work_item → bash → read → review → result`；`10:47:00.843` 的评审理由**明确写了「看最终提交 diff / VR-214 passed」**。

**这个样例能说明什么、不能说明什么（不夸大）：**

- 能说明：评审跳确实会去看「最终提交 diff」；`plan.findings` 能承载行段；协调者的 prompt 以 cacheRead 为主（366786 里 329728 是 cacheRead）。
- **不能说明**：`pathDigest` 前后无交集只说明这两个 coord 跳之间读的文件没有交集，**它既没有证明 48% 重读，也没有证明任何方案能节省成本**；该样例 `coverage` 为 partial、brief 相关指标缺省，且 `bash` 调用**不能**断言为「读代码」。
- 未做的补齐：不读状态文件、不读会话记录文件去补这些缺省指标。

---

## 6. 方案比较

### 6.1 两种做法

**① 结构化笔记（代码地图写进规划）**

- 机制：协调者首跳把代码地图（文件:行 或 符号、接缝、要读的段落）写进规划的一个**固定字段**，简报随 `plan` 来源带出，后续每跳复用、按需增量。
- 对应堵的洞：§3.1 的结构缺口 + §4 的跨跳重复 48%。
- 代价：多一个要维护的字段；需要时效标记，否则会把旧行段当现状。
- 概念对应：**Anthropic 的「结构化笔记」**（agent 把关键事实持久写到上下文之外的记忆里，下一段只带引用而不是重读原文）。**仅概念对应**；Anthropic 那边的具体实现与本仓库效果**未独立验证**。

**② 评审包（交卷后给有界 diff 摘要）**

- 机制：执行者交卷后，平台按**可信基线**生成该工作项的有界 diff 摘要（变更文件、增删行、关键片段，带上限与截断标注），放进 `since_last_hop`。评审跳先看 diff，再按需 `read`。
- 对应堵的洞：§3.4（`since_last_hop` 无 diff）+ §4 评审跳 40.5 次读代码调用；COM6 coord-3 的评审理由已经说明评审者**本来就要看 diff**，只是现在得自己去读。
- 代价：依赖可信基线与提交身份（否则会重建出错误的包）；要处理 binary / 重命名 / 未跟踪 / 并行提交。
- 概念对应：**Devin 的「评审者只读 diff」**（评审者拿到的是 diff 而不是整仓，先读变更再决定要不要深挖）。**仅概念对应**；外部具体实现与效果**未独立验证**。

### 6.2 为什么选组合而不是二选一

- 首跳规划派发与评审加派发的**读代码调用次数几乎一样**（41 vs 40.5），只做一件只能覆盖一半。
- ① 解决「我在哪、该读哪」，② 解决「刚改了什么」，两者回答的不是同一个问题。
- 两者**可独立冻结、独立上线**：A 只碰 `PlanBody` 与 plan 的保存/投影路径；B 只碰 adapter 的 git 读取与 `since_last_hop` 装配。任一方先落地都不需要另一方先存在。

**选择：分阶段组合 —— A 与 B 各自独立可冻结的票，C（复测）依赖 A/B 之后，且真实运行需 L3 另授权。**

---

## 7. 数据形状

### 7.1 草案 A：`plan.codeMap`（可选字段）

挂在 `PlanBody` 上，**可选**——旧 plan 没有这个字段时形状必须一字不变（§8 兼容）。

```ts
// kernel：纯类型。kernel 不 import 任何东西，连 node: 都不。
interface PlanCodeMapEntry {
  readonly path: string;                  // 仓库相对路径
  readonly symbol: string;                // 符号名（函数/类型/常量）
  readonly lineRange?: string;            // 形如 "123–145"，可选
  readonly signature?: string;            // 函数签名，可选
  readonly seam: string;                  // 一句话：为什么这里是接缝
  readonly readRanges: readonly string[]; // 下一段该读的段落（短引用）
  readonly testSeam?: string;             // 钉住它的测试接缝（文件:行 或 测试名）
  readonly verifiedAtRevision: string;    // 核实时的 revision，用于判 stale
}
interface PlanCodeMap {
  readonly schemaVersion: 1;
  readonly baseRevision: string;          // 这张地图相对哪个版本核出来的
  readonly entries: readonly PlanCodeMapEntry[];
}
```

- **只放短引用事实**：条目里放的是「路径 + 符号 + 行段 + 一句话接缝」，**不放代码正文**。引用而非复制，是它能在 4 KiB 内有用的前提。
- **时效**：`baseRevision` + `verifiedAtRevision` + 符号。`lineRange` 会随代码漂移，**符号 + hash/revision 才是判 stale 的依据**；`baseRevision` 变了就把行段标 stale、只留符号与路径，避免把旧行段当现状。
- **上限**：**8 项 / 单项 512 B / 整包 4 KiB**（元数据计入）。
- **缺省语义（必须写明）**：
  - `updateFindings`（`planning.ts:4–33`）**保留** `codeMap` 不动——它的语义是「只补发现」。
  - `updatePlan`（`planning.ts:35–46`）是整份替换。**缺省** `codeMap` 时按「沿用上一版」还是「清空」必须由票明确；本票建议**缺省 = 沿用上一版**（替换语义下丢代码地图比留一条 stale 地图更贵，且 stale 有 revision 可判），但该选择**待 L3 冻结**。

### 7.2 草案 B：`reviewPackage`（独立持久对象，不是简报字段）

```ts
interface ReviewPackageFile {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'deleted' | 'renamed';
  readonly added: number;                 // 增行
  readonly deleted: number;               // 删行
  readonly binary?: true;                 // 二进制：不带 hunk
  readonly hunks: readonly {
    readonly oldStart: number;
    readonly newStart: number;
    readonly text: string;                // 已脱敏
  }[];
}
interface ReviewPackage {
  readonly schemaVersion: 1;
  readonly workItemId: string;
  readonly submittedAttemptId: string;    // 哪一次交卷
  readonly orderRevision: string;
  readonly baseRevision: string;          // 相对什么（可信 per-work-item baseline）
  readonly headRevision: string;          // 到哪（提交 checkpoint）
  readonly files: readonly ReviewPackageFile[];
  readonly truncated: boolean;
  readonly omittedFiles: number;          // 被上限挡掉的文件数
  readonly omittedHunks: number;          // 被上限挡掉的 hunk 数
  readonly reason?: string;               // 生成不了 / 部分生成的原因
}
```

- **身份与基线（硬要求）**：`baseRevision` 取**可信的 per-work-item baseline**（`standard-validation.ts:44–71`），`headRevision` 取该次提交的 checkpoint。**不得从 mutable HEAD 重建旧交卷**，**不得用 Mission 的 `workspaceRef.baseRevision` 顶替**——前者会随时间变，后者会让包对不上这个工作项真正改了什么。
- **生成后持久、稳定**：同一个 `submittedAttemptId` 任何时候取到同一个包。评审跳在几天后重看，看到的必须是当时那一次交卷的 diff。
- **上限**：每包 **12 文件 / 每文件 2 段 / 每段 20 行 / 总计 8 KiB**，**先到先止**。
- **必须明确处理的情形**：二进制（只给 `binary: true` 与增删行，不给 hunk）、重命名、未跟踪新文件（沿用 `workspace.ts:581–607` 已有的 `ls-files --others` 处理）、并行提交（同一工作项多次交卷各自成包）、git 不可用（`reason` 说明，不造包）、脱敏（走与 `agent-view-helpers.ts:623–637` 一致的脱敏路径）。
- **不裁旧 VR 权威信息**：包里不带完整验证报告；完整报告仍走 `coagent_get_validation_report`。

### 7.3 B 在 `since_last_hop` 里的呈现

`since_last_hop` 的条目在现有 `{ summary, validationReport? }` 基础上**可选**加 `{ reviewPackage? }`。**多包合计上限 12 KiB**；超出的包**不静默丢**——保留引用（`workItemId` + `submittedAttemptId`）与截断标记，协调者按需 `coagent_get_work_item` 取。

---

## 8. 层次与所在层

| 部分 | 层 | 说明 |
|---|---|---|
| `PlanCodeMap` / `ReviewPackage` 类型 | **kernel**（`src/kernel/payloads.ts` 一带） | 纯类型，不 import 任何东西，连 `node:` 都不；也不出现 provider / model / session / http / sql 这类词 |
| 校验、上限裁剪、投影、持久化、baseline 取用 | **application**（`platform/planning.ts`、`platform/agent-view-helpers.ts`、`platform/standard-validation.ts`、`context-builder.ts`） | 规则写在用例层；「上限」是应用层判据，不是模型自觉 |
| 只读 git 取 diff、工具参数、简报渲染 | **adapter**（`src/api/server.ts` 的 `agentTools` 与 `workspace` 调用方） | adapter 只读，不判规则 |

现有分层先例：`buildContextBundle`（`context-builder.ts:285–313`）只吃显式值、不读盘；`buildAgentWorkItemView`（`agent-view-helpers.ts:616`）在 application 里做 20 KiB 收紧；`WorkspaceService.diff`（`workspace.ts:581–607`）已经把 git 调用收在一处。

---

## 9. 预算（budget）影响与 COM1「简报优先」

### 9.1 现有预算机制

- 入口：`GET /api/run/brief?budget=N`（`src/api/server.ts:2113–2125`，`parseBriefBudget` 同文件 `:304`）。**省略预算时不裁剪**，沿用完整简报与旧字段，也不生成预算报告或截断事件。
- 估算：`estimateTokens = ceil(UTF-8 字节 / 4)`（`context-builder.ts:202–209`），逐条累加。
- 裁剪：`OPTIONAL_DROP_ORDER = ['plan', 'environment_notes']`（`:215–216`），**整条丢弃、不截断、不把内容挪进必需来源**。其余来源（含 `project_rules`、`contract`、`final_review`）**不裁**。
- 报告：`budgetReport = { budget, estimatedBefore, estimatedAfter, omittedSources, overflow, remainingOverBudget }`；`overflow=true` 表示必需源本身就超了（`applyBudget`，`:218–245`）。
- 审计：只有 `omittedSources` 非空才写 `context.truncated` 事件（`startup-brief.ts:162–176`）——「没裁」不能被记成「裁过」。

### 9.2 新增内容对预算的影响

- A 的 `codeMap` 整包 4 KiB、B 的 `since_last_hop` 多包合计 12 KiB ⇒ **新增估 token 上界 1024 + 3072 = 4096**。这是**估算上界**，不是实测。
- **它们仍然计入整体 budget**，不是「预算外的旁路」。
- 裁剪顺序建议（待冻结）：新的**可选**内容（`hunks`）先丢，再丢 `notes`，**然后**才是既有的 `plan` → `environment_notes`。这样旧的裁剪语义保持可解释：`omittedSources` 里出现什么、为什么出现，仍是一条链。
- **不得声称硬顶**：必需源本身超预算时只能是 `overflow=true` + `remainingOverBudget`，这一点在加了 A/B 之后不变——报告里不能写成「简报从此不会超预算」。

### 9.3 与 COM1「简报优先」的关系

`orchestrator.ts:369–378` 的 `briefFirst` 明确：状态已在开跑简报里（契约、规划、工作项索引、上一跳增量），**不要先 `coagent_get_mission` 再取一遍**；`queryWhenNeeded` 只放行三类例外（简报缺必要详情 / 并发变化 / 平台拒绝）。

- A 是**加强** COM1：把「该读哪」也放进简报，进一步减少 `read`。
- B 是**加强** COM1：评审跳在简报里就有 diff，`since_last_hop` 从「告诉你发生了什么」升级为「告诉你改了什么」，减少评审跳的 `read` 与 `get_work_item`（后者占工具返回 11%）。
- 反向风险：**新增内容变多会侵蚀 budget**，而 `plan` 恰好是第一顺位被丢的源——A 把代码地图挂在 `plan` 上，就存在「预算一紧，代码地图先没」的自相矛盾。这是 A 的设计代价，必须在票里点明，必要时考虑把 `codeMap` 单列为独立可选来源。**本票不下结论，交 L3 冻结。**

---

## 10. 兼容、时效与提交身份

### 10.1 旧数据兼容

- **旧 plan 无 `codeMap`**：字段可选，缺省即「无地图」；`projectStartupBriefFields`（`context-builder.ts:340–356`）投影时**只在存在时给键**，旧简报键集合一字不变。先例就是 `contract_check`（`:350–356` 的注释明确写了「无核对时旧简报的键集合与形状必须一字不变」）。
- **旧 Mission 的 bundle 指纹**：`hashedEntry`（`:253–260`）把整份内容哈希进去。给 `plan` 加可选字段会改变有新字段的 plan 的 hash——**这只影响新数据**，不追溯旧数据；但测试里若有硬编码 hash 断言需要同步（见 §12 的测试接缝）。
- **旧 `since_last_hop` 条目**：B 的 `reviewPackage` 是可选键，没有包的历史条目形状不变；`summarizeSinceLastHop` 的 200 字符 cap 与事件覆盖集合**不变**。
- **旧 VR 权威信息不裁**：见 §7.2。

### 10.2 时效

A：靠 `baseRevision` + `verifiedAtRevision` + 符号判 stale；行段过期只降级为「符号 + 路径」，不删除条目。理由：`lineRange` 会漂，符号不会那么快漂。

### 10.3 提交身份

B：`submittedAttemptId` 是包的身份键。生成必须发生在**该次提交落定之后**，且 `baseRevision` 来自可信 per-work-item baseline（`standard-validation.ts:44–71`，空值直接拒绝）。**不得从 mutable HEAD 重建旧交卷**——HEAD 会动，重建出来的包对不同时间是不同内容，评审者会在对不上的东西上签字。

---

## 11. 工单草案（可分开冻结）

三条草案都**只是草案，本票不执行、不实现**。测试命令也只是草案里建议跑的命令，本票未跑。

### 草案 A —— `plan.codeMap`：结构化代码地图

- **目标**：跨跳复用「在哪、该读哪」的短引用，降低首跳规划派发的重复读代码。
- **窄文件范围**：`src/kernel/payloads.ts`（加纯类型）、`src/application/platform/planning.ts`（`updateFindings` 保留 / `updatePlan` 缺省语义）、`src/application/context-builder.ts`（如需单列来源则加来源与 `REASON`）。
- **验收**：
  1. `PlanCodeMap` 为可选字段，旧 plan 缺省时投影出来的简报键集合与字段值不变。
  2. 校验在 application：超 8 项 / 单项 512 B / 整包 4 KiB 时明确拒绝或降级，且降级后有标注。
  3. `updateFindings` 路径保留 `codeMap` 不动；`updatePlan` 的缺省语义按冻结结论实现并**写进注释**。
  4. `verifiedAtRevision` 与当前 revision 不符时，行段判 stale 并降级为符号+路径。
- **定向测试（1–2 条，复用既有接缝）**：
  - `node --test test/context-builder.test.ts`
  - `node --test test/platform.test.ts`

### 草案 B —— `reviewPackage`：有界 diff 评审包

- **目标**：评审跳先看 diff 再按需读，降低评审跳的 `read` / `get_work_item`。
- **窄文件范围**：`src/application/platform/agent-view-helpers.ts`（`since_last_hop` 装配与 12 KiB 聚合上限）、`src/application/platform/standard-validation.ts`（baseline 取用）、`src/application/workspace.ts`（只读 git 取 diff 与 hunk，含未跟踪文件）、新增一个 application 模块做生成/持久化。
- **验收**：
  1. 同一 `submittedAttemptId` 重复取到**完全一致**的包（持久、稳定，不随 HEAD 变）。
  2. `baseRevision` 必须来自可信 per-work-item baseline；空/缺时给 `reason`，不造包。
  3. 上限：12 文件 / 每文件 2 段 / 每段 20 行 / 8 KiB，先到先止；`truncated` + `omittedFiles` + `omittedHunks` 如实标注。
  4. binary、重命名、未跟踪、git 不可用四类各有既定行为，不静默丢。
  5. `since_last_hop` 多包合计 12 KiB；超出的保留引用与截断标记。
- **定向测试（1–2 条，复用既有接缝）**：
  - `node --test test/workspace.test.ts`（临时 git fixture 接缝）
  - `node --test test/orchestrator-standard-validation.test.ts`

### 草案 C —— A/B 落地后的复测

- **目标**：量化 A/B 是否真省钱。**依赖 A 与 B 都已落地**。
- **范围**：不改生产，只做度量与对比；真实 agent 运行**需 L3 另授权**。
- **验收**：按 §13 的指标定义产出分层对比，缺值写 `unknown`，不得用估算填。

### 配套依赖（不在本票范围）

- **工具参数 / adapter 渲染**（协调者怎么写 `codeMap`、简报怎么渲染 `reviewPackage`）是 A/B 的**未来配套依赖**，需单独票核实。
- **pi 侧**：本票**不改 pi**，也**不宣称**「平台加字段即端到端可用」。

---

## 12. 已核实的代码接缝（供草案落地时直接复用）

| 接缝 | 位置 | 用途 |
|---|---|---|
| 来源顺序与缺省占位 | `src/application/context-builder.ts:285–313` | A 若单列来源，照这里的模式加 |
| 投影与「只在存在时给键」 | `context-builder.ts:340–356` | 兼容旧简报的样板 |
| 预算与可选丢弃 | `context-builder.ts:202–245` | §9 的裁剪顺序在这里改 |
| 预算投影/缺省测试 | `test/context-builder.test.ts:269–315`、`:488–508` | **复用**，不新造断言族 |
| 20 KiB 收紧与脱敏 | `agent-view-helpers.ts:616–709`（`MAX_AGENT_WORK_ITEM_BYTES` 在 `:257`） | B 的上限与脱敏照这里写 |
| `since_last_hop` 200 字符 cap | `agent-view-helpers.ts:65–66, 96–170` | B 的条目挂点 |
| per-work-item 可信 baseline | `src/application/platform/standard-validation.ts:44–71` | B 的 `baseRevision` 来源 |
| git diff（含未跟踪） | `src/application/workspace.ts:581–607`（声明 `:175–189`） | B 的只读 git 取数；临时 git fixture 用 `test/workspace.test.ts` |
| 简报入口与工具权限 | `src/api/server.ts:2113–2125`、`:1270–1281` | adapter 挂点 |
| 协调者不续跑 | `src/application/orchestrator.ts:923–944` + `test/stall-paths.test.ts:321–328` | 前提：跨跳只能靠结构化状态，不能靠会话 |
| COM1 简报优先 | `src/application/orchestrator.ts:369–378` | §9.3 的规则出处 |

**不要求穷举**：草案的测试只锁关键场景（旧的没变 / 上限生效 / 身份稳定），不为每个分支各写一条。

---

## 13. 复测指标定义

| 指标 | 定义 | 口径与注意 |
|---|---|---|
| 跨跳重复读比例 | **路径 digest 跨跳交集比例**：把每跳读过的路径做 digest，算相邻/同类跳之间的交集占比 | 这是**现在可定义**的指标；COM6 样例的 `pathDigest` 前后无交集**不等于**总体重复率 |
| 每跳读代码调用次数 | `read` + `grep` 次数；**`bash` 不算**（`bash` 是否读代码不可断言） | 分层统计：**规划跳** 与 **评审跳** 分开（§4 的 41 vs 40.5 就是这么分的） |
| 每跳 prompt token | `input + cacheRead`；`cacheWrite` 是否计入**按提供方口径核实后再定**，不自行假定 | 同样按规划/评审分层 |
| 样本与配置 | 必须**同配置、同样本 coverage** 下前后对比 | coverage 为 partial 或指标缺省时写 **`unknown`**，**不得用估算填** |
| 不虚构的指标 | **没有**「行段重复率」这种指标——现有数据里没有这个维度，不凭空造 | — |

对照基线：§4 的上层测量（24 跳/41 次/102 万/$0.69；17 跳/40.5 次/93 万/$0.77）是**引用值**，复测时应在**同口径**下重新取数，不直接拿来做减法。

---

## 14. 五维审查（L2）

| 维度 | 结论 |
|---|---|
| **设计** | A/B 各自只加一个可选结构，不新增状态边、不改 kernel 状态机；分层干净（kernel 纯类型 / application 规则 / adapter 只读）。**待定项**：A 挂在 `plan` 上会与「plan 是预算第一顺位丢弃源」冲突（§9.3），是否单列来源需 L3 冻结。另有配套依赖（工具参数、adapter 渲染、pi）未包含，避免把「平台加字段」当成端到端。 |
| **功能** | 行为路径完整：A = 类型 → 校验 → 保存/保留 → 投影 → 简报；B = 基线/身份 → 只读 git → 生成 → 持久 → `since_last_hop` 聚合 → 按需 `get_work_item`。两条路径都不依赖另一方。 |
| **复杂度** | 新增的是**类型 + 一条装配 + 一处上限裁剪**，没有新的控制流分支树。**本轮生产没有新函数**，所以「单函数 40 行 / 单文件 400 行」这类机械硬顶**不适用**；未来若某模块真的变大，应**抽辅助函数**而不是为了满足行数硬拆。 |
| **测试** | 复用 `test/context-builder.test.ts` 的投影/预算断言与 `test/workspace.test.ts` 的临时 git fixture；每条草案 1–2 条定向命令，锁关键场景（旧形状不变 / 上限生效 / 身份稳定），不穷举分支。 |
| **命名与注释** | `codeMap` / `reviewPackage` 与既有 `work_items_index` / `since_last_hop` 同一套下划线命名；`omittedFiles` / `omittedHunks` / `truncated` / `reason` 沿用 `AgentWorkItemView` 已有的「截断必须可见」词汇。注释写**为什么**：例如「不得从 mutable HEAD 重建旧交卷」要写明后果是「评审者会在对不上的东西上签字」，而不是复述代码在做什么。 |

---

## 15. 未验证事项（如实保留）

1. **A/B 的全部效果未验证**：没有任何运行数据支持「A 或 B 能省多少」。§4 的 48% 重复、41/40.5 次读代码调用是本工单引用的**上层测量**，不是本票复算，也不构成对 A/B 收益的证明。
2. **COM6 样例不证明总体**：`coverage` 为 partial、brief 指标缺省、`bash` 不能断言为读代码、`pathDigest` 前后无交集既不证明 48% 重读也不证明方案能省钱。未读状态文件 / 会话文件去补这些指标（红线不允许）。
3. **尺寸表的口径未统一**：表中「source JSON 字节」与「估 token（`ceil(UTF-8/4)`）」是两种不同的东西，**实际渲染进模型的 token 未知**。本地 `.coagent/project.md` 的 16021 字节 / ≈4006 估 token 只是**当前本地文件**的事实，**不是** COM6 历史 brief 的实际值，不能混用。
4. **Mission 字节数两次取数不一致**（56180 vs 56237）：差异未归因，仅如实记录。
5. **`updatePlan` 缺省 `codeMap` 的语义未定**：本票倾向「沿用上一版」，但这是**建议**，待 L3 冻结。
6. **A 是否单列为独立简报来源未定**：见 §9.3 的预算自相矛盾。
7. **工具参数与 adapter 渲染**是 A/B 的配套依赖，未设计、未核实；**pi 侧未核实**，本票不宣称平台加字段即端到端可用。
8. **C（复测）的真实 agent 运行**需 L3 另授权；在授权前 C 只能产出现有数据的同口径重算，不能算「已验证」。
9. **Anthropic「结构化笔记」与 Devin「评审者只读 diff」仅为概念对应**：其具体实现与本仓库落地后的效果**未独立验证**，不构成效果背书。
10. **本报告不是实现完成证据**：只有一份文档；方案全部待 L3 冻结。文档检查（关键词 + LF + `git diff --check`）只是**结构检查**，不能代替内容真实性。
