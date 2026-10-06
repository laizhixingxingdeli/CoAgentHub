# 运行中变更

## 不可变请求持久基础

Application 的 ChangeRequestRepository 提供 append/get/listByMission；内存与 File 实现保存 L3 确认的原始请求。记录字段为 changeId、missionId、reviewer、reason、sourceContractRevision、confirmedChange、workItemId、attemptId、claimGeneration、baseSnapshotHash、createdAt，全部明确提供，不含尚未发生的 L2 diff 或消费/应用状态。reviewer 是受信调用者提供的身份事实，不是字符串鉴权。

changeId 同全部字段内容重试幂等，异内容拒绝且保留原记录；新内容须新 id，重试复用原时间。仓储校验明确字段并拒绝额外字段，不推断需求，不生成时间/hash/seq；输入和返回独立复制冻结。listByMission 可按目标字段 AND 精确过滤。

File 实现沿用同一 FileStateStore 单写者事务，changeRequests 随提交持久化、随失败回滚，跨实例可恢复；version 1 旧状态缺集合按 [] 读取，既有集合保持无损。

上述 ChangeRequest 持久基础仍未由服务加载或消费，无变更创建 HTTP/pi/runtime 接线，不表示在途变更、L2 影响判断或回执闭环已启用；预算、状态机与工单修订门禁不变。

## 影响判断身份与只读边界

QueuedHop/EnqueueHopInput及key/逻辑周期入口支持可选purpose='impact'与changeId，必须配对、role仅coordinator、changeId非空。impact以独立JSON编码身份分槽，含分隔符的不同changeId不碰撞；queued/claimed/retry_wait/dead_letter复用本变更槽，仅completed释放下一周期。Map与File恢复保留身份，沿用原claimAvailable五维容量、租约、代次与失败路径，无新增仓储/锁/限额旁路。普通缺省key与周期语义不变。

可信调用者可经RunTokenRegistry.issue签发impact牌：仅coordinator且要求有效claim（id/owner非空、claimGeneration为正safe integer）；签发复制冻结身份字段与claim。普通牌及resolve/revoke/revokeAttempt语义不变，HTTP body不提供purpose/changeId/role，也没有新增公开签发端点。

impact牌在HTTP run入口实行显式只读allowlist，仅允许现有missionRead、attemptGetBrief、attemptGetContext、workItemGetAgentDetail动作；读取仍须通过原绑定与来源门禁（context不解除executor来源限制）。未知动作与全部写动作fail closed，403 ACTION_DENIED，无副作用，不进入普通协调者的旧兼容回退；普通coordinator、executor与independent_reviewer原门禁不变。

B1/B2a 的请求持久、队列身份与 impact 只读牌仍有效。B2b 在此之上增加 append-only ChangeImpact（内存与同一 FileStateStore）：按 changeId 一份权威结果幂等，同 id 异内容冲突不覆盖；字段含 changeId、decision（compatible/replan/cancel_replace）、明确 workOrderDiff、affectedAcceptance 正整数索引、reason；来源由可信入口补齐，不信 HTTP body 身份。保存前同一事务校验原 ChangeRequest、当前目标与活租约、impact coordinator 与其活 claim 及 changeId 一致；旧代次/跨任务/重复异内容拒绝无副作用。不声称差异已应用，不改原冻结工单。未装配/PG 明确 unsupported。

Platform 提供专属 startImpactCoordinatorAttempt / getChangeRequest / submitChangeImpact / listPendingChangeRequests / finishLostImpactAttempt。RunTokenIssuer 可选 startImpactCoordinator，经 main.makeIssuer / hosted issuer 签发 B2a 目的牌并绑定 changeId，缺能力 unsupported 且不回退普通牌。HTTP 工具 coagent_get_change_request / coagent_submit_change_impact 仅 impact 牌可用；B2a 只读 allowlist 仅为本专属提交增补一条限权写，原派发/验收/规划/终审仍 403。不公开 HTTP 签发 impact 牌。

Orchestrator 在执行者 run.wait 未落定期间可 opt-in 查看本目标未决请求：一份变更只复用独立 impact 逻辑 hop，走原五维容量/公平、领取代次/心跳、PRE/POST 预算、候选健康/费用/用量计入和 finally 收尾吊销 token。普通协调者与 impact 互斥；等待容量或已有 L2 时保留 pending。执行者结束则先 stopAndJoin 监督再普通验收。能力默认关闭；mission-runner / 生产入口不接线。测试隔离临时状态不冒充生产启用。不向执行者投递差异，不开放 L3 变更创建入口，不改 stdin EOF 或 AgentRun 端口。仍不表示消费/应用/回执闭环或完整 COM3 已启动。