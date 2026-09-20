# Decision Engine 是横向信号能力，不是第四层

## 取舍

Decision Engine（未来的 `DecisionProvider` port 及其实现）是
**与 AgentRuntime 并列的 Application 侧横向信号能力**，
不是 Mission / Orchestrator / Runtime 之上的第四层，
也不是替代 kernel 状态机或 Harness 执行权的“决策中枢”。

不采用：把 Decision 做成内核第四层、把 Jev（或任一供应商）类型泄漏进
kernel / RuntimePort、或让信号直接改写 PASS / RETRY / FAIL / 审查级别。

**本 ADR 固定长期边界与 source map。** 当前 checkout 中搜索不到
`DecisionProvider`、`PRE_DISPATCH`、`adr-0002` 及相关实现——
因此本文是**未来边界约定**，不声称代码已经落地。

## Source map（权威归属）

| 能力 | 权威位置 | 说明 |
|------|----------|------|
| Mission / WorkItem / Attempt 状态 | **kernel** | 状态权威仍在 kernel；Decision 不得成为状态源 |
| 权限、dispatch、review、L3 | **Application / Platform（Harness）** | 硬规则、真正派发、执行后审查与平台策略 |
| 路由 / 重试 / 唤醒 | **Orchestrator** | 编排节奏与触发，不把 Decision 当成编排器 |
| 模型调用与运行时会话 | **AgentRuntime** | 保持独立；与 Decision **正交**，互不隶属 |
| 选择 / 打分 / 无操作等信号 | **DecisionProvider（未来 Application port）** | 只产信号；与 AgentRuntime 并列 |
| 供应商适配（含未来 Jev） | **Application 适配层** | 可替换 provider；不泄漏到 kernel / RuntimePort |

## Runtime 与 Decision 正交

- **AgentRuntime**：执行对话、工具与模型 I/O。
- **DecisionProvider**：在约定钩子上提供 *Choice / Score / No-op* 类信号。
- 二者同属 Application 边界上的 port 级能力，**不互相包装、不共享供应商类型**。
- kernel 与 `RuntimePort` **不得**出现 Jev 或具体 Decision 供应商的 API/SDK 类型。

## 信号钩子（未来语义，非已实现 API）

### PRE_DISPATCH

在硬规则、权限与状态校验**已经通过**之后、**真正 dispatch 之前**，
由 Harness / Application 查询 Decision 信号（若已配置 provider）。

- 信号可影响“选哪条路径 / 优先级加权 / 明确 no-op”等**建议**。
- **不得**绕过已失败的硬规则；硬规则未通过则根本不进入此钩子。
- 最终是否 dispatch、dispatch 到何处，仍由 Harness / Orchestrator 路径执行。

### POST_EXECUTION

在执行结果返回、且**确定性验证与状态规则先完成**之后，
在 execution review 的决策边界使用 Decision 信号。

- 信号可提供评分、选项或 no-op，供审查策略参考。
- **最终** PASS / RETRY / FAIL、以及审查级别等**动作**仍由 Harness 执行。
- Decision **不得自动降低审查**；不得单方面改写 kernel 状态。

## Decision 只产信号，Harness 执行动作

Decision 的返回形态限于信号，例如：

- **Choice**（有限枚举建议）
- **Score**（量化参考）
- **No-op**（明确不干预）

不在此列、且明确禁止的包括：直接提交状态迁移、直接降审查、
直接触发工具或改写 Attempt 权威状态。信号是输入；**动作在 Harness**。

## Jev 只是未来可替换 provider

- Jev（若采用）是 DecisionProvider 的**一种**适配实现，不是架构层名称。
- 可替换：换供应商或本地规则实现时，只动 Application 适配层与组合根。
- **Jev 无工具、无任务状态机**；它不拥有 Mission/WorkItem/Attempt，
  也不替代 Orchestrator / Runtime。
- 真实 Jev API（endpoint / auth / schema / model / 错误语义等）
  **仍标注待研究**——本 ADR 不猜测、不冻结具体协议。

## 为什么

1. **状态权威必须单一。** 若 Decision 能写状态或降审查，kernel 与
   review 链路会出现双源，现场排障与审计都会失真。
2. **横向信号优于第四层。** 需要的是在 PRE/POST 边界上可插拔的建议，
   不是再叠一层“总控”。第四层会与 Orchestrator、Harness 抢职责。
3. **Runtime 正交才能替换模型与替换决策。** 绑在一起会迫使每次换模型
   或换决策供应商都穿透 kernel。
4. **供应商隔离是长期成本控制。** Jev 只是 provider；协议未研究清楚前
   只锁边界，不锁 SDK 形状，避免错误抽象沉淀进 port。

## 什么时候该推翻它

- 产品强制要求 Decision 成为唯一编排权威（取代 Orchestrator 主路径）；
- 合规要求审查动作必须由外部决策服务同步签发（Harness 不再执行动作）；
- 经多版本实践证明 PRE/POST 两钩子不够，必须把信号嵌入 kernel 状态转移本身。

出现任一条，另开 ADR 推翻本条。在那之前，
“先把 Jev 接到 Runtime 里更快”或“让模型直接 PASS”不是理由。

## 明确不在本 ADR 范围

- 不实现 `DecisionProvider`、Jev adapter、PRE/POST 代码。
- 不规定 Jev endpoint、认证、schema、模型名或报文。
- 不修改 Mission/WorkItem/Attempt 的现有状态机语义（仅声明其权威仍在 kernel）。
