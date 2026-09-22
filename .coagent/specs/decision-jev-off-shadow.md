# Decision / Jev：OFF 与 SHADOW

Decision 是 Application 侧横向信号，不是第四层。当前只有 `off` / `shadow`；SHADOW 只记录建议，永远不改变实际 dispatch。

## 模式

| 模式 | 行为 |
| --- | --- |
| **off**（缺省 / 空 / 未知值） | 不构造 provider；不读 decision 相关 env（key/timeout/body/model）；dispatch 路径不跑 shadow；无 decision 事件 |
| **shadow** | 启动前必须能注入/构造 provider，否则 fail-closed；dispatch 前可写 `decision.shadow` 审计事件；**effectiveAction 恒等于 baselineAction（原 dispatch 名单）** |

- 解析：`parseDecisionMode(COAGENT_DECISION_MODE)`（`decision-mode.ts`）。未知值 → `off`（不抛）。
- 启动：`assertDecisionModeStartup` — `shadow` 且无 provider → 抛错；须在 store/lock/listen **之前**（`main.ts` `startServer`）。

## Provider 工厂

- `createDecisionProvider`（`decision-provider-factory.ts`）：`mode !== shadow` → 立即 `undefined`，**零** decision env 触碰。
- SHADOW：要求 `TYPESAFE_API_KEY`；可选 timeout/body/model env；`JevSystemOneHttpTransport` + `JevDecisionProvider`。Jev 无工具、无任务状态机。

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
