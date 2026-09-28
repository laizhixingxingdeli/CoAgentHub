# 候选熔断持久状态

候选熔断按 `profileId` 隔离。查询无记录返回 `closed`；`open` 保存失败分类 `failureClass` 和 ISO `openUntil`。显式非探测失败可从任何状态重新打开并覆写分类与截止。

只有当前 `open` 且调用者提供的 `now >= openUntil` 时，`tryClaimProbe` 才能原子地领取一次，转成带 `probeClaimed: true` 的 `half_open`，保留原失败分类和截止；其他领取返回 false。只有已领取的 `half_open` 可 `resolveProbe`：成功转 `closed` 并清除失败字段，失败带新分类和截止重新转 `open`；非法或重复解决拒绝且不更改状态。输入须提供非空 profileId/失败分类以及有效的标准 ISO 时间戳。

文件仓储将状态与现有状态文件一起持久化；旧版缺少候选熔断字段的状态按空集合加载。事务失败回滚候选状态。唯一探测领取只保证在同一个 FileStateStore 的单写者约束下成立，不保证不同文件实例/进程对同一路径并发写的互斥。PostgreSQL 仓储通过逐 profile 主键记录和条件 UPDATE 领取/解决，跨数据库连接并发领取同一名额只成功一个。

此能力目前仅交付状态和仓储合同；尚未修改或接入 Orchestrator 的候选选择逻辑。
