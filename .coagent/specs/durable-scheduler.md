# Durable Scheduler

本阶段只建立待执行 Hop 的可持久队列事实；不从运行中的 Orchestrator 自动入队、领取或启动 Agent，CLI 行为不变。

`DurableScheduler.enqueue` 使用时钟与 ID 生成器建立状态为 `queued` 的记录，包含 `id`、`projectId`、`missionId`、`workItemId`、`role`、`priority`、`availableAt`、`attemptCount`、`maxAttempts`、`idempotencyKey`、`createdAt`、`updatedAt`。入队前校验非空身份/幂等键、合法角色、非负安全整数优先级和尝试次数、正整数尝试上限且次数不超过上限，以及有效时间；仓储直连入队还校验记录 ID、queued 状态和时间戳。

文件与 PostgreSQL 仓储提供 enqueue/get/list：同一业务幂等键重复入队返回已有项，不覆盖原项；不同键分别保留；读取返回副本。文件仓储随状态快照落盘，重开可读；旧快照没有 `queuedHops` 时按空队列恢复，事务失败回滚。文件版遵守单写者约束，不声称跨进程并发原子幂等。PG 使用 `queued_hops` 表的唯一 `idempotency_key` 约束处理并发同键冲突，重开仍可读。

队列领取、租约、重试、死信、并发上限与运行时派发均不属于本阶段。
