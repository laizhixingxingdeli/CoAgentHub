# 平台生成的 Git 提交与分支释放

检查点为 `chore(mission): <W-n> 检查点 <missionId>`，交付为 `chore(mission): 执行者交付 <missionId>`，合并为 `merge(mission): <missionId> <契约 intent 首句，最多60字>`。不改写既有提交，执行者自己的提交规则不变。

只有 Mission 已 completed 且签字记录存在 mergedInto，才在释放其 worktree 后清理自身 `mission/<id>` 分支。释放 worktree 与删除分支两步的失败都记录 `workspace.branch_cleanup_failed`（`data.step` 为 `release_worktree` / `delete_branch`），保留合入结果；删分支仍先验证分支祖先已合入当前目标，再用 `git branch -d`。未合入、被放弃或合并失败的分支保留。交卷时的一次性清理失败后，**排他写进程启动时重试**：对每个项目仓先 `for-each-ref` 列出仍存在的 `mission/*` 分支，只对 completed 且 mergedInto、分支还在的 Mission 再跑一次同样的删除；失败记 warning 不挡启动，不发领域事件。除此之外不批量清理历史分支。
