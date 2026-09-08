# Spec: 明确 diffSummary 的数据归属

> **状态**: **Landed**(W1 `8813d929` + W2 `3269d309` + W3 `e691fd24`,
> 2026-09-09 检视者 L3 逐项通过)
>
> **L3 收口记录(三个工作项逐项复核)**:
>
> | 项 | 提交 | 检视者独立复核 |
> |---|---|---|
> | **W1** 归属表 + `mergeDiffSummary` | `8813d929` | 纯新增 520 行 / 0 删除,**未碰任何写路径**;`0 failed \| 15 passed` |
> | **W2** 写路径改接单一入口 | `3269d309` | 两条 `rg` 达标;B2–B5/C1 全走最终产物;`1 failed \| 71 passed`,那 1 红是既有 Windows `EPERM` 清理红 |
> | **W3** 对外形状回归 | `e691fd24` | 零生产代码;`0 failed \| 42 passed`;前端 `81 passed / 0 failed` |
>
> **本票的核心目标是可证伪的,检视者重跑确认**:
>
> ```
> rg 'preserveDispatchKindNote\(' packages/backend/server/src
>   → 只剩 types.ts:277 定义处,写路径业务代码 0 调用
> rg 'function preserve' packages/backend/server/src/lib/executor-task
>   → 仍是 2 个,未长出第三个 preserveXxx
> ```
>
> 「测试绿了」证明不了本票成功;**「那个坏模式没再长出来」才能。**
> 这两条判据是**协调者起草时自己设计的**,比检视者原来的写法好。
>
> **顺带修掉的两个真实缺陷**(协调者读代码发现,检视者复核属实):
> `notify.ts` `markTaskCancelled` 漏保留 `rollbackSkipped` 与整个 `platform.*`;
> `control.ts` 回滚 `{ error: "rollback" }` 整袋替换全抹。
>
> **D1 做到了最难的那点**:历史夹具是
> `.insert(taskTable).values({ diffSummary: historicalDiffSummary })`
> **原样直插、不经 `mergeDiffSummary`** —— 真的旧形状,
> 不是用新代码写出来的行冒充历史。
>
> ⚠️ **一条检视者自己的失误,记在这里**:
> W1 的「显式 `null` = 删键」语义**与 `types.ts:315` 的既有契约冲突**
> (那里明写「summary 已含该键,含显式 null → 以调用方为准」)。
> **检视者 L3 W1 时放过了** —— 当时查了「跨所有者保护在不在」,
> 没查「语义与别处既有契约合不合」。W2 碰到真实写路径才暴露并更正
> (对外 `null` = 写入 null,抹键走内部 `DIFF_SUMMARY_DELETE`),
> 跨所有者保护未被破坏。
> **W1→W2 的拆分顺序在这里救了场** —— 这正是协调者定该顺序的理由。
>
> **检视者冻结记录(§6)—— 这是新流程 `coordinator-as-technical-lead` 的第一次实跑**:
>
> 草案与计划由**协调者**按 reviewer skill §4–§5 产出(`938d9052`),
> 检视者只做 §3(需求对齐)与本次 §6(确认冻结)。
>
> **协调者的五条异议,逐条裁定**:
>
> 1. **「R4 往 diffSummary 加结算字段」不准确 —— 异议成立,检视者写错了。**
>    检视者复核 `git show 5074ed7c | grep -cE '^\+.*diffSummary'` = **0**,
>    R4 落的是独立表 `dispatch_intent`。preserve 链变长的主因是
>    **「整袋替换 + 逐字段补丁」模式本身**,与 R4 无关。需求书那句作废。
> 2. **本票不做物理嵌套存储** —— **采纳**。注册表 + 合并入口已满足
>    「有类型结构 + 单一合并 + 所有权」,嵌套会抬高 API 兼容成本,
>    与需求里「保持 API 兼容」的硬约束冲突。
> 3. **不与 S1 绑死** —— **采纳**。需求本就写明不做 S1。
> 4. **基线口径** —— **裁定:验收口径是「不新增失败」,不是「清单必须全绿」。**
>    编制日基线 server 19 文件 `357 passed / 11 failed`,
>    前端 4 文件 `81 passed / 0 failed`。那 11 红是既有的,不属本票。
> 5. **`control` 回滚与 `markTaskCancelled` 漏保留打进 W2** —— **采纳**。
>    它们与本票是同一缺陷类(整袋替换丢失他有键),且 W2 正好要动这两个文件,
>    另开票反而割裂。
>
> **检视者独立复核了协调者的两条新发现,均属实**(这两条我自己分析时没找到):
>
> | 位置 | 问题 |
> |---|---|
> | `notify.ts:129` `markTaskCancelled` | 只 `preserveDispatchKindNote`,**漏** `rollbackSkipped` 与整个 `platform.*`(含 `resumeOf` / `ownerServerPid` / `l3MergedInto`) |
> | `control.ts:265` 回滚 | `diffSummary: { error: "rollback" }` —— **整袋替换,全抹** |
>
> 这正是 §10 要的产出:技术分析有了统一产物,**并因此浮出两个真实缺陷**。
>
> **验收质量检视者认可**:每条都指明了取数方式(`rg` 命令 / DB 行 / HTTP JSON / WS 事件),
> 并明写「不只是 helper 返回值」。
> 其中 **C2**(`rg -n 'function preserve'` 不得新增第三个)是对本票**真实目标**
> 的可证伪检验,不是走过场 —— 值得后续票参考。
>
> **计划**:[plans/diffsummary-ownership.md](../plans/diffsummary-ownership.md),
> W1 → W2 → W3,顺序理由(先立可验收的合并语义,再改路径,最后钉对外形状)成立。
> **版本**: 1.0
> **日期**: 2026-09-09
> **来源**: 报告 `docs/implementation-optimization-review-2026-09-07.md` §5 S2；检视者 §3 grill 产出（`req-s2-diffsummary`）
> **编制**: 协调者（技术负责人）按 reviewer skill §4–§5 起草；**待检视者 §6 冻结**。不得派发、不得 `spec_published`。

