# 启动收敛（RECON-002B）

平台接手时把上一次残留的在途状态收干净：判死无人收尾的 Attempt、回收孤儿 worktree、补裁它们的实时输出。

## 前提

收敛是**写操作**。只读进程（观测面）不得调用——共用 Postgres 时它会把别人正在跑的 attempt 判死。推进状态的进程必须用 `missionId` 限定范围：它只对自己接手的那条 Mission 有「没有别人在跑」这个认知。

文件存储同理：`buildPersistentPlatform(…, { reconcile: false })` 不收敛。`l3.ts` 的只读命令（`inbox` / `show` / `plan`，含 `plan decide`——它只写方案运行记录那份独立文件）一律这样起。理由不是理论上的：写者刚开一跳时 attempt 已经落盘、spawn 还没回来、第一次心跳还没打，这几秒里它就是「从没心跳过」；只读命令在这时起来收敛，会把它判死并**整份写回状态文件**，而写者正握着锁在写——两个写者，后写的盖掉先写的，悄无声息。夜跑时检视者每 20 分钟就要 `l3.ts plan` 一次，这不是小概率。缺省（不传）仍收敛，推进状态的入口行为不变。

## Attempt

- `in_progress` 且租约过期（默认 `DEFAULT_LEASE_TOLERANCE_MS` = 90s）→ `interrupted`，写 `attempt.ended`。
- 心跳仍新鲜 → 进 `alive`，**一律不动**。看得见才知道收敛为什么没收它。
- 判成 `interrupted` 而非失败：它没交出任何技术结论，属于可重试那一类。

## 实时输出补裁

- 正常收尾在 Orchestrator 的 `finally` 里已裁（留尾部 `KEEP_TAIL_ON_FINISH` 行 + 一条裁剪说明）。跑不到 `finally` 的**只有编排进程自己死掉**这一种情况——而那恰好是收敛正在收的这些跳。不补裁的话留存策略是反的：正常结束的留 500 行，被猝死带走的整跳全留着且再无人回收。
- 传入 `live` 时，对**每个判死的** attempt 调一次 `live.finish(missionId, attemptId)`；`alive` 的一跳都不碰。
- 阈值与裁剪说明口径完全复用 `live.ts`，此处不另立参数。
- 裁剪在状态与事件**之后**：收敛的本职是解开卡死的 Mission，裁不动不该让它失败。
- 裁剪失败**不吞**，进 `liveTrimFailed` 并由启动路径打 warning。裁不动意味着那一跳的行还在无限留着，是要人看的事实。
- 不传 `live` 时 `liveTrimmed` / `liveTrimFailed` 恒为空，行为与接入前一致。

## worktree

按各 Mission 的 `workspaceRef.projectRoot` 分组收敛；同一根下**非终态** Mission 的 id 为 protected。终态只有 `completed` / `blocked`。不发领域事件——这是磁盘卫生。

## Non-goals

- 把 Attempt 判死、孤儿 worktree、实时输出补裁改成周期任务。这些仍只在启动跑一次、且范围限定不变。
- 多 Runner 租约 / fencing token；那属于 DurableScheduler 范围。
- Artifact 回收：`FileArtifactStore` 目前只有 `put` / `get`，没有枚举与删除，不在本能力内。
- Outbox / Saga / exactly-once。
- DurableScheduler、fencing、Dispatcher、L3 merge 重试、公开 HTTP 修复接口。
- token 发放 / 吊销、live 输出、正在跑的 Attempt / Runner 状态——周期路径一律不碰。

## 周期投递修复（与启动收敛的边界）

启动收敛收的是**无人收尾的 Attempt** 和 **孤儿 worktree**。周期任务只跑 `repairMissingDeliveries`：补可从现存状态核实的缺失投递（全部升级，以及当前结果对应的最后一次可核实交卷）。不改 Mission / Attempt 状态，不重放交卷或升级命令。归档 Mission、对不上的交卷身份、缺事件的缺口进 skipped / uncertain，不强补。

