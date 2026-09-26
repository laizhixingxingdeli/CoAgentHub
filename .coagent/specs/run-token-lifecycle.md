# Run Token 生命周期（RECON-002A）

Run Token 是某一次 Attempt 的临时运行身份；Agent 只能通过 token 获得 mission / attempt / role / workItem 上下文，不接受请求体自述身份。

## 发放与解析

- Coordinator / Executor Attempt 启动后才发 token。independent_reviewer Attempt 由控制面 `POST /api/missions/:missionId/independent-reviewer-attempts` 开出后发牌；E2 不经 Orchestrator / `RunTokenIssuer` 派发。
- registry 以 token 解析出冻结的 RunContext。
- 解析结果映射为 PolicyEngine 的 Principal：`role: coordinator` → `kind: coordinator`，`role: executor` → `kind: executor`，`role: independent_reviewer` → `kind: independent_reviewer`（与终审签名的 `reviewer` Principal **不是同一种**）；绑定 `missionId` / `attemptId` / 执行者另绑 `workItemId`。身份 id 用 attemptId，不用原始 token。
- independent_reviewer token 只绑定该 Mission 与 Attempt，只允许 `coagent_get_mission_review_bundle` 与 `coagent_submit_independent_review`。
- 入口先解析 Run Token，再求策略；与控制面 Principal **不能互换**。控制头不能当 Run Token，请求体里的 `role` / `attemptId` 也不采信。
- control-plane Principal 与 Run Token 正交，不能互相替代。

## 收尾吊销

- Orchestrator 的运行路径继续在 `finally` 中吊销当前 token。
- HTTP `POST /api/missions/:missionId/attempts/:attemptId/finish` 在成功收尾后，按 URL 中的权威 `missionId + attemptId` 吊销该 Attempt 的**全部** token（含 independent_reviewer）；相同 attemptId 的其它 Mission 不受影响。
- HTTP finish 不依赖调用方在 body 中回传 token。
- 被吊销 token 的迟到 Agent 调用返回 `401 UNKNOWN_RUN_TOKEN`。

## 重启语义

当前 registry 为进程内存实现。进程重启后旧 token 不会恢复，因此天然失效；本能力不把 Run Token 持久化。

## Non-goals

- TTL / expiry 时间策略。**尚未实现，规格与 PolicyEngine 都不得声称已强制执行。** 过期身份只接受调用方已经认定的输入（控制面 resolver 的 `{ status: 'expired' }`）；Run Token 没有这项输入。
- scope / audience 扩展。尚未实现，不得写成已强制。
- 持久化 token registry。
- 多 Runner 租约/fencing；那属于 DurableScheduler / recovery 范围。