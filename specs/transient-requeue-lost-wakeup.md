# Spec: 瞬时限流退避重排队后任务静默搁浅 —— CI 四次,机制未证

> **状态**: **Open —— 症状与性质已定性(真缺陷,非预算、非 S1 回归);根因未证**
> **版本**: 1.0
> **日期**: 2026-09-13
> **来源**: CI 四次同一条红,检视者复核
> **纠正**: 本文推翻 [t4-fixed-sleeps-not-worth-converting.md](t4-fixed-sleeps-not-worth-converting.md) §3.2
> 对该用例的「预算太紧」定性 —— 那是**错判**

## 1. 症状

`packages/backend/server/test/executor-transient-quota.test.ts`
> 验收 4:同一 run 连续 3 次 transient → 第 3 次升级为 exhausted

```
Error: 任务 <id> 在 20000ms 内未满足断言(当前状态=queued)
```

**四次,全同一条、同一句错误:**

| CI run | commit | 时间 |
|---|---|---|
| 34702872946 | `bc1cadc2` | 2026-09-12 15:49 |
| 34704993731 | `28bf2c46` | 2026-09-12 16:31 |
| 34740348104 | `d00e3bf8` | 2026-09-13 05:37 |
| 34740407660 | `532fba5b` | 2026-09-13 05:39 |

## 2. ⚠️ 不是预算 —— §3.2 的旧定性是错的

T4 §3.2 曾把它归为「预算太紧:该测试要等三轮真实退避,CI 慢就临界」。
**那个判断没有核对退避值,是错的。**

```ts
__setTransientQuotaForTests(200, ESCALATION_LIMIT);   // 退避 200ms
```

退避是 **200 毫秒**,三次 attempt 合计应在 2 秒内跑完。实测:

| 环境 | 验收 4 单条耗时 |
|---|---|
| 本机(Windows)空载 | **1325 ms** |
| 本机 + 8 路 CPU burn 并发 | **1674 / 1673 / 1671 ms** |
| CI 失败时 | **20000 ms(等满上限)** |

⚠️ **分布是双峰,不是长尾**:要么 1.3–1.7 秒,要么整整 20 秒。
**双峰 = 丢唤醒 / 搁浅,不是慢。** 负载只把它从 1325 抬到 1674ms
——离 20000ms 差一个数量级,加预算毫无意义。

**判据补充(写给以后的自己)**:判「预算 vs 竞态」之前,
**必须先核对被等待的那个量的真实配置值**。只看「耗时撞上限」就下结论,
会把一个真缺陷记成一条无害的预算问题 —— 本条就是这么被放过两次的。

## 3. ⚠️ 不是 S1 守卫引入的回归

前两次(`bc1cadc2`、`28bf2c46`)**早于**给重排队加 `expectedStatuses: ["running"]`
的提交 `78fde321`。且失败时 DB 状态读到的是 `queued`,说明那次带守卫的
`writeTaskStatus` **写成功了**(竞态失败会保持终态,不会是 queued)。

## 4. CI 日志:卡在**第一次**重排队,之后 20 秒全静默

run 34740407660,任务 `01a09944-2a9b-7374-97e7-f94894f7261b`:

```
05:36:16.598  [executor] server 侧 spawn: ... (group=__default__)
05:36:16.610  [executor] 任务失败 exit=1: 01a09944-...
05:36:36.780  → 任务 01a09944-... 在 20000ms 内未满足断言(当前状态=queued)
```

**全日志里该 taskId 只出现一次 spawn。** 不是「三轮退避太慢」——
它**一次都没有被再派发**。

`handleTransientQuotaBackoff` 走到了重排队(DB 已是 `queued`),
即 `group.queue.push(run)` 与 200ms 退避定时器都已执行;
`runOne` 的 `finally` 里还有一次 `requestPump()`。**两次唤醒都没生效。**

## 5. 闸门逐条排除(重排队之后结构上应当可派发)

`pumpQueue` 的选组谓词 + `runBlockReason`,逐条对本场景:

| 闸门 | 本场景 |
|---|---|
| `runningGroupCount() >= maxParallelGroups` | `runOne` finally 已把 run 移出 `group.running` |
| `runningForWorkspace(g) < workspaceCap(g.key)` | 默认组 cap=1;同上,槽位已释放 |
| `isInCooldown(run.ex)` | 瞬时限流路径**明确不进冷却**;`beforeEach` 的重置也清了 `executorCooldowns` |
| `runningExecutorCount >= ex.maxConcurrency` | 同组已空 |
| `concurrencyRetryAt` 未到 | 200ms 后自然过期 |
| `concurrencyBlocked` | 瞬时路径**不置**该标记(注释明确) |
| 组被从 `groupQueues` 摘除 | 全仓无 `groupQueues.delete`,**不会发生** |

⇒ **闸门都开着,所以丢的是唤醒本身。**

## 6. 两处结构缺陷(确凿,与根因是否查明无关)

### 6.1 `requestPump()` 撞上正在泵送 = **信号丢弃,不重排**

```ts
async function pumpQueue(): Promise<void> {
  if (pumping) return;       // ← 直接丢,没有「泵完再看一遍」
  setPumping(true);
  ...
}
```

这是典型的丢唤醒结构。正确形态是**合并信号**:忙时置 pending,
本轮结束后再跑一遍循环。

⚠️ 另外 `__resetExecutorQueueForTests()` **不重置 `pumping`**
(`state.ts:542` 的 `export let pumping`)。一旦它被留在 `true`,
整个 worker 进程里后续**所有** `requestPump()` 永久静默,
且测试间的重置救不回来。

### 6.2 重排队路径清掉认领超时定时器,**却不重设**

`handleTransientQuotaBackoff` 里:

```ts
clearRunTimers(run);          // ← 清掉 claimTimer(state.ts:629)
...
group.queue.push(run);        // ← 重新排队,但没有重新 arm claimTimer
```

正常入队路径两处都会 arm(`queue.ts:420`、`queue.ts:717`),
重排队路径**没有**。

⇒ **后果正是本条症状的形状**:唤醒一旦丢失,
「queued 超过 claim 阈值未被 running → failed」这条兜底**不存在**,
任务不是失败,而是**永久静默挂在 queued**。

⚠️ 这两处**各自单独修好**都能把「20 秒静默挂死」变成可观测:
6.1 让唤醒不丢,6.2 让丢了也有人喊。**两条都要修。**

## 7. 未证的

**具体是哪一次唤醒被吞掉,没有证明。** 本机(Windows)空载与 8 路负载下
各跑多次均未复现;⚠️ **CI 是 Linux、本机是 Windows**,fake bin 的走法
(直接执行 vs 经 Git bash `sh.exe`)与进程语义都不同,
**本机复现不了不能当作证据**。

根因需要在 CI 侧加可观测量(泵送进入/跳过、每次 `requestPump` 的来源与
当时的闸门快照)后定位。

## 8. 处置

按缺陷处理,不按 flake 静音。修复必须附**不修就会红**的回归测试
(ADR-0011:验收测试必须能失败)。
