# Plan: 明确 diffSummary 的数据归属

> 配套 `specs/diffsummary-ownership.md`。spec 冻结后 `specHash` 作验收锚点；**本文件会变**（回填 taskId、标完成），不要写入 specs/。
> 路径规则：`specs/<name>.md` → `plans/<name>.md`（从 `specRef` 推得）。
> 平台不解析本文件。计划是提示，**task 事实是权威**。

## 元信息

| 字段 | 值 |
|---|---|
| specRef | `specs/diffsummary-ownership.md` |
| specHash | |
| 编制 | 三方 |
| 更新 | 2026-09-09 |
| 来源 | 检视者需求下达 `req-s2-diffsummary`；报告 §5 S2 |
| 编制角色 | 协调者（技术负责人）§4–§5；**未冻结、未派发** |

## 先做哪一步、为什么

`diffSummary` 是**所有终态与中途调度写路径的汇合点**。若先改各路径的
写法、后定义所有权，中间态会出现「一半路径按新规则合并、一半仍整体替换」，
无法对「不同所有者不能互相覆盖」做端到端验收。

因此顺序强制为：

1. **W1 先建归属表 + 单一合并入口 + 纯函数单测**（不改任何写路径）——
   此时可验收「合并语义本身」；
2. **W2 再把写路径逐个改接到该入口，并删除路径上的 preserve 链**——
   此时可验收「新增字段不再需要多路径 preserve 补丁」；
3. **W3 最后钉 API / 完成事件 / 前端读取形状与历史 JSON**——
   验收必须读到最终产物（响应体、WS 载荷、页面消费的键），不能停在
   merge 函数返回值。

不可把 W1/W2 合成一张票：W1 失败时 W2 的路径改动会 simultaneous 变红且
无法归因；也不可先做 W3 夹具再改合并语义（会把旧形状锁成通过）。

## 现状摘要（编制时读过的实现）

| 区域 | 路径 | 发现 |
|---|---|---|
| 终态写 | `executor-task/queue.ts` done / `failTask` / cancel / waiting / alert / transient | 整体替换后链式 `preserveDispatchKindNote` + `preserveRollbackSkipped`；**不保留** `platform.*`、`stallAlerted` 等 |
| PATCH 结案 | `routes/group/tasks.ts` | 同款双 preserve + `mergePlatformTokenFields` + 多处平台补写（`l1Bypass` / `claimVerification` / `staleBuildSuspected` / `outputTail` / `liveOutputTail` / 额度键） |
| 取消 | `executor-task/notify.ts` `markTaskCancelled` | **只** preserve `dispatchKindNote`，**漏** `rollbackSkipped` / `platform` |
| 回滚控制 | `lib/control.ts` | `diffSummary: { error: "rollback" }` **整袋抹掉**既有字段 |
| 孤儿收敛 | `lib/orphan-task-reconciler.ts` | 以既有为底合并（正确方向，但与 queue 终态策略不一致） |
| queued 可见性 | `executor-task/queued-task-reclaim.ts` | `writeQueuedDiffSummary` 已 base-merge + 双 preserve |
| 属主 pid | `queue.registerTaskOwnerServer` | 写入 `platform.ownerServerPid`；随后 CLI done 若整体替换会丢 |
| 续跑 | `executor-task/coordinator-resume.ts` | `platform.resumeOf` / `resumeForChild` / `closeGuardResume` |
| 调度意图 | `executor-task/dispatch-intent.ts` | **独立表** `dispatch_intent` 结算，**不**往 `diffSummary` 堆字段（与需求叙述略有偏差，见草案异议） |
| 协调活动 | `lib/coordination-activity.ts` | 写入 `task.dispatchAudit`，不碰 `diffSummary` |
| 前端读 | `TaskPanel.tsx`、`group-tasks-by-spec.ts`、`requirement-layer-state.ts`、`merge-requirement-timeline.ts` | 扁平键：`hash`/`error`/`stallAlerted`/`unconfirmed`/`review_request`/`platform.resumeOf`/`retries`/`noExecutionReason`/`liveOutputTail` |

已存在的「按字段打补丁」：

- `preserveDispatchKindNote` / `preserveRollbackSkipped`（`types.ts`）
- `mergePlatformTokenFields`（同文件）
- `platform.*` 命名空间（续跑 / L3 并入 / 属主 pid）——**半套所有权，未推广**

## 工作项

> **工作项 ≠ task**：工作项 = 要完成的事；task = 一次执行。重派的多个 task 可属同一工作项。
> **未派发工作项不得伪装成 queued task。**

### W1 — 归属表 + `mergeDiffSummary` 单一入口（纯函数）

