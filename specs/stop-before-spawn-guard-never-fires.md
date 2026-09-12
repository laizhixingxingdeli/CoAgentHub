# Spec: spawn 前的停止守卫永远不会触发,停止指令报成功但执行器照跑

> **状态**: **Landed — L3 通过(2026-09-12),实现 `7378d741`**
>
> ## ✅ L3 收口记录
>
> ### 决定性的一条:测试在修复前是红的
>
> 检视者把 `queue.ts` 单独回退到修复前(`git checkout HEAD~1 -- <file>`),
> 跑新增的 `test/stop-before-spawn-guard.test.ts`:
>
> ```
> × R1 CLI: pre-spawn 窗口停止 → 假 bin 哨兵文件不存在(未 spawn)
> × R1 A2A: pre-spawn 窗口停止 → runA2AExecutor 未被调用
> × R2: run.kill 在 spawn 返回后的同一同步段即可用
> Tests  3 failed (3)
> ```
>
> **三条全红,还原后全绿。** 这证明两件事:测试真的在测东西,缺陷真的存在。
> ⚠️ 验收 1 特意禁止「只断言状态是 cancelled」正是为此 —— 那种断言在修复
> 前后都是绿的,等于没测。
>
> ### 实现
>
> - **R1**:A2A(`runA2AExecutor` 构造处)与 CLI(`runExecutor` 调用处)
>   各在**紧邻上方**重查一次 `run.stopped`;检查同步,只有命中分支才 await
>   —— **未命中路径没有新让点**,§1.1 的空窗约束守住了。
>   开头那个不可达的守卫**原样保留**(零成本防御,票面允许)。
> - **R2**:`run.kill = handle.kill` 移到两条分支拿到 `handle` 的第一时间
>   (CLI 在 `runExecutor` 返回后、stall 定时器与 pid 落库 await **之前**),
>   删掉原先落在 pid await 之后的那次赋值。
>
> ### 检视者独立核实
>
> - 修复前 A/B:3 条新测试全红(见上)✓
> - 还原后:4 个文件 **44 passed | 0 failed**(基线 41 + 新增 3)✓
> - `executor-coordinator-workspace-gate` **未回归**(验收 3)✓
> - `tsc --noEmit` exit 0;`biome check .`(仓库根)exit 0 ✓
> - 提交边界:仅 `queue.ts`(+24/−1)与新测试文件,未动
>   `cancel.ts` / `control.ts` / 其它 runOne 分支 ✓
>
> ### 判据的质量
>
> 测试没有走「看任务状态」这条捷径:CLI 侧让假 bin 一启动就写哨兵文件、
> **断言文件不存在**;A2A 侧监视 `runA2AExecutor` / `fetch` 的调用次数、
> **断言从未被调用**。这是「可观察的事实」而不是「推断的结论」。
> **版本**: 1.0
> **日期**: 2026-09-12
> **来源**: 拆解阶段 2 的准入实测
> ([queue-ts-decomposition-design.md](queue-ts-decomposition-design.md) §4)
> —— 全量 1286 条用例里该分支**零命中**,追查发现不是没测,是**到不了**。

## 1. 缺陷

### 1.1 守卫本身是死代码

`packages/backend/server/src/lib/executor-task/queue.ts` `runOne` 开头:

```ts
// 停止指令可能在 spawn 前到达(kill 句柄尚未就绪):标记 stopped 后
// 在此中止,不再 spawn,直接置 cancelled。
if (run.stopped) { … await markTaskCancelled(…); return; }
```

它位于 `runOne` 的 **第一个 `await` 之前**(函数起点 +28 行)。而 `pumpQueue` 是:

```ts
group.running.push(run);
activeRuns.add(run);
void runOne(run, group);      // ← 同步调用,同步执行到第一个 await
```

`push` 与这个检查之间**没有任何让点**,外部代码没有机会写 `run.stopped`。

⚠️ 这个「无 await」是**刻意的**:同文件 :1023-1026 记着,
`getPeerExecutorNames` 被改成惰性取,正是为了不在「置 running」与「spawn 占位」
之间插让点(否则工作树占位守卫会出现可观察空窗,
`executor-coordinator-workspace-gate` 验收 1 实测到 occupancy 读成 0)。
**所以不能靠「把检查往后挪一点」了事** —— 那条约束还在。

`run.stopped` 的三个写入点(`cancel.ts:86`、`cancel.ts:122`、
`state.ts:653` 的测试重置)**全都遍历 `g.running`**,而 run 进入 `g.running`
的唯一时刻就是上面那三行同步语句。故该守卫**永远读不到 true**。

### 1.2 它本该保护的窗口,实际无人保护

`cancel.ts` `cancelQueuedTasks` 里有一段专门针对该窗口:

