# ValidationReport 与 ReviewAuthority

机器独立验收与协调者自报权威分立。执行者**不得**给自己签发通过。

## ReviewAuthority

```text
{ kind: 'coordinator', attemptId }
{ kind: 'validator', reportId, policyRevision }
```

- 无 `executor` 分支（`src/kernel/payloads.ts`）。
- Standard 路径继续由 Coordinator Attempt 做 `review`；Lightweight 机器验收只认 `validator`。

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
| `diffSize` | 不跑 diff-size | `maxChangedFiles` / `maxChangedLines`（≥1 键，非负整数）；`used >= limit` fail；in-force 维 unknown fail |

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
