# 模型质量基线（离线、可复跑）

这份文档定义「怎么用 Langfuse 里的事实记录和平台的权威验收，算出一份可以逐次对比的模型质量基线」。
它描述的是一个**离线报告**：只读一份显式记录数组，输出按比较维度分好的指标。
它不做 LLM 裁判，不按 token 数猜质量，不推荐模型，也不改变任何路由。

脚本：`scripts/langfuse-evaluation-report.mjs`（零依赖，只用 Node 内置模块）。
测试：`test/langfuse-evaluation-report.test.ts`（两条综合验收）。
示例数据：本文件第 8 节，全部 **synthetic**。

## 1. 为什么不能混算

一个「总体通过率」在这种数据上必然骗人，因为样本之间至少差在这些地方：

- **角色**：executor 的产出由 L2（协调者）验收，coordinator 的产出由 L3（检视者）验收。
  把两者放一起，等于把「代码写对」和「单拆得对」当同一件事。
- **任务类型 / 难度**：边界修复和约束遵守的失败原因完全不同；easy 与 hard 的成功率不可比。
- **提示词版本 / 代码版本**：换了 prompt 或换了被评测的代码，就不再是同一实验条件。
- **验收规则版本（rubric）**：rubric 改过，历史结论就不是同一把尺子量出来的。
- **评价来源**：`machine`（平台验证引擎/命令绿）**不是**质量通过；它只说明机器检查过了。
- **基础设施故障**：环境挂了导致的失败不是模型能力，混进 reject 会系统性低估。

所以本报告的基本单位是**完全相同的比较条件**，任何一条记录只要条件不齐，就进 `notComparable`，
不进任何排名。

## 2. 输入契约

CLI 只接受一个 JSON 文件，内容是**记录数组**，每条记录：

| 字段 | 类型 | 含义 | 缺失时 |
| --- | --- | --- | --- |
| `caseId` | string | **一次执行案例**的唯一 id；同一 case 的多次尝试共用 | notComparable |
| `attemptId` | string | 平台 Attempt id；同一 case 内唯一 | notComparable |
| `attemptIndex` | integer ≥ 0 | 该 case 内的第几次尝试（**不是**全局序号，**从 0 开始**） | notComparable |
| `role` | `executor` \| `coordinator` | 这次尝试的角色 | notComparable |
| `taskType` | string | 任务类型（如 `boundary-fix`、`ticket-split`） | notComparable |
| `difficulty` | string | 难度（如 `easy`/`hard`） | notComparable |
| `model` | string | 模型标识 | notComparable |
| `promptVersion` | string | 提示词版本 | notComparable |
| `codeRevision` | string | 被评测的代码版本 | notComparable |
| `rubricVersion` | string | 验收规则版本 | notComparable |
| `outcome.status` | `accept` \| `reject` \| `unknown` | 该次尝试的权威结论 | notComparable |
| `outcome.source` | `l2` \| `l3` \| `machine` | 结论来源 | notComparable |
| `infrastructureFailure` | boolean | 该次失败是否源于环境/基础设施 | notComparable |
| `costUsd` | number ≥ 0 \| null | 该次尝试的已知费用；**未知必须写 `null`** | notComparable |

规则：

- **`caseId` 是一次执行案例的唯一 id，不是任务 id**。同一个固定任务换模型重跑，属于**不同执行案例**，
  必须用不同的 `caseId`；否则两批实验会被当成同一个 case 的不同尝试，首次/最终/返工与全案成本全被混在一起。
  固定任务本身（输入快照、工单、rubric）的引用要保留在**输入来源清单**里（第 7.5 节），
  以便知道这条 case 是哪个冻结任务的哪次执行。
- **不从缺失字段猜值**。没有 `role` 就不知道它是 executor 还是 coordinator，不按 attemptId 前缀猜；
  没有 `difficulty` 就不许归到 easy 组。空字符串、`NaN`、负数费用同样算非法。
- **`costUsd: 0` 与 `null` 是两件事**：前者是「确实不花钱」，后者是「不知道」。把未知填 0 会
  把单位成本算低，报告里会明确给出覆盖率，不会掩盖。
