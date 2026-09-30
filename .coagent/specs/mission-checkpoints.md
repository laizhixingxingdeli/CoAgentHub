# Mission 工作项检查点与候选失败回滚

成功 `structured_submit` 的 executor 完成 `finishAttempt` 后，在 Mission worktree 的 Mission 分支建立 `mission(<missionId>): <workItemId> 检查点` 提交，之后才可启动下一跳。授权来自该 Mission 中与当前 workItemId 匹配的冻结 `WorkOrder.allowedScope`，不是修复任务的源码范围，也不从契约文字猜测。检查点对范围外 dirty/staged、无法确定范围或 Git 错误 fail closed；仅显式暂存授权路径并检查 index，不使用 `git add -A`。没有实际变更可不新建提交。普通 Git workspace 缺检查点能力、缺冻结授权或提交失败时报告详情并停靠，不换候选、不回滚已交回的成果；显式 InPlace workspace 不伪装成 Git 提交。协调者与失败跳不建检查点。

后续可换候选失败仍按本跳开始的 HEAD reset/clean，仅移除当前跳半成品；前面工作项的检查点已进入 HEAD，所以保留。`killed_idle`、`quota`、`auth`、`upstream_5xx` 共用此语义；不改变失败分类、机器终审、集成分支合入或 `resetTarget`。测试 Git 操作只在测试自建的临时仓与其 Mission worktree 执行。

源：`src/application/orchestrator.ts`、`src/application/workspace.ts`。测试：`test/orchestrator.test.ts`、`test/workspace.test.ts`、`test/failover-limits.test.ts`、`test/independent-reviewer.test.ts`。
