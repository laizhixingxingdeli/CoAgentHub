# COM4 验收证据最小方案调查

> **本文件是调查与提案，不是运行时完成证据。** 下面每一条「现状」都只是读集成分支
> 当前源码读出来的事实，写明了文件与行号，供 L3 核对；第 2 节以后的记录名、事件名
> 都是**提案名，待 L3 冻结**。本文件不实现任何一张票，不含测试结果。
> 分支：`mission/COM4-design-20261007`（HEAD `fb7f66d`）。

---

## 1. 现状（契约验收 1）

### 1.1 工作项逐条验收

**形状** —— `AcceptanceResult { criterion, status: pass|fail|unverified|not_applicable, evidence?, note? }`，
`src/kernel/payloads.ts:477-485`；`ReviewRecord` 同文件 `487-496`，除 `acceptanceResults`
外还有 `attemptId`（写下评审的那一跳）与 `submittedAttemptId`（这份结论验的是哪一次提交）。

**写入** —— `checkAcceptanceResults`，`src/application/platform/work-order-helpers.ts:114-155`：
工单 `acceptance` 非空时必须等长、`criterion` 与验收原文逐字相等；`pass` 要求非空
`evidence` 字符串；`unverified` / `not_applicable` 要求非空 `note`。

**事件** —— `src/application/platform/work-item-review.ts:80-98` 的 `review.recorded`，
`data` 只有 `verdict`、`reasons`、`criteria`（数字序号）、`contractRevision`、
`acceptance`（四态计数）、`unverified`（判 unverified 的 criterion 原文）。
**完整的 `acceptanceResults` 只挂在 `ReviewRecord` 上，不在事件里。**

**criteria 序号** —— `criteriaList`，`src/application/platform/agent-view-helpers.ts:333-348`：
工单显式写了 `criteria` 就照抄去重；standard 缺省返回 `[]`，**不展开全契约**；
只有 `lightweight` 首跳或带 `coordinator_rejected` 晋升记录的工单才展开 `1..N`。

**示例输入**（工单 acceptance 为 `["跑定向测试"]`）：

```json
[{ "criterion": "跑定向测试", "status": "pass", "evidence": "node --test test/foo.test.ts 退出码 0" }]
```

**示例输出**：`ReviewRecord.acceptanceResults` 原样保留上面这个对象，并带上
`submittedAttemptId`；`review.recorded` 事件的 `data.acceptance` 为
`{pass:1,fail:0,unverified:0,not_applicable:0}`，`data.criteria` 为工单 `criteria`
里的数字（工单没写 criteria 且是 standard，则为 `[]`）。

- **现在能证明什么**：某次 L2 评审对**工单自己的验收原文**逐条给过结论，且
  `ReviewRecord.submittedAttemptId` 标明验的是哪次提交。
- **现在不能证明什么**：这条工单验收等于契约第 N 条（除非工单 `criteria` 显式含 N）；
  只回放事件看不到 `evidence` 正文；`evidence` 是自由字符串，没有命令 / 报告 id 结构。

### 1.2 交卷 criteria 与终审门

**形状** —— `MissionResultCriterion { index, status, evidence: string }`，
`src/kernel/payloads.ts:581-586`（工单给的区间 `615-619` 在本分支上是 `615-630`
的 `MissionResultBody`，`criteria` 为**可选**字段，见 `628` 行与 `622-627` 的注释：
历史交卷没有它，缺字段必须还能读回来）。

**写入校验** —— `src/application/platform/mission-result-criteria.ts:11-61`：
`index` 必须落在 `1..acceptanceCount` 且不重复；未知字段直接拒绝；`status` 必须
在四态枚举内；`evidence` 只要**是字符串**就收；只有 `not_applicable` 额外要求非空。
（`missionResultCriteriaIssues` 在 `69-85`。）

