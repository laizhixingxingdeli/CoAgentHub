# ValidationReport 与 ReviewAuthority

机器独立验收与协调者自报权威分立。执行者**不得**给自己签发通过。

## ReviewAuthority

```text
{ kind: 'coordinator', attemptId }
{ kind: 'validator', reportId, policyRevision }
```

- 无 `executor` 分支（`src/kernel/payloads.ts`）。
- Standard 路径继续由 Coordinator Attempt 做 `review`；Lightweight 机器验收只认 `validator`。
- **这是工作项 L2 的轴，不是 Mission 终审的轴。** `FinalReviewAuthority`（human / machine / plan / reviewer）只出现在 L3 最终检视上；本文件的 ReviewAuthority 不给 executor 增加终审权，也不因为多了检视者代签就把终审下放到执行者。

## 独立检视（independent_reviewer，E2）

Mission 级追加记录，**不是** WorkItem `ReviewRecord`，也**不是** `FinalReview`。

- 角色字面量是 `independent_reviewer`，不复用终审签名人 `reviewer`。
- 结论 `pass` / `send_back` 绑定：missionId、reviewerAttemptId、reviewerProfileId、契约 revision、被审 HEAD、L2 逐条结果引用、ValidationReport 引用、理由、平台时间。
- `send_back` 不改任何 L2 逐条结果，也不流转 planning / finalize / merge。
- `pass` 不是用户确认，也不签 `FinalReview`。契约 revision、被审 HEAD、被引用 L2 或 ValidationReport 任一变化后，读取方不得把旧 pass 当成当前有效结论。
- 同一组证据下若最新结论是 `send_back`，不得回退到更早的 `pass`。
- 缺 ValidationReport、引用不属本 Mission、非 awaiting_review、交卷非 delivered：不得 pass。
- **HA 确定性验证（E3a）**：合规 HA 在协调者逐条 L2 之后、独立检视之前，由平台在 Mission 工作区**当前 HEAD** 上，用各活跃（非 retired）工作项冻结工单的 `validation` 命令跑 `ValidationEngine`，落盘可追溯报告，覆盖全部活跃工作项。不得用协调者 accept 或执行者自报代替。验证失败、缺失或证据已变，都不能产生有效 pass。有效 pass 只表示待授权，Mission 仍停在 `awaiting_review`，不记 `FinalReview`，本项不开放 HA 合并。

## ValidationReport

- 不可变、可追溯机器事实；与 `EvidenceRecord`（执行者自报）分立。
- 字段：`id`、`policyRevision`、`missionId`、可选 `workItemId`/`attemptId`、时间窗、`passed`、`checks`。
- `checks.kind`：`command` | `changed-paths` | `forbidden-paths` | `diff-size`。
- 仓储 **append-only**：同 id 仅允许结构完全相同的幂等 save；冲突 → `VALIDATION_REPORT_CONFLICT`。无 list/update/delete。

## ValidationEngine

- 默认跑 command* + changed-paths；当 Frozen `WorkOrder.validation` 携带对应字段时**追加** `forbidden-paths` / `diff-size`（VAL-002）。
- **全部通过**才附带 `authority: { kind:'validator', reportId, policyRevision }`；失败不签发权威。
- 缺省字段 = 对应检查**不在 force**（不发射 placeholder `passed:true`）；在 force 且测量 unknown / 路径 spec unsupported → fail-closed，无权威。
- 路径/上限**只**来自 frozen `WorkOrder.validation`（Platform 拷贝），不来自 `ExecutionBudget`、promotion 检测器、Jev/Decision、Executor 自报或 prose（`doNot` / guardrails / verification）。
- 不接 WorkItem 状态机 / 不自动 accept（`validation/engine.ts`）。
- `policyRevision` 常量：`VALIDATION_POLICY_REVISION`（仍为 1）。

### 配置语义（WorkOrder.validation）

| 字段 | 缺省 | 在 force |
|---|---|---|
| `commands` | 必填（可 `[]`） | 每条跑 command check |
| `forbiddenPaths` | 不跑 forbidden-paths | 含 `[]`（空 denylist → pass）；命中 deny → fail（无 failureCode）；glob/escape/`''` → `unsupported_scope` |
| `diffSize` | 不跑 diff-size | `maxChangedFiles` / `maxChangedLines`（≥1 键，非负整数）；上限按字面「最多」：`used > limit` 才 fail，恰好到上限通过（`0` = 一个都不许改）；in-force 维 unknown fail |

