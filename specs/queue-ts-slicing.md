# Spec: 把 queue.ts 切开(S4)

> **状态**: **进行中 —— 第 1 片已 Landed(`5aa87907`),余 5 片未下发**
> **版本**: 1.0
> **日期**: 2026-09-12
> **来源**: `docs/implementation-optimization-review-2026-09-07.md` S4
> **前置**: 无。每一片相互独立,可单独下发、单独回滚。

## 1. 为什么切

`packages/backend/server/src/lib/executor-task/queue.ts` 原 **3916 行**。

这不是审美问题,是**成本问题**:执行器接到涉及它的任务时,光把文件读进上下文
就吃掉大半轮次,反复出现「读完就没预算干活」。2026-09-11 的级联事故里,
250 轮窗口内 `tasks.ts`(1849 行)被反复读了 **22 次**。

⚠️ **本 spec 自身有个陷阱**:要重构的正是那个巨文件,**每张票必须写死行号/符号
清单并明令「不要通读」**,否则切片票自己就会把执行器烧穿。第 1 片证明这可行
——票面只让读 341 行(import 块 + 尾部),一轮过。

## 2. 切法

`executor-task/` 早就是模块目录(`ticket-template.ts` / `cooldown-store.ts` /
`report.ts` / `types.ts` …),queue.ts 只是那个没拆的胖文件。新模块与它们并列。

**每片只搬一个职责,纯搬运,行为零变化。** 不借机重构、不改签名、不补测试。

### ⚠️ 关键洞察:多数消费方走 barrel

`src/lib/executor-task/index.ts` 是公开面。**只要 barrel 改导出来源,外部调用点
就零改动** —— 第 1 片因此 `git diff --stat` 只有 3 个文件。

但**有直引 `./queue` 的**,切到它们涉及的符号时必须一并跟进:

| 直引方 | 引了什么 |
|---|---|
| `lib/executor-task/coordinator-resume.ts` | 多个 |
| `lib/executor-task/dispatch-intent.ts` | `maybeDispatchExecutorTask` |
| `lib/executor-task/queued-task-reclaim.ts` | `enqueueTaskRun` / `queuedBlockReason` |
| `lib/orphan-task-reconciler.ts` | 多个 |
| `routes/executor/index.ts` | `clearExecutorCooldown` |
| `routes/group/tasks.ts` | 多个 |
| `test/coordinator-resume.test.ts` 等 4 个测试 | `enterCooldown` / `enqueueTaskRun` |

## 3. 分片清单

⚠️ **行号会随每片落地而漂移**(第 1 片落地后 import 块增删,后续锚点整体上移
约 4 行)。**以符号名为准,行号只作参考,每次下发前重取。**

| # | 片 | 符号 | 目标文件 | 血缘 | 状态 |
|---|---|---|---|---|---|
| 1 | 票面构造 | `TEST_KEYWORDS` `countOccurrences` `resolveTestExecutor` `buildSpecSection` `executionApiBase` `buildExecutionContextSection` `ticketRole` `buildTicket` | `ticket-builder.ts` | **0 外部改动** | ✅ `5aa87907` |
| 2 | spawn 失败归类 | `isConcurrencyConflict` `spawnFailureHint` `spawnFailureStatus` `spawnFailureReason` `formatExecutorStartupFailure` | `spawn-failure.ts` | 纯函数,低 | 未下发 |
| 3 | 冷却管理 | `MIN_EFFECTIVE_COOLDOWN_MS` `normalizeCooldownEnd` `enterCooldown` `appendCooldownAudit` `restoreExecutorCooldowns` `clearExecutorCooldown` | `cooldown.ts` | **中** —— 3 个测试 + `routes/executor` 直引 | 未下发 |
| 4 | 超时/停滞处理 | `handleStallAlert` `handleStall` `handleA2ASilence` `refreshA2AActivity` `hasRecentA2AProgress` `handleUnconfirmed` `handleDetachedTimeout` `handleClaimTimeout` | `timeout-handlers.ts` | 中 | 未下发 |
| 5 | 尝试/token 记账 | `beginAttempt` `markAttemptTokenUnavailable` `collectAttemptTokenUsage` `backfillDetachedClosedTokenFields` `endAttempt` | `attempt-accounting.ts` | 中 | 未下发 |
| 6 | 额度失败路由 | `routeQuotaFailure` `isTransientQuota` `handleTransientQuotaBackoff` `handleQuotaFailure` | `quota-failure.ts` | 中 | 未下发 |

