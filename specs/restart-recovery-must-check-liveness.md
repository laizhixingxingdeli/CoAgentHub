# Spec: 启动恢复把还活着的任务判成孤儿

> **状态**: Ready for Implementation
> **版本**: 1.0
> **日期**: 2026-08-25
> **回归自**: `no-manual-restart-in-dev`(`a5bd7a64`)——切到 watch 模式后暴露

## 背景:消灭了手动重启,却引入了自动重启

`no-manual-restart-in-dev` 让开发期改用 `tsx watch`,消除了「执行器停后端」这个
失败源。但它引入了一个**更频繁**的:**执行器每改一次后端源码就触发一次 watch
重载**,而 `recoverInterruptedTasks` 在每次启动时把所有 `queued`/`running` 且
`executor_key` 非空的任务判为 `failed`(`server-restart`)。

实测:`two-party-has-no-entry-point` 那张票**实现完整正确**,但因执行期间多次
改动后端源码触发重载,任务被判死、零提交。**后端全程健康**——这次不是进程没了,
是判据错了。

## 根因:判「孤儿」的前提在 watch 下不成立

`queue.ts:214` 的判据是:

```ts
inArray(status, ["queued","running"]) AND executorKey IS NOT NULL
```

注释写明其前提:「`executor_key` 非空 = server 自己登记的任务,**重启后确认是
孤儿**」。

这个前提基于「进程重启 ⇒ 我 spawn 的子进程都死了」。但执行器是
**`detached: true` 独立进程组**(`executor-runner.ts:84`)——
**watch 重载后它们仍在运行**。前提不成立,任务被误杀。

⚠️ 这里有个容易只看一半的事实:`detached` 让执行器**不会**被父进程重载杀掉
(这是 `no-manual-restart-in-dev` 删除旧规定的依据,该依据正确);但同一个事实
也让**「重启后必是孤儿」的推断失效**。两个方向的后果,此前只看到了一半。

## 决策:恢复前实际确认进程存活,而不是假定

### R1. 记录执行器进程标识

task 表新增可空列记录 spawn 出的**进程组 id**:

```ts
executorPid: integer("executor_pid"),
```

- spawn 成功后写入(`detached: true` 下 `child.pid` 即进程组 id)
- 任务落终态时**不清空**(保留供排障)
- 历史数据为 `null`

新建迁移。**不加索引**(无按此列查询的需求)。

### R2. 恢复逻辑改为「确认死亡才判失败」

`recoverInterruptedTasks` 对每条候选任务:

| `executorPid` | 进程存活检查 | 处置 |
|---|---|---|
| 非空,进程**仍存活** | `process.kill(pid, 0)` 不抛错 | **保持原状**,不判 failed |
| 非空,进程**已消失** | `process.kill(pid, 0)` 抛 `ESRCH` | 判 `failed`(`server-restart`) |
| **为空**(历史数据) | 无从判断 | 判 `failed`,**行为与改动前一致** |

存活检查用 `process.kill(pid, 0)`,**不发送信号**,仅探测存在性。
抛 `EPERM`(存在但无权限)按**存活**处理。

⚠️ **不要用「进程名匹配」判存活** —— 进程名会重名,本轮检视者已因此误判过一次
(把 8 小时前的残留进程当成当前执行者)。**pid 才是身份。**

### R3. 保住的任务要重新纳入监管

被判定为「仍存活」而保留的任务,重启后其**内存态计时器已丢失**
(`stallTimer` / `stallAlertTimer` 挂在旧进程的 run 对象上)。

本票**不要求**重建计时器 —— 那需要重建整个 run 上下文,超出范围。
但必须确保它们**仍被 `executor-task-liveness` 的读时求值覆盖**
(该机制不依赖计时器,天然免疫重启),并在日志中记录「保留 N 个仍存活的任务」。

### R4. 不改 detached 语义

**不要**为了让恢复逻辑好写而把执行器改成非 detached。`detached` 是刻意的
(`executor-runner.ts:81` 注释:停止指令需 `process.kill(-pid)` 整体终止进程组),
改它会破坏停止/回滚。

### R5. 不改这些

- **不改** `no-manual-restart-in-dev` 的结论(watch 仍是开发期正确选择)
- **不改** `executor-task-liveness` / `stale-runtime-detection`
- **不改**桥任务的豁免(`executor_key` 为空者仍不参与回收)

## 验收标准

- [ ] task 表有 `executor_pid` 列,可空;迁移文件存在且**已对本地库执行**并贴出输出
- [ ] spawn 成功后 pid 被写入
- [ ] **进程仍存活时,重启后该任务保持 `running`,不被判 failed**(本票核心,必测)
- [ ] 进程已消失时,重启后判 `failed`,原因仍为 `server-restart`(回归)
- [ ] `executorPid` 为空的历史任务 → 判 `failed`,**行为与改动前逐字一致**(回归,必测)
- [ ] `executor_key` 为空的桥任务 → **仍不参与回收**(回归,必测)
- [ ] 存活检查用 `process.kill(pid, 0)`,**未使用进程名匹配**
- [ ] `EPERM` 按存活处理
- [ ] 日志记录保留了多少个仍存活的任务
- [ ] **未改动** `detached: true` 语义(R4)
- [ ] 后端测试全绿,贴出用例数

## 不涉及

- 重建内存态计时器(R3,由 `executor-task-liveness` 的读时求值兜底)
- detached 语义(R4)
- watch 模式本身(它是对的)

## 执行环境提示

- 本仓 pnpm 项目,后端**以 watch 模式运行**
- ⚠️ **执行期间不得停止或重启后端**;并**尽量一次性改完再验证** ——
  每次改动后端源码都会触发重载(这正是本票要修的问题,在修好之前它仍然存在)
- 迁移命令需要 `DATABASE_URL` 已导出
- ⚠️ 做完**记得提交**