- 记录形状非法（不是对象）与字段非法（拼错、类型错）分开统计：`missing` 表示没采集到，
  `invalid` 表示数据不可信，两者都带字段名与最多 5 条 `{caseId, attemptId, attemptIndex}` 例子。

### 数据从哪来

映射关系必须来自**真实记录**，不许自行虚构：

| 报告字段 | 真实来源 |
| --- | --- |
| `caseId` / `attemptIndex` / `role` / `attemptId` | 平台 Mission/WorkItem/Attempt 记录（`/api/missions/:id`、activity 事件），Langfuse 侧对应 `langfuse.session.id`、`stableIds({missionId, attemptId})` 与 `coagent.call_index`。 |
| `taskType` / `difficulty` | 平台的分类/Mission 元数据。没有就不要写记录——**不要**从工单标题或模型输出反推难度。 |
| `model` / `promptVersion` / `codeRevision` | Langfuse generation 的 `coagent.source.model`、调用侧传入的 prompt 版本、被评测的提交。 |
| `outcome.status` / `source` | L2：`coagent.l2.verdict`（work item 级 `lastReview`，只认 `submittedAttemptId` 指向的受评 Attempt）。L3：`coagent.l3.verdict`（Mission 级 `final_review.*`）。机器绿：`coagent.validation.*`，只标 `machine`。 |
| `infrastructureFailure` | 平台 Attempt 的 `endedBy` / `failReason` 等故障事实；判不出来就是不知道，不要默认 `false` 后又不说明。 |
| `costUsd` | Langfuse `cost_details` 或平台 usage 折算；拿不到写 `null`。 |

投影细节见 `docs/langfuse.md` 与 `scripts/langfuse-quality-records.mjs`；本报告不自己解释评审原文。

## 3. 分组与权威矩阵

分组维度（**全部**相同才算同组）：

```
role × taskType × difficulty × model × promptVersion × codeRevision × rubricVersion × source
```

角色与权威来源的对应是硬规则，不是偏好：

| role | 权威来源 | 其它来源怎么处理 |
| --- | --- | --- |
| `executor` | 只用 `l2` | `l3` 结论 → `excluded.sourceRoleMismatch`；`machine` → `excluded.machine` |
| `coordinator` | 只用 `l3` | `l2` 结论 → `excluded.sourceRoleMismatch`；`machine` → `excluded.machine` |

- `machine` **永远**不进质量组：机器检查通过不是质量通过，也不能当 reject。
- `infrastructureFailure: true` 的记录**整条**单列进 `excluded.infrastructureFailures`
  （带上原结论与费用，便于审计），既不算模型 reject，也不占样本数。
- `outcome.status = unknown` 保留在组内（它是一条真实尝试），但不计入任何「已判定」的分子分母；
  缺首次评审就是 unknown，**不拿第二次尝试顶成首次**。
- 被排除的尝试如果落在某个 case 的中间，会让该组的首次/最终口径变成 `unknown`
  （因为真实的首/末 attemptIndex 不在本组），这是刻意的：宁可少报，也不张冠李戴。
- **最终看的是整个 case，不是组内最后一条**。同一 case 的后续尝试可能换了模型或难度而落在别的组：
  组内那条更早的 `accept` 只是旧结论，不能当「最终通过」，也不算「已完成 case」。
- 被剔除的残缺记录如果带**可用的** `attemptIndex`，它同样参与首/末边界（它证明「还有第几次」）；
  该 case 有任何一条残缺记录的 `attemptIndex` 不可用，就无法确定最新一次，最终保守记 `unknown`。
  首次只在输入里**没有完整的 `attemptIndex = 0`**（或残缺记录声称自己是 0）时才记 `unknown`；
  已知完整的 0 仍照算——但该 case 的全案成本继续是未知。
- 输入里根本没有观测到 `attemptIndex = 0`（例如只导出了第 2 次），就没有真实首次：
  `firstAttempt` 记 `unknown`，**不**把最小观测值当首次。

## 4. 指标口径

每个组输出：