凡在本 spec 写下数字或「X 会/不会」的断言，必须附可复算的取数语句（命令 / 单测构造）。

## 1. 背景与目标

### 1.1 用户目标

让 `task.diffSummary` 的**每个字段有明确的所有者**，新增字段不再需要在多个终态路径上追加 `preserve*` 补丁；不同所有者的字段不能互相覆盖；历史 JSON 仍可读取；最终 API 与页面形状有回归检查。

### 1.2 为什么现在做

检视者 2026-09-08 实测：终态路径已在链式叠加两个 preserve 补丁。

```
packages/backend/server/src/lib/executor-task/queue.ts  (preserve 链)
    let next = preserveDispatchKindNote(row.diffSummary, {...});
    next = preserveRollbackSkipped(row.diffSummary, next);
```

同文件与 `routes/group/tasks.ts` / `notify.ts` 还并行存在 `mergePlatformTokenFields`、
`platform.*` 手工深合并、以及整袋替换。报告 §5 S2 的验收原文正是
「新增字段不再需要在多个终态路径追加 preserve 补丁」——**补丁现在就在代码里，而且在变长。**

### 1.3 目标（可判定）

1. 存在**唯一**的 diffSummary 合并入口；写路径通过它合并，而不是各自 `Object.assign` / 整袋 `set` 后再补 preserve。
2. 每个已知键有且仅有一个**逻辑所有者**；合并时非本所有者的既有键默认保留，且**不得**被其他所有者的 patch 覆盖。
3. 新增一个所有者已登记的键时，**不必**再写 `preserveNewField` 并把它挂到 N 条终态路径。
4. 对外仍暴露**既有扁平** `diffSummary` JSON 形状；历史行可读；前端既有读键不改。

## 2. 改动范围

### 2.1 在范围内

