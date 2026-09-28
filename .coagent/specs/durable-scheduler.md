# Durable Scheduler

持久待执行 Hop 队列提供入队、读取、领取、续租与完成的事实；当前不从 Orchestrator 自动入队、领取或启动 Agent，CLI 行为不变。重试、死信、并发上限与运行时派发不属于当前能力。

`DurableScheduler.enqueue` 使用时钟与 ID 生成器建立状态为 `queued` 的记录，包含 `id`、`projectId`、`missionId`、`workItemId`、`role`、`priority`、`availableAt`、`attemptCount`、`maxAttempts`、`idempotencyKey`、`createdAt`、`updatedAt`。入队前校验非空身份/幂等键、合法角色、非负安全整数优先级和尝试次数、正整数尝试上限且次数不超过上限，以及有效时间；入队者不得设置状态、owner、leaseUntil 或领取代次。仓储直连入队还校验记录 ID、queued 状态和时间戳。

文件与 PostgreSQL 仓储提供 enqueue/get/list：同一业务幂等键重复入队返回已有项，不覆盖原项（即使原项已经 claimed/completed）；不同键分别保留；读取返回副本。文件仓储随状态快照落盘，重开可读；旧快照没有 `queuedHops` 时按空队列恢复，旧版仅含 queued Hop 且无领取代次时可读取并领取，首领代次为 1。文件版遵守单写者约束，不声称跨进程并发原子幂等；PG 使用 `queued_hops` 表的唯一 `idempotency_key` 约束处理并发同键冲突。

`claim(id, owner, leaseMs)` 仅在 queued 且 availableAt 不晚于当前时钟，或已领取且当前时钟到达/越过 leaseUntil 时成功；返回 claimed 状态、owner、leaseUntil、持久且逐次递增的正整数 claimGeneration。不可用时间、未到期租约或已 completed 返回无项。`renew(id, owner, claimGeneration, leaseMs)` 仅当前 owner 和代次且租约尚未到期时可以把 leaseUntil 推进到更晚，`complete(id, owner, claimGeneration)` 同样须当前有效 owner、代次与租约，成功后状态 completed，不能再次领取。错误 owner、错误代次和过期续租/完成被拒，保留原记录不变；接管后旧代次不能续租或完成。文件仓储通过单写者事务串行执行条件转移；PG 在数据库事务中行锁读取，并以原 JSONB 行值作为 UPDATE 条件兑现写入。重开后状态、owner、leaseUntil 和代次仍保留；竞争领取同一项最多一个成功。
