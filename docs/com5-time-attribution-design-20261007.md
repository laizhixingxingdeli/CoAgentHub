# COM5 耗时归因调查报告（接线调查，未实现代码）

- 调查对象：集成分支 `codex/communication-integration` HEAD `c096b1b`。
- 本文件性质：**接线调查**。它是设计与接口调查，**不是运行时完成证据**；本票**不实现代码**（`src/`、`test/` 均未改动）。真正的实现接口由 L3 冻结后再写代码。
- 契约起点与实码的差异：契约文本起点写「协议只有 tool.started」，实码已经有 `tool.completed`（`src/application/ports.ts:232`、`src/runtime/spawn.ts:69-70` 已把它解析成 RuntimeEvent）。**以实码为准**，本文所有盘点基于实码。
- 样例来源说明：第 2 节的时间戳样例来自主工作区运行中的文件状态 `C:/program1/coagenthub-v5/.coagent-state.json`（Work Truth，不在 git 里），证据集标记为 `COM4-AB-acceptance-evidence-20261007`。本文只引用时点、kind、callId 计数与 `usage.total/quality`；不引用 `failureMessage`、命令文本、profile，也不引用 token 以外的用量明细。
- 只写「未知」或「未验证」，不编造新的行号或新的 Mission 数字。

## 验收对照表

| 契约/工单验收 | 对应章节 |
| --- | --- |
| 验收 1（逐阶段来源与真实示例/明确缺失，含不可靠与缺失） | 第 2 节 |
| 验收 2（应用层纯投影、数据形状、并集、重叠不叠加、未分类、禁 token 推算、重连不重复、历史缺失标未知、单条时间线不倒序） | 第 3 节 |
| 验收 3（`runtime.tool.completed` 接收与持久化、旧适配器不发则未知、pi 另票；hop 三个事件不可覆盖时点与旧记录兼容；`narrate.js` 与 `test/web-event-coverage.test.ts` 影响） | 第 4 节 |
| 验收 4（T1–T4 可分开冻结的工单草案与依赖顺序；第 6 节五维结论与未验证清单；全文声明未实现） | 第 5 节、第 6 节 |

## 1. 非目标

本票明确不做以下任何一项：

1. **不实现代码**：本票只交付本文件，`src/` 与 `test/` 一行不改。
2. 不改调度策略、不改 `durable-scheduler` 的职责边界（它保持纯函数）。
3. 不做 PERF1。
4. 不让 pi 发工具结束事件（那是 pi 仓库的票，见第 5 节 T5）。
5. 不建第二条时间线：沿用现有单条 Mission 时间线，不新增重复时间线 DOM。
6. 不把不可观测空档标成「思考」。
7. 不用 token 推算耗时。
8. 不做鉴权 D1d、不做预算 B7。
9. 不合入 master（合入需用户另行授权）。
10. 不自行改契约，不把环节顺序改成「最新在顶」。

## 2. 逐阶段盘点

每一项按四段写：**现在能不能测**、**事件 kind 与字段**、**文件:行**、**COM4-AB 真实示例 / 明确缺失**，最后写**不可靠或缺失**。

### 2.1 排队与 hop 退避