**机器闸** —— `missionResultCriteriaIssues` 只把「非 pass 且非 not_applicable」算未达成，
把 `evidence` 原文拼进诊断串，**不解析证据来源**。`holdForUnmetCriteria`，
`src/application/platform/machine-finalization.ts:22-49`，在合并、集成验证之前调用；
`104-107` 写明 `acceptanceEvidence` **完全不参与**闸门。
（`missionResultCriteriaIssues` 落在本分支 `69` 行起，工单给的 `63-77` 区间大致对应。）

**检视者门** —— `finalizeMission`（`src/application/platform/final-review.ts:20-47`）与
`applyFinalReview`（同文件 `132-164`）只要求 `mission.status === 'awaiting_review'`，
**不调用 `missionResultCriteriaIssues`**。

**交卷入口** —— `submitMissionResult`，`src/application/platform/mission-control.ts:51-61`：
先 `validateMissionResultCriteria`，再 `recordResult`。附件里的
`criterionWorkItems`（`src/application/platform/mission-result-attachments.ts:202-214`）
只按工单 `criteria` 列出 `workItemId`，空关联给空数组，**不是证据**。

**示例**：acceptance 2 条，criteria 为
`[{index:1,status:"pass",evidence:"见 W-1"},{index:2,status:"unverified",evidence:""}]`。
`missionResultCriteriaIssues` 返回含「`#2 status=unverified`」的一项；若两条都是 pass，
issues 为 `[]`——**即使 evidence 是「见 W-1」这种自由文本**。
今天人工 `finalizeMission` 仍可能 merge。

- **现在能证明什么**：条数、`index`、状态枚举齐。
- **现在不能证明什么**：pass 的 evidence 指向某次提交、某份报告或某次契约修订。
  **交卷 evidence 只是自由文本。**

### 1.3 reviseContract 对已验收项与交卷

- kernel：`src/kernel/mission.ts:722-729`（本分支实测位置）——非终态覆盖契约，
  `contractRevision += 1`。
- 用例：`src/application/platform/mission-lifecycle.ts:9-27`，`executing` **或**
  `awaiting_review` 都 `sendBackToPlanning`，reasons 只有
  「Contract 已更新到 rN，需要按新契约重新核对」。起点里「只在 awaiting_review」
  的说法已过时，以这两行为准。
- accepted 不能作废：`src/application/platform/mission-control.ts:9-36`（注释 `15-28`）；
  `src/kernel/work-item.ts:57-67`：`accepted` 只能再进 `dispatched`。
- 真实例子：`test/platform.test.ts:772-783` 附近，`reviseContract` 后
  `status=planning`、`finalReview.reasons[0]` 匹配 `/Contract 已更新/`、工作项仍是
  `dispatched`（该例还没验收）。
- **没有任何代码**把已有的 `ReviewRecord` 或交卷 `criteria` 标成失效。

- **现在能证明什么**：契约文本与修订号变了，Mission 被打回规划。
- **现在不能证明什么**：已验收项自动失效，或交卷 criteria 被清空。

### 1.4 验证报告按 submittedAttemptId

- 键：`validationReportKey = workItemId + NUL + submittedAttemptId`，
  `src/application/platform/agent-view-helpers.ts:269-271`。
- 读取：`referencedReportId`，`src/application/platform/validation-report-views.ts:30-44`，
  只认 `event.kind`、`missionId`、`workItemId`、`data.submittedAttemptId`、`data.reportId`；
  **`event.attemptId` 不参与**（`24-28` 注释说明理由）。`54-56` 说明旧报告**不得回退**。
  `getAgentValidationReport`（`61-103`）只看当前 `item.submittedAttemptId`。
  `workItemValidationReportViews`（`108-139`）正序扫、后写盖前写，仍按当前
  `submittedAttemptId` 取。
