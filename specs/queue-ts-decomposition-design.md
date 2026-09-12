# Spec: queue.ts 拆解设计

> **状态**: **Draft —— 设计待批,尚未下发任何实施票**
> **版本**: 1.0
> **日期**: 2026-09-12
> **取代**: [queue-ts-slicing.md](queue-ts-slicing.md) 的「按职责猜分片」做法
> (那份的第 1/2/5 片已 Landed 且有效,保留;它的 3/4/6 片结论**作废**,
> 见下 §2)
> **来源**: `docs/implementation-optimization-review-2026-09-07.md` S4

## 0. 先说结论

`queue.ts` 现 **3565 行 / 56 个顶层函数**。

1. **它几乎是一张 DAG。** 全文件只有 **1 个强连通分量**(7 函数 / 1265 行),
   而这个分量**仅由「→ `pumpQueue`」这一类回边造成** —— 虚拟切断后
   SCC 归零,整个文件变成 8 层拓扑。
2. **不引入任何间接层,也能搬走 1422 行**(41%)。
   能传递到达 `pumpQueue` 的只有 12 个函数 / 1965 行,其余 44 个是自由的。
3. **真正的大头是 `runOne` 一个函数 896 行**,占拆完之后核心的一半。
   它拆不动的话,模块怎么切都到不了「执行器能轻松读」的程度。
4. 所以顺序是:**纯搬运 → 拆 `runOne` → (如仍需要)才做依赖倒置**。
   把依赖倒置排在最后,是因为它是三者里**唯一有静默失效风险**的一步,
   而前两步做完可能就不需要它了。

## 1. 量出来的结构(不是猜的)

工具在 `.scratch/`(一次性,已清理),做法:按顶层声明切区间,正则提取
`名字(` 形式的调用建图,Tarjan 求 SCC,再算拓扑层与反向可达。

### 1.1 唯一的环

```
enterCooldown ⇄ handleConcurrencyConflict ⇄ handleQuotaFailure
⇄ handleTransientQuotaBackoff ⇄ pumpQueue ⇄ routeQuotaFailure ⇄ runOne
                                    [7 个 / 1265 行]
```

`pumpQueue` **只有 30 行**,却被 7 处调用。把这 7 条入边虚拟切断:

| | SCC 组数 |
|---|---|
| 现状 | 1 |
| 切断 `→ pumpQueue` | **0** |

⚠️ **关键事实:7 处调用全是 `void pumpQueue()`,没有一处 await。**
它在语义上本来就是**信号**(「可能有活了,去看看」),不是调用;
而且 `pumpQueue` 自带 `pumping` 重入闸,多发一次无害。

### 1.2 不做任何倒置时的天花板

反向可达分析:

| | 函数 | 行数 |
|---|---|---|
| 能传递到达 `pumpQueue`(**必须留下**) | 12 | 1965 |
| 自由(**可直接搬**) | 44 | 1441 |

留下的 12 个:`runOne`(896)、`dispatchTask`(300)、
`maybeDispatchExecutorTask`(167)、`enqueueTaskRun`(128)、
`handleTransientQuotaBackoff`(114)、`enterCooldown`(80)、
`handleConcurrencyConflict`(69)、`clearExecutorCooldown`(57)、
`handleQuotaFailure`(53)、`restoreExecutorCooldowns`(48)、
`pumpQueue`(30)、`routeQuotaFailure`(23)。

## 2. ⚠️ 作废 slicing spec 的 3/4/6 片结论

那份 spec 记「冷却 / 超时 / 额度三片搬走会成环」。**其中「超时」一片是错的。**

错因:当时只量了「这一组会不会调用 queue.ts 里的其它顶层函数」,
发现超时组调 `failTask` 就判定成环 —— 但 **`failTask` 自己是叶子**,
把它也搬出去,`timeout-handlers → failure` 就是一条正常的单向边。

**教训:判「能不能搬」不能只看一组的出边,要看整张图。**
一组的出边指向另一组时,成不成环取决于对方会不会指回来,
而这必须**对完整分组做模块级 Tarjan**才知道 —— 眼看必错。
本 spec 的每个分组都过了这道机械校验(§3.2)。

## 3. 阶段 1:纯搬运(零架构改动,零风险)

### 3.1 分组