> 2026-09-23 由 `used >= limit` 改为 `used > limit`。旧写法让 `maxChangedFiles: 1` 等于「一个文件都不许改」，E1 单文件金丝雀改对了却被判超限、Mission 停在 stalled。执行预算（`budget-usage`）仍是 `>=`——那是「下一步动作前」的闸，用满额度就不再开新一跳；diff-size 是对已产出结果的事后检查，语义不同。

检查顺序（已配置时）：`command*` → `changed-paths` → `forbidden-paths` → `diff-size`。

deny ∩ allow：changed-paths 可通过，forbidden-paths 仍 fail（deny wins）。

## Lightweight 绑定（Platform）

`validateAndAcceptLightweightWorkItem`：

1. 仅 `submitted` + 有 `submittedAttemptId`；cwd 来自 trusted worktree，commands 的 cwd 强制覆盖。
2. 从 **frozen order** 拷贝 `allowedScope`、`validation.commands`、可选 `forbiddenPaths` / `diffSize`；不填默认 denylist / 默认体积阈值。
3. **先** `reports.save(report)`，再写 `validation.reported`。
4. `passed=false`：报告已存，item 保持 submitted，不 accept。
5. `passed=true`：authority/linkage（reportId、policyRevision、mission/workItem/attempt）必须一致，否则 `VALIDATION_AUTHORITY_MISMATCH`，仍不 accept。
6. 一致则 `item.review('accept', { authority: validator, ... })`。

`submitLightweightMissionForReview` 再次从仓储读 durable report：缺失 / 未通过 / policy 或 linkage 不一致一律拒绝；通过后 `submitForReview` → `awaiting_review`，**不** `complete`。

## 权威源 / 测试

- 源：`kernel/payloads.ts`（类型）、`validation/engine.ts`、`validation/ports.ts`（含 `DiffFactReader`）、`validation/workspace-diff-fact-reader.ts`、`validation/report-repository.ts`、`platform.ts`（validate/submit-for-review）
- 测试：`validation-engine.test.ts`、`validation-report-repository.test.ts`、`work-item.test.ts`、`platform-lightweight.test.ts`、`builder-validation.test.ts`、`orchestrator-lightweight.test.ts`、`final-review.test.ts`
- 取舍：ADR-0004（Fast Lane 不绕过 L3 / review authority）；ADR-0005（budget unknown **不**硬闸 — 与 validator fail-closed 不同轴）

## L2 逐条验收（优化方案 §11，2026-09-23）

一句总结里「都过了」和「三条过了、第四条没法验」看起来一样，而后者正是 L3 最需要看到的。

- **协调者评审**（`reviewExecutionResult` / 工具 `coagent_review_execution_result`）：工作项的工单有 `acceptance` 时必须带 `acceptanceResults`——一条对一条、顺序一致、`criterion` 照抄原文；`status` ∈ `pass` / `fail` / `unverified` / `not_applicable`；`pass` 要 `evidence`；`unverified` / `not_applicable` 要 `note`。错误码：`ACCEPTANCE_RESULTS_REQUIRED` / `ACCEPTANCE_RESULTS_MISMATCH` / `ACCEPTANCE_RESULT_INVALID` / `ACCEPTANCE_EVIDENCE_REQUIRED` / `ACCEPTANCE_NOTE_REQUIRED` / `ACCEPT_WITH_FAILED_CRITERION`。报错写成协调者能照做的话。
- **内核不变式**：`ReviewRecord` 带逐条结果时，`accept` 不得含 `fail`（`ACCEPT_WITH_FAILED_CRITERION`），不管从哪条路进来；形状非法 → `INVALID_REVIEW_RECORD`。
- **不受约束**：机器（validator）评审；工单没有 `acceptance` 的旧工作项（给了非空结果反而 `MISMATCH`）。旧快照没有这个字段照常恢复，不补、不猜。
- **露出**：`review.recorded` 事件带 `acceptance` 计数与 `unverified` 清单；`l3 show` 列「逐条：x/y pass」与每条非 pass 项（✗ 未过 / ⚠ 未验证 / — 不适用 + 原因）。
- **发布耦合**：pi 侧工具（coagent-pi 的 A5a）要同时发 `acceptanceResults`。集成分支上的平台配 master 上的 pi 会拒掉评审——两边的集成分支要一起合 master。
