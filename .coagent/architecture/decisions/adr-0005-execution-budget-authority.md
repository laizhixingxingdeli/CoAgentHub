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

## 为什么

1. **门禁可复核。** 纯求值 + 显式投影，排障能对照事件与 limit，而不是猜 prompt 或工具表。
2. **软超限不杀任务。** 代币/费用波动常见，适合预警；硬结构（次数/时钟/文件/命令）才值得停或升路径。
3. **晋升权力不外溢。** budget 晋升与检测器晋升同走 Platform commit，但 budget 码必须自检，避免伪造耗尽。

## 什么时候该推翻它

- 产品要求 soft 维也可硬停或自动升 Standard；
- 预算权威改由外部计量服务同步签发且 Hub 不再本地求值。

另开 ADR。在那之前，「先按工具名凑 commandCount」不是理由。
