# AC4 平台收尾验证报告（2026-10-04）

本文件只做**收尾验证与记录**：用本 Mission 隔离 worktree 的真实测试证据，逐条核对已经合入 master 的 AC4 实现。不重新实现功能，不补造历史平台记录。

## 1. 历史 Mission、基线与验证边界

| 项 | 事实 | 出处 |
|---|---|---|
| 历史 Mission 名 | **AC4**（仓库历史资料统一称 AC4；未发现更具体的权威 Mission ID，不猜测） | 提交系列 `mission(PLAN-harness-remaining-20261003-0307-AC4): W-442 … W-455 检查点`；`docs/direct-delivery-20261003.md:3` |
| AC4 内容 | 快车道机器验证通过后由协调者做 L2；reject 在同一协调者 attempt 晋升 Standard 并规划；accept 交 L3 | ADR-0004「修订（2026-09-30）：快车道加协调者验收」（写明「实现见统一计划 AC4、AC2」）；`.coagent/project.md` Lightweight 条目（2026-10-04 收尾验证） |
| master 基线 | **d4f39c8**（`merge: 按用户授权合入全部已完成前后端与文档成果（2026-10-04）`）；本 worktree HEAD 即该提交 | 本 worktree `git rev-parse HEAD` |
| 原 AC4 是否经平台验收 | **否**。AC4 是直接开发后合入 master，**不曾在原平台 Mission 里完成 L2 审查或平台验收** | `docs/direct-delivery-20261003.md:3`「用户明确要求『不走平台。你自己修改』……不伪造 MissionResult、L2 结论或 confirmedBy；真实 AC4 保持暂停」；`:15`「代码交付完成不等于真实平台记录 completed」；`.coagent/architecture/reviewer-runbook.md:101`「实际 AC4 仍保留原状态与基线，本次直接实施不伪造其平台交卷」 |

### 本次 Mission 的验证边界

- 本次是**独立 Mission**（分支 `mission/AC4-platform-closeout-20261004`，位于 `codex/communication-integration` 的嵌套 worktree），提供的是**收尾验证**：拿现有代码与本 worktree 实测，核对实现是否满足契约。**不能补造历史 AC4 的平台验收证据**，也不能把本票结论写成「历史 AC4 已平台验收」。
- 只改本文件（`docs/ac4-platform-closeout-20261004.md`）。不编辑 `src/`、`test/`、`.coagent/`、master、原 AC4 worktree、凭据或真实平台状态；不切分支、不合并、不回滚；不启动真实 agent。
- 只跑两条命令：`node --test test/orchestrator-lightweight.test.ts` 与 `node --test`。数字与退出码照本 worktree 真实输出抄录（见第 3 节）。
- 历史文档 `docs/direct-delivery-20261003.md` 记录的是**当初直接开发时的自测**，不是本票验证结果；两者数字不同（历史 2346 / 2339，本票 2365 / 2358），因为期间另有批次合入，测试总量变了。

## 2. 代码落点（既有实现，本票未改动）

| 关注点 | 位置 |
|---|---|
| 快车道分流：机器过了交协调者 L2，没过则凭报告升级 Standard；升级也失败才 stalled 并把两件事都说出来 | `src/application/orchestrator.ts:1180-1215` |
| L2 一跳（`#runLightweightL2Hop`）：复用 Standard 同一套处置与候选池，不续旧会话；交卷前过权威预算闸 | `src/application/orchestrator.ts:1280-1365` |
| 报告绑定与 reject 触发：`review.recorded` 记 criteria/contractRevision/attemptId；reject 时内部晋升 `coordinator_rejected`，保持当前协调者 attempt 在途以便同一 session 立刻 `updatePlan` | `src/application/platform/work-item-review.ts:53-115` |
| `requireLightweightReviewReport`：缺 submittedAttemptId / 缺报告 / `passed!==true` / mission-workItem-attempt 联动不符 / 被规模闸扣下，一律拒绝验收或交卷 | `src/application/platform/lightweight-submission.ts:14-85` |
| 协调者启动简报与工作项投影（快车道首跳把开跑至今活动压成摘要，standard 保持逐跳增量；工作项视图分级裁剪并深层脱敏） | `src/application/platform/agent-view-helpers.ts:200-240,620-690`；`src/application/platform/startup-brief.ts:120-170` |
| 触发码唯一表（含 `coordinator_rejected`、`validator_failure_unrepairable`） | `src/kernel/payloads.ts:97-125` |
| 规格口径 | `.coagent/specs/classified-intake-lightweight.md`（第 4 条：协调者 accept → `awaiting_review`，reject 同 attempt 晋升并规划）；`.coagent/specs/validation-review-authority.md`（机器报告不替代协调者结论）；`.coagent/specs/lightweight-standard-promotion.md`（升级凭据与失败口径） |

