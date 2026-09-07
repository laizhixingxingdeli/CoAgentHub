# Spec: 第二个 server 实例启动时把生产在途任务全部判死

> **状态**: Landed — 2026-09-07(修复 `eaf19d1b + 0665f25b`;L3 已 pass)
>
> 落地要点:R2/R3 未启动的 queued 不再判死;R1 任务登记属主实例 pid
> **优先级**: 最高。它让「测试平台」这件事本身变成破坏性操作。

## 1. 现象(2026-09-06 07:52 实证)

执行器为验证看门狗票(`cc17d232`)的重启行为,起了一个沙箱 server 实例。
该实例**端口是隔离的**(:3101,生产在 :3001),**数据库不是**。

沙箱实例的启动兜底直接扫了生产任务:

```
/tmp/cohub-sandbox-server.log
  server listening on :::3101
  [executor] 重启兜底:保留 1 个仍存活的任务
  [executor] 重启兜底:2 个 queued/running 任务置为 failed (server-restart)
  2026-09-05T23:52:46.023Z GET /api/health
```

被判死的两条正是当时的生产在途任务 —— 其中 `01a07297-c93d` 是**这个执行器自己
所属工作项的协调任务**。它在测试平台的过程中杀掉了自己的链条。

DB 侧证据:`01a07297-c93d` 与 `01a073b0-0b11` 的 `updated_at` **同为 23:52:43**,
而生产 server 进程(pid 38708)启动于 **21:21:20 从未重启**,
`/api/health` 的 `startedAt` 也仍是 13:21:21Z。**没有任何生产重启发生。**

## 2. 根因

`recoverInterruptedTasks`(`queue.ts:480`)在 `server-startup.ts:43` 于**每次启动时**
无条件执行,按 `DATABASE_URL` 扫全库:

```ts
const candidates = await db.query.task.findMany({
  where: and(inArray(taskTable.status, ["queued", "running"]),
             isNotNull(taskTable.executorKey)),
});
const deadTaskIds = candidates.filter(
  (row) => row.executorPid === null || !isExecutorProcessAlive(row.executorPid),
).map((row) => row.id);
```

两个独立问题:

**问题 A —— 实例不隔离。** 兜底范围是「这个数据库里的所有任务」,
而不是「本实例自己启动过的任务」。任何指向同一 `DATABASE_URL` 的进程,
无论端口多少、是不是沙箱、活了几秒,启动即清场。

**问题 B —— `executorPid === null` 被判死。** `queued` 任务从未 spawn,
`executorPid` 恒为 null,于是**每次启动都会把所有排队任务判死**,
并冠以 `server-restart` 这个与事实不符的原因(它根本没开始过,谈不上被重启打断)。

## 3. 危害

- **测试平台 = 破坏生产。** 看门狗票、结案守卫票、queued 回收票的硬验收都要求
  「真实端到端」,而真实端到端就意味着起实例。当前设计下,照做即自毁。
- **归因被污染。** 2026-09-03~06 有多次任务标记为 `server-restart`,
  我据此判断「后端重启打断了任务」并重派 —— 其中至少 2 条实际上是沙箱实例造成的,
  生产从未重启。**错误的失败原因把检视者引向了错误的结论。**

## 4. 要做的

**R1 兜底只清本实例的任务。** 启动兜底必须限定在「本实例负责的任务」范围内。
可行做法(任选,实现方判断):任务行记录 owning instance id(启动时生成),
兜底只处理 owner 为自己或 owner 已确证消失的行;或以「进程确实不存在**且**
该 pid 不属于任何存活实例」为唯一判据。
⚠️ **不得依赖端口或环境变量猜测「是不是沙箱」** —— 判据必须是数据本身。

**R2 `queued` 不得因 `executorPid === null` 被判死。** 从未 spawn 的任务
应当被**重新入队**(现已有 `queued-task-reclaim`,`54be31ef`),而不是判 failed。
若确需失败,原因也不能写 `server-restart`。

**R3 失败原因要与事实一致。** `server-restart` 只能用于「本实例确实重启且该任务
确实在运行中被打断」。其余情形另用准确原因(如 `queued-never-started`、
`orphan-pid-gone`),使检视者与协调者不会被误导。

## 5. 硬验收

真实端到端,不接受只有单测:

1. 生产实例运行、群内有 1 个 running 与 1 个 queued 任务 → 启动第二个实例
   (不同端口、同一 DATABASE_URL)→ 断言两条任务**状态不变**,
   且 `diffSummary` 未被写入 `server-restart`。
2. 真实重启生产实例(`scripts/coagenthub-prod.sh restart`)→ 断言
   **running 任务**按既有语义被处理,而 **queued 任务被重新入队而非判死**。
3. 断言任何被判死的任务,其 `error` 与实际发生的事一致(R3)。

⚠️ 验收 1 必须真的起第二个进程。**用单测模拟「另一个实例」不算** ——
本缺陷的本质就是「进程边界与数据边界不一致」,在单进程内模拟会绕开它。
起沙箱实例时请先确认群内在途任务已清空,或指向独立数据库。

## 6. 不涉及

- 不改 `queued-task-reclaim` 的回收逻辑(`54be31ef`,已通过 L3)。
- 不改孤儿收敛对**真正**失联进程的处置。
- 不引入服务发现/心跳表之外的额外基础设施 —— 若 R1 需要实例注册,
  用最小实现(单表或 diffSummary 字段),不要新建服务。
