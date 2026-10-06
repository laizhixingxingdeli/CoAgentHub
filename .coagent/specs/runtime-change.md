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

Orchestrator 在执行者 run.wait 未落定期间可 opt-in 查看本目标未决请求：一份变更只复用独立 impact 逻辑 hop，走原五维容量/公平、领取代次/心跳、PRE/POST 预算、候选健康/费用/用量计入和 finally 收尾吊销 token。普通协调者与 impact 互斥；等待容量或已有 L2 时保留 pending。执行者结束则先 stopAndJoin 监督再普通验收。能力默认关闭；mission-runner / 生产入口不接线。测试隔离临时状态不冒充生产启用。B2b 不向执行者投递差异，不开放 L3 变更创建入口，不改 stdin EOF 或 AgentRun 端口。B2b 本身不表示消费、应用或回执已启用。

## 执行者差异读取与分层回执

B3 在已持久的 ChangeImpact 之上，让正在执行的 L1 按可信 run 身份与当前领取代次读取发给自己的明确差异，并逐层持久回执。层只有 adapter_received、session_consumed、executor_started。一条 changeId 只对应一个目标执行 Attempt，按层各记一次；同层同内容重试幂等，同层异内容冲突不覆盖。verified 不能经回执写入。记录含 changeId、missionId、workItemId、attemptId、claimGeneration、layer、平台时钟 at；executor_started 还必须带 contentHash，且等于平台对 ChangeImpact.workOrderDiff（UTF-8）算出的 SHA-256 hex。来源由可信入口补齐，不信请求体身份。

File 沿用同一 FileStateStore 事务快照，legacy 缺集合按 [] 读取，不升版本、不另开写者。未装配与 PG 模式明确 unsupported，不隐式回退。

读只返回目标 attemptId 与领取代次都等于本次执行、且 decision=compatible 的差异（含 changeId、workOrderDiff、affectedAcceptance、diffHash 与已记录回执层），并校验本执行仍是 in_progress 的当前 Attempt、代次当前且租约有效。写回执在同一围栏事务里校验目标 Attempt、代次与活租约、对应 ChangeImpact 存在且目标一致、decision=compatible，层只能按 adapter_received→session_consumed→executor_started 前进。旧代次、跨 Attempt、目标不符、非 compatible、越层、hash 不符拒绝且无副作用。replan 与 cancel_replace 不下发给执行者。

HTTP 工具为 coagent_get_change_deliveries 与 coagent_ack_change_receipt。身份只来自 run token（role=executor，attemptId 与 claim 齐全）。请求体只接受业务字段；多出字段 400。coordinator、independent_reviewer 与 impact 牌 403。陈旧代次或失租 409。路由按精确工具名放在普通 AGENT_TOOL_ACTION 之前，不改 policy-engine 通用权限表，impact 牌入口白名单不放宽。

回执只记事实层。adapter_received、session_consumed、executor_started 互不相等，也不等于 verified。executor_started 是执行者带 hash 的结构化自述，不是应用证据。叙事只说执行侧已收到、已进入会话、执行者自述已按差异继续，并明确不等于已应用或已验证。不接 pi 轮询与 steer，不启用生产闭环，不新增 WaitReason。

## 交卷快照与验收确认

B4 在 B3 之上，不新造事件种类。execution_result.submitted 追加 appliedChanges 与 snapshotHash。appliedChanges 是本次执行 Attempt、本工作项、layer=executor_started 且带 contentHash 的 changeId 与 contentHash，按 changeId 升序；未装配变更能力时为 []。snapshotHash 是 SHA-256 hex（UTF-8）。输入是 canonical JSON：对象键按字典序，数组保序。形状为 { v: 1, orderRevision, contractRevision, workOrderHash, appliedChanges }。workOrderHash 是工单内容的 SHA-256 hex，字段为 objective、allowedScope、requiredBehaviour、constraints、acceptance、verification、doNot、contextRefs、validation（缺为 null）、criteria（缺为 null），不含 orderRevision；没有工单时对 canonical JSON null 取哈希。缺 appliedChanges，或 snapshotHash 不是 64 位小写 hex 的旧事件照常可读，叙事标「快照未知」，不补造字段。

L2 accept 之前，若已装配变更能力且存在指向该工作项的 compatible ChangeImpact，平台在同一次验收事务里要求覆盖：指向本次提交 Attempt 的必须已有 executor_started，且 contentHash 等于差异正文哈希；指向本工作项旧 Attempt 的 compatible 变更，这次提交没有覆盖，同样不许 accept。拒绝码 ACCEPT_CHANGES_UNCOVERED，原因列出未覆盖的 changeId，无副作用。reject 不受影响。没有任何变更判断，或没有装配变更能力时，验收与原先一致。

accept 成功，且本次 submittedAttemptId 有平台通过的验证报告时，平台经独立入口 recordVerified 为本次提交覆盖的每条 compatible 变更写一条 verified 记录。字段含 changeId、missionId、workItemId、attemptId（被验收的提交）、claimGeneration、layer=verified、at、contentHash、sourceAttemptId（做验收的 coordinator Attempt）、reportId。事件仍是 change.receipt_recorded。同内容重放幂等且不重复发事件。执行侧 append 与 HTTP 回执继续拒绝 verified；list/get 仍只返回三层执行侧回执。未验收时记录里不出现 verified 字段或空占位。旧的 submitted 与报告按 submittedAttemptId 保留，不被覆写。叙事：layer=verified 的动作是「变更回执：平台已确认」，detail 说明是平台依据 L2 验收与验证报告确认。三种执行侧层的叙事不变。不接 pi，不启用生产闭环，不新增 WaitReason。