| 模块 | 函数 | 行 |
|---|---|---|
| `task-repo.ts` | `resolveTaskRepo` `parseRepoPathFromBody` `countCommitsAfterCheckpoint` | 56 |
| `stream-text.ts` | `summaryStreamText` `liveStreamText` | 48 |
| `cancel.ts` | `cancelQueuedTasks` `cancelRunningTasks` `currentRunningTask` `hasDuplicateActiveRun` | 183 |
| `restart-recovery.ts` | `recoverInterruptedTasks` `isOwnedByLiveForeignInstance` `ownerServerPidOf` `registerTaskOwnerServer` | 160 |
| `dispatchability.ts` | `runBlockReason` `isRunDispatchable` `queuedBlockReason` `queuedExecutorTaskCount` `ensureGroupQueue` `workspaceCap` `runningForWorkspace` `workspaceGateBlocked` | 173 |
| `dispatch-target.ts` | `resolveRoleTarget` `buildDispatchTargetAudit` `createTaskDispatchWarnings` `isReviewerNotDispatchableTarget` `isCoordinatorTask` `isPlatformResumeTaskLike` `countConsecutiveFailedChildren` `recordRedispatchStopped` | 311 |
| `failure.ts` | `handleFailure` `failTask` `isTransientQuota` | 223 |
| `timeout-handlers.ts` | `handleStallAlert` `handleStall` `handleA2ASilence` `hasRecentA2AProgress` `refreshA2AActivity` `handleUnconfirmed` `handleDetachedTimeout` `handleClaimTimeout` | 231 |
| `cooldown.ts`(部分) | `appendCooldownAudit` `normalizeCooldownEnd` | 37 |
| **合计搬出** | | **1422** |

`queue.ts` 核心 **3565 → ~2140**(−40%)。

### 3.2 机械校验结果:0 环

```
task-repo / stream-text / cancel / restart-recovery /
dispatchability / dispatch-target / cooldown   -> (无出边)
failure           -> task-repo
timeout-handlers  -> dispatchability, failure
queue.ts(core)    -> 以上全部
```

⚠️ **每张实施票落地后必须重跑这道校验**(分组一变,结论就可能变)。

### 3.3 下发顺序(依赖决定,不能乱序)

| 票 | 模块 | 行 | 前置 |
|---|---|---|---|
| 1 | `task-repo` + `stream-text` + `cancel` + `restart-recovery` | 447 | 无 |
| 2 | `dispatchability` + `dispatch-target` | 484 | 无 |
| 3 | `failure` + `timeout-handlers`(+ `cooldown` 那 2 个) | 491 | 票 1、2 |

票面模板沿用 [queue-ts-slicing.md](queue-ts-slicing.md) §4 已验证有效的那套:
写死行号、明令「不要通读」、**逐字 diff 自证**、预先算出回引符号并把必然出现的
`export` 差异写进票面、`biome check` 必跑。

### 3.4 第 1 票收口(L3,2026-09-12,`60763ad2`)

`task-repo` + `stream-text` + `cancel` + `restart-recovery`,4 模块 / 13 函数。
queue.ts **3565 → 3091**(−474)。**独立核实**:

- **13 个函数逐字核验全 ✓**(工具见下),差异只有 3 个预告的 `export`
- `tsc` exit 0;`biome check .`(仓库根)exit 0
- 测试 **3 failed | 36 passed**,与基线逐字相同(那 3 条是
  `executor-task-repo` 既有的假执行器 ENOENT)
- barrel 公开面 **124 : 124** 零增零减;`git diff --stat` 恰好 6 文件
- 4 个新模块都不 import `./queue`,彼此也不互引

#### ⚠️ 票面的「只许改 N 个文件」逼出了一条 pass-through re-export

`test/second-instance-sweep.test.ts` **deep-import** 了
`recoverInterruptedTasks from "../src/lib/executor-task/queue"`。
搬走之后这条会断,而票面卡死「只许改 6 个文件」,于是执行侧在 queue.ts 末尾
加了 `export { recoverInterruptedTasks } from "./restart-recovery";` 兜住 ——
**取舍正确且如实报了遗留,但根因在票面**:我漏算了 deep-import 消费方。

**改进(第 2 票起执行)**:下发前查清「有哪些文件是从 `./queue` 深引、而不是
走 barrel 的」,把它们**明确列进票面允许改动的清单**,并写明
**不许用 re-export 兜**。第 2 票据此列了 2 处(`coordinator-resume.ts`、
`queued-task-reclaim.ts`),并顺带清掉第 1 票留下的那条 re-export。

### 3.5 第 2 票收口(L3,2026-09-12,`6c147dcc`)

`dispatchability` + `dispatch-target`,2 模块 / 16 函数。
queue.ts **3091 → 2626**(−465)。**独立核实**:

- **16 个函数逐字核验全 ✓**,差异只有 9 个预告的 `export`
- `tsc` exit 0;`biome check .`(仓库根)exit 0
- 测试 **114 passed | 0 failed**(基线 106 是前 4 个文件口径,本轮 5 个文件)
- barrel 公开面 **124 : 124**;`git diff --stat` 7 文件
- 两个新模块都不 import `./queue`
- **上一票那条 pass-through re-export 已删**,`second-instance-sweep.test.ts`
  改走 barrel;queue.ts 现在只剩改动前就有的
  `export { isExecutorProcessAlive } from "./state";`