- **现在能不能测**：只能测到「入队时点」和「完成/最后一次失败时点」；**等待时长不可测**，因为认领时点没有被持久化成可覆盖之外的独立事实。
- **事件 kind 与字段**：持久结构是 `QueuedHop`，字段只有 `createdAt`、`updatedAt`、`availableAt`、`status`、`attemptCount`、`claimGeneration`（`src/application/durable-scheduler.ts:6-39`）。入队时 `createdAt = updatedAt = now`（同文件约 822 行）。`claimHop`（`:128-133`）只把 `updatedAt` 改成 `now`，**不留 `claimedAt`**，`createdAt` 保留。`reportHopFailure`（`:216-224`）用 `failedAt + 退避` 覆盖 `availableAt`。完成行仍留在 `queuedHops` 里，`updatedAt` 是完成时刻。
- **文件:行**：`src/application/durable-scheduler.ts:6-39`、约 `:822`、`:128-133`、`:192-224`；项目队列另有 `mission.queued` / `mission.queue_started`（`src/application/platform/mission-queue.ts:144` 与 `:159`）。
- **COM4-AB 真实示例**：
  - `HOP-b780d0b5`：`createdAt=2026-10-06T19:29:37.175Z`，`updatedAt=2026-10-06T19:35:47.043Z`，`claimGeneration=1`，**无 `claimedAt`**，`status=completed`。
  - `HOP-44d6ebc4`：`createdAt=2026-10-06T20:08:34.335Z`，`attemptCount=2`，`lastFailure.at=2026-10-06T20:23:46.759Z`，`availableAt` 现为 `2026-10-06T20:23:48.759Z`（**已被后一次失败覆盖**）。
  - activity 里 `mission.waiting` 且 `reason=project_busy`：`2026-10-06T20:15:15.062Z`（`detail` 原文里含 `availableAt=2026-10-06T20:15:15.818Z`）→ `mission.resumed` `2026-10-06T20:16:14.589Z`。
  - 该 Mission **没有** `mission.queued` / `mission.queue_started`（明确缺失）。
- **不可靠或缺失**：`updatedAt` 会被认领、续租、失败反复覆盖，**不能当认领时点**；`availableAt` 会被后一次失败覆盖，**`detail` 字符串里的 `availableAt` 也不可当持久终点**。因此老的记录里「排队 + 退避」的**时长未知**，只有入队时点（`createdAt`）可显示。

### 2.2 调度与选候选

- **现在能不能测**：能测到一个**粗区间的总长**（`orchestration.round.started` → 下一次 `attempt.started`），但**内部拆分不可测**。
- **事件 kind 与字段**：`orchestration.round.started`，`data` 只有 `schemaVersion: 1`（`src/application/platform.ts:1536`）；它写在 preflight 与预算闸之后、`#runHop` 之前（`src/application/orchestrator.ts` 约 666-690 行的注释与调用）。`attempt.started` 的 `data.kind` 是 `coordinator` 或 `executor`（`src/application/platform/attempts.ts:24`）。
- **文件:行**：`platform.ts:1536`；`orchestrator.ts` 约 `666-690`；`attempts.ts:24`；两者之间的 `#availableCandidates`（`orchestrator.ts:1483` 起）对每个候选调 `#quotaUsage`（`:1494`、`:1518`）；同段还有 `getMissionConflictFiles` 与领 hop。
- **COM4-AB 真实示例**：
  - 执行者常见约 **43 秒**：`orchestration.round.started` `2026-10-07T03:09:31.570Z` → `attempt.started W-504.exec-1` `2026-10-07T03:10:14.926Z`（**43356ms**）。
  - 协调者更长：`2026-10-07T02:51:55.074Z` → `coord-4` `2026-10-07T02:53:21.022Z`（**85948ms**）。
  - 退避后的执行者约 29 秒：`2026-10-06T20:16:15.036Z` → `W-502.exec-2` `2026-10-06T20:16:44.129Z`（**29093ms**）。
- **不可靠或缺失**：这段**没有子事件**，`#availableCandidates` / `#quotaUsage` / `getMissionConflictFiles` / 领 hop 混在一起。**不能把整段标成「只在查用量」**。L3 所说 40–45 秒与执行者样本同量级，但**内部拆分未知**。

### 2.3 agent 运行