- 今天的复用规则：`submittedAttemptReportId`（`src/application/platform/standard-validation.ts:48-66`）
  倒序找同一 `workItemId + submittedAttemptId`；已有报告则原样返回、不重跑、不换
  `reportId`（`103-114`，注释写明理由）。写 `validation.reported` 时 attemptId 参数
  留空（`184-188`），`data` 含 `reportId`、`passed`、`submittedAttemptId`。
- 示例：同一 W-1 两次提交 A-old / A-new，两份 `validation.reported` 事件都在；
  `getAgentValidationReport` 只返回 A-new 引用的那份。这不是「代码没变就复用旧报告」。

- **现在能证明什么**：某次提交被哪份 `reportId` 引用。
- **现在不能证明什么**：换了 Attempt 之后旧报告仍适用于新代码或新的
  `validation.commands`。

### 1.5 COM3 / B4

- `ChangeImpact.affectedAcceptance`：`src/application/change-impact.ts:38`；
  `169-175`：`decision === 'compatible'` 且数组为空则拒绝。保存入口
  `src/application/platform/change-impact.ts:468-530`，事件 `change.impact_decided`
  带 `changeId`、`workItemId`、`attemptId`、`claimGeneration`、`decision`、
  `affectedAcceptance`。**没有任何读取方**拿 `affectedAcceptance` 去作废验收。
- 交卷快照：`src/application/platform/executor-submissions.ts:75-112`。
  `appliedChanges` 只收本次 `attemptId + workItemId + layer === 'executor_started'`
  且有 `contentHash` 的回执，按 `changeId` 升序。`snapshotHash = submissionSnapshotHash`
  （`src/application/change-receipt.ts:347-364`），输入含 `orderRevision`、
  `contractRevision`、`workOrderHash`、`appliedChanges`。缺字段时叙事写
  「快照未知」（`src/web/narrate.js:422-427`）。
- 门禁：`src/application/platform/work-item-review.ts:155-174` `requireCoveredChanges`；
  未覆盖抛 `ACCEPT_CHANGES_UNCOVERED`。判定函数
  `src/application/change-receipt.ts:124-147` `findCoveringReceipt` 与 `149-157`
  `uncoveredCompatibleChangeIds`：回执 `attemptId` 必须等于本次 `submittedAttemptId`、
  `layer === 'executor_started'`、`contentHash` 等于 diff 的 sha256。
- 下发：`src/application/platform/change-receipt.ts:110-126`（`deliverableImpacts`）与
  `234-256`（`requireDeliverableImpact`）只把 `attemptId` 与 `claimGeneration` 都等于
  本次执行的 `compatible` 差异交给执行者。旧 Attempt 的 `changeId`，新执行写不了回执。
- verified：`work-item-review.ts:183-218` `recordVerifiedReceipts`。没有本次 passed 报告
  就一条不写、**也不抛**，accept 仍可成功。`VerifiedChangeRecord` 定义在
  `src/application/change-receipt.ts:48-72`。执行侧 list 不返回 `verified`。
- 真实例子：`test/change-snapshot-review.test.ts:309-371`——未 ack 的 compatible 变更
  accept 抛 `ACCEPT_CHANGES_UNCOVERED` 且盘上逐字节不变；重派并再次提交后，旧 impact
  仍未覆盖，第二次 accept 仍拒；两份 `execution_result.submitted` 与两份
  `validation.reported` 按 attemptId 都还在。

- **现在能证明什么**：本次提交是否带着与 diff 哈希相符的 `executor_started`；
  accept 且有通过报告时平台写过 `verified`。
- **现在不能证明什么**：重派后旧 `changeId` 有恢复路径（**今天没有**）；
  `affectedAcceptance` 已参与验收失效。

---

## 2. 最小方案（契约验收 2）

只做**明确关联**与**字符串全等失效**。不做语义推断，不做跨环境测试缓存。

采用下面两个新的 append-only 记录（**提案名，待 L3 冻结**）。不改交卷 `criteria`
现有的三个字段，以免历史交卷读不回来（`src/kernel/payloads.ts:622-628` 明确要求）。