切完约 1030 行,queue.ts 落到 ~2700。

### 剩下的硬骨头(本 spec 不含,另行设计)

- **`runOne`** —— 单函数约 900 行。不能整搬,得先在函数内部找出可独立的阶段。
- **`dispatchTask`** —— 约 300 行。
- `routes/group/tasks.ts`(1968 行)同类问题,另立。

## 4. 每片的验收(照第 1 片的模板)

1. **逐字搬运,且自证**:
   ```
   git show HEAD:<queue.ts 路径> | sed -n '<起>,<止>p' > .scratch/moved-before.txt
   diff .scratch/moved-before.txt .scratch/moved-after.txt   # 应为空
   ```
   ⚠️ **这条比跑测试更重要**:queue.ts 覆盖面广但本机有既有红,
   「失败数不增加」保护不住搬运,逐字 diff 才保得住。
2. **无循环依赖**:新模块不得 import `./queue`,汇报说明怎么确认的。
3. `git diff --stat` 里只应出现:queue.ts、index.ts、新文件,
   以及第 2 节表格里确有直引的那些文件。多出来的 = 多改了东西。
4. `npx tsc --noEmit -p tsconfig.json` exit 0。
5. **`npx biome check .`(仓库根)exit 0**。
   ⚠️ 这条在 2026-09-12 前的直连票里漏过,CI 因此红了两笔(`49a6d01d` 补)。
6. 票面指定的测试文件,失败数不超过既有基线;基线由下发方预先取好写进票面。
7. 汇报给出 queue.ts 行数前后对照。

## 5. 第 1 片的收口记录(L3,2026-09-12)

**独立核实**(不采信汇报):

- 逐字 diff:`HEAD~1` 的 `3710-3912` 对新文件 **203 行 : 203 行**,
  唯一差异是 `buildSpecSection` 前多了 `export` ✓
- `tsc --noEmit` exit 0 ✓
- `biome check .`(仓库根)exit 0 ✓
- 测试 **7 failed | 60 passed**,与基线**逐字相同**;
  `ticket-template.test.ts` 单跑 **9 passed** ✓
- barrel:`buildTicket` / `executionApiBase` / `resolveTestExecutor` 三名改从
  `./ticket-builder` 导出,`resolveTaskRepo` 留在 `./queue` ✓
- `ticket-builder.ts` 的 import 无 `./queue`,无环 ✓
- `git diff --stat` 仅 3 文件 ✓

**执行侧抓到了票面的一个错(值得记)**:票面表格把 `buildSpecSection` 标为
「不导出」,但 queue.ts 的 **A2A prompt 路径**还有一处调用它。下发方(检视者)
只数了 grep 的出现次数就假定两处都在搬走区间内。执行侧的处理是对的 ——
最小加 `export`、函数体不动、**不进 barrel**(公开面不变);
若改为把它留在 queue.ts,`buildTicket` 反过来要 import `./queue`,**会成环**。

**本机既有红的性质**(下发前已查清,写进了票面,执行侧因此没去追):
7 条全部是假执行器 bin 在本机起不来(`ENOENT … ticket.md`),不是断言不符;
A/B 确认与 `090bcf7d` 的 spawn 改动无关(改前改后同为 7 failed);CI 上这批是绿的。

## 6. 不涉及的改动

- 不改任何函数签名、导出名、行为。
- 不借切片之机修缺陷、补测试、改措辞。
- 不动 `state.ts`、`tasks.ts`。
- 工作文件一律 `.scratch/`。