- **现在能不能测**：能测，且这是目前最可靠的一段。
- **事件 kind 与字段**：`attempt.started` / `attempt.ended`（`src/application/platform/attempts.ts:151`）。`ended` 带 `endedBy`、`usage`（`input`/`output`/`total`/`quality`）、可选 `contextMetrics`（工具**次数**，**没有耗时**）。
- **文件:行**：`attempts.ts:24` 与 `:151`；重启收尾会再 append 一条 `attempt.ended` 且 `endedBy=interrupted`（`src/application/platform/reconcile.ts:128`）。
- **COM4-AB 真实示例**：
  - `W-503.exec-1`：`2026-10-07T03:00:06.628Z` → `2026-10-07T03:04:04.086Z`，`usage.total=1235016`，`quality=reported`。
  - 重启收尾：`W-502.exec-2` 在 `2026-10-06T20:22:34.954Z` 有 `endedBy=interrupted`，**该跳没有 `usage`**。
- **不可靠或缺失**：`contextMetrics` 只有次数、没有毫秒，**不能拿来推算耗时**。`endedBy=interrupted` 的收尾行与正常结束行并存时，同一 attempt 会**出现两条 `attempt.ended`**，需要在下游按「矛盾重复不求和、标未知」处理。

### 2.4 工具执行

- **现在能不能测**：**只能看到开始时点，时长未知**。
- **事件 kind 与字段**：协议已有 `tool.completed`（`src/application/ports.ts:232`）；`src/runtime/spawn.ts:69-70` 已把 `t=tool.completed` 解析成 RuntimeEvent。但 `src/application/orchestrator.ts` 约 `2057-2094` 的 `run.on` **不处理它**。持久化只有 `runtime.command.started`（`src/application/platform/command-tracking.ts:13-21`，`data` 里是 `schemaVersion` 与 `callId`），且**仅 `activityClass=command`** 才落。
- **文件:行**：`ports.ts:232`；`spawn.ts:69-70`；`orchestrator.ts` 约 `2057-2094`；`command-tracking.ts:13-21`；`src/web/task.js` 约 `318`（`startedCommands` 已按 `callId` 去重，只计条数不计时长）。
- **COM4-AB 真实示例**：有 **321 条** `runtime.command.started`，**0 条完成事件**。
- **不可靠或缺失**：因为 hub 在落库前**丢弃** `tool.completed`，**现网无法证明 pi 是否已经发过**——写成「未验证」。所以工具时长现在**缺失**，只有开始时刻。

### 2.5 平台验证

- **现在能不能测**：验证窗的**起止在报告仓储里有**，但**活动流里只有时点**；**现网页算不出验证与运行的重叠**。
- **事件 kind 与字段**：`ValidationCheckResult` / `ValidationReport` 有 `startedAt`/`endedAt`（`src/kernel/payloads.ts:396-455`；`src/application/.../engine.ts:82` 起逐 check 记时）。activity 只有 `validation.reported`（`src/web/narrate.js` 约 820 行），字段 `reportId`、`passed`。网页简版 `ValidationReportView`（`src/application/platform/types.ts:508`）只有 `durationMs`，**没有起止**。
- **文件:行**：`kernel/payloads.ts:396-455`；`engine.ts:82` 起；`narrate.js` 约 `820`；`platform/types.ts:508`。
- **COM4-AB 真实示例**：
  - `VR-203`：attempt `W-502.exec-5`，`attempt.ended` `2026-10-07T02:51:51.926Z`；报告窗 `2026-10-07T02:51:53.050Z`–`02:51:53.884Z`（**834ms**），command check **536ms**，与该次运行**不重叠**；activity 上 `validation.reported` 在 `02:51:54.191Z`。
  - `VR-205`：报告窗 `2026-10-07T03:43:05.568Z`–`03:45:29.587Z`（**144019ms**），在 `W-504.exec-14` ended `03:43:04.411Z` 之后；activity 到 `03:45:29.921Z` 才 `validation.reported`。
- **不可靠或缺失**：**检查起止不在 activity 里**，现网页因此**算不出重叠**。做投影时必须**从报告仓储单独读入起止**，并让重叠只计一次。

### 2.6 L2 评审