- `packages/backend/server/src/lib/executor-task/` 内 diffSummary 合并与类型/注册表（新建模块或扩 `types.ts`，实现自选，**导出合并入口稳定**）。
- 所有**写入** `task.diffSummary` 的 server 路径改接该入口（见 §3.4 清单）。
- 单测：合并语义、路径级跨所有者保留、历史 JSON / API / WS / completion 信封形状。
- 可选：既有 `preserveDispatchKindNote` / `preserveRollbackSkipped` / `mergePlatformTokenFields` 改为对合并入口的薄委托（保持符号，避免无关注点 import churn）。

### 2.2 不在范围内（检视者约束，不可放宽）

- **不**立即迁移为新表或新列（不要求 schema migration）。
- **不**改变对外 API 字段名与任务资源形状（前端与既有消费方不得因此被强迫改动）。
- **不**改 `review_request` / `review_result` / `spec_published` 的载荷契约（字段名、必选/可选、`lite` 语义、顶层 `type` 与嵌套键两种形态均保留）。
- **不做** S1（统一状态转换入口）、**不做** S4（拆 `queue.ts`）。
- **不**把 `dispatch_intent` 表回并进 `diffSummary`；意图结算保持独立表（见 §7）。
- **不**改 `coordination-activity` 写入的 `dispatchAudit` 通道。

## 3. 详细改动

### 3.1 所有者（逻辑分区，不是强制物理嵌套）

存储与 API **保持扁平**（顶层键 + 既有 `platform` 子对象）。所有者是合并规则上的分区：

| 所有者 id | 含义 | 典型键（登记表权威；实现时以代码常量为准） |
|---|---|---|
| `result` | 经过验证或执行器侧的执行结果 | `summary`, `hash`, `tests`, `todo`, `reportMissingReason`, `claimVerification`, `unconfirmed`, `alreadySatisfied`, 以及执行器 patch 中**未登记**的扩展键 |
| `scheduling` | 平台调度事实 | `queuedBlocked`, `stallAlerted`, `executorCooldownEndMs`, `executorCooldownSource`, `cooldownFallbackReason`, `discardedCooldownEndMs`, `quotaMatchedLine`, `quotaMatchedButCommitFound`, `quotaMatchedButTransient`, `staleBuildSuspected`, `noExecutionReason`, 熔断/重派留痕键（若已在 diffSummary） |
| `review` | 检视 / 结案证据 | `review_request`, `review_result`（若曾入 diffSummary）, `claimAdjudication`, `l1Bypass`, `degradedToTwoParty` |
| `relation` | 平台续跑与实例关系（`platform` 块） | `platform.resumeOf`, `platform.resumeForChild`, `platform.closeGuardResume`, `platform.ownerServerPid`, `platform.l3MergedInto`；对 `platform` **深合并** |
| `metrics` | attempt/task 汇总型可观测字段 | `tokenUsage`, `tokenUsageReason`, `outputTail`, `outputTailMissing`, `liveOutputTail`, `retries`, `reconciledReason`, `reconciledAt` |
| `audit` | 跨生命周期审计留痕 | `dispatchKindNote`, `rollbackSkipped` |
| `terminal` | 终态原因文案 | `error`（fail/cancel/rollback/额度等路径写入；**任意终态写者**经合并入口以 `terminal` 所有者更新，不因此清空其他所有者键） |

说明：

- **`platform` 整块归属 `relation`**：对 `platform` 的 patch 深合并，不得用只含部分键的 `platform` 对象替换整块。
- **未登记键**：归**本次写入声明的所有者**（通常 `result`）。这样执行器扩展字段不会被平台合并丢弃，同时不能用来覆盖已登记的他所有者键。
- **显式清除**：仅当 patch **自有**键且值策略允许（实现选定：`null` 表示清除该键，或 `undefined` 表示不写）。他所有者键即使出现在 patch 中也**忽略**（或测试中断言被拒绝），不得覆盖。

### 3.2 单一合并入口

