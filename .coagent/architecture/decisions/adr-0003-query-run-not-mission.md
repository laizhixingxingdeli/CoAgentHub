# QueryRun 不是 Mission

## 取舍

只读问答走独立 **QueryRun** 用例与仓储，**不**创建 Mission、不进入 Mission 状态机、不占 Project mutation slot。

不采用：把问答做成 `runKind=query` 的 Mission，或让 Query 路径复用 Coordinator/Executor Attempt。

## 为什么

1. **状态权威保持单一且可审计。** Mission 表示有边界的变更与审查链；只读问答塞进同一状态机会迫使大量「空落地」分支，并污染 waiting/completed 语义。
2. **只读必须工具层强制。** Mission 执行面绑定写工具与 run token；Query 需要闭集 allowlist 与 `supportsQuery` fail-closed。混在同一 attempt 模型里，拒绝写工具的时机容易晚于 runtime.start。
3. **晋升显式、可追溯。** 需要改代码时走 `QueryPromotionService`（needs_mutation → lightweight Mission + 显式 WorkOrder），用 `origin.queryRunId` 连接，而不是在 query 返回时偷偷 createMission。

## 后果

- Work Truth 上 QueryRun 与 Mission 分仓储（内存 / file / PG 实现可并行）。
- Classified 路由到 query 时 **拒绝建 Mission**（`QUERY_ROUTE_REQUIRED`），引导 Query 路径。
- 观测面/API 若暴露 query，不得假冒 Mission 生命周期事件。

## 什么时候该推翻它

- 产品强制要求只读问答与变更共享同一条 L3 审查与合并收据；
- 合规要求每一次模型调用都必须挂在 Mission/Attempt 树上。

出现任一条，另开 ADR。在那之前，「先 createMission 再标 query 比较省事」不是理由。