- **现在能不能测**：**不能**。
- **事件 kind 与字段**：`review.recorded` 是**时点**（带 `verdict`），**不是区间**；**没有 `review.started`**。
- **文件:行**：`review.recorded` 的具体落点是「未知」（本票未核实该行号，不编造）。
- **COM4-AB 真实示例**：`coord-4`：`attempt.started` `02:53:21.022Z` → `review.recorded` `02:59:17.622Z` → `attempt.ended` `02:59:22.934Z`。
- **不可靠或缺失**：整跳含**调查、规划、派发**，**不能当成评审耗时**。**评审时长现在缺失**，必须标未知，禁止用协调者 attempt 墙钟冒充。

### 2.7 等待决定

- **现在能不能测**：三类等待各用**成对事件**可以测出墙钟区间。
- **事件 kind 与字段**：`mission.waiting` 的 `data.reason`/`detail` 与 `mission.resumed`（`src/application/platform/mission-lifecycle.ts:43`）；升级 `escalated`（`src/application/platform/escalations.ts:93`，`data.question`）到 `escalation.answered`（`:181`）；L3 终审：`mission_result.submitted` 到 `final_review.merged` / `send_back` / `abandoned`。
- **文件:行**：`mission-lifecycle.ts:43`；`escalations.ts:93` 与 `:181`。
- **COM4-AB 真实示例**：
  - 该 Mission **没有** `escalated`，**也没有** `reason=waiting_l3`（明确缺失）。
  - 可测的终审等待：`mission_result.submitted` `2026-10-07T04:07:01.028Z` → `final_review.merged` `2026-10-07T04:09:54.399Z`（**173 秒**，归入 waiting_decision）。
  - hop 退避等待见 2.1，`reason=project_busy`。
- **不可靠或缺失**：`detail` 是自由文本，**禁止解析** `detail` 取时间；升级和搁置在 COM4-AB 里**没有真实区间样本**。

### 2.8 暂停与搁置

- **现在能不能测**：暂停有真实样本可测；搁置在本 Mission 无样本。
- **事件 kind 与字段**：`mission.paused`（`src/application/platform/mission-lifecycle.ts:62`）到 `mission.resumed_from_pause`（`:163`）；`mission.parked`（`:107`）到 `mission.resumed_from_park`（`:150`）。
- **文件:行**：`mission-lifecycle.ts:62`、`:107`、`:150`、`:163`。
- **COM4-AB 真实示例**：
  - 暂停：`mission.paused` `2026-10-06T20:26:04.076Z` → `resumed_from_pause` `2026-10-07T02:46:18.695Z`，随后 `02:46:24.619Z` `mission.resumed`。
  - 该 Mission **没有** `mission.parked`（明确缺失）。
- **不可靠或缺失**：缺结束事件时（例如服务被杀）**时长未知**，**不把 `now` 算进去冒充已结束**。

## 3. 最小方案

### 3.1 决定

采用**应用层纯函数投影**，无 I/O：

- 新模块 `src/application/time-attribution.ts`，对照 `src/application/budget-usage.ts` 的 `projectAuthoritativeWallClockMs`（约 413 行，**区间并集**）。
- **不放 kernel**：内核不 import 任何东西、不出现 provider/model/session 等词；投影涉及验证报告与 hop，属于应用层。
- **不只放 `src/web/task.js`**：验证起止和未来的 hop 事件**不在浏览器已有的 activity 数组里**；重叠、并集、去重是**用例规则**，写在前端等于把规则放进展示层。
- `GET /api/missions/:id` **附带投影结果**（后端算好，前端只渲染）。
- `src/web/task.js` **沿用现有单条时间线**（`pullView` 约 1641 行；环节头已有 `formatDuration` 约 81 行和 token 行 `stageUsageLine`），只**多显示阶段耗时和已有 token**。**不新增时间线 DOM**。

明确**不采用**的两条路：前端自算、第二条时间线。

### 3.2 环节顺序

`stageListHtml`（`task.js:487-490`）按**首次时间升序**。架构红线要求任务内进度**按发生顺序**，不是最新在顶。契约验收括号里的「最新在顶上」与红线和现码**不一致**。本方案**沿用现有发生顺序，不倒序**；请 L3 冻结实现票时确认。任务列表的倒序不在本方案改。

