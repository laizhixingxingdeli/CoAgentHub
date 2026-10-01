# 执行预算：权威求值与 hard/soft 语义

## 取舍

Mission 可选 `ExecutionBudget` 由 application **纯函数权威求值**；Orchestrator 按 **hard / soft** 分叉：hard 可停调度或内部晋升，soft 只发阈值事件。usage 只来自可信 attempt 事实与 durable ActivityLog 投影。

不采用：按工具名启发式算 command；用 Mission 创建时长冒充 wall-clock；caller 手填 `budget_exceeded` 晋升；`unknown` 维当作已超限。

## Hard vs Soft

- **Hard**（attempts / rounds / wallClockMs / changedFiles / commands）：权威 exceeded 时——Lightweight 可由 Platform **再求值**后内部 `budget_exceeded` 晋升；Standard（或晋升失败）→ `waiting` + `execution_budget_exceeded`。
- **Soft**（input/output/total tokens / cost）：70/90/100 事件 only，永不 stall、永不 promote。
- **unknown / not_in_force**：不门禁、不晋升。无 budget 配置 = 行为与接预算前一致。

## 权威与发放

- 阈值事件 durable、按 dimension×threshold 去重一次。
- 公开 `promoteMissionToStandard` **拒绝** `budget_exceeded`；仅 `promoteLightweightForBudgetExceeded` 在硬超限自检后发放。防止调度器外「写一个码就升级」。

## 修订（2026-09-30）：按票累计的费用硬停

用户定（ADR-0007；取代 2026-09-23「软预算只预警、永不停」的决定）。Mission 级 `ExecutionBudget` 的 hard / soft 语义不变，这是**票级**的新门禁：

- **按票累计**：分类加上这张票所有的 Mission（含隔离重跑）一起算；只算运行时上报的真实花费，订阅模型记 0，不拿估算补。
- **到 $10 硬停**：挂起这张票、释放改动名额；检视者先诊断（做不出来在空转 / 平台或模型问题 / 票大但在推进），再带着判断问用户。用户同意继续，默认再给 $10，或按用户给的数。
- **两条跟钱无关的线，交检视者、不问用户**：同一条验收标准连续 3 个工作项没通过（打回、作废、卡住都算）；一张票开到第 15 个工作项。
- 超限同样只能由平台自己求值判定，caller 不得手填。

实现见统一计划 AC1、AC3；实现之前由值守检视者人工执行。

## 为什么

1. **门禁可复核。** 纯求值 + 显式投影，排障能对照事件与 limit，而不是猜 prompt 或工具表。
2. **软超限不杀任务。** 代币/费用波动常见，适合预警；硬结构（次数/时钟/文件/命令）才值得停或升路径。票级费用硬停是例外：它停的不是一跳，而是「要不要继续为这张票花钱」这个该由用户定的问题。
3. **晋升权力不外溢。** budget 晋升与检测器晋升同走 Platform commit，但 budget 码必须自检，避免伪造耗尽。

## 什么时候该推翻它

- 产品要求 soft 维也可硬停或自动升 Standard（票级费用硬停已按此修订）；
- 预算权威改由外部计量服务同步签发且 Hub 不再本地求值。

另开 ADR。在那之前，「先按工具名凑 commandCount」不是理由。
