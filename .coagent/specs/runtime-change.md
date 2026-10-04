# 运行中变更

## 不可变请求持久基础

Application 的 ChangeRequestRepository 提供 append/get/listByMission；内存与 File 实现保存 L3 确认的原始请求。记录字段为 changeId、missionId、reviewer、reason、sourceContractRevision、confirmedChange、workItemId、attemptId、claimGeneration、baseSnapshotHash、createdAt，全部明确提供，不含尚未发生的 L2 diff 或消费/应用状态。reviewer 是受信调用者提供的身份事实，不是字符串鉴权。

changeId 同全部字段内容重试幂等，异内容拒绝且保留原记录；新内容须新 id，重试复用原时间。仓储校验明确字段并拒绝额外字段，不推断需求，不生成时间/hash/seq；输入和返回独立复制冻结。listByMission 可按目标字段 AND 精确过滤。

File 实现沿用同一 FileStateStore 单写者事务，changeRequests 随提交持久化、随失败回滚，跨实例可恢复；version 1 旧状态缺集合按 [] 读取，既有集合保持无损。

当前仅持久基础，未由服务加载或消费，无 HTTP/pi/runtime/policy 接线，不表示在途变更、L2 影响判断或回执闭环已启用；权限、预算、状态机与工单修订门禁不变。