### 3.3 数据形状（拟议接口，**不是已实现**）

```
projectTimeAttribution(input) → {
  schemaVersion: 1,
  coverage: 'complete' | 'partial' | 'unknown',
  totalOccupiedMs: number | null,
  phases: TimePhase[]
}
```

`TimePhase`：

- `kind`：闭集 `queue | hop_backoff | schedule_select | agent_run | tool | validation | l2_review | waiting_decision | pause | park | unclassified`
- `start?`、`end?`
- `durationMs: number | null`
- `attemptId?`、`workItemId?`
- `countedInTotal: boolean`
- `overlaps: string[]`
- `quality: 'measured' | 'unknown'`
- `note?`

`input`：

- `activity` 事件（`at` / `kind` / `attemptId` / `workItemId` / `messageId` / `data`）；
- 可选 `validationReports`（`id`、`attemptId`、`workItemId`、`startedAt`、`endedAt`、`checks` 的 `kind` 与起止；**不要 `outputTail`**）；
- 可选 `hops`（**只用** `id`/`role`/`workItemId`/`createdAt`/`status`；**禁止用 `updatedAt` 当认领**）。

### 3.4 规则

1. **工具并集**：按 `callId` 的 `[started, completed]` **并集**计占用。没有完成事件则 `durationMs=null`、`quality=unknown`，**禁止**用下一条事件或 `attempt.ended` 闭合。
2. **验证重叠**：验证窗与 `agent_run` 相交则**两者都显示**，相交切片**只进总耗时一次**，`overlaps` 标明。不相交的验证照常计入。
3. **未分类**：`agent_run` 内部减去已知工具并集后的剩余标 `unclassified`（展示文案「未分类」）。**任一相关工具时长未知，则这段剩余也未知**；**禁止标成思考**，**禁止用 `usage.total` 或 `contextMetrics` 推算毫秒**。
4. **重连不重复计时**：相同 `messageId`，或相同 `attemptId + callId` 的 started/completed，**不第二次计时**。同一 attempt 两条**互相矛盾的 `attempt.ended`**：**不求和**，该跳时长标未知，页面仍可读。**不要照搬预算投影**的「重复就把整票标 unknown」或「用 `capturedAt` 闭合未结束工具」。
5. **历史缺事件**：不抛错，`coverage` 为 `partial` 或 `unknown`，缺项标未知。
6. **`schedule_select`** = `round.started` 到下一次 `attempt.started`；`note` 写明**含选候选与冲突查询，不能再拆**。
7. **`queue`**：**只在同时有 `hop.enqueued` 与 `hop.claimed` 时**计时长；只有 `hop.createdAt` 时入队时点可显示，**等待时长未知**。**禁止解析 `mission.waiting` 的 `detail`**。
8. **`hop_backoff`**：有 `hop.backoff` 事件则用其 `failedAt`/`availableAt`；否则**仅当** `mission.waiting reason=project_busy` 到下一条 `mission.resumed` 时，把这段墙钟标为退避等待（`measured`），`note` 写明 **`detail` 里的 `availableAt` 会被覆盖、不采用**。
9. **`l2_review`**：只有 `review.recorded` 时点，`durationMs=null`。**禁止**用协调者 attempt 墙钟冒充评审耗时。
10. **`waiting_decision`**：`waiting_l3` 等 `mission.waiting`（**除** `project_busy` 已归退避、以及暂停/搁置）到 `mission.resumed`；`escalated` 到 `escalation.answered`；`mission_result.submitted` 到 `final_review.merged` | `send_back` | `abandoned`。COM4 终审那 **173 秒**归这一类。
11. **`pause` / `park`**：用 2.8 的成对事件；**缺结束则时长未知**，**不把 `now` 算进去冒充已结束**。
12. **token**：只**原样带上** `attempt.ended` 的 `usage`（`total`/`quality`），与阶段毫秒**分开**呈现。

