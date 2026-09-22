# RESULT — SPEC-OBS-001A

## Summary

Closed the new-agent **Project Truth** coverage gap for already-shipped behavior. Added Living Specs + durable ADRs under `.coagent/`, pointed `project.md` at them, regenerated root `VIBE.md` (artifact only), and pinned the inventory in `project-memory` tests. **No** application/kernel/runtime/UI/API behavior changes.

## Files touched

| File | Change |
| --- | --- |
| `.coagent/specs/query-run.md` | **new** — independent QueryRun read-only path |
| `.coagent/specs/classified-intake-lightweight.md` | **new** — classified intake + Lightweight Fast Lane |
| `.coagent/specs/validation-review-authority.md` | **new** — ValidationReport + ReviewAuthority |
| `.coagent/specs/execution-budget-gates.md` | **new** — authoritative hard/soft budget gates |
| `.coagent/specs/lightweight-standard-promotion.md` | **new** — LW→Standard promotion + detectors |
| `.coagent/specs/decision-jev-off-shadow.md` | **new** — Decision/Jev OFF + SHADOW non-authority |
| `.coagent/architecture/decisions/adr-0002-decision-provider-boundary.md` | **extend** — SHADOW explicitly non-authoritative; drop “future-only” claim; point to Living Spec |
| `.coagent/architecture/decisions/adr-0003-query-run-not-mission.md` | **new** — QueryRun is not a Mission |
| `.coagent/architecture/decisions/adr-0004-fast-lane-does-not-bypass-l3.md` | **new** — Fast Lane does not bypass L3 / review authority |
| `.coagent/architecture/decisions/adr-0005-execution-budget-authority.md` | **new** — budget authority + hard vs soft semantics |
| `.coagent/project.md` | index / Core Model / Invariants / Memory Model wording for new-agent discovery |
| `VIBE.md` | **regenerated** from `.coagent/` (not a SoT) |
| `test/project-memory.test.ts` | pin required Spec/ADR slugs + ADR-0002 SHADOW non-authority + vibe index |
| `RESULT-SPEC-OBS-001A.md` | this file |

Unchanged by design: all `src/**`, HTTP/UI, Mission history, no `project.yaml` / constitution / extra project-level memory file.

## Capability → source map (docs only)

| Spec | Primary source | Tests |
| --- | --- | --- |
| query-run | `query-run.ts`, `query-promotion.ts` | `query-run`, `query-promotion`, `pi-query-runtime` |
| classified-intake-lightweight | `classified-mission-intake.ts`, `task-classifier.ts`, `platform` LW methods, `orchestrator` LW | `classified-mission-intake`, `task-classifier`, `orchestrator-lightweight`, `platform-lightweight` |
| validation-review-authority | `validation/*`, `kernel/payloads` ReviewAuthority | `validation-engine`, `validation-report-repository`, `builder-validation` |
| execution-budget-gates | `budget-usage.ts`, Platform budget APIs, Orchestrator gate | `budget-gates`, `budget-usage`, `budget-*-facts` |
| lightweight-standard-promotion | `platform` promote*, `promotion/*` | `promotion*`, `budget-gates` (budget path) |
| decision-jev-off-shadow | `decision-mode`, factory, shadow-runner, Jev adapter, `main` startup | `decision-*`, `platform-dispatch-shadow`, `start-server` |

## Tests run

- Targeted: `node --test test/project-memory.test.ts` → **13 pass / 0 fail** (was 12; +1 inventory pin)
- Full suite: `npm test` → **1115 pass / 0 fail / 244 suites**
- `git diff --check`: clean (exit 0; CRLF warnings only)

## Non-goals (this slice)

- No runtime behavior, gate, or API changes
- No large docs framework / constitution / project.yaml
- No Mission narrative history in `.coagent/`
- VIBE remains generated; hand-edits are not SoT
