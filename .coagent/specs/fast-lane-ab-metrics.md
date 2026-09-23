# Fast Lane A/B 指标（FASTLANE-METRICS）

`Platform.listRuns(missionId)` 是同一任务多次运行的只读对照出口；`src/l3.ts runs` 直接展示这些事实。

## 口径

- `entryMode` 表示进入本次运行时的 lane。若 Mission 已由 Lightweight 晋升 Standard，则从可信 `PromotionRecord.fromMode` 还原为 `lightweight`。
- `currentMode` 表示当前 lane；`promotionTrigger` 直接来自唯一可信 PromotionRecord。
- `firstExecutionResultMs` = `mission.created` 到第一条 `execution_result.submitted` 的非负时间差。
- `totalDurationMs` 只在 Mission 为 `completed | blocked` 时计算：`mission.created` 到终态 `updatedAt`。
- 任一时间缺失、非法或倒序时返回 `undefined`，不得伪造为 0。
- L2 打回只统计非 validator 的 `review.recorded`；L3 打回只统计 `final_review.send_back`。
- L3 检视次数（打回率的分母）只数人：机器 L3 放行（`authority: machine`）与方案放弃（`authority: plan`）不计——夜跑的每一条都算进来的话，A/B 表就把人和机器混在一列里。
- Validator 运行/失败只统计 `validation.reported` 且 `passed` 为布尔值的事件。
- `baseRevision` 原样暴露用于判断两次运行是否同一起点；缺失或不同只提示不可直接归因。

## 非目标

- 不自动判定 Fast Lane 是否优于 Standard，不把计划中的 40%～70% 等假设区间变成硬阈值。
- 不新增实验状态机、不允许 caller 覆盖 TaskClassifier 路由、不伪造同任务不同 lane。
- 不计算“误通过率”：当前没有独立后验 ground truth。
- Jev SHADOW 信号不进入这些权威指标。

真实金丝雀应先保证相同任务与相同 `baseRevision`，再比较 Token、首次结果/总时延、L2/L3 打回、Validator 失败以及 Lightweight→Standard 升级率/原因。