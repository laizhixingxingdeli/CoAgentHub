# Spec: 孤儿收敛器抢在续跑之前判死协调者,续跑机制全面失效

> **状态**: Landed — L3 通过(2026-08-28)
> **版本**: 1.0
> **日期**: 2026-08-27

## 现象

自 `orphan-tasks-only-reconcile-on-restart`(`3cd3435e`)上线后,
**所有协调根任务一律以 `failed` 收场**,续跑一条都没再发生:

```
01a04148  01a0415e  01a0418b  01a0419d  01a0419e
全部:executor pid <n> no longer exists
```

历史续跑记录印证:带 `diffSummary.platform.resumeOf` 的任务共 5 条,
**全部产生于孤儿收敛器上线之前**,之后为零。

## 根因:两个机制互相拆台

```
1  协调者派完子任务 → 进程退出(这是 coordinator-exits-after-dispatch 要的行为)
2  孤儿收敛器 10 秒一轮 → 发现 pid 不存在 → 把父任务收敛为 failed
3  子任务干完 → 触发续跑 → coordinator-resume.ts:71
      if (isTerminalTaskStatus(parent.status)) return "skipped";
   父任务已是 failed(终态)→ skipped
```

**孤儿收敛器赶在续跑之前把父任务判死了。**

`orphan-task-reconciler.ts` 中没有任何关于「待续跑协调者」的判断;
`coordinator-resume.ts:71` 又硬性要求父任务非终态。两者单独看都正确,
合在一起使 `wake-the-coordinator-on-child-completion`(`785e4f1a`)完全失效。

## 决策

### R1 — 孤儿收敛必须排除「等待续跑的协调任务」

父任务同时满足以下条件时,**不得**被收敛为终态:

- 该任务的执行方是协调者(复用 `isCoordinatorTask`,不另写判定)
- 其名下**存在尚未到终态的执行子任务**

⚠️ 判定必须复用 `coordinator-resume` 已有的同源逻辑,不得另写一套口径。

### R2 — ⚠️ 不得改成「协调任务一律不收敛」

那会让真正卡死的协调任务永远挂着 `running`,
把 `rebuild-when-runtime-goes-stale` R4 的在途保护重新变成死锁
(这正是孤儿收敛器当初要解决的问题)。
**只豁免「有非终态子任务在跑」的协调任务**;子任务全部终态后若协调者仍未回来,
应照常收敛。

### R3 — 续跑创建后仍需能收敛

续跑任务本身也可能变成孤儿。
⚠️ 续跑任务(带 `diffSummary.platform.resumeOf`)不在 R1 豁免范围内,
其 pid 消失后应照常收敛,避免出现永不收敛的任务。

### R4 — ⚠️ 不得放宽 coordinator-resume 的终态检查

不要通过删除 `coordinator-resume.ts:71` 的终态判断来「绕过」本问题 ——
那会让已被正确判死的协调任务也被重新拉起。
本票的修法是**让父任务在该续跑时不被判死**,而不是让续跑接受终态父任务。

### R5 — 范围限制

不改看门狗脚本,不改结案守卫,不改 `runtime-status.ts`。

## 验收要点

- 派发一条真实需求票,验证:协调者派完退出后**父任务不被收敛**,
  子任务终态时**产生带 `resumeOf` 的续跑任务**,父任务最终以 `done` 结案
  (贴出任务链与 `resumeOf` 记录)
- 协调任务无任何子任务、pid 已消失 → **仍被正常收敛**(R2,防回归死锁)
- 子任务全部终态后协调者仍未回来 → **照常收敛**(R2)
- 续跑任务自身 pid 消失 → **照常收敛**(R3)
- 测试全绿,贴出用例数;**基线 751**

## 注意

⚠️ 本票**必须下发给执行器**完成,**不限定是哪一个**。
⚠️ specHash 不是 commit,汇报时不要混用。
⚠️ 提交前先 `git status` 确认工作树,不要把无关的暂存文件一并提交。
⚠️ 结案若被守卫拒绝,如实回报原文,**不要自行重启后端,也不要以 failed 收场**。
⚠️ 做完记得提交。