## 4. 要补的事实与兼容

### 4.1 工具结束：接收与持久化

- 平台在 `orchestrator` 的 `run.on` 里接收**已经解析的** `tool.completed`，经**新的** `platform.recordToolCompleted` 追加 `runtime.tool.completed { schemaVersion: 1, callId, name }`，`at` 即结束时间。
- **不要求 `activityClass`**，**不并进 command-tracking 计数**（工具时长事件和「命令计数」是两回事）。
- **旧适配器不发**：没有事件 → 投影**标未知**。
- **pi 发出 `t=tool.completed` 单列为 pi 仓库票**，本方案**不实施、不改 pi**。
- **现网无法证明 pi 是否已发**，因为 hub 在落库前丢弃 → 写成**未验证**。

### 4.2 排队时点：不新增可覆盖字段当权威

- **不新增**会被 `renew` 覆盖的 `claimedAt` 字段当权威。
- 在**入队成功**时（幂等命中旧行**则不重复发**）追加 `hop.enqueued { hopId, role, workItemId, availableAt }`。
- **仅在** `queued|retry_wait → claimed` 的那一次追加 `hop.claimed { hopId, claimGeneration, enqueuedAt }`；**`renew` 不发**。
- `reportHopFailure` 得到 `retry_wait` 时追加 `hop.backoff { hopId, failedAt, availableAt, attemptCount }`。
- `durable-scheduler` **保持纯函数**，事件由 platform 在 orchestrator 领 hop / 报失败之后写。
- **旧行没有这些事件**：等待时长**未知**；`createdAt` 只可作入队时点，**`updatedAt` 不得当认领**。

### 4.3 叙事与覆盖测试的影响

- `runtime.tool.completed` **不在** `isRuntimeCommand`（`src/web/narrate.js:1059`，只豁免 `runtime.command.` 与 `runtime.command_tracking.`）里，**必须**在 `EVENT_TABLE`（`narrate.js:450` 起）加翻译**或**扩展豁免；否则 `test/web-event-coverage.test.ts` 约 404 行的「每种非命令 kind 调 `narrateEvent` 不得 untranslated」会红。
- `hop.enqueued` / `hop.claimed` / `hop.backoff` **同样要翻译**（它们不是 `runtime.command.` 前缀，落不到豁免里）。
- command 族折叠逻辑（一跳 20 条 `started` 折叠成一行计数）**不要把工具时长事件误当成又一条命令开始**。

## 5. 可分开冻结的工单草案

每张写：目录、真实函数、拟议接口、测试接缝、一到两条关键测试、既有测试与不变量、依赖。验收覆盖：**串行与并行工具并集正确**；**等待决定与执行区分**；**缺事件标未知**；**重连不重复计时**；**历史 Mission 缺项仍可读**。

### T1 纯投影

- **目录**：新增 `src/application/time-attribution.ts`、`test/time-attribution.test.ts`。
- **真实函数**：`projectTimeAttribution`。
- **拟议接口**：第 3.3 / 3.4 节的形状与规则。
- **测试接缝**：`test/time-attribution.test.ts`，参照 `test/budget-usage.test.ts` 约 811 行的并集夹具，但**断言与预算投影不同**（重复不把整票打成 unknown；未结束工具不按 `capturedAt` 闭合）。
- **测试 1**：串行两段工具**相加**、并行两段取**并集**、验证与运行重叠**不双计**。
- **测试 2**：缺 completed、缺 `attempt.ended`、重复 `callId` / 矛盾的第二次 ended，时长为 `null` 或未知且函数**仍返回**。
- **既有不变量**：既有预算测试**不要改语义**。
- **依赖**：无（不依赖 T2/T3），用夹具事件即可。

### T2 持久化工具结束

