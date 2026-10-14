# Mission 工作项检查点与候选失败回滚

成功 `structured_submit` 的 executor 完成 `finishAttempt` 后，在 Mission worktree 的 Mission 分支建立 `mission(<missionId>): <workItemId> 检查点` 提交，之后才可启动下一跳。授权来自该 Mission 中与当前 workItemId 匹配的冻结 `WorkOrder.allowedScope`，不是修复任务的源码范围，也不从契约文字猜测。检查点只提交冻结 allowedScope 内的精确文件，或以 / 结尾的目录下的变更。范围外脏文件（含杂文件与被 .gitignore 忽略的路径）移出工作树存档：已跟踪文件先存补丁再还原，未跟踪文件原样移走，不提交、不删除、不因此失败；记 workspace.scope_archived（路径、来源、存档位置）。无法确定的范围（绝对路径、..、空段、. 段、通配符）与 Git 本身出错仍 fail closed。存在的授权路径用 literal add，已删除的授权路径用 update-index --remove 记删除，不使用 git add -A 或 git add -f。没有实际变更可不新建提交。普通 Git workspace 缺检查点能力、缺冻结授权或提交失败时报告详情并停靠，不换候选、不回滚已交回的成果；显式 InPlace workspace 不伪装成 Git 提交。协调者与失败跳不建检查点。

后续可换候选失败仍按本跳开始的 HEAD reset/clean，仅移除当前跳半成品；前面工作项的检查点已进入 HEAD，所以保留。`killed_idle`、`quota`、`auth`、`upstream_5xx` 共用此语义；不改变失败分类、机器终审、集成分支合入或 `resetTarget`。测试 Git 操作只在测试自建的临时仓与其 Mission worktree 执行。

源：`src/application/orchestrator.ts`、`src/application/workspace.ts`。测试：`test/orchestrator.test.ts`、`test/workspace.test.ts`、`test/failover-limits.test.ts`、`test/independent-reviewer.test.ts`。