### AcceptanceDisposition

字段：

```text
dispositionId           记录 id
missionId
contractRevision        写下这份结论时的契约修订号
index                   正整数，契约验收标准序号
decision                reuse | revalidate | new_requirement
workItemIds             字符串数组
basis                   对象：submittedAttemptId? / reviewAttemptId? / reportId? /
                        snapshotHash? / priorContractRevision? / note（非空字符串）
coordinatorAttemptId
at
```

幂等：同一 `dispositionId` 同内容重复写视为同一条；同 id 异内容冲突，**不覆盖**。

**失效规则（平台机械执行，L2 不能靠散文跳过）**

1. **绑定只认显式序号。** 只认工单 `order.criteria` 里显式出现的契约序号。
   standard 缺省 `criteriaList` 为 `[]` 时（`agent-view-helpers.ts:333-348`），
   该工单的 accepted **不能证明任何契约条**。禁止用验收原文相似度补关联。
2. **契约修订后。** 某 `index` 的验收原文与 `priorContractRevision` 对应原文
   **字符串全等**，才允许 `decision = reuse`。原文变了必须 `revalidate`，旧 accepted
   不算。**修订号本身不同不得把原文未变的项判失败**；新增 `index` 没有 disposition
   或没有变更后的新证据，不能 pass。
3. **ChangeImpact.affectedAcceptance 点名的 index。** 在该 impact 的事件时间之后，
   必须有新的 `submittedAttemptId` 上的 `ReviewRecord`，或新的
   `disposition = revalidate` 且 `basis` 指向变更之后的 `reportId` / `snapshotHash`，
   才能再 reuse。没点名的 index 不因这条 impact 失效。
   `replan` / `cancel_replace` **不自动推断影响面**，只把该 workItem 的显式 criteria
   标成待复验，直到 L2 写下新 disposition。
4. **复用报告。** `reuse` 的 `basis.reportId` 必须能被
   `validationReportKey(workItemId, submittedAttemptId)` 找到，且该报告的
   commands `argv` / `timeout` 与当前工单 `validation.commands` **全等**、
   `allowedScope` 全等。任一字段缺失或不等，**保存 disposition 失败**，该项保持待复验。
   不比较 cwd、机器名、Node 版本；**不建跨环境缓存**。
5. **最终交卷。** 在 `submitMissionResult`（`mission-control.ts:51-61`）里，
   `status = pass` 的每一条还必须有一条对**当前契约原文**有效的 disposition
   （reuse，或变更后的新证据）。没有就不能 `delivered`。`not_applicable` 仍沿用现有
   「evidence 非空」。fail / unverified 继续不能过机器闸。
   **不要因为以前 accepted 就自动填 pass。**

**建议但未验证、留给 L3：** `finalizeMission`（`final-review.ts:20-47`）今天不查
criteria。是否在 merge 前调用同一个 `missionResultCriteriaIssues`，本文件只列为建议，
**不写成已决定**。

---

## 3. B4 恢复与时间线（契约验收 3）

### 为什么重派后一直卡死

`uncoveredCompatibleChangeIds` / `findCoveringReceipt`
（`change-receipt.ts:124-157`）要求回执 `attemptId === 新的 submittedAttemptId`；
而下发与写回执（`platform/change-receipt.ts:110-126`、`234-256`）要求
`impact.attemptId === 本次执行`。**重派后旧 compatible changeId 永远补不上
`executor_started`**，`ACCEPT_CHANGES_UNCOVERED` 就一直挡住 accept。
`test/change-snapshot-review.test.ts:345-370` 已观察到重派后仍拒。

### 选定恢复路径

**不选**：给旧 `changeId` 再做一次 `ChangeImpact`。`ChangeImpact` 按 changeId 一份，
`attemptId` 来自 `ChangeRequest`（`platform/change-impact.ts:468-530`），不能改写；
对新 Attempt 另开 `ChangeRequest` 是现有 B1/B2，**清不掉旧 changeId**。

