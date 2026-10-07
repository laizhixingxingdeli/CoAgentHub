# 工单修订、交接与证据视图

## 协调者与执行者视图

协调者 `coagent_get_mission` 的 submitted 工作项展示最新提交 attempt 的逐条证据命令、退出码、摘要及输出末尾 1,000 字；命令、摘要和输出均先按 `src/application/redact.ts` 脱敏，输出再截尾。accepted/rejected 工作项只展示证据条数和最后评审结论，不展示证据输出。

执行者绑定的工单视图和开跑简报中的工单条目包含工单修订号、已答问题的问答，以及最近一次协调者 reject 的 `requiredChanges`（若最后评审为 accept，不以空数组冒充修改要求）。Mission 被 L3 send_back 后还包含该次 L3 理由；这些交接信息只是视图投影，不修改冻结工单。简报仍不下发完整契约或规划。

## 完整工单修订

协调者可通过 `coagent_revise_work_order`（`POST /api/agent/coagent_revise_work_order`）提交新的完整工单，策略只授予 coordinator。created、rejected、blocked 可修订；dispatched、submitted、accepted、retired 拒绝且错误指出下一步。每次成功修订递增 `orderRevision`（旧工单视为 r1），持久化进现有工单快照，并产生带修订号与变更字段列表的 `work_item.order_revised` 事件；事件有网页可读翻译。执行者交 partial 或报 blocked，以及平台可信收尾转 blocked 后，若工单修订号未变化，同一工作项不可原样重新 dispatch，抛出 WORK_ORDER_REVISION_REQUIRED。应核对工单是否过大或不清楚，修订后再派发；作废只表示不用做了或已被取代，不是重启卡住工作的办法。正常 completed 后 reject 及 L3 send_back 的 accepted 重派不受此门禁影响。

经协调者 create/revise 工具提交工单时，`allowedScope` 超过两个文件或只有目录、`verification` 超过两条命令、`contextRefs` 为空，会在工具响应中收到指向违规项及拆细建议的警告，现有创建/修订事件同步审计警告；这不是拒绝，工单照常建立或修订。直接调用 `Platform.createWorkItem` 的既有路径不受这层工具警告或硬校验影响。适配器工具注册及网页编辑工单不属于此能力的平台实现。

## 已验收补修与平台可信收尾

accepted 项不能修订；要补做就新建补修单，在 requiredBehaviour 引用原工作项 id 与已满足的验收，只写尚缺部分，原验收记录保持不动。目标、验收、范围不变无需升级 L3，发生变化才升级。retired 项不能修订或派发；作废表示不用做了或已被取代，新的不同内容需新建引用原 id 的工单，不能通过作废重启卡住工作。accepted 与 retired 仍不能作废。

dispatched 项仍不能修订。平台内部可信收尾只用于 Standard，在同一围栏事务中确认当前仍 dispatched、所有执行者 Attempt 已结束、最新 Attempt 与工单修订号匹配调用快照后，使用既有 recordBlocked 转 blocked，不新增状态边。条件不成立或已经 blocked 时返回未转换及原因，无副作用；迟到调用不能收掉新执行跳。

调用来源只有两处：墙钟强杀完成进程退出等待、Attempt 收尾与令牌吊销后（runaway）；COM8 同一项连续无结果封顶或候选局部排除耗尽、交回协调者前（no_result_limit）。普通无结果、killed_idle、上游失败仍按原规则重试；runaway 的停机等待语义不变，不回滚工作区，不处理半成品恢复。

平台填写 BlockedRecord，列明来源、次数或分钟数、尝试 id 与结束原因，并提示核对工单后 coagent_revise_work_order 再派发。写独立事件 work_item.platform_blocked，data 含 source、orderRevision、attemptId、reason；不复用 blocked.reported，不计入验收标准连续失败计数。该事件参与未修订不得原样重派门禁，修订同一张单后可再派发。网页以「平台」徽章显示来源与原因。

## 契约验收标准关联与连续失败停派

WorkOrder 可选字段 `criteria?: number[]` 指向 Mission 当前契约 acceptance 的 1-based 序号。建单与修订校验每个值为范围内整数，非法输入整份拒绝。省略或空数组兼容既有工单；协调者工作项索引、详情和交接投影显示序号，没有关联显示 `—`。

按当前契约修订的事件重放，关联某标准的不同工作项被 review reject、retired、reportBlocked 或交 blocked 结果时累计连续失败；同一项重复失败只计一次，通过验收清零。partial、机器回退和无关联元数据的历史事件不计入。

达到三个不同项失败时，同事务记录可答复的 Mission 诊断升级并投递。诊断包含标准原文、工作项 id、首次计数的失败理由，以及各项全部已记录的尝试结束原因与脱敏上游消息；没有记录明确写未知。普通升级不抑制诊断；已有未答复诊断不重复开卡。

未答复诊断阻止 Standard/Lightweight 直接派发及内部自动重派；内部自动重派无副作用返回。答复普通升级不解除诊断停派；答复诊断清零该标准计数并解除其闸，不自动重派对应 blocked 项，后续仍遵守冻结工单修订与正常派发规则。历史数据不迁移。