| 字段 | 内容 |
|---|---|
| 稳定编号 | W1 |
| 目标 | 把「谁拥有哪些键、合并时谁不能覆盖谁」写成可执行的注册表与唯一合并函数；用单测钉死语义，**尚不改**生产写路径。 |
| 范围 | 新建（建议）`packages/backend/server/src/lib/executor-task/diff-summary.ts`（或等价模块）：字段→所有者注册表、`mergeDiffSummary(existing, patch, owner)`、`platform` 深合并、未知键归写入方所有者；既有 `preserve*` / `mergePlatformTokenFields` 可改为对该入口的薄封装（保持导出符号，避免无关测试大面积改 import）。**不**改 queue/PATCH/orphan/control 的调用点。**不**改 schema / API 路由形状。**不**改 `review_request` 载荷字段。 |
| 前置依赖 | 无 |
| 预期产物 | 归属表（与 spec §3 一致）；`mergeDiffSummary`；单测文件（新建，如 `test/diff-summary-merge.test.ts`）；可选：既有 preserve 单测仍绿（若改为委托）。 |
| 验收方法 | `cd packages/backend/server && npx vitest run test/diff-summary-merge.test.ts`（及若改了委托：`test/dispatchKindNote-preservation.test.ts`）。构造：所有者 `result` 写入 `{ summary }` 不得丢掉既有 `platform.resumeOf` / `dispatchKindNote` / `tokenUsage`；所有者 `scheduling` 写入新键 `queuedBlocked` 不得丢掉 `hash`；同所有者可覆盖自身键；`platform` 深合并保留 `resumeOf` 同时写入 `ownerServerPid`；显式 `null` 仅对**本所有者**键生效。 |
| specRef | `specs/diffsummary-ownership.md` |
| specHash | |
| taskId | _未派发_ |
| 状态 | planned |

### W2 — 全部 diffSummary 写路径改接单一合并入口

| 字段 | 内容 |
|---|---|
| 稳定编号 | W2 |
| 目标 | 生产路径不再「整体替换 + 链式 preserve」；新增平台字段只需在**一处**按所有者写入，其它终态路径自动保留。 |
| 范围 | 改接并删除路径内联 preserve 链：`queue.ts`（done / failTask / cancel / waiting / alert / transient 等）、`notify.markTaskCancelled`、`routes/group/tasks.ts` PATCH 结案合并段、`queued-task-reclaim.writeQueuedDiffSummary`、`orphan-task-reconciler`、`control.ts` 回滚写。统一：读既有 → `mergeDiffSummary(..., owner)` → 落库。演示验收用：在 scheduling 所有者下新增**测试专用**或真实的一个已规划键的写入，**不**新增第三个 `preserveX`。`preserveDispatchKindNote` / `preserveRollbackSkipped` 若仍导出，仅作 deprecated 委托，**写路径不得再直接依赖它们完成正确性**。不做 S1 状态机、不做 S4 拆文件、不建新表。 |
| 前置依赖 | W1 |
| 预期产物 | 上述文件的写路径改动；路径级回归测试（扩展既有 `task.test.ts` / `orphan-task-reconciler.test.ts` / `executor-queued-reclaim.test.ts` / `dispatchKindNote-preservation.test.ts` / `retry-rollback-guard.test.ts` / `second-instance-sweep.test.ts` 等，按改动触及补断言）。 |
| 验收方法 | 票面列出的 server 测试文件（见 spec 基线清单）定向 `npx vitest run`。构造场景至少：① spawn 写入 `platform.ownerServerPid` 后 CLI/队列 `done`/`failed`，读库仍有该 pid；② 先有 `dispatchKindNote`+`rollbackSkipped`，`markTaskCancelled` 与 `control` 回滚后两者仍在（回滚可覆盖 `error`）；③ PATCH 只带 `summary`+`review_request`，既有 `tokenUsage` 与 `platform.resumeOf` 仍在；④ 在**单一** scheduling 写入点增加字段后，done/fail/PATCH/cancel **均**无需新 preserve 函数即可保留该字段（用单测证明：grep 写路径无新的 `preserveFoo`）。 |
| specRef | `specs/diffsummary-ownership.md` |
| specHash | |
| taskId | _未派发_ |
| 状态 | planned |

### W3 — 历史 JSON、API 与页面形状回归

