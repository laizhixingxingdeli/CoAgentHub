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

下表 1–5 与 Mission `AC4-platform-closeout-20261004` 契约验收 1–5 一条对一条；结论均为本 Mission worktree 上的既有代码与既有测试核对，本票**未新增功能、未新增测试、未改动 `src/` 与 `test/`**。

| # | 验收 | 结论 | 证据位置 |
|---|---|---|---|
| 1 | 机器验证通过后起 Standard 同候选池的协调者 hop，由既有 review 工具下 accept/reject 结论；accept 走正常合并交 L3 的路径，reject 在同一协调者 attempt 晋升 Standard 并规划；`coordinator_rejected` 在唯一权威触发码表里；criteria 缺省覆盖全契约并在既有 AC1 计数里只记一次 | 通过 | **起跳与 accept 路径**：`test/orchestrator-lightweight.test.ts:389`（`executor → 机器验收 → 同 Standard 候选池 L2 accept → awaiting_review；L3 finalize 才 completed`）——执行者一跳 + 协调者一跳，`view.coordinatorAttemptIds` 等于 coordinator hops 的 attemptId 列表（同一 `#coordinator` 池），`result.kind='awaiting_l3_review'`、视图 `status='awaiting_review'` 且 `isMutating` 仍占名额、工作项 `accepted`、`criteria` 逐条 pass（证据文本含「整份工单 1 条验收全部 pass」），`finalizeMission` 之后才 `completed`。**reject 路径**：`test/orchestrator-lightweight.test.ts:348`（`L2 reject 同 attempt 转 Standard 并规划`）——`executionMode=standard`、工作项 `rejected`、`lastReview.verdict=reject` 且 attemptId/plan 更新的 attemptId 都是那一个协调者 attempt（`coordinatorAttemptIds.length===1`）、promotion 恰 1 条且 `triggerCode='coordinator_rejected'`、`plan` 等于同一 session 里 `coagent_update_plan` 提交的那份、`planRevision>0`、`plan.updated` 排在 `review.recorded` 之后。**criteria 缺省覆盖全契约**：同一用例断言 `review.recorded` 的 `criteria` 等于 `[1]`（契约全量），`contractRevision` 与 Mission 一致——快车道工单不写 criteria，缺省按整份契约展开。**唯一触发码表与 AC1 计数**：`src/kernel/payloads.ts:97-125`（`PROMOTION_TRIGGER_CODES` 唯一清单含 `coordinator_rejected`、`validator_failure_unrepairable`）；`src/application/orchestrator.ts:1280-1365`（`#runLightweightL2Hop` 注释明确不再重复晋升，「重复晋升会把『打回了一次』记成两次，AC1 的连续失败也被多算一次」）。**协调者简报含工单/证据/报告**：`src/application/platform/startup-brief.ts:120-170`（协调者 attempt 才装配 `workItemsIndex` + `sinceLastHop`，含 contract/plan/workItem 与契约核对结论）；`src/application/platform/agent-view-helpers.ts:200-240`（快车道首跳无从算「上一跳增量」，改为把开跑至今的活动压成摘要：已提交结果、证据、机器验证报告；standard 保持逐跳增量）。<br>**本票边界**：上述是代码与测试层面的核对，**本票没有执行合并动作**，accept 之后的合并需由 L3 走既有入口（测试里也是用 `finalizeMission` 代表这一步） |
| 2 | 机器验证失败照旧转 Standard（凭据是平台存下的那份报告） | 通过 | `test/orchestrator-lightweight.test.ts:537`（`报告存下 → 凭它升级 → 协调者带着原因接手做 L2 → 交卷等 L3`）：promotion `triggerCode='validator_failure_unrepairable'`、触发规则里那份 `VR-` 报告 `passed=false`、执行者一跳 + 协调者一跳、协调者指令写明「从 Lightweight 升级上来的」并含报告 id、L2 由协调者下（`accepted`）、结果回到 `awaiting_l3_review`。另 `test/orchestrator-lightweight.test.ts:566`（`升级不成（报告对不上当前这次提交）才停下，并把两件事都说出来`）：报告 attemptId 被改成别次提交时平台拒绝晋升，编排器 `stalled` 且原因同时写出「未通过，升级到 Standard 也失败了」与「不是工作项 W-1 当前这次提交的报告」，不产生协调者 hop。代码：`orchestrator.ts:1180-1215`（`validated.passed && !held && !gate` 才走 L2 hop；否则 `promoteLightweightAfterValidation`，失败才 stalled）、`platform/lightweight-submission.ts:14-85`（联动校验与 `VALIDATION_LINKAGE_MISMATCH`） |
| 3 | 已有两条关键测试覆盖 accept/reject 两条路径 | 通过（沿用既有测试，**本票未新增测试**） | accept → `awaiting_review`、L3 才 `completed` 的正常合并门禁：`test/orchestrator-lightweight.test.ts:389`（见本表第 1 行同名的那条用例，含几百行视图/events/报告三方核对）。reject → 同 attempt 晋升 Standard 并规划：`test/orchestrator-lightweight.test.ts:348`。两条都在本次定向命令里实跑通过，见下方“定向命令实跑（本轮复核）” |
| 4 | 全量 `node --test`：0 fail，只允许 HAOFF1 既有 7 条 skip | 通过 | 见第 3.2 节真实输出：tests 2365 / pass 2358 / fail 0 / skipped 7，退出码 0；7 条 skip 逐个列出且 skip 原因均为既有 HAOFF1 |
| 5 | 产出本收尾报告，并写清历史 Mission 边界 | 通过 | 报告即本文件。第 1 节写明历史 Mission 按仓库资料为 **AC4**、master 基线 **d4f39c8**（本 worktree HEAD 是它的后代已核）、原任务**未**获平台验收；第 2 节列代码落点；第 3 节原样抄录本 worktree 两条命令（`node --test test/orchestrator-lightweight.test.ts`、`node --test`）的真实数字与退出码；第 4 节即本表逐条结论；第 5 节列未验证项。本票只改本文件，不新增功能、不声称「原 Mission 已平台验收」、不补造历史提交或平台记录 |

