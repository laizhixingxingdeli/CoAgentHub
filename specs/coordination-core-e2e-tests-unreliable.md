# Spec: 协调核心的端到端回归测试长期红灯/易碎,回归网失效

> **状态**: Frozen — 2026-09-07

## 1. 现象

`packages/backend/server` 全量 1131 用例中,**两条覆盖协调核心的端到端用例长期红**:

```
× executor-coordinator-workspace-gate.test.ts
    验收 1:协调者 A 进程存活期间 B 的协调票排队;A 进程退出后 B 被拉起
    → expected +0 to be 1   (occupancy 读到 0)

× coordinator-resume.test.ts
    端到端:协调者派子任务后退出 → 子任务完成 → 协调者被重新拉起 → 结案
    → task(...) 未在 15000ms 内达到 running
    [executor] detached 任务启动失败: spawn .../fake-executor.sh ENOENT
```

单文件单独跑同样失败(不是跨文件干扰);`workspace-gate 验收 1` 稳定复现
(每次 ~170ms 失败),`coordinator-resume` 端到端表现为超时。

## 2. 这不是「测试小毛病」

这两条恰好覆盖**平台最核心、也最难靠单测替代的两条链路**:

- 工作树级协调串行(同一棵树同时刻只有一个写树方)
- detached 协调者「派完即退 → 子任务终态 → 续跑 → 结案」

2026-09-03~07 修复期间,它们红着,导致:

1. **无法区分「我改坏了」与「本来就坏」。** 检视者两次被迫用
   `git stash` 把改动摘出去单跑,才能确认红灯与本次改动无关。
   这是每一次改动都要付的税。
2. **真正的回归会被藏住。** 一条恒红的用例等于没有断言。

## 3. 已知线索(测试作者自己写在注释里)

`coordinator-resume.test.ts:645-648`:

> 本组用例自带临时 git 仓库:本文件其它用例的 fire-and-forget spawn 会在
> setup.ts 的共享临时仓库里做 git add/commit,被测试重置 SIGKILL 后可能
> 留下 `index.lock`,使本组 spawn 的「执行前快照」失败(**本文件既有 flake**,
> 与本票改动无关 —— **端到端用例同样偶发**)。

也就是说:**问题被知道、被绕开(给一组用例单独开仓库),但没有被修**,
端到端那条被留在原地继续偶发。

`ENOENT` 出现在 spawn 时,既可能是 bin 不存在,也可能是 **cwd 不存在**
(Node 的经典歧义)—— 本文件确有 `afterAll` 删除临时仓库的代码路径,
排查时不要只盯 bin。

## 4. 要做的

**R1 两条用例稳定通过。** 判据是**连续 10 次全绿**(`--repeat` 或循环跑),
不接受「跑一次过了」—— 其中一条本来就是偶发。

**R2 根因必须写明,不接受靠重试掩盖。** 修法不得是加 retry / 加超时 /
`skip` 掉。若确认根因是 fire-and-forget spawn 与共享临时仓库竞争,
就把仓库隔离做彻底(每个用例或每个文件自带仓库),或让测试重置**等待**
在途 spawn 结束再清理,而不是 SIGKILL 后立刻删目录。

**R3 清理顺序要安全。** 删除临时仓库/临时 bin 前,必须确认没有仍在运行或
即将 spawn 的子进程引用它们;否则 ENOENT 只是症状,换个时机还会复现。

## 5. 硬验收

1. `npx vitest run test/executor-coordinator-workspace-gate.test.ts` 与
   `npx vitest run test/coordinator-resume.test.ts` **各连续跑 10 次全绿**。
2. `npx vitest run`(全量)绿,无 skip 增加、无 `it.skip` / `.todo` 掩盖。
3. 修复说明里写清根因(是 index.lock?是 cwd 被删?是 occupancy 登记时序?),
   并说明为什么这次不会再偶发。

⚠️ **不得通过放宽断言达成。** 例如把 `expect(occupancy).toBe(1)` 改成
`>= 0`、把 15s 超时改成 60s、或删掉端到端用例改写成单测 —— 那是把回归网
拆掉,不是修好它。

## 6. 不涉及

- 不改被测的生产行为(工作树闸、续跑机制本身)。若排查中发现生产代码确有
  时序缺陷,**另开票**,不要混在本票里改。
