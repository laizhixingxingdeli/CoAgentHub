# Spec: 用明确的完成信号替代固定空闲等待(报告 T3)

> **状态**: **Landed — L3 通过(2026-09-12),实现 `40628749`**
> **版本**: 1.0
> **日期**: 2026-09-12
> **来源**: `docs/implementation-optimization-review-2026-09-07.md` §12.6 步骤 T3
> **前置**: T0 / T1 / T2(T2 = `268e7143`)

## 1. 问题

`test/setup.ts` 的 `afterAll` 靠**启发式**判断后台工作做完没有:内存计数
(`activeExecutorTaskCount` / `currentRunningTask` / `queuedExecutorTaskCount`)
全为 0 再**连续 1 秒**,或者**到 20 秒直接 break**。

三处不对:

1. 看的是「当前 Map 看起来为空」,不是「已接收的工作都做完了」——
   **消息返回后尚未入队**、**run 离开内存队列后仍在写终态**这两个窗口都漏。
   `setup.ts` 自己的注释就写着这正是 `PGlite is closed` 竞态的来源。
2. **到 20 秒 break 然后关库 = 隐式当作通过**,有残留也不报。
3. 「连续 1 秒空闲 + 100ms 轮询」是纯猜测,无后台工作的文件白等 1 秒。

## 2. 改法

- `executor-task/background-work.ts`:`trackBackgroundWork` /
  `drainBackgroundWork({timeoutMs})` / `backgroundWorkSnapshot`;
  **同步登记**、`finally` 解除;无 EventEmitter、无 DI、无新依赖。
- 三个 fire-and-forget 入口包一层(**生产逻辑零改动**):
  `pumpQueue` 的 `void runOne` → `runOne:<taskId>`;
  `cancelQueuedTasks` 的 `void markTaskCancelled` → `cancel:<taskId>`;
  `dispatchAndSettleIntent` → `dispatch:<messageId>`(派发时还没有 taskId)。
- 定时器**取消而非等待**(报告:不能把几小时的计划 timer 当成必须自然执行完):
  `__cancelScheduledPumpsForTests` 清 `cooldownTimers` 与两条退避 `setTimeout`,
  **测试专用**。
- `setup.ts`:取消 timer → `drain(20s)` → 成功才关库;**超时打印残留 label 并
  让该文件失败**。移除 1 秒空闲与 100ms 轮询。

## ✅ L3 收口记录

### 父子交接无空计数窗口 —— 检视者独立推演

这是本票最容易出错的地方。`runOne` 的 `finally` 里会 `requestPump()`,
那可能**同步**启动下一个 `runOne`。链条:

1. `trackBackgroundWork` **同步** `pending.add`,再调 `fn()`;解除挂在
   `work.finally(...)`,是**微任务**;
2. `runOne` 内部的 `finally { … requestPump() }` 在 **runOne 的 promise settle
   之前**执行;
3. `requestPump → pumpQueue` **全程没有一个 `await`**(已查实),
   所以子项的 `pending.add` **同步完成**。

⇒ 顺序是「子登记 → 父 settle → 微任务里父解除」,**中间没有 0**。✓

### 其余核实

- 新测 4 条全过,含「内存计数已 0 但 track 未解除时 drain 不返回」这条核心用例;
- 清单 6 文件 **112 passed | 0 failed**,与基线逐字相同;
- `tsc` / `biome`(仓库根)exit 0;
- **生产路径 diff 只有「包一层 `track`」** —— 无新 `await`、无调度判定变更、
  无状态写入时机变更。

### ⚠️ 执行侧报的 drain 超时,检视者**三轮未能复现**

执行侧汇报 `task-completion-events.test.ts` 在 drain 时超时,残留
`runOne:01a0963a…`(~20.9s),并如实列进了清单。

检视者复跑:单文件过、**同清单多文件连跑三轮全过**(每轮 112 passed)。

**更可能的解释不是泄漏,是超时预算在负载下被打穿** ——
执行侧那次是在 pi 自己占着机器时跑的,假执行器(`sh` 子进程)变慢,
一次 `runOne` 越过了 20 秒。

⚠️ **这暴露了本设计的一个薄弱点,记下来**:
`drain` 分不清「还在正常干活」与「泄漏卡死」,只看 20 秒这条线。
报告要求超时即失败(对的,静默吞掉更糟),但**固定预算会把机器负载变成测试失败**。

**观察建议**:CI 上若出现 drain 超时,先看该 job 的机器负载与同轮耗时,
**不要第一反应去找泄漏**。若反复出现,再考虑把预算做成可配置
(env 覆盖)或按「无进展时长」而不是「总时长」判定。
本票不改,因为目前证据只有一次、且指向负载。

## 3. 不涉及

- 不修 drain 可能暴露出的泄漏(另立票,按需)。
- 不改生产调度判定、状态写入、通知时机。
- T4(清点固定 sleep)、T5(复测发布)另见报告 §12.7 / §12.8。
