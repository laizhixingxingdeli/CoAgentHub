# 验收证据处置

平台按契约修订留下验收原文。协调者对受影响条目显式写下 reuse、revalidate 或 new_requirement。交卷门禁默认关闭，只在显式开启后约束受影响条目。不做语义推断，不做跨环境测试缓存。

## 契约原文历史

有契约的建 Mission 记 r1，reviseContract 每次 +1 再记一条。两者都在与 Mission 状态同一事务里写入，一起提交或回滚。每条含 missionId、contractRevision、acceptance 原文数组（不 trim）和平台时钟 at。内存与同一 FileStateStore 可读；legacy 缺集合按空数组。没有历史的旧 Mission 或旧修订视为原文未知，不能据此 reuse。未装配仓储与 PG 模式明确 unsupported，不隐式回退。没有契约的 Mission（contractRevision 仍为 0）不写历史行，也不因留档求值抛错。kernel 的 reviseContract 语义不变。

## AcceptanceDisposition

append-only。字段为 dispositionId、missionId、contractRevision、index、decision（reuse / revalidate / new_requirement）、workItemIds、basis（submittedAttemptId、reviewAttemptId、reportId、snapshotHash、priorContractRevision 可选，note 非空）、coordinatorAttemptId、at。同一 dispositionId 同内容幂等，异内容冲突不覆盖。

协调者专属用例在同一围栏事务里机械校验，身份不从请求体取。index 必须在当前契约范围内。只认工单 order.criteria 显式含该 index 的工作项；standard 缺省空 criteria 不能证明任何契约条，禁止按原文相似度补关联。reuse 必须有 priorContractRevision 的已存原文，且第 index 条与当前原文字符串全等，并且该 index 在 basis 证据之后没有被任何 ChangeImpact.affectedAcceptance 点名。basis.reportId 必须能按 validationReportKey(workItemId, submittedAttemptId) 找到，且该报告的 commands（argv 与 timeout）与当前工单 validation.commands 全等、allowedScope 全等。不比较 cwd、机器名、Node 版本。revalidate 与 new_requirement 的 basis 必须指向该条最近一次原文变更或变更判断之后的提交与报告。任一不符拒绝且无副作用。成功写 acceptance.disposition_recorded。

## 交卷门禁

默认关闭。只有 Platform 依赖显式开启才生效；src/main.ts 与托管入口都不开启。开启时，submitMissionResult 对受影响条目在 status=pass 时必须有一条对当前契约修订有效的 disposition，否则拒绝并列出缺少的 index。受影响条目只包括：原文在本 Mission 的契约修订中改过或新增的 index、被任何 ChangeImpact.affectedAcceptance 点名的 index、replan 或 cancel_replace 判断所在工作项显式 criteria 里的 index。未受影响的条目行为不变。not_applicable 仍只要求 evidence 非空。机器终审 holdForUnmetCriteria 在开启时复用同一判定。关闭时交卷与终审零变化。人工 finalizeMission 不加此门禁。

## HTTP 与叙事

协调者专属工具 coagent_record_acceptance_disposition 按精确工具名在普通 AGENT_TOOL_ACTION 之前分流，放进单独集合，与 impact、回执、coverage 分开。身份只来自 run token：role=coordinator 且不是 impact 牌。请求体只收业务字段，多出字段 400。executor、independent_reviewer 与 impact 牌 403。不改 policy-engine 通用权限表。

acceptance.disposition_recorded 的中文叙事是「L2 记录验收处置：复用 / 需复验 / 新要求」，并写明这是 L2 的判断，不等于验收已通过，也不等于已验证。

不在生产开启交卷门禁，不在本能力内注册 pi 侧 ToolSpec。