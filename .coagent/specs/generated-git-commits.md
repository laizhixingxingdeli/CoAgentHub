# 平台生成的 Git 提交与分支释放

检查点为 `chore(mission): <W-n> 检查点 <missionId>`，交付为 `chore(mission): 执行者交付 <missionId>`，合并为 `merge(mission): <missionId> <契约 intent 首句，最多60字>`。不改写既有提交，执行者自己的提交规则不变。

只有 Mission 已 completed 且签字记录存在 mergedInto，才在释放其 worktree 后清理自身 `mission/<id>` 分支。实现先验证分支祖先已合入当前目标，再使用 `git branch -d`；失败记录 `workspace.branch_cleanup_failed`，保留合入结果。未合入、被放弃或合并失败的分支保留；不批量清理历史分支。
