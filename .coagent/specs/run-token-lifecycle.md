# Run Token 生命周期（RECON-002A）

Run Token 是某一次 Attempt 的临时运行身份；Agent 只能通过 token 获得 mission / attempt / role / workItem 上下文，不接受请求体自述身份。

## 发放与解析

- Coordinator / Executor Attempt 启动后才发 token。
- registry 以 token 解析出冻结的 RunContext。
- control-plane Principal 与 Run Token 正交，不能互相替代。

## 收尾吊销

- Orchestrator 的运行路径继续在 `finally` 中吊销当前 token。
- HTTP `POST /api/missions/:missionId/attempts/:attemptId/finish` 在成功收尾后，按 URL 中的权威 `missionId + attemptId` 吊销该 Attempt 的**全部** token；相同 attemptId 的其它 Mission 不受影响。
- HTTP finish 不依赖调用方在 body 中回传 token。
- 被吊销 token 的迟到 Agent 调用返回 `401 UNKNOWN_RUN_TOKEN`。

## 重启语义

当前 registry 为进程内存实现。进程重启后旧 token 不会恢复，因此天然失效；本能力不把 Run Token 持久化。

## Non-goals

- TTL / expiry 时间策略。
- scope / audience 扩展。
- 持久化 token registry。
- 多 Runner 租约/fencing；那属于 DurableScheduler / recovery 范围。