#### ⚠️ 事实生成器的盲区:只认 function / const,漏 interface

`ResolvedRoleTarget` 是 `resolveRoleTarget` 正上方的局部 interface,
票面给的行号区间**没包含它**(生成器只扫 `function` / `const` 声明)。
执行侧自己发现并一起搬了,否则 `tsc` 过不去。

**第 3 票起**:生成行号区间后,要**人工检查每段起点上方有没有紧邻的
`interface` / `type` / `const` 声明**,有就一并纳入区间并写进票面。

#### 核验工具 `.scratch/verify-move.mjs`

按函数名从 `<oldRev>` 抽原文与新文件比对,只放行「行首多一个 `export `」。

⚠️ **这个工具自己也做了双向验证才用**:正向能确认 3 个既有模块逐字一致;
反向注入一个空格能抓出来并 exit 1。**只会说 ✓ 的工具不能拿来验别人。**

## 4. 阶段 2:拆 `runOne`(896 行 —— 真正的大头)

阶段 1 做完,核心 ~2140 行里 `runOne` 独占 896。**它不拆,拆分就没到位。**

好消息:它**有天然接缝**。骨架是一个 884 行的 `try { … } finally`,内部:

| 段 | 行 | 内容 |
|---|---|---|
| A 前置闸门 | ~30 | 重复活动 run / 已停止 / 认领定时器 |
| B 上下文解析 | ~30 | 仓库 / A2A? / detached? / 协调者? |
| C 启动 | ~220 | A2A 分支 56、CLI 分支 160 |
| **D 结果处理** | **~440** | 见下 |
| E finally | ~10 | 清理 |

**D 段不是一坨,是一串互斥的终态分支**:

```
await handle.promise → 收 token → flush 输出
  ├ run.stopped            (~47)
  ├ memoryPerGroup + ctxId (~16)
  ├ run.detached           (~14)
  ├ run.stalled            (~11)
  ├ run.a2aSilenced         (~8)
  ├ result.timedOut        (~79)
  ├ result.code === 0     (~175)
  └ else(非零退出)        (~48)
catch                      (~10)
```

即「给定 `(run, result, 上下文)`,判定终态」的**分支表**。

### 拆法(建议)

先抽一个显式的 `RunContext`(把 B 段算出的 `repoRoot` / `isA2a` /
`detached` / `memoryPerGroup` 等收进一个对象),然后**一次抽一个分支**
为 `handleXxxOutcome(ctx): Promise<boolean>`(返回「是否已处置」),
`runOne` 退化成一条链。

⚠️ **每次只抽一个分支,单独一票、单独验收。** 这不是搬运(要引入 ctx 参数),
逐字 diff 保不住,必须靠**测试 + 分支覆盖**。下发前要先把
`executor-queue.test.ts` 对每个分支的覆盖情况查清楚写进票面 ——
**没有覆盖的分支不许在本阶段动**,先补测试再说。

## 5. 阶段 3:`pump-signal`(依赖倒置)—— 建议**暂不做**

做完阶段 1+2,核心约 **1100 行**。此时再把冷却族(222)与额度族(259)
搬出去,需要打断「→ `pumpQueue`」:

```ts
// pump-signal.ts —— 约 10 行
let pump: (() => void) | null = null;
let missed = false;
export function registerPump(fn: () => void): void {
  pump = fn;
  if (missed) { missed = false; fn(); }   // 补发注册前丢掉的信号
}
export function requestPump(): void {
  if (pump) pump();
  else { missed = true; console.warn("[executor] pump 尚未注册,信号已暂存"); }
}
```

7 处 `void pumpQueue()` → `requestPump()`;`queue.ts` 模块初始化时
`registerPump(() => void pumpQueue())`。因无人 await,语义不变。

**但建议排在最后,甚至不做**,理由:

- **收益只有 ~440 行**,而阶段 1+2 已经拿到 ~2400 行;
- **它是三步里唯一有静默失效风险的**:注册没发生 → 信号丢 →
  **任务静默不再派发**。本仓库在「静默回落」上吃过亏
  (`dispatch-policy` 读不到文件却不报,见
  [dispatch-policy-load-is-not-observable.md](dispatch-policy-load-is-not-observable.md));
- 若要做,**必须**:① 上面那个补发 + 告警的版本,不能是静默 no-op;
  ② 加一条测试断言「模块加载后 pump 已注册」;
  ③ `/api/health` 透出注册状态,可观测。

## 6. 不涉及的改动

- 阶段 1 不改任何函数签名、行为、导出名(必须加的 `export` 除外)。
- 不借拆解之机修缺陷、补测试、改措辞、调格式。
- `tasks.ts`(1968 行)同类问题,**另立** —— 它的调用图还没量过,
  不要假设结论可以照搬。