```ts
// 已出队未 spawn 的过渡窗口(pump 已置 running、kill 句柄未就绪):
// 置 stopped 标记,runOne 的 spawn 前 guard 会在真正启动前取消该任务——
// 保证「停止指令已执行但任务照跑」不会发生在 spawn 前窗口。
const r = g.running.find((rr) => !rr.kill && …);
if (r) { r.stopped = true; clearRunTimers(r); stopped.push({…}); }
```

**但 guard 早就跑过了。** 从 `runOne` 的 stopped 检查到实际 spawn,中间隔着
**8 个以上的 `await`**:

```
db.update(task → running) → notifyTaskStatusChanged → postStatus
→ beginAttempt → isCoordinatorTask → db.query.task.findFirst
→ resolveTestExecutor → groupHasReviewerMember → … → spawn
```

停止指令落在这段窗口里时:

1. `cancelQueuedTasks` 置 `stopped = true`,并**把该任务放进返回的
   `stopped[]` —— 即向用户报告「已停止」**;
2. `control.ts:166` 紧接着调 `cancelRunningTasks`,它执行 `run.kill?.()`,
   而此刻 `run.kill` **仍是 undefined**,是空操作;
3. `runOne` 毫不知情,继续走完剩下的 await 并**真的 spawn**;
4. 直到执行器自己跑完,结果路径的 `if (run.stopped)`(函数起点 +461 行)
   才把它记成 cancelled。

**净效果:停止报告成功,执行器照跑到底**,期间照常烧额度、照常改工作树、
照常提交。这正是 `cancel.ts` 那条注释声称被防住的情况。

### 1.3 还有第二个子窗口

`run.kill = handle.kill` 在函数起点 **+328 行**,而 spawn 在 **+152(A2A)/
+255(CLI)**。即 spawn 之后还有 70~170 行才登记 kill 句柄。这段时间里
进程已经在跑,但 `cancelRunningTasks` 拿不到 kill,`cancelQueuedTasks` 的
`!rr.kill` 分支又只置标记 —— **同样停不下来**。

## 2. 为什么现在才发现

因为**没有任何测试执行过这个分支**。拆解阶段 2 的准入条件是「没覆盖的分支
不许动」,为此做了插桩实测(全量 1286 条用例),该分支命中数 **0** ——
追因才发现它不是漏测,是不可达。

⚠️ **方法论留痕**:零覆盖有两种成因 ——「没人写测试」和「根本执行不到」。
**先分清是哪一种再补测试**,否则会给一段永远不执行的代码写出一个永远绿的测试。

## 3. 要做的

### R1. 在真正 spawn 之前重新检查 `run.stopped`

在 A2A 与 CLI **两条**分支的 spawn 调用**紧邻之前**各加一次检查,命中则
`clearRunTimers` + `markTaskCancelled` + `return`,与既有守卫同语义。

⚠️ **不要动函数开头那个检查的位置**(§1.1 的空窗约束仍然成立)。
开头那个可以保留(防御性,零成本),但不能靠它。

⚠️ **两条分支都要**。只加 CLI 分支会让 A2A 执行器继续漏。

### R2. spawn 后立即登记 kill 句柄

把 `run.kill = handle.kill` 移到**拿到 handle 之后的第一时间**,消除 §1.3
那段「进程在跑但无 kill 句柄」的窗口。

⚠️ 移动时必须确认 `handle` 在两条分支上都已就绪,且不改变既有的
`handle.pid` 登记、detached 分支、A2A 分支的任何其它顺序。

### R3. 不要改 `cancelQueuedTasks` 的返回语义

它把该任务算进 `stopped[]` 是**对的** —— R1 落地后,这个报告就名副其实了。
本票不动 `cancel.ts`。

## 4. 验收标准

1. **两条分支各一条测试**,证明「停止指令落在 pre-spawn 窗口 → 执行器
   **没有被 spawn**」。判据必须是**可观察的事实**,例如假执行器 bin
   被调用时会写一个哨兵文件 —— **断言该文件不存在**;
   不接受「任务状态是 cancelled」作为唯一判据(§1.2 里它本来也会变 cancelled,
   区别只在执行器跑没跑)。
2. 一条测试证明 **`run.kill` 在 spawn 后立即可用**(R2)。
3. **`executor-coordinator-workspace-gate` 的验收 1 不得回归** ——
   §1.1 的空窗约束正是被它测出来的。该文件必须跑,且失败数不增加。
4. 既有测试失败数不增加;基线由下发方预先取好写进票面。
5. `npx tsc --noEmit -p tsconfig.json` exit 0。
6. **`npx biome check .`(仓库根)exit 0。**

## 5. 不涉及的改动

- 不改 `cancel.ts` / `control.ts` 的任何逻辑。
- 不改停止指令的 HTTP 语义与返回结构。
- 不动 `runOne` 的其它分支(结果路径、超时、额度)。
- 不借机拆 `runOne`(那是拆解阶段 2,另有其票)。
- 不改工作树占位守卫的判定。
