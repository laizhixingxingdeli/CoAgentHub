# Decision / Jev：OFF 与 SHADOW

Decision 是 Application 侧横向信号，不是第四层。当前只有 `off` / `shadow`；SHADOW 只记录建议，永远不改变实际 dispatch。

## 模式

| 模式 | 行为 |
| --- | --- |
| **off**（缺省 / 空 / 未知值） | 不构造 provider；不读 decision 相关 env（key/timeout/body/model）；dispatch 路径不跑 shadow；无 decision 事件 |
| **shadow** | 启动前必须能注入/构造 provider，否则 fail-closed；dispatch 前可写 `decision.shadow` 审计事件；**effectiveAction 恒等于 baselineAction（原 dispatch 名单）** |

- 解析：`parseDecisionMode(COAGENT_DECISION_MODE)`（`decision-mode.ts`）。未知值 → `off`（不抛）。
- 启动：`assertDecisionModeStartup` — `shadow` 且无 provider → 抛错；须在 store/lock/listen **之前**（`main.ts` `startServer`）。

## 钩子（2026-09-23）

- `COAGENT_DECISION_HOOKS`：逗号分隔，`parseDecisionHooks` 解析；**只在 shadow 模式下读**（off 仍零 decision env 触碰）。认 `pre_dispatch` / `pre-dispatch` / `pre`、`post_execution` / `post-execution` / `post`；`none` 或全是不认识的词 = 一个都不跑（写错时宁可少调）。
- **缺省只有 POST_EXECUTION，PRE_DISPATCH 默认关**，要显式写上。依据 E3 实测：远端默认拒绝（只发 ID）下 PRE 的答案是常数（风险 18/18 答 MEDIUM），三道题都比「全猜多数类」还差——每次派发付几百毫秒换一个常数。
- 平台依赖 `decisionHooks`（缺省同上）；Standard 与 Lightweight 两个派发点都要 provider **且** 钩子含 PRE_DISPATCH 才调用。
- POST_EXECUTION 的生产接线在 J2；在那之前，shadow 模式按缺省配置**实际什么都不调**。

## Provider 工厂

- `createDecisionProvider`（`decision-provider-factory.ts`）：`mode !== shadow` → 立即 `undefined`，**零** decision env 触碰。
- SHADOW：要求 `TYPESAFE_API_KEY`；可选 timeout/body/model env；`JevSystemOneHttpTransport` + `JevDecisionProvider`。Jev 无工具、无任务状态机。
- 默认超时 **1500ms**（`COAGENT_DECISION_TIMEOUT_MS` 覆盖，上限 60s）。依据 E3：热连接约 300ms，进程里第一次调用 733–1342ms、闲置 20 秒后 729ms；生产里一条 Mission 一个进程、派发间隔几分钟，调用几乎都是冷的，原来的 800ms 会误杀大部分调用。代价：shadow 在派发路径上最坏多等这么久。

## Shadow 运行时

- `runDecisionShadow`（`decision-shadow-runner.ts`）：build state → provider.decide → ActivityLog `kind=decision.shadow`。
- provider / append 失败**吞没**，不向调用方抛，**不阻断**后续 `item.dispatch`。
- Platform 在 Standard `dispatchWorkItems` 与 Lightweight `dispatchLightweightWorkItem` 中：mutation slot 已获、硬规则已过之后、真实 dispatch 之前调用；无 provider 则跳过。
- Lightweight shadow **不**伪造 Coordinator `attemptId`。

## 非权威（硬不变量）

- Shadow **不得**改写 PASS/RETRY/FAIL、审查级别、WorkItem/Mission 状态。
- `baselineAction` / `effectiveAction` 均为既定 workItemIds 的 dispatch 副本；本期不做信号驱动的路径改写。
- Phase2 退出评估（`phase2-shadow-exit-evaluator.ts`）只**离线**消费 `decision.shadow` 流，不接生产 dispatch。

## Source / tests

- 源：`decision-mode.ts`、`decision-provider-factory.ts`、`decision-shadow-runner.ts`、`jev-decision-provider.ts`、`platform.ts`（dispatch 钩子）、`main.ts`
- 测：`decision-mode.test.ts`、`decision-provider-factory.test.ts`、`decision-shadow-runner.test.ts`、`platform-dispatch-shadow.test.ts`、`jev-decision-provider.test.ts`、`phase2-shadow-exit-evaluator.test.ts`、`start-server.test.ts`
