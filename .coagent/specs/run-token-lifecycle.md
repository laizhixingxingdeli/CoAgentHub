# Run Token 生命周期（RECON-002A）

Run Token 是某一次 Attempt 的临时运行身份；Agent 只能通过 token 获得 mission / attempt / role / workItem 上下文，不接受请求体自述身份。

## 发放与解析

- Coordinator / Executor Attempt 启动后才发 token。independent_reviewer Attempt 由控制面 `POST /api/missions/:missionId/independent-reviewer-attempts` 或生产 `RunTokenIssuer.startIndependentReviewer`（Orchestrator / MissionRunner / run-mission 装配的独立候选池）开出后发牌；不得复用 coordinator/executor 的 token 或候选，不接受请求体自述身份。
- registry 以 token 解析出冻结的 RunContext。队列驱动的 Attempt 从 Runner 实际领取的 Hop 取得 `id`、`owner`、`claimGeneration`，在开 Attempt 时同事务写入按 attemptId 可定位的 `attempt.started` 队列标记，发牌时将领取身份冻结进 RunContext；调用方不能提供租约核对所用的 now。非队列 Attempt 不带标记或领取身份。
- 解析结果映射为 PolicyEngine 的 Principal：`role: coordinator` → `kind: coordinator`，`role: executor` → `kind: executor`，`role: independent_reviewer` → `kind: independent_reviewer`（与终审签名的 `reviewer` Principal **不是同一种**）；绑定 `missionId` / `attemptId` / 执行者另绑 `workItemId`。身份 id 用 attemptId，不用原始 token。
- independent_reviewer token 只绑定该 Mission 与 Attempt，只允许 `coagent_get_mission_review_bundle` 与 `coagent_submit_independent_review`。
- 入口先解析 Run Token，再求策略；与控制面 Principal **不能互换**。控制头不能当 Run Token，请求体里的 `role` / `attemptId` / 队列 owner / 代次也不采信。
- control-plane Principal 与 Run Token 正交，不能互相替代。队列 Agent 写工具（包括独立检视提交）由已解析 RunContext 传领取身份；平台同一文件或 PG 写事务核对当前租约、owner 与代次后提交状态、事件和投递。旧代次或过期租约拒绝且不落副作用；缺事务 fencing 能力时 fail closed；队列 Attempt 即使缺内存 claim 也不得无 fence 写入。非队列保持原写入规则。

## 收尾吊销

- Orchestrator 的运行路径继续在 `finally` 中吊销当前 token；队列路径在直接 finishAttempt 时传实际领取身份，事务内核对后才可收尾。
- HTTP `POST /api/missions/:missionId/attempts/:attemptId/finish` 在成功收尾后，按 URL 中的权威 `missionId + attemptId` 吊销该 Attempt 的**全部** token（含 independent_reviewer）；相同 attemptId 的其它 Mission 不受影响。失败不吊销有效 token。
- 非队列 HTTP finish 不依赖调用方在 body 中回传 token，保持旧权限。对于有持久队列标记的 Attempt，finish 必须携带有效 `x-coagent-run` header token，token 绑定的 Mission/Attempt 必须与 URL 匹配，并从已发牌的冻结身份取 claim；平台同一写事务内核对租约。请求体的 role、owner、代次均不是身份依据；重启丢牌时不能退回无 fence 的 finish。
- 被吊销 token 的迟到 Agent 调用返回 `401 UNKNOWN_RUN_TOKEN`。

## 重启语义

当前 registry 为进程内存实现。进程重启后旧 token 不会恢复，因此天然失效；本能力不把 Run Token 持久化。队列 Attempt 的标记随事件持久，重启后无有效内存 token 的 finish 仍被拒绝。

## Non-goals

- TTL / expiry 时间策略。**尚未实现，规格与 PolicyEngine 都不得声称已强制执行。** 过期身份只接受调用方已经认定的输入（控制面 resolver 的 `{ status: 'expired' }`）；Run Token 没有这项输入。队列租约过期核对与 Run Token TTL 不是同一种能力。
- scope / audience 扩展。尚未实现，不得写成已强制。
- 持久化 token registry。
- 跨主机文件版多写者与跨主机自动扩容。
