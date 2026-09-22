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
- 字段：`id`、`policyRevision`、`missionId`、可选 `workItemId`/`attemptId`、时间窗、`passed`、`checks`（`command` | `changed-paths`）。
- 仓储 **append-only**：同 id 仅允许结构完全相同的幂等 save；冲突 → `VALIDATION_REPORT_CONFLICT`。无 list/update/delete。

## ValidationEngine

- 只跑 command + changed-paths；产出报告。**全部通过**才附带 `authority: { kind:'validator', reportId, policyRevision }`；失败不签发权威。
- 不接 WorkItem 状态机 / 不自动 accept（`validation/engine.ts`）。
- `policyRevision` 常量：`VALIDATION_POLICY_REVISION`。

## Lightweight 绑定（Platform）

`validateAndAcceptLightweightWorkItem`：

1. 仅 `submitted` + 有 `submittedAttemptId`；cwd 来自 trusted worktree，commands 的 cwd 强制覆盖。
2. **先** `reports.save(report)`，再写 `validation.reported`。
3. `passed=false`：报告已存，item 保持 submitted，不 accept。
4. `passed=true`：authority/linkage（reportId、policyRevision、mission/workItem/attempt）必须一致，否则 `VALIDATION_AUTHORITY_MISMATCH`，仍不 accept。
5. 一致则 `item.review('accept', { authority: validator, ... })`。

`submitLightweightMissionForReview` 再次从仓储读 durable report：缺失 / 未通过 / policy 或 linkage 不一致一律拒绝；通过后 `submitForReview` → `awaiting_review`，**不** `complete`。

## 权威源 / 测试

- 源：`kernel/payloads.ts`（类型）、`validation/engine.ts`、`validation/report-repository.ts`、`platform.ts`（validate/submit-for-review）
- 测试：`validation-engine.test.ts`、`validation-report-repository.test.ts`、`builder-validation.test.ts`、`orchestrator-lightweight.test.ts`、`final-review.test.ts`
- 取舍：ADR-0004（Fast Lane 不绕过 L3 / review authority）