**选定**：L2 把差异并入修订后的工单，并显式写

```text
ChangeCoverage {
  changeId, missionId, workItemId,
  orderRevision, workOrderHash,
  coordinatorAttemptId, at
}
```

accept 时，除现有 `findCoveringReceipt` 外，若该记录的 `orderRevision` 与
`workOrderHash` 等于本次 `execution_result.submitted` 快照里的同名字段
（`executor-submissions.ts:75-112`、`change-receipt.ts:347-364`），视为覆盖。
**不等仍抛 `ACCEPT_CHANGES_UNCOVERED`，无副作用。** 同内容幂等；异内容冲突。
没有这条记录的旧 Mission / 未装配仓储：**保持今天的门禁**，缺字段不等于已覆盖。

**数据兼容**：旧 `ChangeImpact`、旧回执、旧交卷**不回填**。
`src/application/pg-store.ts`（1593 行）里检索不到 `ChangeImpact` / `changeReceipt`
相关字样，新记录同样未装配时不启用——**不得写成 PG 已支持**。

### 时间线

**不新增第二条。** 新事实用活动事件 `acceptance.disposition_recorded` 与
`change.coverage_recorded`（**提案名**），`attemptId` 用写下记录的 coordinator attempt，
这样 `src/web/task.js:181-193` 的 `groupActivity` 会把它放进现有环节。
必须在 `src/web/narrate.js` 的 `EVENT_TABLE`（`432` 行起）加翻译，否则
`test/web-event-coverage.test.ts:405-415` 会失败。

如实写：`FileActivityLog.list`（`src/application/file-store.ts:1043-1047`）是**追加顺序**；
任务页环节按首事件时间**升序**（`task.js:485-488`）。契约里「单一倒序时间线」的措辞
与源码不一致。本方案不发明倒序列表，只挂现有这一条活动流。

展示内容：变更（已有 `change.impact_decided` / `change.receipt_recorded`）、
L2 影响结论（disposition 事件）、应用（coverage 事件）、
复验（新的 `validation.reported` + `review.recorded`）。

---

## 4. 可分开冻结的工单草案与五维（契约验收 4）

### 票 A —— 证据绑定与交卷闸

- 目录范围：新增 `src/application/acceptance-disposition.ts`；改
  `src/application/platform/mission-control.ts`（`submitMissionResult:51-61`）。
- 真实函数：`validateMissionResultCriteria` / `missionResultCriteriaIssues`
  （`mission-result-criteria.ts:60` / `69`）、`criteriaList`
  （`agent-view-helpers.ts:333`）。
- 拟议接口：`recordDisposition(ctx, missionId, coordinatorAttemptId, record)`、
  `dispositionIssues(criteria, contractRevision, dispositions)`——机器闸复用同一个
  issues 函数（`machine-finalization.ts:22`）。
- 测试接缝：参照 `test/platform.test.ts:772-790` 的 reviseContract 例与交卷路径。
- 关键测试：① 契约修订后原文未变的 index 仍可 reuse、原文变了的 index 无新 disposition
  则交卷被拒；② 工单未写 criteria 时其 accepted 不能让任何契约条 pass。
- 会碰到的既有测试：`test/platform.test.ts`（交卷路径）、`test/machine-finalization*`。
- 依赖：无（可先做）。
- 不碰 kernel 历史字段的必填性。

### 票 B —— 报告复用核对

- 目录范围：`src/application/platform/standard-validation.ts`、
  `src/application/platform/validation-report-views.ts` 的读取条件。
- 真实函数：`submittedAttemptReportId`（`standard-validation.ts:48`）、
  `getAgentValidationReport`（`validation-report-views.ts:61`）、
  `validationReportKey`（`agent-view-helpers.ts:269`）。
- 拟议接口：`reusableReportFor(basis, order)`——供 A 的 reuse 校验调用。
- 测试接缝：`test/orchestrator-standard-validation.test.ts`（守当前
  `submittedAttemptId`，不回退旧报告）。
