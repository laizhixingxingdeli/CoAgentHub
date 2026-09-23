# 机器 L3：合进集成分支，在合并结果上验证，红则回滚

`Platform.finalizeMissionByMachine` 是**机器放行**的唯一入口；`Platform.abandonMissionForPlan` 是**方案运行放弃失败 Mission** 的唯一入口。两者都是可信内部入口，不接 HTTP、不进 agent tools。公开的 `finalizeMission` 只发人类权威。

## 可观察边界

- **前置（任一不满足就拒绝，什么都不合）**：Mission 在 `awaiting_review`（`NOT_AWAITING_REVIEW`）；不是 `high_assurance`——合并永远要人（`HIGH_ASSURANCE_NEEDS_HUMAN`）；集成命令表非空，没有新证据的放行只是把 validator 那份又数一遍（`MACHINE_FINALIZE_NEEDS_VERIFICATION`）；注入了 `commandRunner` 与 `reports`，缺了 fail-closed 而不是退化成不验直接合（`MACHINE_FINALIZE_UNAVAILABLE`）。三种装配（`buildPlatform` 带 workspace、`buildPersistentPlatform`、`buildPgPlatform`）都注入 `commandRunner`。
- **钉分支**：项目仓当前分支必须等于调用方声明的集成分支，否则 `INTEGRATION_BRANCH_MISMATCH`，不合、不跑验证。合并目标取自「当时 checkout 的分支」，不核对的话，中途有东西切回 master，后续功能会静默合进 master。**master 全程不动。**
- **锚点先落事件**：合并前把集成分支 HEAD 写成 `final_review.integration_anchor` 事件——进程死在「已合并、未验证」之间时，得有东西知道退回哪。
- **合并**沿用落地闸：目标 HEAD 必须等于 Mission 的分叉基线，目标工作区必须干净（**未跟踪文件也算**）。合不进去 → Mission **留在 `awaiting_review`**，`waitReason = waiting_l3`，事件 `final_review.merge_failed`（authority machine）；不写 FinalReview、不跑验证、集成分支不动。
- **验证夹在 merge 与 complete 之间**：在合并结果（项目仓）上逐条跑集成命令，产出 durable `ValidationReport`（id 前缀 `IVAL`），事件 `final_review.integration_verified`。`completed` 没有出边，先 complete 再验，红了就只能退 git、退不了状态。
- **绿** → `completed`，`FinalReview.authority = { kind: 'machine', integrationReportId, policyRevision }`，回收工作区。
- **红** → 退回锚点：只在集成分支仍停在我们合出来的那个 commit 上时才 `reset --hard`，否则拒绝退——宁可留一个没验过的合并让人看，也不悄悄抹掉别人的提交。Mission **留在 `awaiting_review`**（机器判不了不等于这条完了）；退回成功时返回 `rolledBackTo`，退回失败时只有 `reportId` 没有 `rolledBackTo`（调用方据此判「集成分支不安全」）。
- **方案放弃**（`abandonMissionForPlan`）：只发 `abandon`，永不放行。必须指向 `planRunId` 与 `escalationId` 并写理由（`PLAN_ABANDON_INVALID`）；已终结的拒绝（`MISSION_ALREADY_TERMINAL`）。Mission → `blocked`，**释放项目的改动名额**；`FinalReview.authority = { kind: 'plan', planRunId, escalationId }`——检视者选的动作还是等过了期，记在那张升级单上。回收工作区前先把未提交的产出提交到 Mission 分支，**分支保留**给人看。
- **为什么非放不可**：名额的判据是「动过代码且没到终态」。验证红了、合并失败了、协调者卡住了的 Mission 都停在非终态，不放掉，方案里后面的功能一个都派发不了。
- **权威三分**：`human`（公开 `finalizeMission`，`principalId` 可缺）/ `machine`（只由本入口在集成验证通过后发）/ `plan`（只用于方案放弃）。公开入口收到非 human 一律 `FINAL_REVIEW_AUTHORITY_FORBIDDEN`。

## 非目标

- 不决定**何时**放行、放弃——那是方案驱动（`plan-run`）的事。
- 不向 master 或任何非集成分支合并；集成分支 → master 仍由人放行（ADR-0004）。
- 不重试红的验证：红就是红，flake 要在测试侧修。
- 不处理 high_assurance。

## 权威源 / 测试

- 源：`src/application/platform.ts`（`finalizeMissionByMachine` / `abandonMissionForPlan` / `finalizeMission`）、`src/application/workspace.ts`（`currentBranch` / `resetTarget` / `mergeToTarget`）、`src/kernel/payloads.ts`（`FinalReviewAuthority`）、`src/main.ts`（`commandRunner` 接线）
- 测试：`test/machine-finalize.test.ts`、`test/final-review.test.ts`、`test/run-plan-wiring.test.ts`
