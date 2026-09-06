# Spec: 同一仓库的执行前快照并发冲突,任务被判死且永不启动

> **状态**: Landed — 2026-09-07(修复见 `d6b8bd92`;本 spec 补记产品缺陷本身)
> **来源**: 修 [coordination-core-e2e-tests-unreliable.md](coordination-core-e2e-tests-unreliable.md)
> 时定位到,那张票的 §6 要求「生产时序缺陷另开票」——本票即是。

## 1. 缺陷

`createCheckpoint` 依次执行 `git add -A` 与 `git write-tree`,两者都要拿
`.git/index.lock`。**两个任务同时对同一棵树做快照时,必然有一个拿不到:**

```
[executor] 执行前快照失败: git write-tree 失败:
  fatal: Unable to create '.../.git/index.lock': File exists
```

快照失败 → `failTask` → 任务被判死,**永远到不了 running**。

## 2. 为什么既有并发闸挡不住

`maxConcurrentPerWorkspace` 按 **`project_path`** 分组。
而**不同 `project_path` 可以落在同一个 git 仓库**:

- 测试:多个群共用 setup 的临时仓库;
- 生产:多个群的 `project_path` 指向同一棵树(或子目录)时同样成立。

闸限制的是「同一 project_path 的并发」,快照争的是「同一仓库的 index 锁」——
两个粒度不一致,中间那段就是缺陷窗口。

## 3. 危害

- 任务**未开始就判死**,且原因是 git 底层报错,读起来不像并发问题;
- 上层看到的是「执行器失败」,协调者会重派 —— 重派后若仍并发,继续失败;
- 2026-09-03~07 期间表现为协调核心两条 E2E 用例偶发红(实测复现率 ~10-17%),
  每次改动都要额外花时间确认「红灯是不是我造成的」。

## 4. 已落地的修法(`d6b8bd92`)

按 `repoRoot` 串行化 `createCheckpoint`:同一仓库排队,不同仓库互不影响。
只改并发时序,不改快照语义。

验证:两个目标测试文件合跑 **10 轮全绿**(修复前同口径 6 轮/10 轮各复现 1 次);
后端全量 77 文件 / 1134 用例全绿。

## 5. 仍待确认(留给后续)

**R1 回滚路径是否有同样问题。** `resetToCheckpoint` / 回滚指令同样操作 git 索引,
是否也需要同一把锁,未验证。

**R2 跨进程并发不在本次范围。** 当前锁是**进程内** Map,只挡住同一个 server 实例
内的并发。两个 server 实例指向同一仓库时(沙箱/测试实例场景,见
[second-server-instance-sweeps-production-tasks.md](second-server-instance-sweeps-production-tasks.md))
仍会冲突。需要跨进程锁(文件锁)才能覆盖,**但要先确认该场景是否被允许存在** ——
如果本来就不该有两个实例写同一棵树,那更该在别处挡住,而不是在这里加锁。
