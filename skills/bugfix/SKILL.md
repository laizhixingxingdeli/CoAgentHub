---
name: coagenthub-bugfix
description: Diagnose and fix bugs through CoAgentHub — reproduce, isolate root cause, write a fix spec, dispatch to executors, then verify the bug is gone. Use when the user reports something is broken or behaving incorrectly.
---

# CoAgentHub Bugfix

You are a **coordinator** handling a bug report on CoAgentHub.
Your job: reproduce the bug, isolate the root cause, write a precise fix spec, dispatch to an executor, and verify the fix.

## Prerequisites

- CoAgentHub server running (`http://localhost:3001/api`).
- Registered as a participant with `coordinator` role in a group.
- Participant ID in `~/.coagenthub/participant-id` or `COAGENTHUB_PARTICIPANT_ID` env var.

## Process

### 1. Triage — 快速分类

First, determine the bug's severity and type:

```
❓ Is this a crash, wrong behavior, or performance issue?
❓ Can the user reproduce it? What are the exact steps?
❓ When did it start? What changed recently? (git log --oneline -10)
❓ Is there an error message, stack trace, or log output?
```

Classify:
- **Crash** (500/error/throw) → go to step 2A
- **Wrong behavior** (logic error, output mismatch) → go to step 2B
- **Performance** (slow, timeout) → go to step 2C
- **Can't reproduce** → ask for more info, do NOT dispatch yet

### 2. Diagnose — 定位根因

This is YOUR job, not the executor's. You must find the root cause before writing the fix spec.

#### 2A. Crash Diagnosis

```
1. Find the error in logs: grep for the error message / stack trace
2. Trace the call chain: which route → which function → which line
3. Identify the exact failure point
4. Note: what input triggers it? what's the expected vs actual output?
```

#### 2B. Wrong Behavior Diagnosis

```
1. Reproduce: write the exact steps that trigger the wrong behavior
2. Trace: find where the logic diverges from expected
3. Isolate: narrow down to the specific function/condition that's wrong
4. Note: what should happen vs what actually happens
```

#### 2C. Performance Diagnosis

```
1. Measure: what's the current response time / memory usage?
2. Profile: where is the bottleneck? (DB query, N+1, sync loop, large payload)
3. Note: what's the target performance? what's the bottleneck?
```

<diagnosis-rules>

- Explore the codebase yourself. Read the relevant source files.
- Find the EXACT line or condition that causes the bug.
- Do NOT guess. If you can't find the root cause, say so and ask the user for more info.
- Document your findings with: file path, function name, line number, what's wrong.

</diagnosis-rules>

### 3. To-Fix-Spec — 写修复规范

Write a fix spec in `specs/`. This is shorter than a feature spec — it's a surgical description of what's broken and how to fix it.

<fix-spec-template>

# Fix Spec: <bug title>

> **状态**: Ready for Fix
> **日期**: <date>
> **严重程度**: critical | high | medium | low

## Bug 描述

What's broken, in one paragraph.

## 复现步骤

1. <exact step>
2. <exact step>
3. Observe: <wrong behavior>

## 期望行为

What should happen instead.

## 根因分析

- **文件**: <file path>
- **函数**: <function name>
- **问题**: <what's wrong, precisely>
- **原因**: <why it's wrong>

## 修复方案

What to change, precisely. Not a vague "fix the bug" — a specific description:
- Change condition X from A to B
- Add null check before calling Y
- Fix the off-by-one in loop Z

## 验收标准

- [ ] Bug no longer reproduces with the original steps
- [ ] Existing tests still pass (no regression)
- [ ] New test added that covers the bug case (prevents regression)
- [ ] No new warnings or errors in the output

## 不涉及的改动

- Do NOT refactor unrelated code
- Do NOT change the API interface
- Fix ONLY this bug, nothing else

</fix-spec-template>

### 4. Dispatch — 下发修复任务

Call `coagenthub_dispatch_task` with:
- `specRef`: path to the fix spec
- `body`: the fix instructions (reference the root cause and fix plan)
- `executorName`: the executor to use
- `acceptance`: extracted from the fix spec

<dispatch-rules>

- Bug fixes are usually small and focused — one task per bug.
- If the fix touches multiple files across layers, it's still one task (vertical slice).
- Use `planOnly: true` to preview before sending.
- Include the reproduction steps in the body so the executor can verify.

</dispatch-rules>

### 5. Verify — 验证修复

When the executor reports completion:

<verification-rules>

1. Pull task details: `coagenthub_get_task` — check `diffSummary` and `outputTail`.
2. **Reproduce check**: Does the original reproduction plan still trigger the bug?
   - If the executor added a test, check that the test covers the bug case.
   - If no test was added, ask the executor to add one (regression prevention).
3. **Regression check**: Run the full test suite. Any new failures?
4. **Scope check**: Did the executor change anything beyond the fix? Reject unrelated changes.
5. **文档同步检查** — Bug 修复通常不需要更新文档，但如果：
   - 修复改变了 API 行为 → 更新 `docs/architecture.md` §4
   - 修复涉及架构层面的根因 → 新建 `docs/adr/000X-xxx.md`
   - 修复改变了开发流程 → 更新 `AGENTS.md` / `CONTEXT.md`
6. Verdict:
   - Bug gone + no regression + docs in sync → `✅ 修复验证通过`
   - Bug still exists → `❌ 未修复：<reproduction result>` → retry
   - Bug gone but regression → `❌ 引入回归：<failing test>` → retry
   - Bug gone but docs out of sync → `❌ 文档未同步：<具体文件>` → retry

</verification-rules>

## API Reference

Same as `coagenthub-coordinator` skill. Key tools:

| Action | Tool |
|--------|------|
| Dispatch fix task | `coagenthub_dispatch_task` (with specRef) |
| Check fix result | `coagenthub_get_task` |
| Post verification | `coagenthub_post_message` |

## Constraints

- **No dispatch without diagnosis**: You must find the root cause first. "Try to fix the crash" is not a valid task body.
- **No dispatch without fix spec**: The specRef is mandatory.
- **Fix scope is narrow**: Bug fixes should NOT include refactoring, new features, or style changes.
- **Regression test is mandatory**: The fix must include a test that would have caught the original bug.
- **Verify before closing**: Never mark a bug fix done without confirming the bug is actually gone.