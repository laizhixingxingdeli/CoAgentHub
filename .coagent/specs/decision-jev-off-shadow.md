# Decision / Jev：OFF 与 SHADOW

Decision 是 Application 侧横向信号，不是第四层。当前只有 `off` / `shadow`；SHADOW 只记录建议，永远不改变实际 dispatch。

## 模式

| 模式 | 行为 |
| --- | --- |
| **off**（缺省 / 空 / 未知值） | 不构造 provider；不读 decision 相关 env（key/timeout/body/model）；dispatch 路径不跑 shadow；无 decision 事件 |
| **shadow** | 启动前必须能注入/构造 provider，否则 fail-closed；dispatch 前可写 `decision.shadow`、交卷后可写 `decision.post_execution` 审计事件；**effectiveAction 恒等于 baselineAction（原 dispatch 名单）** |

- 解析：`parseDecisionMode(COAGENT_DECISION_MODE)`（`decision-mode.ts`）。未知值 → `off`（不抛）。
- 启动：`assertDecisionModeStartup` — `shadow` 且无 provider → 抛错；须在 store/lock/listen **之前**。
- 装配：`buildDecisionDeps(env, fetch)`（`main.ts`）一处按 env 组装 `{decisionProvider, decisionHooks, postExecutionEvaluator}`，off 时是空对象、除 `COAGENT_DECISION_MODE` 外不读任何 env。`startServer`、`run-mission`、`run-plan` 三个入口共用它，原样展开进构建器（J2 之前只有 `startServer` 接了 provider——CLI 跑的任务永远不会触发 shadow）。两个 CLI 在读任何输入之前就调用：shadow 缺 key 直接退出，不留半截 Mission / 状态 / 锁。

## 钩子（2026-09-23）

- `COAGENT_DECISION_HOOKS`：逗号分隔，`parseDecisionHooks` 解析；**只在 shadow 模式下读**（off 仍零 decision env 触碰）。认 `pre_dispatch` / `pre-dispatch` / `pre`、`post_execution` / `post-execution` / `post`；`none` 或全是不认识的词 = 一个都不跑（写错时宁可少调）。
- **缺省只有 POST_EXECUTION，PRE_DISPATCH 默认关**，要显式写上。依据 E3 实测：远端默认拒绝（只发 ID）下 PRE 的答案是常数（风险 18/18 答 MEDIUM），三道题都比「全猜多数类」还差——每次派发付几百毫秒换一个常数。
- 平台依赖 `decisionHooks`（缺省同上）；Standard 与 Lightweight 两个派发点都要 provider **且** 钩子含 PRE_DISPATCH 才调用。
- POST_EXECUTION 的生产接线见下「POST_EXECUTION shadow」（J2）。

## Provider 工厂

- `createDecisionProvider`（`decision-provider-factory.ts`）：`mode !== shadow` → 立即 `undefined`，**零** decision env 触碰。
- SHADOW：要求 `TYPESAFE_API_KEY`；可选 timeout/body/model env；`JevSystemOneHttpTransport` + `JevDecisionProvider`。Jev 无工具、无任务状态机。
- `createPostExecutionEvaluator`（J2）：同一套 env、同一种传输（同一端点、同一把 key、同一个超时与模型），返回 `JevPostExecutionEvaluator`；off 同样立即 `undefined`、零 env 触碰。
- 默认超时 **1500ms**（`COAGENT_DECISION_TIMEOUT_MS` 覆盖，上限 60s）。依据 E3：热连接约 300ms，进程里第一次调用 733–1342ms、闲置 20 秒后 729ms；生产里一条 Mission 一个进程、派发间隔几分钟，调用几乎都是冷的，原来的 800ms 会误杀大部分调用。代价：shadow 在派发路径上最坏多等这么久。

## Shadow 运行时

- `runDecisionShadow`（`decision-shadow-runner.ts`）：build state → provider.decide → ActivityLog `kind=decision.shadow`。
- provider / append 失败**吞没**，不向调用方抛，**不阻断**后续 `item.dispatch`。
- Platform 在 Standard `dispatchWorkItems` 与 Lightweight `dispatchLightweightWorkItem` 中：mutation slot 已获、硬规则已过之后、真实 dispatch 之前调用；无 provider 则跳过。
- Lightweight shadow **不**伪造 Coordinator `attemptId`。

## POST_EXECUTION shadow（J2，Jev 设计 §9）