```ts
// 示意签名（最终以实现导出为准）
mergeDiffSummary(
  existing: unknown,
  patch: Record<string, unknown>,
  owner: DiffSummaryOwner,
): Record<string, unknown>
```

规则（验收用）：

1. `existing` 非对象时视为 `{}`。
2. 结果从 `existing` 的可识别对象拷贝开始。
3. 对 `patch` 的每个顶层键：若键（或 `platform` 内键）登记所有者不是 `owner` → **不应用**该键；若是 `owner` 或未登记 → 应用。
4. `platform`：双方均为对象时深合并；只应用 `relation` 所有者写入的子键。
5. 同所有者再次写入可覆盖自身键。
6. 函数**不**写库、不发 WS；纯函数，可单测。

### 3.3 与既有 helper 的关系

| 现状 | 本票后 |
|---|---|
| `preserveDispatchKindNote` | 可保留为调用 `mergeDiffSummary` 保留 `audit` 键的委托，或删除并由路径直接 merge；**正确性不得依赖路径再手写一遍** |
| `preserveRollbackSkipped` | 同上 |
| `mergePlatformTokenFields` | 并入：`metrics` 所有者合并 +「patch 已含键则尊重 patch」的既有 R2 语义（`token-fields-clobbered-by-close`） |
| 各路径 `preserveA; preserveB; mergeToken` 链 | **删除**；改为一次 `mergeDiffSummary`（若一次写入含多所有者，允许按所有者**连续两次** merge，仍禁止 per-field preserve 函数扩散） |

### 3.4 必须改接的写路径清单

实现时用 `rg 'diffSummary:' packages/backend/server/src` 核对无遗漏；至少包括：

| 模块 | 场景 |
|---|---|
| `executor-task/queue.ts` | done 落库、`failTask`、cancel、waiting 提示、stall alert、transient、额度冷却标记、属主 pid 登记、熔断留痕 |
| `executor-task/notify.ts` | `markTaskCancelled` |
| `executor-task/queued-task-reclaim.ts` | `writeQueuedDiffSummary` |
| `executor-task/coordinator-resume.ts` | 创建续跑任务初始 diffSummary、`closeGuardResume` 登记 |
| `routes/group/tasks.ts` | PATCH 结案合并（含 L3 并入 `markL3MergedInto`、token/outputTail/l1Bypass 等平台补写） |
| `orphan-task-reconciler.ts` | 收敛 failed 合并 |
| `lib/control.ts` | 回滚后 `error: "rollback"`（**必须**经 merge，禁止整袋只写 error） |
| `cooldown-store.ts` | 清冷却字段时的剩余对象写回 |

每条路径写入时必须**声明所有者**（或对多所有者分段 merge）。

### 3.5 存储与 API 形状

- **DB**：继续 `task.diffSummary` JSON；不要求把行迁移成嵌套 `owners` 对象。
- **HTTP GET 任务 / 列表、WS `task_status_changed`、completion event 信封**：`diffSummary` 仍为对象；消费方继续读顶层 `hash` / `error` / `tokenUsage` / `review_request` / `platform.resumeOf` 等。
- **禁止**在本票把对外形状改成 `{ result: {...}, scheduling: {...} }` 除非同时提供**完全兼容的扁平投影**且默认响应仍是扁平（本票选择：**不引入对外嵌套**）。

### 3.6 历史 JSON

下列历史形态必须仍能被读取与再合并（夹具单测）：

1. 顶层 `{ "type": "review_request", ... }`（旧）；
2. 嵌套 `{ "review_request": { "type": "review_request", ... } }`（现）；
3. 无 `platform` 键的旧行；
4. 仅有 `tokenUsage` / `tokenUsageReason` 的行；
5. 含 `dispatchKindNote` / `rollbackSkipped` 的行。

再合并后不得丢掉上述已存在键（除非同所有者显式覆盖）。

## 4. 验收标准

每条均可由执行器构造；「最终产物」指 DB 行、HTTP JSON 或 WS 事件，不只是 helper 返回值。