两件事不要混：

- **启动时**：`reconcileInterruptedAttempts` / `reconcileOrphanedWorktrees` 仍按原规则，只跑一次。只读观测面不调 Attempt 收敛；推进状态的进程用 `missionId` 限定。
- **运行中**：`startServer` 与 `run-plan` 按间隔补投递。不周期调用上面两个启动收敛函数。

### 配置

`COAGENT_RECONCILE_INTERVAL_MS`：未设 = 60000 毫秒；`0` = 关闭；其余必须是正整数。非法值在开状态、拿锁、listen、建 worktree 之前拒绝。

### 锁与活对象

- 文件版 `startServer` 是只读观测面，**不握长锁**。每轮 `acquireLock`；锁忙 warn 并跳过，不写文件。拿到锁后新开 `FileStateStore`（注入 `hasArchivedMission`），跑完释放。
- 文件版 `run-plan` 已持排他锁，用现有装配修，不再取锁。
- PG：每轮新开独立 `PgStateStore`，在专用连接上 `pg_try_advisory_lock` 做跨进程互斥；拿不到就跳过。刷新并修复这份独立 store，不 `refresh`、不改写 Runner / HTTP 正在用的活 Platform。结束时解锁并关掉独立连接。

### 失败策略

单次 tick 抛错只记 warning，HTTP 健康检查与 `run-plan` 主循环继续，下一轮照跑。上一轮没结束不排下一轮。`repairMissingDeliveries` 把单项读取或补建异常收进 `result.errors` 而不抛：周期 tick 逐项记含 Mission 标识和原因的 warning，不阻断后续 tick；`uncertain` / `skipped` 不是故障，不当 warning。调度的 `warn` 自己抛错时接住并退回 `console.warn`，循环继续，`stop()` 正常完成——告警通道不该拖垮调度。`server.close` 与 `run-plan` 正常 / 异常退出都 `stop`：不再排下一轮，等在途那一轮结束，释放文件锁和独立 PG 连接。调用方只调 `server.close` 也必须等到这一步完成。

关闭与清理的异常路径同样要走完：

- `server.close`：无论 `periodic.stop` 成败都关 HTTP；`closeHttp` 同步抛错当作关闭错误接住。stop 与关闭的错误都保留（两个都有时用 `AggregateError`）。有 callback 就交给 callback；没有 callback 时，server 上有 `error` 监听器则 `emit('error')`，否则 `console.error`——不得静默，也不得留下未处理的 Promise 拒绝。callback / error 监听器自身抛错只记录（`console.error`），不重复交付，也不变成未处理拒绝。
- `run-plan` 退出：`periodic.stop`、`persist`、`releaseLock` 各自独立尝试（`runIndependentCleanup`），一步失败不跳过后面的，锁必须释放。失败经 `console.error` 留下可诊断信息。主流程错误与清理错误都保留：清理全成功时原样抛出主流程错误；两边都失败时抛 `AggregateError`（主流程错误在前），并用 `formatErrorForLog` 展开内部错误再打印。
- 信号退出：记中断原因、`periodic.stop`、`persist`、`releaseLock` 各自独立尝试（`cleanupAfterSignal`），一步失败仍继续、每步失败都记录，最后一定尝试释锁并以退出码 130 退出（清理失败靠 stderr 诊断，不另开退出码）。该路径永不留下未处理拒绝。

## Source / tests

- 源：`application/reconcile.ts`、`application/live.ts`、`application/pg-store.ts`（advisory lock）、`main.ts`（接线与 warning）、`run-plan.ts`
- 测：`reconcile.test.ts`、`worktree-reconcile.test.ts`、`recovery-paths.test.ts`、`reconcile-periodic.test.ts`、`start-server.test.ts`、`run-plan-wiring.test.ts`
