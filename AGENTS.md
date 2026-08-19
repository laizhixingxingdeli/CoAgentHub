# AGENTS.md

Agent-facing conventions for the CoAgentHub repo: where the domain docs live,
the workspace commands, coding style, and how to operate the GitHub issue
tracker.

## Project in one sentence

CoAgentHub is a LAN-scale multi-participant collaboration hub: participants
(humans, CLIs, resident scripts, AI bots) register identities, join task
groups, exchange role-routed messages, and hand off files via P2P signaling. It
does coordination and messaging only — it does not proxy file bytes.

## Domain docs (read these before diving into code)

- Read **`CONTEXT.md`** first. It defines the ubiquitous language
  (`participant` / `group` / `audience` / `task` / `checkpointRef` / `callbackRef`
  / `completion event` …) and the run topology. Use exactly those terms in issue
  titles, test names, refactor proposals and hypotheses — don't drift to
  synonyms.
- **`docs/architecture.md`** is the structural reference: directory tree, data
  model, API surface, and key flows.
- **`docs/adr/`** records the architecture decisions (message tree, trust model,
  single-scheduler executors, memory, role decoupling, durable completion
  events). Read the relevant ADR before working in an area; if your output
  contradicts one, surface the conflict explicitly rather than silently
  overriding it.
- If a referenced file doesn't exist, proceed silently — don't flag its absence
  or propose creating it up front.

## Workspace & commands

pnpm monorepo; packages live under `packages/**` (`@laizhixingxingdeli/…` scope).
Scheduling policy / env knob review lives in `docs/usage.md`.

| Task | Command |
| --- | --- |
| Install deps | `pnpm install` |
| Run dev servers (web :3000, API :3001) | `pnpm dev` |
| Build everything | `pnpm build` |
| Build frontend only | `pnpm build:frontend` |
| Lint | `pnpm lint` |
| Unit tests | `pnpm test` |
| E2E tests | `pnpm test:e2e` |
| Per-package test / types | `pnpm --filter @laizhixingxingdeli/server test` · `… check-types` |

Migrate the database before exercising the server:
`pnpm --filter @laizhixingxingdeli/database migrate`.

## Coding style

- **Frontend**: React + Vite + wouter; **backend**: Hono + Drizzle ORM + PostgreSQL.
- Linting and formatting are enforced by **Biome** (config in `biome.json`).
- Backend domain logic is split into focused, independently-testable modules
  (e.g. `lib/executor-task/` → types/state/output-buffer/notify/report/queue);
  keep the exported surface stable and unit-testable.
- TypeScript strict mode; run `check-types` after non-trivial changes.
- No new dependencies without justification.

## Issue tracker

Issues and specs are tracked as GitHub issues, operated via the `gh` CLI (the
repo is inferred from `git remote -v`). PRs are **not** a triage surface.
GitHub shares one number space across issues and PRs, so a bare `#42` may be
either — resolve with `gh pr view 42`, falling back to `gh issue view 42`.

- **Create**: `gh issue create --title "..." --body "..."` (heredoc for multi-line).
- **Read**: `gh issue view <number> --comments`.
- **List**: `gh issue list --state open --json number,title,body,labels,comments --jq '...'`
- **Comment**: `gh issue comment <number> --body "..."`
- **Labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

When a skill says "publish to the issue tracker", create a GitHub issue; when
it says "fetch the relevant ticket", run `gh issue view <number> --comments`.

### Triage labels

| Role | Label | Meaning |
| --- | --- | --- |
| Needs triage | `needs-triage` | Maintainer needs to evaluate this issue |
| Needs info | `needs-info` | Waiting on the reporter for more information |
| Ready for agent | `ready-for-agent` | Fully specified, ready for an AFK agent |
| Ready for human | `ready-for-human` | Requires human implementation |
| Wontfix | `wontfix` | Will not be actioned |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the
corresponding label string from this table.

## Spec-Driven workflow

CoAgentHub uses a Spec-Driven dispatch flow: the coordinator must not dispatch a
task until the implementation plan is fully settled in a written spec. The full
workflow (project bootstrap, pre-flight grill, to-spec, dispatch, post-flight
verification) lives in the **coordinator skill** and its references:

- `skills/coordinator/SKILL.md` — the coordinator procedure.
- `specs/` — spec documents (Spec-Driven workflow) and `docs/adr/` for decisions.

The executor's method (implement → test → self-review → report) is carried by
`skills/executor/SKILL.md`; the task ticket only triggers that skill. When you
change workflow, spec, or skill behavior, keep `AGENTS.md` / `CONTEXT.md` /
`docs/architecture.md` / `docs/adr/` in sync.