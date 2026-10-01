# 协调者交接包与按需工作项详情

## 方案条目契约

`featureContract` 生成某条方案功能点的 Mission 契约时，保留原有非目标，只将直接上游依赖、直接下游依赖或 `allowedScope` 路径相同/目录祖先重叠的其他条目加入「方案其他条目」，逐条一行 `id：标题`。无关条目不进入该段；原有验收、约束和 guardrails 不变。

## 开跑简报

平台 `getStartupBrief` 为协调者提供 `work_items_index` 和 `since_last_hop` 两个新增 Bundle 来源，并在旧简报字段投影同样的内容；工作项索引逐项给编号、标题、状态、执行次数、最后一次评审结论。增量仅包含上一个协调者 Attempt 结束后新发生的提交及平台已存证据摘要、卡住报告、答复与 L3 决定，按发生顺序；第一次唤醒增量为 `[]`。`plan` 来源仍保留完整 PlanBody。纯构造器没有显式提供两个可选输入时保留原默认来源；生产简报显式提供它们，包括空数组，因此多两项。执行者 Bundle 与投影始终不含这两个来源；默认预算不裁剪。

## 按需读取

协调者 `coagent_get_mission` 只给契约、完整规划、工作项紧凑索引、升级和答复摘要，不内嵌每张工单、执行结果和评审历史。`POST /api/agent/coagent_get_work_item` 以 `{ workItemId: string }` 取当前 Run Token 所绑定 Mission 的单项详情，只准协调者；返回工单和修订号、最新一次执行结果全文、平台已存证据摘要与评审。历次提交只有事件保存的 outcome、changedFiles、orderRevision、时间，非最新正文标明「旧正文未保存」，不虚构已遗失的正文。超长详情截断且注明；序列化 UTF-8 JSON 不超过 20480 字节。60 个短工作项的 Mission 精简视图序列化 JSON 不超过 30720 字节。网页控制面 `GET /api/missions/:id` 继续返回完整视图，不采用 agent 精简视图。

此能力仅在 application/api 层投影已有状态，不改变 kernel 或持久化模型。适配器 coagent-pi 的工具注册和提示词属于单独的 HO4。