### 4.1 单一合并入口

- [ ] **A1** 存在导出的 `mergeDiffSummary`（或同名权威入口）；`rg -n 'preserveDispatchKindNote\\(' packages/backend/server/src` 在 **W2 完成后**不得再出现于 queue/notify/tasks/orphan/control/reclaim 的写路径业务代码（薄委托定义处除外）。取数：`rg` 命令。
- [ ] **A2** 纯函数单测：`result` 写入 `{ summary: "x" }` 到既有 `{ platform: { resumeOf: "p" }, dispatchKindNote: {...}, tokenUsage: 1 }` → 三者仍在且 `summary==="x"`。

### 4.2 跨所有者不覆盖

- [ ] **B1** 单测：`scheduling` patch 含 `hash: "deadbeef"`（`hash` 属 `result`）→ 结果 `hash` 仍为既有值（或既有为缺省时仍不被 scheduling 写入）。
- [ ] **B2** 路径：任务先 `platform.ownerServerPid = P`，再走队列 `done` 或 `failTask` → `GET` 任务 JSON 中 `diffSummary.platform.ownerServerPid === P`。
- [ ] **B3** 路径：既有 `dispatchKindNote` + `rollbackSkipped`，调用 `markTaskCancelled` → 两键仍在，且 `error` 为停止原因。
- [ ] **B4** 路径：`control` 回滚写 `error: "rollback"` → 既有 `platform.resumeOf`（夹具预置）仍在。
- [ ] **B5** 路径：PATCH 结案 body 仅 `{ status:"done", diffSummary:{ summary:"ok", review_request: <合法载荷> } }`，库内预置 `tokenUsage` 与 `platform.resumeOf` → 结案后二者仍在且 `review_request` 合法。

### 4.3 新增字段不再需要多路径 preserve

- [ ] **C1** 在**仅一处** scheduling 写入点（例如 reclaim 或单测用的 helper）写入已登记的新键或使用现有 `queuedBlocked`；随后分别触发 done / failed / PATCH done / cancel 中至少 **3** 条路径；**断言**该 scheduling 键仍在。
- [ ] **C2** 取数：`rg -n 'function preserve' packages/backend/server/src/lib/executor-task` —— W2 完成后不得新增第三个业务 `preserveXxx` 字段级函数来满足 C1（允许 `mergeDiffSummary` 内部实现）。

### 4.4 历史 JSON 与 API / 页面

- [ ] **D1** 夹具覆盖 §3.6 五种历史形态，经 `mergeDiffSummary` 再写入后 HTTP GET 仍能读出原关键键。
- [ ] **D2** completion event 信封与 `task_status_changed` 载荷中 `diffSummary` 仍为对象，且含场景键（扩既有 `task-completion-events` / `task-status-ws` 或新 compat 测试）。
- [ ] **D3** 前端基线清单相对编制日不得因本票变红：
  ```
  node scripts/test-baseline.mjs --json packages/frontend/web \
    src/pages/app/groups/messages/TaskPanel.test.tsx \
    src/components/layout/context-panel/group-tasks-by-spec.test.ts \
    src/components/layout/context-panel/merge-requirement-timeline.test.ts \
    src/components/layout/context-panel/requirement-workspace.test.tsx
  ```
  编制基线：`81 passed / 0 failed` @ `22f7045c`。

### 4.5 回归（既有契约）

- [ ] **E1** `token-fields-clobbered-by-close`：平台 token 在 PATCH 未带键时保留；显式带键以调用方为准。
- [ ] **E2** `dispatchKindNote` / `rollbackSkipped` 跨终态保留（既有 preservation 测试改接后仍表达同一断言）。
- [ ] **E3** L3 并入 `platform.l3MergedInto`、续跑 `resumeOf`、queued `queuedBlocked` 行为不回退。
- [ ] **E4** 不修改 `review_request` 校验示例与 `lite` 语义。

### 4.6 测试执行口径

