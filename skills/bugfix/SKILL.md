---
name: coagenthub-bugfix
description: Handle bug reports on CoAgentHub — triage and fix orchestration now live in the reviewer (triage) and coordinator (dispatch/verify) skills; this file is the index into them. Use when the user reports something is broken or behaving incorrectly.
---

# CoAgentHub Bugfix

You are handling a **bug report** on CoAgentHub. Bug triage and fix orchestration have moved into the three-role workflow (reviewer → coordinator → executor + three-layer review). **Do NOT re-implement the old five-step process here** — this file is an index into the owning skills. Follow the roles below.

## 入口 (Entry)

Bug reports reach the **reviewer** first — the user-side single entry point. Hand the report to the reviewer (if you ARE the reviewer, follow the triage flow in the reviewer skill).

## 索引 (Index)

| 旧职责 | 现在在哪 | 指引 |
|--------|---------|------|
| Triage / 需求分流（大需求 vs 小 bug） | **reviewer** skill — `### 2. Triage Requirements` | 小 bug：**不新增、不更新 spec**，直接请协调者下发修正任务（可引用相关既有 `specRef` 作为上下文）；仅当 bug/修复影响 spec 描述时才修订 spec（版本 +1，公布 `spec_amended`） |
| Diagnose / 定位根因 | **reviewer** skill 的分流职责（复现/定位纪律） | 根因定位纪律见 reviewer skill；协调者不再自行诊断 |
| To-Fix-Spec → 方案描述 | **coordinator** skill — `### 2. Dispatch` | **不落 `specs/`**：方案描述直接进任务书 body；仍需 reviewer 冻结的 `specRef`（小 bug 引用相关既有 spec） |
| Dispatch | **coordinator** skill — `### 2. Dispatch`（含 `2.1 Dispatch 纪律`、`2.2 限额处理`） | 按 `specRef` + `specHash` 下发，一票一个内聚关注点 |
| Verify | **coordinator** skill — `### 4. 验收编排`（L2 → L3 → 裁决 → 结案） | 三层检视闭环；L2 未过直接重下发，L2 通过后下发 L3 检视任务 |

## Constraints

- 以 **reviewer**（分流 / spec）与 **coordinator**（dispatch / verify）两个 skill 为权威来源；本文件仅作索引，不重复造流程。
- **Regression test is mandatory**: the fix must include a test that would have caught the original bug（该约束由 executor skill 的执行纪律承接）。
- **harness-neutral**: instructions issued to dispatched executors/subagents must not hard-code a specific harness's tool names or agent-type names. The `coagenthub_*` tool names are the platform contract and are exempt.
