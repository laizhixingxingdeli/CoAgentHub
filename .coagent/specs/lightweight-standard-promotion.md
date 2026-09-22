# Lightweight → Standard 晋升（PROMO-001）

可信升级把 Lightweight mutation Mission 转为 Standard，并留下 `PromotionRecord`；入口只在进程内。

## 入口

| API | 谁调用 | 说明 |
| --- | --- | --- |
| `promoteMissionToStandard(id, { code, rule })` | 进程内策略 / 检测接线 | 非空 `rule`；`code` ∈ `PROMOTION_TRIGGER_CODES` |
| `promoteLightweightForBudgetExceeded(id)` | Orchestrator budget gate | 唯一合法 `budget_exceeded` 发放路径 |

- 公开入口对 `budget_exceeded` **永久拒绝**（见 execution-budget-gates / ADR-0005）。
- 不接受 caller 自带完整 `PromotionRecord` / evidence / HEAD JSON；审计字段由 Platform 从 trusted state 构造（`id` 由 `ids.next('promo')`）。

## 提交语义（`#commitPromotionToStandard`）

- 要求当前为 lightweight mutation lane；已 standard 且唯一 promotion 的 code/rule 相同 → 幂等 `changed:false`；不同 trigger → `PROMOTION_ALREADY_APPLIED`。
- `fromStatus` 快照当前 status；`executing` → `toStatus=planning`，否则保持 investigating/planning。
- Record 含：trigger、时间、consumedUsage、evidenceIds、validationReportIds、workspaceRevision、workItemIdsSnapshot。
- 升级后走 Standard 编排（可再启 Coordinator）；**不**因此 completed，L3 权不变。

## 触发码与检测器

码表在 kernel（`PromotionTriggerCode`）：`changed_files_gt_3`、`top_level_modules_gt_2`、`new_dependency`、`new_public_interface`、`persistence_format_change`、`executor_ambiguity`、`invalid_premise`、`design_decision`、`validator_failure_unrepairable`、`permission_expansion`、`budget_exceeded`、`diff_intent_unprovable`。

纯检测器（**不**自动 promote，由上层接线）：

- `promotion/diff-detectors.ts` — diff 路径计数 / top-level modules
- `promotion/new-dependency-detector.ts`
- `promotion/validator-failure-unrepairable-detector.ts`

## 权威源 / 测试

- 源：`platform.ts`（promote* / `#commitPromotionToStandard`）、`kernel/payloads.ts`（码表与 `PromotionRecord`）、`application/promotion/*`
- 测试：`promotion.test.ts`、`promotion-diff-detectors.test.ts`、`promotion-new-dependency-detector.test.ts`、`promotion-validator-failure-unrepairable-detector.test.ts`、`budget-gates.test.ts`