## 3. 实测命令与退出码（本 Mission worktree）

命令与退出码均为本 worktree 实际执行结果，未做任何修饰。

### 3.1 定向

```
node --test test/orchestrator-lightweight.test.ts
```

退出码 **0**。

```
ℹ tests 16
ℹ suites 9
ℹ pass 16
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 465.2617
```

### 3.2 全量

```
node --test
```

退出码 **0**。

```
ℹ tests 2365
ℹ suites 504
ℹ pass 2358
ℹ fail 0
ℹ cancelled 0
ℹ skipped 7
ℹ todo 0
ℹ duration_ms 130846.0322
```

7 条 skip 全部为既有 HAOFF1（skip 原因文本均为「HA 路暂时关闭（HAOFF1，2026-09-28），恢复 HA 分支时去掉 skip」）：

- `test/plan-driver.test.ts:1002` 打回后隔离重跑，第二条放行合入
- `test/plan-driver.test.ts:1308` 四项禁止副作用全 false 的 HA 用原始 facts 调 createClassifiedMission
- `test/plan-driver.test.ts:1334` HA 建单被平台拒绝时不回落 Standard，挂起并写明原因
- `test/plan-routing.test.ts:209` 事实判到 high_assurance 且禁止副作用全 false → 按 HA 建 classified
- `test/run-plan-wiring.test.ts:1699` 真 Git：方案 HA approve 受控合入，释放名额后 F2 合入
- `test/run-plan-wiring.test.ts:1994` 真实平台接线：合格 HA 等待决定，stop 保留 Mission
- `test/run-plan-wiring.test.ts:2177` 真平台：HA 待放行时 F2 无分类、会话或派发；skip 后释放名额再推进

结论：**fail = 0、skipped = 7 且均为既有 HAOFF1**，满足契约验收 4 的口径。

## 4. 契约五条验收逐条结论