### 定向命令实跑（本轮复核）

本 pwd（`.../.coagent-worktrees/AC4-platform-closeout-20261004`，HEAD `cf9832f`，`d4f39c8` 为其祖先）执行：

```
node --test test/orchestrator-lightweight.test.ts
```

退出码 **0**，`tests 16 / suites 9 / pass 16 / fail 0 / cancelled 0 / skipped 0 / todo 0`，`duration_ms 457.4829`。三个关键场景点名通过：`L2 reject 同 attempt 转 Standard 并规划`（reject 路径）、`executor → 机器验收 → 同 Standard 候选池 L2 accept → awaiting_review；L3 finalize 才 completed`（accept 路径）、`报告存下 → 凭它升级 …` 与 `升级不成 … 才停下`（机器验证失败回退）。

本轮不再跑全量：第 3.2 节那份 `2365 / 2358 / 0 / 7`、退出码 0 的结果（W-460.exec-2 的 E-1436 与 VR-158）继续有效。

## 5. 未验证 / 遗留

- 本票只做**代码层**核对。常驻服务未启动、真实平台状态未改动，因此「AC4 行为在真实运行中生效」不在本票验证范围内（沿用 `docs/backend-remaining-delivery-20261004.md:21` 的边界口径：服务 3101 保持停止，新代码没有部署到真实状态单写者）。
- 历史 AC4 没有平台 L2 审查或验收记录，本票**不**为其补写；需要历史验收结论时应另由 L3 走既有入口处理。
- 全量耗时约 131 秒（本机实测），比历史记录的 186 秒短；差异来自机器与批次内容，不作为质量判据。
- 全量输出曾落在本 worktree 的 `.full-test-20261004.log` 供比对 skip 明细，核对完成后已删除；`.gitignore` 未覆盖这类临时日志，因此本票不把它留在工作区、也不提交。