| 字段 | 口径 |
| --- | --- |
| `attempts` | 组内尝试条数（已去重） |
| `cases` | 组内 case 数 |
| `decidedCases` | 组内至少有一条 `accept`/`reject` 的 case 数；`undecidedCases = cases - decidedCases` |
| `outcomes` | `{accept, reject, unknown}` 逐条计数 |
| `firstAttempt.passRate` | 该 case **真实首次尝试**（`attemptIndex = 0`，且它在整份输入里被权威评审过）为 `accept` 的 case 数 ÷ 有权威 verdict 的首次 case 数；输入里没有 index 0 时该 case 记 `unknown` |
| `finalAttempt.passRate` | 该 case **真实最后一次尝试**（整个 case 在输入里可证实的最大 `attemptIndex`，含残缺记录给出的索引）的权威结论为 `accept` 的 case 数 ÷ 有权威 verdict 的末次 case 数；最新一次不在本组、不可评估或无法确定时为 `unknown` |
| `rework.rejectCount` | 组内 `reject` 条数（L2 或 L3 的 reject，`unknown`/`machine` 不算） |
| `rework.perCase` | `rejectCount / cases` |
| `cost.coverage` | 费用已知的尝试数 ÷ 尝试数 |
| `cost.knownCostUsd` | 组内已知费用之和；一条已知都没有时是 `null` |
| `completedCaseCost` | 只看**最终可评估且为 `accept`** 的 case（与 `finalAttempt` 同一条件，组内曾 `accept` 不算）：`completedCases`、`costKnownCases`、`costUnknownCases`、`coverage`、`totalCostUsd`、`perCompletedCaseUsd`（全案成本成立的条件见下） |

三条容易写错的地方：

1. **首次 ≠ 组内第一条，也 ≠ 最小观测值**。首次按定义是 `attemptIndex = 0`。如果该 case 的首次尝试是
   infra failure、machine 结论、维度不同，或者**根本没有导出**（输入里最小的索引是 2），
   那么本组的「首次」就是 `unknown`，不能把组内第二条或第 2 次当成首次。
   但「0 不存在 / 不可信」才是首次 unknown 的理由：0 完整且被权威评审过，即使后面还有残缺记录，首次照算。
2. **最终 ≠ 组内最后一条，也不是「组内曾经 accept」**。最终 = 整个 case 在输入里可证实的最大 `attemptIndex`。
   同一 case 的第 0 次用模型 A 判 `accept`、第 1 次换模型 B 判 `reject` 时，A 组那条旧 `accept`
   **不是**最终通过：A 组的 `finalAttempt` 记 `unknown`（最新一次不在本组），`completedCases` 为 `0`，
   成功成本字段全 `null`；完成判定只看同一个「最终可评估且 `accept`」条件。
   如果更晚那一次只剩一条残缺记录（例如缺 `costUsd`），它的索引证明「还有第 1 次」但结论不可评估，
   同样记最终 `unknown`、完成数 `0`、成本 `null`，**不拿旧 `accept` 顶上**；该 case 的全案成本也继续未知。
3. **单位成功成本包含该 case 此前所有尝试**（`caseCostScope: all-attempts-of-case`），
   跨组也算——返工的钱不能因为换了难度标签就丢掉。任一必要费用为 `null`，该 case 成本未知：
   计入 `costUnknownCases`，**不进**分母，也不当 0。没有任何费用已知的已完成 case 时，
   `perCompletedCaseUsd` 与 `totalCostUsd` 都是 `null`。
3. **只有输入闭合时才敢说「全案成本」**。以下三条同时成立才算已知：
   - 观测到从 `0` 到 `last` 的**连续**索引（缺 0 或中间缺号都不行，例如 0 与 2 有、1 缺）；
   - 每一条索引对应的费用都已知（`costUsd` 非 `null`）；
   - 该 case **没有**记录因为缺字段/字段非法被剔除（剔除记录进 `notComparable`）。

   否则该 case 计入 `costUnknownCases`，`coverage` 只统计真正闭合的 case，`totalCostUsd`/
   `perCompletedCaseUsd` 只用闭合 case 计算；一个都没闭合时两者为 `null`、`coverage` 为 `0`。

**指标只表示输入里的最新权威结果**：报告读到哪份输入就只反映到那份输入为止，
`finalAttempt` 是「这份输入里可证实的最大 attemptIndex」，不是「整个 Mission 已经终审完成」。
只导出第 2 次且它是 `accept` 时，可以记「输入里的最新权威结论是 accept」，但该 case 的首次仍是
`unknown`、全案成本仍是 `unknown`——**最新观察不等同整个 Mission 已完成**。
输入未闭合（缺索引、有残缺记录被剔除）时，不得据此宣布 Mission 结束或结论已成定局。

