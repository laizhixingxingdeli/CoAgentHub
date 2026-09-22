# RESULT — BUDGET-001-S5

## Summary

Implemented authoritative budget gates (S5a+S5b) on the Orchestrator loop, consuming S1–S4 evaluators. Hard dimensions stop Standard or promote Lightweight; soft dimensions emit durable 70/90/100 only. Public caller-authored `budget_exceeded` promotion remains rejected; Platform-internal `promoteLightweightForBudgetExceeded` self-evaluates hard exceedance then commits.

## Files touched

| File | Change |
|---|---|
| `src/kernel/payloads.ts` | `WaitReason` += `execution_budget_exceeded` |
| `src/application/budget-usage.ts` | Hard/soft sets, `budgetThresholdCrossings`, `anyHardAuthoritativeExceeded`, detail formatter |
| `src/application/platform.ts` | `evaluateMissionBudget`, `recordBudgetThresholdEvents`, `promoteLightweightForBudgetExceeded`, `#commitPromotionToStandard`; public `budget_exceeded` still rejected |
| `src/application/orchestrator.ts` | GATE-PRE (after HA, before `round.started`) + GATE-POST (after hops); LW promote→continue / Standard wait |
| `src/web/narrate.js` | WAIT_REASON translation |
| `src/api/web.ts` | WAIT_REASON translation |
| `test/budget-gates.test.ts` | **new** — plan §8 matrix |
| `test/budget-usage.test.ts` | (boundary still holds; comment wording only via src) |
| `test/mission.test.ts` | Allow `executionBudget` field use in budget/platform/orchestrator |
| `test/promotion.test.ts` | Public hand-fill still rejected |
| `test/source-constraints.test.ts` | Block new trusted methods on HTTP surface |
| `test/web-narrate.test.ts` | WAIT_REASON key list |

## Deliberate unknown / non-enforced

- **`changedFiles`**: remains **unknown** in `evaluateMissionBudget` unless caller passes trusted `changedFiles[]`. Orchestrator does **not** wire `Workspace.diff` into the run loop this slice → **not hard-gated**.
- Soft tokens/cost: unknown when usage not fully `reported` / cost missing → no threshold, no promote.
- rounds/commands/wall mixed/legacy projection → unknown → no gate.
- HA: still fail-closed before budget path.
- Heuristics `?? 12` / pool `maxAttempts ?? 3` / `30m` wall-clock **unchanged** and non-ExecutionBudget.
- `ExecutionBudget` shape unchanged; no Jev policy.

## Gate semantics

1. No `executionBudget` → no events, no stall, no promote.
2. Compare `used >= limit` (incl. `0 >= 0`).
3. Hard: `attempts|rounds|wallClockMs|changedFiles|commands`.
4. Soft: token/cost dims → events only at 70/90/100.
5. Threshold once per dimension/threshold via durable `mission.budget.threshold` v1 scan.
6. LW hard exceeded → `promoteLightweightForBudgetExceeded` → clear wait → `continue` as Standard.
7. Standard hard exceeded (or promote fail) → `waiting` + `execution_budget_exceeded`.
8. Public `promoteMissionToStandard({code:'budget_exceeded'})` → `BUDGET_PROMOTION_NOT_READY`.

## Tests run

- Targeted: `test/budget-gates.test.ts`, `budget-usage`, `promotion`, `wait-reason-coverage`, `mission`, `orchestrator-lightweight`, `budget-round-facts`, `source-constraints`, `web-narrate`
- **Full suite: 1114 pass / 0 fail**
- `git diff --check`: clean

## Plan §8 coverage

| # | Case | Covered |
|---|---|---|
| 1 | no budget = prior behavior | yes |
| 2 | maxAttempts:0 PRE zero hop (Std wait / LW promote) | yes |
| 3 | used==limit next PRE no extra Attempt | yes |
| 4 | rounds at limit no new round.started | yes |
| 5 | non-reported tokens no soft events | yes |
| 6 | missing cost not compared | yes |
| 7 | maxCommands known 0 vs omitted unknown | yes |
| 8 | 70 then 90 once; rerun no dup | yes |
| 9 | soft 100% continues | yes |
| 10 | hard Std wait, no promote | yes |
| 11 | hard LW promote + mode standard | yes |
| 12 | public budget_exceeded reject | yes |
| 13 | budget label over pool attempt_limit | yes |
| 14 | full green + non-budget promotion intact | yes |
