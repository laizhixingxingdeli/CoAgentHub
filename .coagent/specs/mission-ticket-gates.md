# Mission 票级费用与工作项数量门禁

## 边界

独立于 ExecutionBudget；其 cost 维继续为 soft，不改变 hard/soft 求值与既有晋升规则。仅统计 agent 已上报的真实花费，不请求外部计费服务、不调整候选池。

## 费用

新建 Standard Mission 持久化 `costCap`，默认 $10。旧快照缺字段保持兼容，不迁移既有数据。平台纯函数累计本 Mission 及 `origin.rerunOf` 原 Mission 链上的上报费用；候选 facts 中 `billing=subscription` 或 `billing=free` 记 0，其他值或缺失照上报计。

达到上限（累计费用 >= costCap）时，在下一跳/下一执行者启动前等待，原因 `mission_cost_cap_reached`。平台开可答复 Mission 升级，说明总费用、角色与候选归因、工作项数量、最近失败工作项及理由。重复运行等待不重复投递同一门禁升级。

检视者答复继续默认增加 $10，答复指定增额则使用该金额；`node src/l3.ts budget raise <missionId> [--by <美元>]` 同样增额，常驻服务存在时转发服务执行。增额须有限且为正；清理对应费用等待/升级后续跑同一 Mission，不误清其他升级。

## 工作项数量

创建第15项时保留新工作项，但停下派发，以 `work_item_checkpoint` 等待并开可答复 Mission 升级。检视者答复继续批准该检查点后解除等待；第30、45…项再次询问是否拆票。

## 验证

`test/ticket-budget.test.ts` 两条综合场景：上报费用到$10停等，增额后同Mission续跑（含重跑链、免费与订阅归因）；第15项停派发，继续后解除，第30项再次停等。等待原因中文同时由 narrate.js 与 API 既有翻译表覆盖。