按 `AGENTS.md` 当前口径：只跑票面清单，在 `packages/backend/server` 下：

```
npx vitest run test/<file>.test.ts
```

**W1 最低清单**：`test/diff-summary-merge.test.ts`（新建）+ 若改委托则 `test/dispatchKindNote-preservation.test.ts`。

**W2/W3 清单（必须覆盖改动触及的既有文件，不能只跑新建）**：

```
test/diff-summary-merge.test.ts
test/diff-summary-compat.test.ts          # 若新建
test/dispatchKindNote-preservation.test.ts
test/retry-rollback-guard.test.ts
test/task.test.ts
test/detached-token-backfill.test.ts
test/orphan-task-reconciler.test.ts
test/executor-queued-reclaim.test.ts
test/coordinator-resume.test.ts
test/second-instance-sweep.test.ts
test/findings-dispatchKind-regression.test.ts
test/l3-per-spec.test.ts
test/coordination-close-integrity.test.ts
test/l2-claim-adjudication.test.ts
test/claim-verification.test.ts
test/token-usage.test.ts
test/task-completion-events.test.ts
test/executor-queue.test.ts
test/task-status-ws.test.ts
test/task-output-detail.test.ts
```

编制基线（server，`22f7045c`）：**357 passed / 11 failed / 370 total**。  
已知 11 failed 为既有红（见 `plans/diffsummary-ownership.md` 基线段）。本票验收 = 本票引入的断言全绿，且**不得新增失败**；不得要求执行器先清空这 11 条历史红，除非某条直接验证本票 B/C/D 且必须先修——那时应升为阻塞并单独说明。

## 5. 不涉及的改动

- S1 统一 `createTask/claimTask/completeTask` 状态机。
- S4 拆分 `queue.ts` / `tasks.ts` 文件结构（本票可小幅抽 `diff-summary.ts`，不是 S4）。
- 新 DB 表/列承载 diffSummary 分区。
- 前端功能改版、新 UI 展示所有者。
- 改 callback-agent、改执行器 CLI 汇报格式。
- 重做 `dispatch_intent` 模型。

## 6. 兼容性

| 消费方 | 要求 |
|---|---|
| Web `TaskPanel` / 需求时间线 / layer-state | 继续读扁平键；本票默认不改前端 |
| 完成事件 / WS | `diffSummary` 对象形状兼容 |
| 协调者 / 检视者 PATCH 载荷 | 仍提交扁平 diffSummary；平台合并保留他有字段 |
| 历史任务行 | 无需 backfill migration即可读 |

## 7. 协调者异议与澄清（供检视者冻结前审）

1. **需求文称 R4（`5074ed7c`）往 diffSummary 加结算字段**——实现上 R4 落地的是**独立表** `dispatch_intent` 与 `dispatch-intent.ts` 结算，**不是** diffSummary 字段膨胀的主因。preserve 链变长的主因是「整袋替换 + 逐字段补丁」模式本身。本票**不**把 intent 结算搬回 diffSummary。
2. **不要在本票做物理嵌套存储**（`{result,scheduling,...}`）。报告允许「先建立有类型的结构」；类型与注册表足够满足「单一合并 + 所有权」。对外嵌套会强迫投影层，和「保持 API 兼容」冲突风险更高。
3. **`control.ts` 回滚整袋替换**与 **`markTaskCancelled` 漏 preserve rollbackSkipped** 是编制时发现的既有漏洞，纳入 W2 修复，不单开票。
4. **不与 S1 绑死**：无统一状态机也能先落地合并入口；S1 以后可把 merge 收进 `completeTask`，但本票不依赖它。
5. **基线已有 11 条失败**：冻结时请确认验收口径为「不新增失败 + 本票断言绿」，而非「清单全绿」。

## 8. 工作项指针

可变计划：`plans/diffsummary-ownership.md`（W1 → W2 → W3）。  
派发前须由检视者冻结本 spec 并公布 `spec_published`（`specRef` + `specHash`）。