| # | 验收 | 结论 | 证据位置 |
|---|---|---|---|
| 1 | L2 reject 在同一协调者 attempt 晋升 Standard 并立即规划 | 通过 | `test/orchestrator-lightweight.test.ts:348`（`L2 reject 同 attempt 转 Standard 并规划`）：`executionMode=standard`、工作项 `rejected`、`lastReview.verdict=reject` 且 attemptId 为该协调者、promotion 恰 1 条且 `triggerCode='coordinator_rejected'`、`plan` 等于测试给的 plan、`planRevision>0`、`review.recorded` 的 criteria 覆盖整份契约且 contractRevision 一致、`plan.updated` 排在 review 之后且同 attemptId。代码：`work-item-review.ts:53-115`（reject 内部晋升、保持 attempt 在途） |
| 2 | accept 才到 `awaiting_review`，且仍须 L3 才 `completed` | 通过 | `test/orchestrator-lightweight.test.ts:390`（`executor → 机器验收 → 同 Standard 候选池 L2 accept → awaiting_review；L3 finalize 才 completed`）：`result.kind='awaiting_l3_review'`、视图 `status='awaiting_review'` 且 `isMutating` 仍占名额、工作项 `accepted`、criteria 逐条 pass（证据含「整份工单 1 条验收全部 pass」）、执行者一跳 + 协调者一跳且只有执行者以 `structured_submit` 收尾、`mission_result.submitted` 与 `delivery.created` 归因真实 L2 attempt、交卷凭据等于落盘报告 id（`/^validation-report:VR-/`）、报告 `passed=true` 且 `attemptId` 等于当前提交 attempt、`finalizeMission` 后才 `completed`。代码：`orchestrator.ts:1280-1365`（`#runLightweightL2Hop` / `#submitIfL2Accepted`）、`platform/work-item-review.ts` |
| 3 | 机器验收失败凭报告晋升 Standard，升级失败才停下并把两件事都说出来 | 通过 | `test/orchestrator-lightweight.test.ts:537`（验收没过 → 自动升级 Standard）：promotion `triggerCode='validator_failure_unrepairable'`、触发规则里那份 `VR-` 报告 `passed=false`、执行者一跳 + 协调者一跳、协调者指令写明「从 Lightweight 升级上来的」并含报告 id、L2 由协调者下（`accepted`）；另 `test/orchestrator-lightweight.test.ts:566`（`升级不成（报告对不上当前这次提交）才停下，并把两件事都说出来`）：报告 attemptId 被改成别次提交时平台拒绝晋升，编排器 `stalled` 且原因同时写出「未通过，升级到 Standard 也失败了」与「不是工作项 W-1 当前这次提交的报告」，不产生协调者 hop。代码：`orchestrator.ts:1180-1215`、`lightweight-submission.ts:14-85`（联动校验与 `VALIDATION_LINKAGE_MISMATCH`） |
| 4 | 全量 `node --test`：0 fail，只允许 HAOFF1 既有 7 条 skip | 通过 | 见第 3.2 节真实输出：tests 2365 / pass 2358 / fail 0 / skipped 7，退出码 0；7 条 skip 逐个列出且均为 HAOFF1 |
| 5 | 机器报告不替代 L2/L3 权威；accept 绑定当前提交 | 通过 | `test/orchestrator-lightweight.test.ts:390` 起：`lastReview.submittedAttemptId` 等于当前 executor 提交 attempt，报告 `missionId/workItemId/attemptId` 三方一致；`test/orchestrator-lightweight.test.ts:1074`（`答复后新 executor attempt 用同一 WorkItem，机器验收后 L2 accept 交 L3`）验证 accept 绑协调者 attempt、验的是答复之后新建的 executor attempt 而非提问那一跳（`lastReview.submittedAttemptId` 等于 `execHops[1]`、不等于 `execHops[0]`）。崩溃恢复场景（`test/orchestrator-lightweight.test.ts:593` `机器已验断定后恢复：不重跑命令，直接同一份报告走 L2 accept`）不重跑命令、直接取同一份报告走 L2 accept。代码：`lightweight-submission.ts:14-85`、`kernel/payloads.ts:97-125`（触发码唯一表）、`.coagent/specs/validation-review-authority.md` |

## 5. 未验证 / 遗留

- 本票只做**代码层**核对。常驻服务未启动、真实平台状态未改动，因此「AC4 行为在真实运行中生效」不在本票验证范围内（沿用 `docs/backend-remaining-delivery-20261004.md:21` 的边界口径：服务 3101 保持停止，新代码没有部署到真实状态单写者）。
- 历史 AC4 没有平台 L2 审查或验收记录，本票**不**为其补写；需要历史验收结论时应另由 L3 走既有入口处理。
- 全量耗时约 131 秒（本机实测），比历史记录的 186 秒短；差异来自机器与批次内容，不作为质量判据。
- 全量输出曾落在本 worktree 的 `.full-test-20261004.log` 供比对 skip 明细，核对完成后已删除；`.gitignore` 未覆盖这类临时日志，因此本票不把它留在工作区、也不提交。
