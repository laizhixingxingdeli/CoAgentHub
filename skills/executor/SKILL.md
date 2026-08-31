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
- The **📜 关联规范** section is produced by the **reviewer** (the coordinator dispatches against it) — "Spec is law" holds regardless of who delivered the ticket.
- If you believe the Spec is wrong or incomplete, do NOT proceed — report back to the coordinator with your concern.

</read-rules>

### 2. Implement

Write the code. Follow the repo's coding standards:

- Use the project's documented conventions (check `.cursorrules`, `AGENTS.md`, `biome.json`).
- Use the domain vocabulary from `CONTEXT.md` — don't invent synonyms.
- Respect existing ADRs in `docs/adr/`.

#### 2.1 修复票越界 → 立即上报，不要自行扩张（闸二，v4.0）

若任务书的 `dispatchKind` 是 `fix`（修复票，复用一份既有冻结 spec），而你发现
**必须越过那份 spec 的边界**才能改动——新增/改变契约、调整数据模型、引入新模块
或推翻既有 ADR：

**停下，不要动手改架构。** 在汇报里写明「本票越界」+ 越界点，交回协调者退回
检视者做 `spec_amended`，按 `requirement` 与新 `specHash` 重新下发。

理由：`fix` 票**不跑 L3**（架构检视在它复用的那份 spec 冻结时已经做过）。你在
`fix` 名义下改架构，等于让一处架构改动**绕开了唯一的架构检视环节**——没有任何
后续关卡会发现它。这不是流程洁癖，是这条链上真实存在的漏洞。

### 3. Test

Testing is **reference-only discipline** — a reference for how to write code, not a mandated step sequence. The loop is just **red → green**:

<test-rules>

- **red → green**: write a failing test first, then write the minimal implementation to make it pass. That's the whole loop.
- **refactor is OUT of the loop**: do NOT refactor during implementation — refactoring belongs to §4 Code Review. If you notice a refactor, note it for review instead of doing it inline.
- **Rhythm**: run type checks often, run single-file tests often, and run the full suite once at the end.
- **Vertical slice**: one verifiable slice at a time; don't cut across layers horizontally.
- All tests must pass. No exceptions.
- If you add new functionality, add tests for it.
- If you fix a bug, add a regression test that would have caught the original bug.
- If a test fails and it's NOT your change's fault, report it — don't silently fix unrelated tests.

</test-rules>

Essential commands:
```bash
pnpm test          # unit tests
pnpm check-types   # type checking
pnpm build         # build verification
```

### 3.5 人工墙 → wizard (Human Wall to Wizard)

When execution hits a step **only a human can perform**, don't stack numbered instructions in stdout or the report — generate a staged interactive bash script for the human to run.

<wizard-rules>

- **Triggers (four cases)**: provisioning infrastructure / configuring credentials or CI secrets / navigating an unfamiliar third-party dashboard / a one-off migration or cutover.
- **Non-trigger (stated explicitly)**: anything the agent can run itself is expressly NOT packaged as a wizard — "agent-doable steps are for the agent; the wizard is left for the clicks, approvals and back-office actions that won't be handed to the agent."
- **Script essentials**: stages with a confirmation gate at each stage, sensitive input hidden from echo, idempotent writes to `.env`, and a skip-items summary at the end.
- **Progress counts by stage** — never estimate time.
- **Self-check** the generated script with `bash -n` (syntax) and `shellcheck` (if available).
- **Inlined form**: the CoAgentHub skill is shipped as a single file (GET /api/skills/executor) and does not bundle the upstream template.sh library — the essentials above are inlined as "what the generated script must contain".

</wizard-rules>

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
- [ ] **判据指名事实(ADR-0009)**: 本次改动若引入或修改了用于分流/放行/拦截的**判据**(关键词表、模式匹配、阈值、计数),注释或 spec 中必须答出两句 —— ①这个判据在拿什么代替什么?②那个代替在什么条件下不成立?第②句写不出来通常意味着还没想清楚,而不是没有前提。同时确认:同一个事实**没有第二个判定出处**(两套判据一定会在某个输入上分叉,而分叉时没人在看)。
- [ ] **Bad smells**: self-check against Fowler's refactoring bad-smell vocabulary — mysterious name / duplicated code / feature envy / data clumps / primitive obsession / repeated switches / divergent change / speculative generality / message chains / middleman. The model carries priors on these; hit any → fix it. (The words themselves trigger the prior; the full vocabulary is listed here.)

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
- **L1 闭环硬约束 (hard constraint)**: if self-review leaves ANY unresolved finding on either axis (Standards or Spec), you MUST NOT send the completion callback. Fix every fixable finding first; send the callback only when both axes are clean — unresolved-and-flagged items (with reasons) may go in the report, but an unresolved finding that touches an acceptance criterion still blocks "done".

</review-rules>

### 5. Report

Output your report in the format specified by the task ticket. At minimum:

```
提交: <commit hash>
测试: <test results summary>
Token: <token count consumed by this run>
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

- **Redaction is the first action**: whenever you display or report commands, output, or captured artifacts, redact first —
  - credentials/tokens/secrets are always written `<REDACTED>`;
  - where an env var can carry a secret, don't write the credential into the script or output;
  - when quoting artifacts, cite only the signal-bearing lines — don't paste whole blocks.
- This constrains display/reporting only; it does NOT change the five-part report structure (提交/测试/Token/汇报/遗留) that the server parses.
- The Code Review 自检 section is MANDATORY in your output.
- Be honest. If something failed review, say so. The coordinator will verify anyway.
- Keep it concise. Don't paste full diffs — the coordinator can `git diff` themselves.

</report-rules>

### 6. Complete

After reporting, the task is in the coordinator's hands. They will verify and either:
- `✅ 验收通过` — task is done
- `❌ 验收未通过：<reason>` — you may be asked to retry

Do NOT mark the task as done yourself via `PATCH /tasks/:id` unless the task ticket explicitly says you should (detached mode — applies to CLI executors as well, not only a2a; the ticket declaring `## ReplyMode: detached` is what matters). The coordinator owns the final verdict.

## Constraints

- **Spec is law**: if a Spec Reference is present, it overrides your own preferences.
- **No scope creep**: fix/build ONLY what the task asks. Don't refactor unrelated code.
- **Self-review is mandatory**: never report done without completing the code review checklist.
- **Be honest**: if you can't do something, say so. Don't fake success.
- **Test everything**: if you wrote code, write tests. If you fixed a bug, write a regression test.
- **harness-neutral**: instructions you issue (and tool references in report prose) must not hard-code a specific harness's tool names or agent-type names. The `coagenthub_*` tool names and `coagenthub-*` skill names are the platform contract and are exempt.