- **目录**：`src/application/orchestrator.ts`、platform 记录函数与 command-tracking 旁的新小模块、`src/web/narrate.js`、必要时 `test/runtime-events.test.ts`。
- **真实改动点**：`orchestrator.ts` 的 `run.on`（`2057` 附近加 `tool.completed` 分支）。
- **测试接缝**：参照 `test/budget-command-facts.test.ts` 的 started 落库方式；一条断言 completed 落成 `runtime.tool.completed` 且**重复 `callId` 只一条**。`spawn` 已有测试，**不要重写**。
- **既有不变量**：旧事件流无 completed 时**不发明结束**。
- **依赖**：无；T4 之前完成即可。`web-event-coverage` 会扫到新 kind。

### T3 hop 时点事件

- **目录**：platform（入队 / 首次认领 / 退避写入）、`src/web/narrate.js`（三行翻译）。
- **真实改动点**：入队、`queued|retry_wait → claimed`、`reportHopFailure → retry_wait` 之后 append 三个 kind。
- **测试接缝**：一条——认领覆盖 `updatedAt` 之后，活动里**仍有 `hop.claimed` 的 `at`**；幂等入队**不产生第二条 `hop.enqueued`**。
- **既有不变量**：**不改 `QueuedHop` 的可覆盖字段当权威**。
- **依赖**：无。

### T4 挂到现有时间线

- **目录**：platform `getMissionView` 或既有 mission GET、`src/web/task.js`。
- **真实改动点**：`task.js` 在现有 `stage-head` 加阶段文案，**不新列表**、**不改 487 行的升序**。
- **测试接缝**：`test/web-task.test.ts` 一条——给定夹具 activity，阶段「未知/未分类」出现在现有 stage 文案里，文档中**不出现第二条时间线容器**。
- **既有不变量**：验证起止**从报告仓储读入投影**，**不把 `outputTail` 放进页面载荷**。
- **依赖**：T1。

### T5（不在本仓库实施）

- pi 适配器发 `tool.completed`。**只在文档列出，不写 pi 路径的实现步骤**。

### 顺序

T1 可与 T2、T3 并行；T4 依赖 T1，最好也等 T2/T3 的 kind 稳定后再做文案，避免叙事返工。每张实现票由 L3 另冻，**本文件不是开工授权**。

## 6. L2 五维结论与未验证

### 五维结论

**设计**：与现有预算墙钟投影同层，规则在应用层纯函数，展示沿用 `task.js` 单条时间线。可行。不进 kernel，不把重叠规则写进 prompt 或 narrate。

**功能**：可测区间能投影；工具结束和认领时点在补事件前标未知，符合不编造。L2 评审不能从现有事件拆出区间，必须标未知，不能把协调者整跳标成评审。等待决定用 waiting/escalated/终审成对事件，与 attempt 墙钟分开。边界：矛盾的重复 ended 标未知而不是求和。

**复杂度**：一个投影模块加少量事件写入，`task.js` 只渲染已算好的阶段。比前端重算或改调度小。实现时新函数守 40 行建议，按阶段拆函数，不要把投影塞进 `orchestrator.ts`。本设计票不设行数硬门禁。

**测试**：T1 两条纯函数测试覆盖并集、重叠、未知、重连；T2/T3 各一条落库；T4 一条文案。不要求本调查票跑 `node --test` 全量。参照 runtime-events、budget-command-facts、web-task、web-event-coverage。

**命名**：phase kind 用上面的闭集；`durationMs` null 表示未知；文案用「未分类」「未知」，不用 thinking、estimatedFromTokens。

### 未验证（必须列出）

- pi 是否已发 `tool.completed`（**未验证**）。
- 调度空档里查用量与冲突查询各占多少（**未知**）。
- COM4-AB 没有升级和搁置的真实区间（**缺失**）。
- 本票未改 `src/test`，故投影与叙事测试**都还没跑**。
- 状态样例来自运行中的主工作区状态文件，不是集成分支仓库内的文件。

---

**本票不实现代码。** 全文所述接口、形状与规则均为设计与调查结论，实现由 L3 冻结后另行开工。