**0 分母一律 `null`**：没有样本不是「100% 成功」，也不是「0 元」。

### 样本量

建议值（不是硬性验收）：一个组至少 **10 个已判定 case** 才适合拿来做横向比较；5–9 个只能当
方向性观察；少于 5 个时，报告里的数字只能说明「这几条记录是这样」，不要写进任何结论。
保留样本量要提前定死并冻结（见第 7 节），不能看到结果后再补 case。

## 5. 去重与冲突

- `caseId + attemptId` 完全相同的重复记录**稳定折叠**（只比较已知字段，多带元数据不算冲突），
  计数进 `summary.duplicatesCollapsed`。
- 组合键按数组序列化（`JSON.stringify([caseId, attemptId])`、`JSON.stringify([caseId, attemptIndex])`），
  **不用字符串拼接**：id 里带控制字符（例如 NUL）时拼接会让不同记录碰撞成同一个键。
- 同一 `caseId + attemptId` 但已知字段内容不同 → **冲突**，整份输入拒绝（退出码 `2`，
  stderr 打 `EVALUATION_REPORT_CONFLICT` 与定位用的 `caseId/attemptId`，不写半份报告）。
- 同一 `caseId + attemptIndex` 指向两个不同 `attemptId` → 同样是冲突（同一「第几次」不能有两个身份）。
- 输入不是数组、文件读不到、JSON 坏了、参数不对 → 退出码 `2`，stderr 只有
  `EVALUATION_REPORT_INPUT_ERROR` 与固定 usage，不回显路径或记录内容。

## 6. CLI 与输出 schema

```bash
node scripts/langfuse-evaluation-report.mjs --input records.json [--report report.json]
```

- `--input`：必填，记录数组文件。
- `--report`：可选，同时把报告写到该文件；stdout 始终输出同一份 JSON。
- 退出码：`0` 成功；`2` 输入/参数/冲突错误。
- 输出键序固定、不含时间戳与随机 id：同一输入两次运行结果逐字节相同，可直接 diff 两次基线。

输出结构：

```jsonc
{
  "schemaVersion": 1,
  "summary": {
    "recordsRead": 5,
    "duplicatesCollapsed": 0,
    "partialRecords": 0,              // 缺/非法字段的记录数（= notComparableRecords）
    "comparableAttempts": 4,
    "comparableCases": 3,
    "groups": 3,
    "notComparableRecords": 0,
    "machineRecords": 1,
    "sourceRoleMismatchRecords": 0,
    "infrastructureFailureRecords": 0,
    "infrastructureFailureKnownCostUsd": 0
  },
  "groups": [
    {
      "group": { "role": "...", "taskType": "...", "difficulty": "...", "model": "...",
                 "promptVersion": "...", "codeRevision": "...", "rubricVersion": "...", "source": "..." },
      "attempts": 0, "cases": 0, "decidedCases": 0, "undecidedCases": 0,
      "outcomes": { "accept": 0, "reject": 0, "unknown": 0 },
      "firstAttempt":  { "evaluatedCases": 0, "acceptedCases": 0, "unknownCases": 0, "passRate": null },
      "finalAttempt":  { "evaluatedCases": 0, "acceptedCases": 0, "unknownCases": 0, "passRate": null },
      "rework":        { "rejectCount": 0, "cases": 0, "perCase": null },
      "cost":          { "knownAttempts": 0, "unknownAttempts": 0, "coverage": null, "knownCostUsd": null },
      "completedCaseCost": {
        "caseCostScope": "all-attempts-of-case",
        "completedCases": 0, "costKnownCases": 0, "costUnknownCases": 0,
        "coverage": null, "totalCostUsd": null, "perCompletedCaseUsd": null
      }
    }
  ],
  "notComparable": [ { "reason": "incomplete_record", "missing": [], "invalid": [], "count": 0,
                       "examples": [ { "caseId": "...", "attemptId": "...", "attemptIndex": 0 } ] } ],
  "excluded": {
    "machine":               { "count": 0, "records": [] },
    "sourceRoleMismatch":    { "count": 0, "records": [] },
    "infrastructureFailures": { "count": 0, "records": [] }
  }
}
```

