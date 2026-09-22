# RESULT-VAL002-EXEC

## Summary

Implemented VAL-002: `forbidden-paths` and `diff-size` as **explicit frozen `WorkOrder.validation` inputs**. No default denylist/thresholds; no coupling to ExecutionBudget, promotion, Jev/Decision, or Executor self-report. Legacy omit path unchanged (VAL-001). In-force unknown measurement fails validation authority. `VALIDATION_POLICY_REVISION` remains `1`.

## Exact files touched

### Production

| File | Change |
|---|---|
| `src/kernel/payloads.ts` | `WorkOrderValidationDiffSize`; `WorkOrderValidationSpec.forbiddenPaths?` / `diffSize?`; `ValidationCheckKind` + nested `forbiddenPaths` / `diffSize` on `ValidationCheckResult`; `ValidationDiffSizeUnknownDimension` |
| `src/kernel/index.ts` | Re-export new types |
| `src/kernel/work-item.ts` | `normalizeValidationSpec` allows `forbiddenPaths` / `diffSize`; freeze/copy; reject empty entries, empty `{}` diffSize, negatives, decimals, extra keys; restore still drops entire malformed `validation` |
| `src/application/validation/ports.ts` | `DiffFactReader` + `DiffLineFacts` |
| `src/application/validation/engine.ts` | Optional input fields; checks order `command* → changed-paths → forbidden-paths → diff-size`; omit when not configured; fail-closed on unsupported scope / unknown measure / over-limit (`>=`); no default paths/numbers |
| `src/application/validation/workspace-diff-fact-reader.ts` | **New.** `git diff --numstat` + untracked text line counts; binary/`-` → unknown; no index mutation; no `diff.stat` |
| `src/application/validation/report-repository.ts` | `cloneCheck` / `checksEqual` for new nested kinds |
| `src/application/platform.ts` | `PlatformValidationDeps` + `validateAndAcceptLightweightWorkItem` copy `forbiddenPaths` / `diffSize` **from frozen order only** |
| `src/main.ts` | Inject `WorkspaceDiffFactReader` beside `WorkspaceChangedPathReader` (in-memory / file / pg builders) |
| `.coagent/specs/validation-review-authority.md` | Living Spec: new checks, in-force/omit, fail-closed unknown, config source constraints |

### Tests

| File | Change |
|---|---|
| `test/validation-engine.test.ts` | forbidden-paths + diff-size matrices; DiffFactReader temp-git facts; refined self-report source guards |
| `test/work-item.test.ts` | freeze/restore extras; reject bad VAL-002 shapes; restore unknown key drops validation |
| `test/validation-report-repository.test.ts` | clone/equal/freeze for new check kinds |
| `test/platform-lightweight.test.ts` | Platform copies deny/size; omit → legacy accept |
| `test/promotion-validator-failure-unrepairable-detector.test.ts` | DETECT-003 static count: `unsupported_scope` now written twice (changed-paths + forbidden-paths); deny-hit / size exceed still no new failureCode |

**Not touched:** `VIBE.md` (no hand-edit), budget/orchestrator/promotion detectors (logic), Jev/Decision, `WorkspaceManager.diff` signature.

## Semantics locked

- **In force** iff field present on input (`forbiddenPaths` including `[]`; `diffSize` object with ≥1 limit).
- Missing field → check omitted (no placeholder pass).
- Deny ∩ allow → changed-paths may pass; forbidden-paths fails.
- Over-limit / deny hit → fail, **no** `failureCode` (not DETECT-003 unrepairable).
- Glob / escape / `''` in denylist → `failureCode: 'unsupported_scope'`.
- `used >= limit` (incl. `0 >= 0`); unknown in-force dimension → fail, no authority.
- Line facts: trusted reader only; missing reader with `maxChangedLines` in force → unknown → fail.

## Verification

```text
node --test test/validation-engine.test.ts test/work-item.test.ts \
  test/validation-report-repository.test.ts test/platform-lightweight.test.ts
→ pass (targeted)

node --test test/promotion-validator-failure-unrepairable-detector.test.ts \
  test/validation-engine.test.ts
→ pass

node --test
→ 1137 pass, 0 fail

git diff --check
→ clean (no whitespace errors)
```

**No commit** (per executor instructions).

## Worktree

`C:\program1\coagenthub-v5\.coagent-worktrees\HOPT-20260922-VAL002`  
branch: `mission/HOPT-20260922-VAL002`