端口 `PostExecutionEvaluator`（`ports.ts`）与 PRE 的 `DecisionProvider` 分开：PRE 只放 ID 与 facts（远端默认拒绝），POST 放按预算投影过的执行摘要，两套放行规则不共用一个口子。Jev 实现 `jev-post-execution-evaluator.ts` 只拼 `jev-post-execution-mapper` 的纯函数（E4 已对真 API 验过兼容）。

**什么时候问**（`orchestrator.ts`，都只在注入了评估器且钩子含 POST_EXECUTION 时）：

| 路径 | 时机 |
| --- | --- |
| Standard | 执行者这一跳成功返回之后、GATE-POST 与协调者评审之前 |
| Lightweight | 机器验收 `passed` 之后（含因规模被扣下、随后升级 Standard 的）；**硬失败不问**——设计 §9.1：Jev 不推翻确定性结果，问了也不该用 |

`Platform.runPostExecutionShadow` 自己再挡一遍：工作项不在 submitted / accepted、没有提交记录就返回；**同一次提交只问一次**（活动日志里已有同一 `submittedAttemptId` 的事件就跳过——崩溃后接着跑会把同一次提交再验一遍，不再多付一次）。升级后协调者复核的是同一次提交，也不会再问。

**输入只取平台可信数据**（`post-execution-shadow.ts` `postExecutionInputFrom`）：

- 工单：objective、constraints + doNot（前缀「不要：」）、acceptance；
- 当前那次提交的执行结果；那个 attempt 的全部证据（自报引用到的才进 `claimedEvidence.summaries`）；
- 改动清单**优先平台 diff**（有隔离工作区、且 Mission 记了 projectRoot 与分叉基线时，与机器验收同一个来源）；原地模式或 diff 出错才退回执行者自报。事件 `filesSource` 标 `workspace_diff` / `executor_claim`，离线评测要知道这一格能不能信；
- 工具次数：attempt 的工具记录最多留尾部 200 条，记满即不知道真实次数——**标为拿不到**，不报 200。

**往外发**：整份输入先脱敏（`redactSecretsDeep`）再按 `DEFAULT_POST_EXECUTION_REMOTE_BUDGET` 投影（总量 16 KB；E4 实测一次 4–5 KB）——先脱敏再截尾。经 `/api/agent` 进来的内容进门已脱敏，但 Lightweight 的工单直接来自 mission 文件，不走那个口子。

**事件** `decision.post_execution`（`schemaVersion: 1`）：`hook`、`providerKind`、`mode: shadow`、`questionSetId`、`ids {projectId, missionId, workItemId, submittedAttemptId}`、`filesSource`、`quality`（`success` / `provider_error` / `state_error`）、`latencyMs`、`truncation {applied, omittedFields, originalBytes, emittedBytes}`，成功时加 `answers`、`resolvedModel`、`usage`，出错时加 `error`（脱敏、截到 200 字）。对账：按 `(missionId, workItemId)` 取该事件之后的第一条 `review.recorded`（协调者 L2 或 validator），L3 结论按 missionId 取 `final_review.*`。

评估器出错、超时（与 PRE 共用 `COAGENT_DECISION_TIMEOUT_MS`）、输入建不出状态或塞不进预算、审计写失败——**只记（或什么都不记）、从不抛**，主流程照走。代价：shadow 调用在编排路径上 await，每次交卷最坏多等一个超时。

## 非权威（硬不变量）

- Shadow **不得**改写 PASS/RETRY/FAIL、审查级别、WorkItem/Mission 状态。
- `baselineAction` / `effectiveAction` 均为既定 workItemIds 的 dispatch 副本；本期不做信号驱动的路径改写。
- Phase2 退出评估（`phase2-shadow-exit-evaluator.ts`）只**离线**消费 `decision.shadow` 流，不接生产 dispatch。

## Source / tests

- 源：`decision-mode.ts`、`decision-provider-factory.ts`、`decision-shadow-runner.ts`、`jev-decision-provider.ts`、`jev-post-execution-evaluator.ts`、`post-execution-shadow.ts`、`platform.ts`（dispatch 钩子、`runPostExecutionShadow`）、`orchestrator.ts`、`main.ts`（`buildDecisionDeps`）、`run-mission.ts`、`run-plan.ts`
- 测：`decision-mode.test.ts`、`decision-provider-factory.test.ts`、`decision-shadow-runner.test.ts`、`platform-dispatch-shadow.test.ts`、`jev-decision-provider.test.ts`、`phase2-shadow-exit-evaluator.test.ts`、`start-server.test.ts`、`post-execution-shadow.test.ts`
