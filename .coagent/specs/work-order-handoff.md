# 工单修订、交接与证据视图

## 协调者与执行者视图

协调者 `coagent_get_mission` 的 submitted 工作项展示最新提交 attempt 的逐条证据命令、退出码、摘要及输出末尾 1,000 字；命令、摘要和输出均先按 `src/application/redact.ts` 脱敏，输出再截尾。accepted/rejected 工作项只展示证据条数和最后评审结论，不展示证据输出。

执行者绑定的工单视图和开跑简报中的工单条目包含工单修订号、已答问题的问答，以及最近一次协调者 reject 的 `requiredChanges`（若最后评审为 accept，不以空数组冒充修改要求）。Mission 被 L3 send_back 后还包含该次 L3 理由；这些交接信息只是视图投影，不修改冻结工单。简报仍不下发完整契约或规划。

## 完整工单修订

协调者可通过 `coagent_revise_work_order`（`POST /api/agent/coagent_revise_work_order`）提交新的完整工单，策略只授予 coordinator。created、rejected、blocked 可修订；dispatched、submitted、accepted、retired 拒绝且错误指出下一步。每次成功修订递增 `orderRevision`（旧工单视为 r1），持久化进现有工单快照，并产生带修订号与变更字段列表的 `work_item.order_revised` 事件；事件有网页可读翻译。执行者交 partial 或报 blocked 后，若工单修订号未变化，同一工作项不可原样重新 dispatch；错误提示修订工单、作废或升级给 L3。正常 completed 后 reject 及 L3 send_back 的 accepted 重派不受此门禁影响。

经协调者 create/revise 工具提交工单时，`allowedScope` 超过两个文件或只有目录、`verification` 超过两条命令、`contextRefs` 为空，会在工具响应中收到指向违规项及拆细建议的警告，现有创建/修订事件同步审计警告；这不是拒绝，工单照常建立或修订。直接调用 `Platform.createWorkItem` 的既有路径不受这层工具警告或硬校验影响。适配器工具注册及网页编辑工单不属于此能力的平台实现。
