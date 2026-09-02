# Spec: 停止按钮对运行中任务无效,但界面显示为可用

> **状态**: Frozen — 2026-09-02
> **日期**: 2026-09-02
> **相关**: [stop-button-needs-confirmation.md](stop-button-needs-confirmation.md)(本票落地后再做)

## 1. 现象(2026-09-02 实测)

子任务 `01a06170-3a4f-720a-bc28-c4118352f226` 在 AtomCode 上运行 74 分钟、
`outputTail` 全空、DB 自 11:26 起零更新。此时:

- 界面上该任务卡片的「停止」按钮**是可点的**;
- 点下去只会在群里收到一句 `⛔ 任务 <id> 已在执行,不支持中断;请等待完成后下发修正任务`;
- 任务继续跑,直到 120 分钟执行超时(`DEFAULT_TIMEOUT_MS`,
  `executor-runner.ts:19`)由服务端自己杀掉。

最终是检视者带外 `kill -TERM -55844` 才终止的 —— 平台内没有任何 in-band 路径。

## 2. 根因:UI 可用态与后端能力不一致

| 层 | 事实 | 位置 |
|---|---|---|
| UI 判定 | `canStop = status === "queued" \|\| status === "running"` | `RequirementTimeline.tsx:513`、`TaskPanel.tsx` 同款 |
| 点击动作 | 发一条 broadcast 消息 `停止 <taskId>` | `requirement-workspace.tsx:559`、`:608` |
| 后端处理 | `handleStop` → `cancelQueuedTasks` | `control.ts:164` |
| 覆盖范围 | 仅 **queued** + **已出队未 spawn**(置 `run.stopped`,spawn 前 guard 拦下) | `queue.ts:495-548` |
| 已 spawn | 落到拒绝分支,回「不支持中断」 | `control.ts:182-192` |

kill 能力本身**是存在的**:`queue.ts:490-492` 注释写明
`spawn detached + process.kill(-pid)`「保留给服务端自身的静默超时 / 执行超时」——
即刻意没有接到用户指令上。

## 3. 危害

误触不是主要危害(后端会拒绝),真正的危害是两条:

1. **没有中止手段。** 换模型、改配置、发现票面写错、执行器空转,全都只能等
   120 分钟超时,或由人带外杀进程。带外杀进程绕过平台记账,且是协调者/平台的
   职责被人代劳。
2. **按钮撒谎。** 亮着的按钮让人以为已经停了。要判断有没有停,得回群里读那条
   拒绝消息 —— 而拒绝消息与操作不在同一处。

## 4. 验收

**R1 — 运行中任务可被中止。** `停止 <taskId>` 命中一个 `running` 且持有
`executorPid` 的本群任务时,终止其进程组并把任务落 `cancelled`。复用已有的
停止路径语义:`run.stopped = true` → 完成回调走 `cancelled` 分支
(`queue.ts:1933-1975`),**不回传 ❌/✅**,不触发重派。

**R2 — 落终态必须可验证。** 验收方式是真实端到端:起一个真实执行子任务,
在其 `running` 且 pid 存活时发停止指令,断言 (a) 进程组不再存在、
(b) 任务 `status === "cancelled"`、(c) 群里有一条明确的已停止回执。
**不接受只有单测**(`feedback_spec_claims_need_running`)。

**R3 — 不误伤协调任务。** 协调任务是 detached 的,其进程可能早已退出而任务仍
`running`。停止一个协调任务时,若 pid 已不存在,仍须把任务落 `cancelled` 并回执,
不得因 kill 失败而静默什么都不做。

**R4 — 权限与只读不变。** 停止仍限 coordinator / human / reviewer
(`control.ts` 现有角色表),归档/软删群仍只读。本票不动权限。

**R5 — 回执与操作同处可见。** 停止的结果(已停止 / 无此任务 / 无权限)除了群消息,
任务卡片自身必须反映出来 —— 点完能在原地看到状态变化,不必回群里找。

## 5. 不涉及

- **不改「回滚」按钮。** 回滚(`git reset --hard`)同样没有二次确认,危害更大,
  但那是独立的一票,本票不顺手改(`feedback_dispatch_batch_size`)。
- 不做二次确认弹窗 —— 见 [stop-button-needs-confirmation.md](stop-button-needs-confirmation.md),
  排在本票之后。
- 不改 120 分钟执行超时与静默超时的既有行为。
