# 启动收敛（RECON-002B）

平台接手时把上一次残留的在途状态收干净：判死无人收尾的 Attempt、回收孤儿 worktree、补裁它们的实时输出。

## 前提

收敛是**写操作**。只读进程（观测面）不得调用——共用 Postgres 时它会把别人正在跑的 attempt 判死。推进状态的进程必须用 `missionId` 限定范围：它只对自己接手的那条 Mission 有「没有别人在跑」这个认知。

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

- 常驻/周期 Reconciler；当前只在启动跑一次。
- 多 Runner 租约 / fencing token；那属于 DurableScheduler 范围。
- Artifact 回收：`FileArtifactStore` 目前只有 `put` / `get`，没有枚举与删除，不在本能力内。
- Outbox / Saga / exactly-once。

## Source / tests

- 源：`application/reconcile.ts`、`application/live.ts`、`main.ts`（接线与 warning）
- 测：`reconcile.test.ts`、`worktree-reconcile.test.ts`、`recovery-paths.test.ts`
