# 权威执行预算门禁（BUDGET-001）

Mission 可挂 `executionBudget`。用法快照与求值在 application 纯函数层；**调度强制**在 Orchestrator PRE/POST gate，经 Platform 记事件 / 升级 / 等待。

## 维度与硬软语义

| 类 | 维度 | 超限效果 |
| --- | --- | --- |
| **hard** | `attempts` `rounds` `wallClockMs` `changedFiles` `commands` | 可停 Standard 调度，或触发 LW 内部 budget 升级 |
| **soft** | `inputTokens` `outputTokens` `totalTokens` `cost` | 仅 70/90/100 事件，**永不** stall / promote |

- 比较：`used >= limit`（含 `0 >= 0`）。
- 无 `executionBudget` → 门禁 no-op（既有启发式不变）。
- `not_in_force` / `unknown` **永不** gate、不贡献 exceeded。
- 不发明默认 limit；不按 tool 名分类 command；`changedFiles` 仅当 caller 提供 trusted 列表才 known。

## 阈值事件

- `budgetThresholdCrossings`：已知 used + in-force limit 时发 70/90/100；`limit===0` 只叙事 100%。
- Platform `recordBudgetThresholdEvents` 经 durable `mission.budget.threshold` 去重（每维每档一次）。

## Orchestrator 门禁

`#enforceAuthoritativeBudget`（PRE：HA 之后、`round.started` 前；POST：hops 后）：

1. soft / 未 hard exceeded → 继续。
2. hard exceeded + `executionMode=lightweight` → `promoteLightweightForBudgetExceeded`（Platform **自检** hard exceed 后 commit）；成功则清 wait 并以 Standard **continue**。
3. Standard hard exceeded，或 LW promote 失败 → `waiting` + `WaitReason=execution_budget_exceeded`。

## 升级发放权

- 公开 `promoteMissionToStandard({ code: 'budget_exceeded' })` → **`BUDGET_PROMOTION_NOT_READY`**（拒绝 caller 手填）。
- 仅 `promoteLightweightForBudgetExceeded`：再求值，无 hard exceed → `BUDGET_NOT_AUTHORITATIVELY_EXCEEDED`；已 standard 且同 trigger 幂等。

## 权威源 / 测试

- 源：`budget-usage.ts`、`platform.ts`（`evaluateMissionBudget` / threshold / promoteLightweightForBudget…）、`orchestrator.ts`（`#enforceAuthoritativeBudget`）
- 测试：`budget-gates.test.ts`、`budget-usage.test.ts`、`budget-round-facts.test.ts`、`budget-command-facts.test.ts`、`wait-reason-coverage.test.ts`
- 取舍：ADR-0005