- 关键测试：① commands / allowedScope 全等时返回该 reportId；② 任一字段不等返回
  undefined 且 disposition 保存失败。
- 依赖：A 的 `basis` 形状冻结后。

### 票 C —— B4 ChangeCoverage

- 目录范围：`src/application/change-receipt.ts`（覆盖判定）、
  `src/application/platform/work-item-review.ts`（`requireCoveredChanges:155`）。
- 真实函数：`findCoveringReceipt:124`、`uncoveredCompatibleChangeIds:149`、
  `submissionSnapshotHash:347`。
- 拟议接口：`findCoverageRecord(...)` + 在 `requireCoveredChanges` 里并列判定。
- 测试接缝：`test/change-snapshot-review.test.ts:309-371` 的重派用例：补一条
  「写了匹配快照的 coverage 后 accept 成功；hash 不符仍拒且无副作用」。
- 关键测试：① coverage 的 `orderRevision` + `workOrderHash` 与本次快照相符时 accept 成功；
  ② 不符时仍抛 `ACCEPT_CHANGES_UNCOVERED` 且盘上逐字节不变。
- 依赖：无。可先做。**不自动清旧 impact。**

### 票 D —— 叙事

- 目录范围：只改 `src/web/narrate.js`（及覆盖测试若缺行）。
- 真实函数：`EVENT_TABLE`（`narrate.js:432`）、`narrateEvent`（`977` 附近）。
- 拟议接口：给两个新 kind 各加一行翻译。
- 测试接缝：`test/web-event-coverage.test.ts:405-415`。
- 依赖：A / C 的事件名冻结后再做。**不新增时间线组件。**

### 顺序

A 与 C 可并行；B 在 A 的字段冻结后；D 在事件名冻结后。
**本票不实现任何一张。**

### 五维结论

| 票 | 设计 | 功能 | 复杂度 | 测试 | 命名与注释 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| A | 新增一个纯数据记录 + 一个纯函数，不进 kernel | 补齐「pass 有没有对得上的证据」这一处空白 | 中：要读契约原文、disposition、criteria 三处 | 有既有接缝可复用 | 名称待冻结；注释需写清「不这么做会怎样」 | **有条件可行**（先冻结字段名与 issues 口径） |
| B | 只加读取条件，不改报告存储 | 挡住「拿旧提交报告当这次证据」 | 低 | 既有测试已守当前 submittedAttemptId | 与 A 的 `basis` 命名要一致 | **可行**（排在 A 后） |
| C | 并列判定，不动现有 `findCoveringReceipt` | 给重派后的旧 changeId 一条恢复路径 | 中：涉及门禁副作用 | 重派用例已存在，补一条即可 | `ChangeCoverage` 与 `ChangeImpact` 要区分清楚 | **可行**（可先做） |
| D | 只加翻译行 | 新事件在界面上说人话 | 低 | 有覆盖测试兜底 | 事件名冻结后才能定文案 | **可行**（排最后） |

### 未验证事项

- 未跑任何测试；未启动服务；未核对 PG（`src/application/pg-store.ts` 里没有
  `ChangeImpact` / `changeReceipt` 字样，新记录未装配）。
- 人工 `finalizeMission` 是否加闸**未定**，本文件只列为建议。
- 契约「单一倒序时间线」措辞与源码不一致（`task.js:485-488` 是升序）——待 L3 定措辞或改码。
- 提案字段名（`AcceptanceDisposition` / `ChangeCoverage` / 两个事件 kind）**未冻结**。
- 第 1 节行号以本分支 HEAD `fb7f66d` 为准；工单给的小部分区间（如
  `payloads.ts:615-619`、`mission-result-criteria.ts:63-77`、`change-impact.ts:38-175`
  的保存入口）与本分支实测位置有偏移，已在文中标出实测位置。
