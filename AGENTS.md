# AGENTS.md

Agent-facing conventions for the CoAgentHub repo: how to consume the domain
docs, how to operate the GitHub issue tracker, and which triage labels to use.

## Domain docs

This repo uses a **single-context layout**: one `CONTEXT.md` at the repo root
plus `docs/adr/` for decision records.

- **Before exploring the code, read `CONTEXT.md`.** It defines the ubiquitous
  language (`participant` / `group` / `audience` / `task` / `checkpointRef` …)
  and the run topology. Use exactly those terms in issue titles, test names,
  refactor proposals and hypotheses; don't drift to synonyms the glossary
  avoids.
- **Read the relevant `docs/adr/*.md` before working in an area** — they record
  the message-tree, trust-model, single-scheduler, memory and role-decoupling
  decisions. If your output contradicts an existing ADR, surface the conflict
  explicitly instead of silently overriding it.
- If a file doesn't exist, proceed silently — don't flag its absence or
  propose creating it up front.

## Issue tracker

Issues and specs for this repo live as GitHub issues, operated via the `gh`
CLI (the repo is inferred from `git remote -v`). Conventions:

- **Create an issue**: `gh issue create --title "..." --body "..."` — use a
  heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, fetching labels and
  filtering comments with `jq` as needed.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '...'`
  with appropriate `--label` / `--state` filters.
- **Comment**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` /
  `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

PRs are **not** treated as a triage surface in this repo. GitHub shares one
number space across issues and PRs, so a bare `#42` may be either — resolve
with `gh pr view 42` and fall back to `gh issue view 42`.

When a skill says "publish to the issue tracker", create a GitHub issue; when
it says "fetch the relevant ticket", run `gh issue view <number> --comments`.

## Triage labels

Five canonical triage roles map to the default labels used in this repo's
tracker:

| Role | Label | Meaning |
| --- | --- | --- |
| Needs triage | `needs-triage` | Maintainer needs to evaluate this issue |
| Needs info | `needs-info` | Waiting on the reporter for more information |
| Ready for agent | `ready-for-agent` | Fully specified, ready for an AFK agent |
| Ready for human | `ready-for-human` | Requires human implementation |
| Wontfix | `wontfix` | Will not be actioned |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use
the corresponding label string from this table.
