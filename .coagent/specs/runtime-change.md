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

当前仅交付队列身份和凭据权限基础，未接入impact调度、结论提交、run.wait并行监督、pi工具或消费/应用回执；队列行与purpose牌不表示变更已下发、消费或应用，不代表完整B2或COM3闭环已启动。