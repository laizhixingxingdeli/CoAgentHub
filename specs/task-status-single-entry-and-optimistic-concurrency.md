# Spec: task 状态写入唯一入口 + 乐观并发(报告 S1)

> **状态**: **Landed —— 两个阶段均已落地(2026-09-13)**
> **版本**: 1.0
> **来源**: `docs/implementation-optimization-review-2026-09-07.md` §5 S1
> **实现**: 第 1 阶段 `293d51aa`;第 2 阶段 `4e7a4246` / `78fde321` /
> `a9d5c173` / `ffece323`

## 1. S1 的两条验收,分两阶段做

| 验收 | 内容 | 阶段 |
|---|---|---|
| 1 | 生产状态写入点能够枚举并归属到权威入口 | 第 1 阶段(纯收敛,行为不变) |
| 2 | **旧状态竞争失败不继续执行副作用** | 第 2 阶段(乐观并发,行为改动) |

**这样切是有理由的**:收敛完之后,第 2 条变成「给一个函数传参」,
不必再碰十几个散落的写入点;而且每个转换可以**单独一票、单独验收**。

## 2. 第 1 阶段(`293d51aa`):12 处 → 1 个入口

`executor-task/task-transitions.ts` 的 `writeTaskStatus` 成为唯一写入口。
**11/12 迁入**;`routes/group/tasks.ts` 的 **PATCH 留在原地**,理由成立:
`status` 可选、`notify` 有条件(`status !== undefined && updated.status !== task.status`)、
写后还有额度冷却 / coordination activity / dispatch warnings 三段副作用 ——
硬套会改行为。

⚠️ **执行侧实现了票面写着「本票不实现」的 `expectedStatuses`,而那是必须的**:
`orphan-task-reconciler` 改动前 `where` 里本来就有 `eq(status,"running")`
(注释:R5 以「仍为 running」为条件更新)。不实现它反而会**删掉那道守卫**。
副作用是好的:第 2 阶段的机制由此**已经存在并在一个站点被验证过**。

⚠️ **票面那条 grep 自证判据不够严**:PATCH 用的是简写 `{ status }` 而非
`status:`,检视者的扫描漏了它。**写这类自证要覆盖简写属性。**

## 3. 第 2 阶段:一个转换一张票

| 票 | 转换 | `expectedStatuses` | 竞态输了跳过的副作用 |
|---|---|---|---|
| `4e7a4246` | `done` | `["running"]` | **不发「任务完成」卡片** |
| `78fde321` | `queued` ×2(瞬时限流 / 403) | `["running"]` | **不 `group.queue.push`(不复活)**、不发「退避重试」 |
| `a9d5c173` | `running` | `["queued","running"]` | **不 `postStatus` / 不 `beginAttempt` / 不 spawn** |
| `ffece323` | `failed` ×3 + `cancelled` ×2 | `["queued","running",<目标自身>]` | 不宣告 ❌/⚠️、不进批量 notify |

**现状:11 个 `writeTaskStatus` 调用点里 10 个有守卫。**

### 3.1 三条设计判断

1. **`running` 的前置取 `["queued","running"]` 而非 pin 死 `["queued"]`** ——
   要防的是**终态**;pin 死会误伤重试 / 回收重入。
2. **终态写入的统一判据:「只有活着的任务能被写成终态」**,
   即 `["queued","running"] + 目标状态自身`。
   加「目标自身」是为了**保住幂等重写**(同一终态补写更详细的 `diffSummary`
   不该被拦)。
3. **异常 ≠ 竞态**。原有 `try/catch` 里的 `console.warn` 是 **DB 异常**路径,
   保持旧行为;**只有返回 `null`** 才按竞态处置。两者混成一条路径会把
   「数据库挂了」当成「别人先写了」。

### 3.2 唯一的例外:`control.ts` 回滚

它**故意**把已 `done` 的任务改判 `failed` —— 原注释就写着
「快照对应的任务视为未完成」,回滚的语义本就是把完成的工作判为未完成。
**这是合法的跨终态写入,不加守卫**,并已就地补了标注。

⚠️ 票面明写了「若某处存在合法跨终态写入就停下来说明,宁可 5/6 也不要拍脑袋」——
执行侧照做了。**这一条比多加一个守卫更有价值。**

## 4. L3 核实:四票各自做了变异,共 8 次

检视者**每一票都自己重跑变异,不采信汇报**:

| 变异 | 结果 |
|---|---|
| 去掉 `done` 守卫 | 竞态用例变红 |
| 去掉两处 `queued` 守卫 | **两条各自变红**(互不覆盖) |
| 去掉 `running` 守卫 | 变红,断言用的是**假 bin 哨兵文件**(证明没真 spawn) |
| 去掉 `failTask` 守卫 | 变红,另两条保持绿 |
| 去掉 `markTaskCancelled` 守卫 | 变红,另两条保持绿 |
| **去掉「目标状态自身」** | **幂等重写那条变红** ← 连设计决定本身也有测试守着 |

其余:`tsc` / `biome`(仓库根)每票 exit 0;各票的清单测试均 0 failed
(88 → 90、41 → 45、81 → 83、109 → 112)。

## 5. 与今天其它工作的关系

第 2 阶段堵的三个洞是同一族,且都是
[stop-before-spawn-guard-never-fires.md](stop-before-spawn-guard-never-fires.md)
的**下游**:那张票修的是「守卫读不到 `stopped`」,本 spec 修的是
「**DB 里已经是终态,内存里却照跑 / 照写**」。

具体说:即使停止成功落库,在本 spec 之前——

- 成功路径会把 `cancelled` **覆盖成 `done`** 并发完成卡片;
- 退避重试会把它**重新入队**;
- pump 会把它**置回 `running` 并真的 spawn**。

**三条都堵上了。**

## 6. 未做的

- **PATCH 路由**(`routes/group/tasks.ts`)仍是第二个写入点,且无守卫。
  它的 `status` 可选、副作用多,要单独设计。
- `control.ts` 回滚:见 §3.2,**有意不做**。
