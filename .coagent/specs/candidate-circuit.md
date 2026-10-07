# 候选熔断持久状态

候选熔断按 `profileId` 隔离。查询无记录返回 `closed`；`open` 保存失败分类 `failureClass` 和 ISO `openUntil`。显式非探测失败可从任何状态重新打开并覆写分类与截止。

Standard 执行者的 `no_structured_result` 另有工作项级局部规则，不属于候选熔断：从该工作项的持久 Attempt 历史读取候选与结束原因；某候选自己最近两次 Attempt 都为 `no_structured_result` 时，下一次执行跳在此工作项上排除它，按当前角色配置顺序选择下一个可用候选。其他候选的尝试不解除此排除；不改候选配置、全局熔断、冷却或健康记录，其他工作项不受影响，只换执行模型，不改工单或验收。

同一工作项尾部连续 `no_structured_result` 达到 **4 次**（跨候选累计），或局部排除后没有可用候选时，不再自动重跑。平台复用 `attempt_limit_reached` 等待原因，携带工作项、连续次数与涉及候选的说明唤醒协调者处置；工作项保持 `dispatched`，不伪造执行者结果或交付。单候选两次即排除耗尽，可以早于4次交回。协调者既有连续两轮无结构化提交就停、不换模型再赌的规则不变；Lightweight 路径不适用此局部轮换。

只有当前 `open` 且调用者提供的 `now >= openUntil` 时，`tryClaimProbe` 才能原子地领取一次，转成带 `probeClaimed: true` 的 `half_open`，保留原失败分类和截止；其他领取返回 false。只有已领取的 `half_open` 可 `resolveProbe`：成功转 `closed` 并清除失败字段，失败带新分类和截止重新转 `open`；非法或重复解决拒绝且不更改状态。输入须提供非空 profileId/失败分类以及有效的标准 ISO 时间戳。

文件仓储将状态与现有状态文件一起持久化；旧版缺少候选熔断字段的状态按空集合加载。事务失败回滚候选状态。唯一探测领取只保证在同一个 FileStateStore 的单写者约束下成立，不保证不同文件实例/进程对同一路径并发写的互斥。PostgreSQL 仓储通过逐 profile 主键记录和条件 UPDATE 领取/解决，跨数据库连接并发领取同一名额只成功一个。

`buildPersistentPlatform` 和 `buildPgPlatform` 分别创建与各自状态存储绑定的候选熔断仓储；生产 `run-mission`、`run-plan` 将该平台的同一仓储注入 `MissionRunner`，后者交给 `Orchestrator`。重建持久平台及 Runner 后，未到期的 `open` 候选不启动 Agent；未提供仓储的调用继续使用原有进程内 cooldown 行为。候选配置的追加与顺序不变。

候选额度读取采用每次筛选惰性单读快照：有 provider fact 且需要额度判断时才读取，同次筛选最多读取一次，失败结果也在该次筛选内共享。成功返回额度数组或 `{ available: true, providers: [...] }` 时，在 Orchestrator 实例内缓存 60 秒，从读取成功完成时计时，以注入的当前时钟判断过期；缓存期内后续跳复用。异常、unavailable 或无效返回形状不缓存，额度按未知处理。额度未知不阻止原本 closed 的候选派发，也不作为到期 quota 候选恢复的余量确认。COM8 工作项局部排除仍先于额度读取；候选顺序不变。

编排器和网页健康投影共用 `findUsageRow`：仅匹配 status 为 ok 且 provider 等于候选 provider fact 的行；行无 modelPrefix 时可匹配，有 modelPrefix 时仅当候选 model fact 以 `modelPrefix/` 开头才匹配。多个匹配行优先取最长 modelPrefix；同长度取输入中的第一行；无前缀行作为兜底。upstream 长名不参与匹配。缺省 modelPrefix 的 xAI 行保持既有行为；tenrouter 的 cbcn、ag 等模型前缀分别显示和判断对应上游额度。仍仅在额度耗尽且 resetAt 在将来时主动打开 quota 熔断至该时刻，不改变既有熔断或探测语义。

有仓储时按既有顺序查询候选：`closed` 可用，未到期 `open` 和 `half_open` 不可用；到期 `open` 必须原子领取探测名额才启动 Agent，输家可尝试下一候选。探测成功（结构化提交）关闭；候选失败按新分类和未来截止重新打开；探测中 `platform_unreachable` 恢复为领取前的原 `open` 记录，不因平台故障轮换。普通无结构化结果不证明探测成功；不会被记录为候选故障。

`upstream_failure` 的明确配额、鉴权、上游 5xx 信号分别记为 `quota`、`auth`、`upstream_5xx`；无状态码但消息含 `Internal error during token generation`、`internal error`、`overloaded`、`temporarily unavailable`（不区分大小写）的上游临时故障也记为 `upstream_5xx` 且可 failover，使同一次 Mission 可换候选或等待退避到期继续。`killed_idle` 记为 `killed_idle`；有本地适配器信号的运行时异常记为 `local_adapter_error`。文本不足以确定类别的上游失败记为 `unknown`，不猜成配额或鉴权。候选失败按类持久 `open` 并设未来截止；只有明确可 failover 的类别才在当前 Hop 尝试有序的下一候选。`unknown` 不 failover，同一次 Mission 运行也不会通过后续轮次绕路启动下一候选；`platform_unreachable` 和普通执行结果失败均不因熔断轮换。

额度类 `quota` 的例外：从失败信息/适配层可得的响应头 `Retry-After`、`x-ratelimit-reset` 或消息里的相对重试时间、`resets at`、`重置于`、`(quota resets at <ISO>)`（不区分大小写）解析未来重置时间；有时间则 `openUntil` 为该时间，期间不请求；无时间（如预付 credits 耗尽）则 `openUntil: null`，无自动到期/半开探测，只有人工复位才能关闭。文件和 PG 仓储记录复位审计（profileId、actor、ISO at、reason）。其余失败分类和时长不变。适配器用量行的同 provider `remainingPercent === 0` 或 `usedPercent >= 100` 且未来 `resetAt` 会使候选 quota open 至重置时刻；重置后派发前先刷新用量，确认有余量才能恢复；用量不可用时沿用既有派发逻辑，但不可用量不能让无期限 quota 自行恢复。