导出函数：`buildEvaluationReport(records)`（纯函数）与常量
`EVALUATION_REPORT_SCHEMA_VERSION` / `INPUT_ERROR` / `CONFLICT_ERROR`，供测试与后续脚本复用。

## 7. 固定的评测任务设计

目的是给「同条件比较」提供一批**冻结**的 case。四个任务族，每个族都冻结输入、验收规则、
代码版本与提示词版本；一次基线运行只换被测的 `model`（以及需要对比时的 `promptVersion`）。

### 7.1 executor：边界修复（`taskType: boundary-fix`）

- **冻结输入**：一个小仓库快照（代码版本 `codeRevision` 固定到提交）+ 一条工单，
  工单要求修一个边界行为（例如空输入/越界下标/时区边界）。
- **冻结验收**：L2 按 rubric（`rubricVersion`）逐条判定，必须带证据；`machine` 的测试绿只作参考。
- **失败典型**：改对主路径但边界仍抛错；补了测试但没改实现；改了不该改的文件。
- **难度**：easy = 单文件单函数；hard = 跨 2–3 个文件且要求不破坏既有不变量。

### 7.2 executor：约束遵守（`taskType: constraint-following`）

- **冻结输入**：一份带明确禁令的工单（例如「不许改 `src/api/`」「不许新增依赖」
  「只允许改这一个文件」）+ 仓库快照。
- **冻结验收**：L2 检查是否越界改动、是否引入依赖、是否改了冻结文件；违反任一条即 reject。
- **失败典型**：为了通过测试顺手改了禁止目录；新增依赖；改了工单未提及的公共接口。

### 7.3 coordinator：拆单（`taskType: ticket-split`）

- **冻结输入**：一份需求 + 架构边界文档（目录级边界固定）+ 冻结的代码版本。
- **冻结验收**：L3 判定拆出的票是否一票一个 Mission、范围到目录级、票与票的依赖顺序正确、
  每票验收可验证；漏依赖或越界合并即 reject。
- **失败典型**：一票跨多个目录；票的验收不可执行；顺序颠倒导致后面的票拿不到前面的产物。

### 7.4 coordinator：错误验收识别（`taskType: false-accept-detection`）

- **冻结输入**：一份**故意有问题**的执行者交卷（synthetic：测试绿但漏了验收项、证据与结论不符）
  + rubric。
- **冻结验收**：L3 必须识别出该交卷不满足验收并给 reject；放行即算失败。
- **失败典型**：被「测试全绿」说服而忽略缺证据；只核结论不核证据来源。

### 7.5 冻结与保留样本

- 每个任务族的输入、rubric、代码版本、提示词版本在开跑前写进这批记录的元数据并冻结；
  中途改任何一项，就必须换 `rubricVersion`/`promptVersion`/`codeRevision`，等于新的一组。
- **同条件比较**：只比同一 `role × taskType × difficulty × promptVersion × codeRevision × rubricVersion`
  下不同 `model` 的组；跨难度/跨 rubric 的数字不放在一起排名。
- **保留样本量**：每个族至少准备 10 个 case（建议 12–20，覆盖 easy/hard 两档），
  一次基线运行把这批 case 全跑完；不足的组按第 4 节的样本量建议标注，不做结论。
- **输入来源清单**：每次运行的记录数组要能追回「这条 case 对应哪个冻结任务」——固定任务的
  输入快照、工单、rubric 与代码版本的引用写进随记录的来源清单里；同一个固定任务换模型重跑时，
  用新的执行 `caseId`，靠来源清单把它和之前的执行对上，不靠 `caseId` 复用。
- 每次运行前把记录数组与报告一起存档（`--report`），下一次运行 diff 报告即可看出变化。

## 8. 示例（synthetic，不代表任何真实模型）

下面这份输入是**编造**的，只用来说明输出形状与口径，不能据此说任何模型更强。

