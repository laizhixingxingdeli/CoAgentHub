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

## Spec-Driven Dispatch (规范驱动任务下发)

CoAgentHub 采用 Spec-Driven 工作流：协调者在完全确定实现方案前不允许下发任务。

### 下发前检查清单（Pre-Flight Grill）

在调用 `coagenthub_dispatch_task` 之前，协调者必须：

1. **编写或更新 Spec 文档**：在 `specs/` 目录下创建或修改 `.md` 文件，
   包含以下章节：
   - `## 背景`：为什么需要这个改动
   - `## 改动范围`：涉及哪些文件/模块，不涉及什么
   - `## 验收标准`：可验证的完成条件（checklist 格式）
   - `## 不涉及的改动`：明确排除项

2. **自检**：问自己三个问题：
   - 我是否已经明确了所有的输入输出？
   - 验收标准是否可验证（不是"优化性能"而是"响应时间 < 200ms"）？
   - 如果我是执行器，仅凭这份 Spec + 任务书我能一次性写对吗？
   **如果任何一个答案是"否"，不要下发任务，继续完善 Spec。**

3. **传入 specRef**：调用 `coagenthub_dispatch_task` 时传入 `specRef` 参数，
   指向刚才编写的 Spec 文件路径。

### 完成后验收（Post-Flight Grill）

当执行器回传结果后，协调者必须：

1. **拉取任务详情**：`coagenthub_get_task`，检查 `diffSummary` 和 `outputTail`
2. **对照 Spec 验收**：逐项检查 Spec 中的验收标准是否全部满足
3. **文档同步检查**：代码改动是否需要同步更新文档（ADR、architecture.md 等）
4. **裁决**：
   - 全部通过：在群内发 `✅ 验收通过` 并标记任务 done
   - 部分失败：在群内发 `❌ 验收未通过：<原因>` 并要求重试或人工介入
