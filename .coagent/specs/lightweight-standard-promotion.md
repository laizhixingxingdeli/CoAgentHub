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

## 交卷后的自动升级（接线，2026-09-23）

Lightweight 工作项交卷后，平台跑机器验收；**没有被机器 accept 就升级到 Standard**，不再停在 stalled 等人（E1 实测停过 870 秒：执行者改对了，一条验收配置判失败，车道没有出口）。

- 触发由纯函数 `promotion/lightweight-gate.ts` 的 `lightweightGateTrigger(report)` 从**一份 trusted ValidationReport** 复算，顺序固定：
  1. `changed_files_gt_3` / `top_level_modules_gt_2`——实际改动清单取自报告里 changed-paths 检查的 `actual`。规模超了，**验收通过也要升级**。
  2. `validator_failure_unrepairable`——报告未通过。`invalid_argv` / `unsupported_scope` 写成「验收配置本身跑不起来，要重写工单」；其余普通失败写成「Lightweight 没有返工通道，交协调者对照报告做 L2」。不另设「让执行者照报告再修一次」的循环：E1 那次是工单配错、改动本身是对的。
- `validateAndAcceptLightweightWorkItem`：通过但规模超了 → **不 accept**，返回 `held: <code>`，工作项留在 submitted（一旦 accept，升级后 L2 就无从审起）。
- `promoteLightweightAfterValidation(missionId, reportId)`（进程内）：调用方只能指名报告，不能自带理由。报告须存在且属于该 Mission（`PROMOTION_REPORT_MISMATCH`），须是该工作项**当前这次提交**的（`PROMOTION_REPORT_STALE`），须推得出触发（`NO_PROMOTION_TRIGGER`）；之后走 `#commitPromotionToStandard`。
- Orchestrator：工作项 submitted 且未被 accept → 调上面的入口 → 清掉等待原因 → 继续（Standard：协调者被唤醒做 L2，指令开头写明「从 Lightweight 升级上来的，原因：<triggerRule>」）。升级本身失败才 stalled，原因同时写出验收结果与升级失败的缘由。

**尚未接线**：`new_dependency`（需要可信地读工作区里**未提交**的 package.json；`showRootPackageJson` 刻意只读已提交 revision）；`executor_ambiguity` / `invalid_premise` / `design_decision` / `permission_expansion` / `new_public_interface` / `persistence_format_change` / `diff_intent_unprovable`（还没有可信的信号来源）。

## 权威源 / 测试

- 源：`platform.ts`（promote* / `#commitPromotionToStandard`）、`kernel/payloads.ts`（码表与 `PromotionRecord`）、`application/promotion/*`
- 测试：`promotion.test.ts`、`promotion-diff-detectors.test.ts`、`promotion-new-dependency-detector.test.ts`、`promotion-validator-failure-unrepairable-detector.test.ts`、`budget-gates.test.ts`
