# Mission 票级费用与工作项数量门禁

## 边界

独立于 ExecutionBudget；其 cost 维继续为 soft，不改变 hard/soft 求值与既有晋升规则。仅统计 agent 已上报的真实花费，不请求外部计费服务、不调整候选池。

## 费用

新建 Standard Mission 持久化 `costCap`，默认 $10。旧快照缺字段保持兼容，不迁移既有数据。平台纯函数累计本 Mission 及 `origin.rerunOf` 原 Mission 链上的上报费用；候选 facts 中 `billing=subscription` 或 `billing=free` 记 0，其他值或缺失照上报计。

达到上限（累计费用 >= costCap）时，在下一跳/下一执行者启动前等待，原因 `mission_cost_cap_reached`。平台开可答复 Mission 升级，说明总费用、角色与候选归因、工作项数量、最近失败工作项及理由。重复运行等待不重复投递同一门禁升级。

检视者答复继续默认增加 $10，答复指定增额则使用该金额；`node src/l3.ts budget raise <missionId> [--by <美元>]` 同样增额，常驻服务存在时转发服务执行。增额须有限且为正；清理对应费用等待/升级后续跑同一 Mission，不误清其他升级。

## 工作项数量

创建第15项时保留新工作项，但停下派发，以 `work_item_checkpoint` 等待并开可答复 Mission 升级。检视者答复继续批准该检查点后解除等待；第30、45…项再次询问是否拆票。

### 显式签名检查点批准与恢复

自然语言答复可能因包含否定场景名（例如 `reject`）被现有解析规则判作拒绝，导致升级已答复但检查点仍等待。保留现有自然语言规则及已答复历史，不改费用门禁；检视者可使用显式通路恢复同一 Mission。

`Platform.approveWorkItemCheckpoint` 在单一事务内批准工作项检查点。`threshold` 必须为正整数且为15的倍数，已实际到达，存在对应 `platformGate` 检查点升级（包括已答复升级），并对应当前下一未批准检查点；禁止批准未来检查点。`reviewer` 与 `reason` 必须非空。成功记录 `mission.work_item_checkpoint.approved`，包含 `threshold`、`reviewer`、`reason`，原已答复升级历史不可覆盖。

重复批准同一已批准 `threshold` 幂等，不重复事件。批准只清理匹配的 `work_item_checkpoint` 等待，不解除其他门禁，不改变 `costCap`。后续仍在第30、45…项遇到相应检查点。

检视者命令：`node src/l3.ts checkpoint approve <missionId> --threshold 15 --as <reviewer> --reason <reason>`。常驻服务持锁时复用现有回环转发；控制 HTTP 入口复用既有控制鉴权与错误返回，均经同一 Platform 方法，不直接编辑状态、不引入新凭据。

## 验证

`test/ticket-budget.test.ts` 两条综合场景：上报费用到$10停等，增额后同Mission续跑（含重跑链、免费与订阅归因）；第15项停派发，继续后解除，第30项再次停等。等待原因中文同时由 narrate.js 与 API 既有翻译表覆盖。

`test/checkpoint-recovery.test.ts` 一条临时持久状态回归：含 `reject` 场景名的批准答复后，无开放升级仍检查点等待；显式签名批准后原 Mission 可继续，历史与 `costCap` 不变。

`test/l3-checkpoint-approval.test.ts` 一条综合临时状态测试：HTTP 与 CLI（含回环转发）的签名批准、重复批准零重复事件，表驱动拒绝未来检查点及缺签名；复用既有控制授权。