| 字段 | 内容 |
|---|---|
| 稳定编号 | W3 |
| 目标 | 合并与路径改动不改变对外扁平形状；历史两种 `review_request` 形态与既有前端读键仍可用。 |
| 范围 | 夹具：历史扁平 `diffSummary`（含顶层 `type:"review_request"` 与嵌套 `review_request`、旧无 `platform` 块、仅有 token 字段等）经 merge 往返后 API 序列化键集合兼容；断言 `GET /groups/:id/tasks/:taskId`、`task_status_changed` WS 载荷、completion event 信封中的 `diffSummary` 仍为**单层对象**（`platform` 子对象保持既有约定）；前端既有测试不改断言语义即可通过（若键路径变了则本票失败）。**不**改前端业务代码，除非发现只读适配 bug（应回退服务端以保兼容）。 |
| 前置依赖 | W2 |
| 预期产物 | server 侧历史夹具测试（可放 `test/diff-summary-compat.test.ts`）；必要时补强 `task-completion-events` / `task-status-ws` 对关键键的断言；前端清单内测试保持全绿。 |
| 验收方法 | server：`npx vitest run test/diff-summary-compat.test.ts test/task-completion-events.test.ts test/task-status-ws.test.ts`（及 W2 清单回归）。前端：`node scripts/test-baseline.mjs` 同清单，对 `TaskPanel` / `group-tasks-by-spec` / `merge-requirement-timeline` / `requirement-workspace` 对比编制基线（81 passed / 0 failed）。最终产物：至少一次读 **HTTP JSON** 或 **WS 事件** 里的 `diffSummary.hash` / `error` / `review_request` / `platform.resumeOf`，不得只断言 merge 纯函数。 |
| specRef | `specs/diffsummary-ownership.md` |
| specHash | |
| taskId | _未派发_ |
| 状态 | planned |

## 依赖图

```
W1 → W2 → W3
```

## 基线（编制时实测）

commit `22f7045c`；平台 win32；node v24.13.0；时间 2026-09-09。

### Server（`packages/backend/server`）

```
node scripts/test-baseline.mjs --json packages/backend/server \
  test/dispatchKindNote-preservation.test.ts \
  test/retry-rollback-guard.test.ts \
  test/task.test.ts \
  test/detached-token-backfill.test.ts \
  test/orphan-task-reconciler.test.ts \
  test/executor-queued-reclaim.test.ts \
  test/coordinator-resume.test.ts \
  test/second-instance-sweep.test.ts \
  test/findings-dispatchKind-regression.test.ts \
  test/l3-per-spec.test.ts \
  test/coordination-close-integrity.test.ts \
  test/l2-claim-adjudication.test.ts \
  test/claim-verification.test.ts \
  test/token-usage.test.ts \
  test/task-completion-events.test.ts \
  test/executor-queue.test.ts \
  test/dispatch-intent-persist.test.ts \
  test/task-status-ws.test.ts \
  test/task-output-detail.test.ts
```

结果：**357 passed / 11 failed / 370 total**（文件 14 passed / 5 failed / 19）。

已知失败（与本票无关的既有红，W2/W3 不得以「顺便修」扩大范围，除非挡住本票验收；若挡住则另开 fix 或在 L2 注明）：

- `detached-token-backfill.test.ts` — 协调者进程内 PATCH 结案 token 补写
- `task-output-detail.test.ts` — R5 404 说明
- `retry-rollback-guard.test.ts` — 验收#3 无效 ref
- `coordinator-resume.test.ts` — 7 条（任务书文案 / supersedes 推断）
- `task.test.ts` — PATCH failed 额度冷却落库
- `claim-verification.test.ts` — 窗口起点后存在提交

### Frontend（`packages/frontend/web`）

```
node scripts/test-baseline.mjs --json packages/frontend/web \
  src/pages/app/groups/messages/TaskPanel.test.tsx \
  src/components/layout/context-panel/group-tasks-by-spec.test.ts \
  src/components/layout/context-panel/merge-requirement-timeline.test.ts \
  src/components/layout/context-panel/requirement-workspace.test.tsx
```

结果：**81 passed / 0 failed / 81 total**（4 files）。

## 诊断（Bug / 修复票；本票为 requirement，此段作风险记录）

| 字段 | 内容 |
|---|---|
| 现象 | 终态路径靠逐字段 preserve 链式补丁；新字段必须改多处 |
| 期望行为 | 单一合并入口 + 字段所有权；跨所有者不覆盖；API 扁平形状不变 |
| 已观察事实及证据位置 | `types.ts:277-346` 双 preserve + token merge；`queue.ts:644-647` 等链式调用；`notify.ts:128` 只 preserve 一字段；`control.ts:265` 整袋替换；orphan 以 base merge（策略分裂） |
| 根因假设 | 无所有者模型；写路径默认整体替换 |
| 被排除的假设 | 「R4 dispatch_intent 把结算字段堆进 diffSummary 导致链变长」——`5074ed7c` 实际落在独立表 `dispatch_intent`，不解释 preserve 链变长 |
| 建议修复范围 | 见 W1–W3；不做新表、不做 S1/S4 |
| 不能改变的行为 | 对外 `diffSummary` 扁平键；`review_request`/`review_result`/`spec_published` 载荷契约；前端不强制改 |
| 回归场景 | token 结案保留、dispatchKindNote、rollbackSkipped、resumeOf、queuedBlocked、L3 并入、completion event |
| 最终产物验收方式 | 读库字段 + HTTP/WS JSON + 前端测试基线 |
