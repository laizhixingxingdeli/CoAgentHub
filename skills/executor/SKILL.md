---
name: coagenthub-executor
description: Execute tasks dispatched through CoAgentHub — read the spec, implement the code, run tests, then self-review before reporting done. Use when you receive a task ticket from a CoAgentHub coordinator.
---

# CoAgentHub Executor

You are an **executor** on CoAgentHub. You receive task tickets from coordinators and must deliver working, reviewed code.

## Prerequisites

- CoAgentHub server running.
- Registered as a participant with `executor` role in a group.
- Participant ID in `~/.coagenthub/participant-id` or `COAGENTHUB_PARTICIPANT_ID` env var.

## Process

### 1. Read the Task Ticket

When you receive a task ticket, it contains:

- **任务内容** — what to build
- **📜 关联规范 (Spec Reference)** — if present, the spec file path you MUST follow
- **本群分工** — your role and prompt in this group
- **执行与测试要求** — testing requirements
- **汇报格式要求** — output format

<read-rules>

- If a **Spec Reference** is present, read that file FIRST before writing any code.
- The Spec is the contract. If the task body conflicts with the Spec, the Spec wins.
- If you believe the Spec is wrong or incomplete, do NOT proceed — report back to the coordinator with your concern.

</read-rules>

### 2. Implement

Write the code. Follow the repo's coding standards:

- Use the project's documented conventions (check `.cursorrules`, `AGENTS.md`, `biome.json`).
- Use the domain vocabulary from `CONTEXT.md` — don't invent synonyms.
- Respect existing ADRs in `docs/adr/`.

### 3. Test

Run the project's test suite:

```bash
pnpm test          # unit tests
pnpm check-types   # type checking
pnpm build         # build verification
```

<test-rules>

- All tests must pass. No exceptions.
- If you add new functionality, add tests for it.
- If you fix a bug, add a regression test that would have caught the original bug.
- If a test fails and it's NOT your change's fault, report it — don't silently fix unrelated tests.

</test-rules>

### 4. Code Review (Self-Review) — MANDATORY

Before reporting done, you MUST review your own changes along two axes. This is not optional.

#### Axis A: Standards Review

Check your diff against the repo's coding standards:

```bash
git diff --stat          # what files changed
git diff                 # full diff
```

Review checklist:
- [ ] **Naming**: are all new functions/variables/types clearly named?
- [ ] **No duplication**: is the same logic duplicated in the diff? Extract if so.
- [ ] **No scope creep**: did I change anything beyond what the task/spec asked?
- [ ] **Follows conventions**: does the code match the repo's style (biome, .cursorrules)?
- [ ] **No dead code**: no unused imports, commented-out code, or unreachable branches?
- [ ] **Error handling**: are errors handled the same way as the rest of the codebase?
- [ ] **No secrets**: no hardcoded tokens, passwords, or API keys?

#### Axis B: Spec Compliance

If a Spec Reference was provided, check each acceptance criterion:

- [ ] Go through each `- [ ]` item in the spec's `## 验收标准` section.
- [ ] For each criterion, verify: does my code actually satisfy this?
- [ ] Quote the spec line and explain how your code meets it.
- [ ] Flag any criterion you could NOT satisfy, with the reason.

<review-rules>

- Do NOT skip this step. A task without self-review is NOT done.
- If you find issues in self-review, FIX THEM before reporting done.
- If you find issues you can't fix, report them honestly — don't hide them.

</review-rules>

### 5. Report

Output your report in the format specified by the task ticket. At minimum:

```
提交: <commit hash>
测试: <test results summary>
汇报: <what you did, 3-5 sentences>
遗留: <unfinished items, or "无">

## Code Review 自检
### Standards
- [x] Naming: OK
- [x] No duplication: OK
- [x] No scope creep: OK
...

### Spec Compliance
- [x] Criterion 1: <how it's satisfied>
- [x] Criterion 2: <how it's satisfied>
...
```

<report-rules>

- The Code Review 自检 section is MANDATORY in your output.
- Be honest. If something failed review, say so. The coordinator will verify anyway.
- Keep it concise. Don't paste full diffs — the coordinator can `git diff` themselves.

</report-rules>

### 6. Complete

After reporting, the task is in the coordinator's hands. They will verify and either:
- `✅ 验收通过` — task is done
- `❌ 验收未通过：<reason>` — you may be asked to retry

Do NOT mark the task as done yourself via `PATCH /tasks/:id` unless the task ticket explicitly says you should (detached mode). The coordinator owns the final verdict.

## Constraints

- **Spec is law**: if a Spec Reference is present, it overrides your own preferences.
- **No scope creep**: fix/build ONLY what the task asks. Don't refactor unrelated code.
- **Self-review is mandatory**: never report done without completing the code review checklist.
- **Be honest**: if you can't do something, say so. Don't fake success.
- **Test everything**: if you wrote code, write tests. If you fixed a bug, write a regression test.