```json
[
 {"caseId":"EX-BF-01","attemptId":"EX-BF-01.a0","attemptIndex":0,"role":"executor","taskType":"boundary-fix","difficulty":"easy","model":"model-a","promptVersion":"prompt-v1","codeRevision":"rev-1","rubricVersion":"rubric-v1","outcome":{"status":"reject","source":"l2"},"infrastructureFailure":false,"costUsd":0.4},
 {"caseId":"EX-BF-01","attemptId":"EX-BF-01.a1","attemptIndex":1,"role":"executor","taskType":"boundary-fix","difficulty":"easy","model":"model-a","promptVersion":"prompt-v1","codeRevision":"rev-1","rubricVersion":"rubric-v1","outcome":{"status":"accept","source":"l2"},"infrastructureFailure":false,"costUsd":0.35},
 {"caseId":"EX-CF-02","attemptId":"EX-CF-02.a0","attemptIndex":0,"role":"executor","taskType":"constraint-following","difficulty":"easy","model":"model-a","promptVersion":"prompt-v1","codeRevision":"rev-1","rubricVersion":"rubric-v1","outcome":{"status":"accept","source":"machine"},"infrastructureFailure":false,"costUsd":0.2},
 {"caseId":"EX-CF-02","attemptId":"EX-CF-02.a1","attemptIndex":1,"role":"executor","taskType":"constraint-following","difficulty":"easy","model":"model-a","promptVersion":"prompt-v1","codeRevision":"rev-1","rubricVersion":"rubric-v1","outcome":{"status":"unknown","source":"l2"},"infrastructureFailure":false,"costUsd":0.22},
 {"caseId":"CO-SP-01","attemptId":"CO-SP-01.a0","attemptIndex":0,"role":"coordinator","taskType":"ticket-split","difficulty":"easy","model":"model-a","promptVersion":"prompt-v1","codeRevision":"rev-1","rubricVersion":"rubric-v1","outcome":{"status":"accept","source":"l3"},"infrastructureFailure":false,"costUsd":1.1}
]
```

结果（节选）：

| 组 | attempts | cases | 首次 | 最终 | 返工/case | 费用覆盖 | 已完成 case 单位成本 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| executor / boundary-fix / easy / L2 | 2 | 1 | 0/1 = 0 | 1/1 = 1 | 1 | 2/2 = 1 | 0.75 |
| executor / constraint-following / easy / L2 | 1 | 1 | null（唯一尝试是 unknown） | null（同上） | 0 | 1/1 = 1 | null（0 个已完成 case） |
| coordinator / ticket-split / easy / L3 | 1 | 1 | 1/1 = 1 | 1/1 = 1 | 0 | 1/1 = 1 | 1.1 |

`summary`：`recordsRead 5`、`comparableAttempts 4`、`comparableCases 3`、`groups 3`、
`machineRecords 1`（`EX-CF-02.a0` 被排除，所以该 case 的首次只能是 unknown）。

## 9. 复跑

```bash
# 只看这一个脚本的两条综合验收（不跑全量、不装依赖、不连模型）
node --test test/langfuse-evaluation-report.test.ts

# 生成/对比基线
node scripts/langfuse-evaluation-report.mjs --input baseline-20261018.json --report report-20261018.json
diff report-20261018.json report-20261019.json
```

两条测试覆盖：分组与 L2/L3 权威矩阵、machine 与 infra 单列、unknown 不折算、首次/最终/返工/
费用覆盖/单位成功成本口径、闭合口径（只有 index 2 时首次 `unknown` 但最终可记「输入里的最新权威
结论」、全案成本仍未知；0 与 2 缺 1 或同案有残缺记录被剔除时全案成本未知、`coverage` 为 `0`；
索引完整则原样计算）、跨组最终口径（同一 case 换模型后最后一次 `reject` 时，旧 `accept` 所在组
`completedCases = 0`、成功成本字段 `null`；完整 0 `accept` + 更晚残缺记录时最终 `unknown`、完成数 `0`、
成本 `null`）、稳定去重、内容冲突与 attemptIndex 冲突拒绝、缺维度进 `notComparable`。

## 10. 不做的事

- 不做 LLM 裁判，不用模型给模型打分。
- 不按 token 数、字数、调用次数推断质量。
- 不自动推荐模型、不自动改路由、不改任何平台状态。
- 不从缺失字段猜 role / difficulty / taskType / 结论 / 费用。
- 不把 `machine` 结论当质量通过，不把 infra failure 当模型能力 reject。
- 不在样本不足或 0 分母时给出「100%」「0 元」这类看起来确定的数字。
