# Spec: 续跑消费者把检视者收件箱里的 L3 事件判死,L3 回传成了 5 秒竞态

> **状态**: Frozen
> **版本**: 1.0
> **日期**: 2026-09-07
> **来源**: 2026-09-07 首次真实下发时的实测(见 §1.1),不在实现优化报告的
> R1–R10 清单内;归属报告 §3.3 与 S3「多个模块各自推导活动事实,互相补偿」。
> **相关**: [l3-request-delivery-and-scope.md](l3-request-delivery-and-scope.md)(收件人由载荷裁定)、
> [wake-the-coordinator-on-child-completion.md](wake-the-coordinator-on-child-completion.md)(续跑消费者的来处)、
> [completion-events-never-reach-terminal-state.md](completion-events-never-reach-terminal-state.md)(dead 判定的来处)

## 1. 背景与目标

### 1.1 现状证据(实测)

检视者(`claude`)向协调者派发了一条 detached 任务
`01a07a5f-8deb-726f-9615-9d779242536d`。任务落终态后 DB trigger 正确创建了完成事件,
收件人正是检视者。**约 2 秒后该事件变成 `dead`**:

```
state=dead  attempts=0
last_error=事件所属任务没有父任务(非被派发的子任务),无续跑对象
created_at=13:37:57.925   updated_at=13:37:59.821
```

检视者随后 `GET /api/participants/:id/task-completion-events` 返回 **0 条**
(inbox 列举只含 pending 与过期 leased,`dead` 不列出),也无法再 `claim`
(claim 的原子条件同样不含 `dead`)。

### 1.2 机制

[`coordinator-resume.ts`](../packages/backend/server/src/lib/executor-task/coordinator-resume.ts)
的 `consumePendingCompletionEvents()`(第 798 行起)每 **5 秒**跑一次
(`startCoordinatorResumeConsumer` 默认 `intervalMs = 5_000`),它:

1. 扫出**全部** `pending` 事件 —— **不按收件人过滤**;
2. 对每条事件调 `maybeCreateCoordinatorResumeTask(db, task)`;
3. 返回 `permanence === "permanent"` 时把事件置 `dead`。

而 `maybeCreateCoordinatorResumeTask` 的第二条永久分支正是:

```ts
if (!childTask.parentTaskId) {
  return { kind: "skipped", permanence: "permanent",
           reason: "事件所属任务没有父任务(非被派发的子任务),无续跑对象" };
}
```

**检视者派给协调者的 detached 任务恰恰就是「无父任务」的顶层任务**
(它是整条链的起点)。于是:

> 协调者 L2 通过 → `PATCH` 该任务为 `done`(带 `review_request`)
> → trigger 写事件到检视者收件箱 → **≤5 秒后被续跑消费者判死**。

检视者只有抢在这 ≤5 秒窗口内 claim 才拿得到 L3 请求。**这不是契约,是竞态。**
`l3-overdue-reminder.ts`(L3 逾期提醒)的存在与这条缺陷同源:L3 请求确实会丢。

### 1.3 为什么这是「两个模块推导同一事实」

- **续跑消费者**关心的事实是:「某个**子任务**结束了,它的父协调任务要不要被拉起」。
  对它而言,「无父任务」意味着**与我无关**。
- **收件箱**关心的事实是:「这条事件有没有被它的**收件人**处理掉」。
  对它而言,`dead` 意味着**投递彻底失败、不再重投**。

现状把前者的「与我无关」写成了后者的「投递失败」。一个模块用自己的判据,
改写了另一个模块的状态机 —— 报告 S3 要求的正是「同一事实不在多个模块独立推导」。

### 1.4 目标

续跑消费者**只处理属于它的事件**(有父任务的子任务完成事件),
不得改动其它事件的投递状态。顶层任务的完成事件保持 `pending`,
由其收件人按 inbox 契约(list → claim → ack/fail)自行消费。

## 2. 改动范围

| 文件 | 改什么 |
|---|---|
| `packages/backend/server/src/lib/executor-task/coordinator-resume.ts` | `consumePendingCompletionEvents()` 的扫描集合加「任务有父任务」条件 |
| `packages/backend/server/test/coordinator-resume.test.ts` | 「永久 skip 2」用例按新契约重写(见 §4.1),并新增可认领性断言 |

**不改**:`maybeCreateCoordinatorResumeTask` 的任何判定分支(包括它对无父任务
仍返回 permanent skip —— 那是**函数级**契约,描述的是「能不能产生续跑」,本票不动);
其余永久分支(R4 防环 / 父任务不存在 / 父任务已终态)的 `dead` 行为;
inbox 端点;DB trigger;`l3-overdue-reminder`;5 秒轮询周期。

## 3. 详细改动

### R1. 扫描集合排除「无父任务」的事件

`consumePendingCompletionEvents()` 取事件时,与 `task` 表 join,
只取 `task.parent_task_id IS NOT NULL` 的事件。

**必须在查询里排除,而不是取出来再 `continue`**:后者虽然也不改状态,但会让
这些事件每 5 秒被反复取出——原实现把它们标 `dead` 的动机正是避免无限重扫
(见该处注释),换成查询层过滤才是把这个动机真正满足掉,而不是绕过它。

### R2. 其余永久分支的 `dead` 行为不变

R4 防环、父任务不存在、父任务已终态这三条永久分支**继续**置 `dead`:
它们的事件确实属于续跑域(有父任务的子任务完成事件),该消费者是其唯一处置方。

### R3. 顶层事件的归宿写清楚

顶层任务的完成事件保持 `pending`,直到收件人 claim + ack。**这是有意的**:

- 收件人存在(检视者 / 外部触发方)→ 它按 inbox 契约消费,事件正常收敛;
- 收件人不存在或从不消费 → 事件长期 `pending`。这与「任何无人消费的事件」
  是同一种情形,由 inbox 自身的语义负责,**不由续跑消费者代为清理**。
  代为清理别人的信箱正是本缺陷的成因。

在代码注释里写明这一条,避免后来者把「顶层事件为什么不清理」重新当成缺陷修回去。

## 4. 验收标准

### 4.1 必须改写的既有用例

`coordinator-resume.test.ts` 的
**「永久 skip 2:事件所属任务无父任务 → 事件置 dead 且 lastError 写明无续跑对象」**
锁定的正是本缺陷行为,必须按新契约重写:

- 同样构造顶层任务(无 `parentTaskId`)+ pending 事件;
- `consumePendingCompletionEvents` 返回 `0`(不产生续跑,不变);
- **断言事件仍为 `pending`**、`lastError` 为空、`attempts` 为 0;
- 断言 `dead` 事件数为 **0**。

⚠️ 汇报中必须写明这条用例改了什么、为什么 —— 它此前把一个会吃掉检视者收件箱
的行为固化成了「通过」。

### 4.2 新增用例

1. **顶层事件在多轮扫描后仍可被收件人认领**:插入顶层任务的 pending 事件 →
   连续跑 `consumePendingCompletionEvents` **3 次** → 事件仍 `pending` →
   用收件人身份 `claim` **成功**拿到 `leaseToken` → `ack` 后 `state === 'delivered'`。
   (读数据库最终记录,不止断言函数返回值。)
2. **子任务事件行为不变**:有父任务且父非终态 → 仍创建续跑任务、事件置 `delivered`
   (既有用例保持绿)。
3. **R4 防环仍置 dead**:既有用例「永久 skip 1」保持绿,证明本票没有把
   `dead` 一并取消。

### 4.3 回归口径(本机 Windows 基线)

```
cd packages/backend/server && npx vitest run test/coordinator-resume.test.ts
```

**本机基线(改动前实测,2026-09-07 14:18):6 failed | 40 passed (46)** ——
这 6 条红是 Windows 环境问题(测试用 `#!/bin/sh` 假执行器,Windows 起不来),
与本票无关。验收口径是:**失败数不增加,且 40 条绿的那部分不减少**;
新增/改写的用例必须绿。不得用「本机本来就红」放过任何新增的红。

全量后端回归同理:本机基线 **129 failed | 924 passed (1053)**(2026-09-07 13:48 实测)。

### 4.4 端到端

真实跑一轮:检视者派发 → 协调者 PATCH 终态 → **检视者在 30 秒后仍能列到该事件
并 claim 成功**(不再是 5 秒竞态)。读 API 返回,不看日志推断。

## 5. 不涉及的改动

- **不改 `maybeCreateCoordinatorResumeTask`**:它的分支语义正确,错的是调用方
  拿它的结论去改别人的状态机。
- **不改 inbox 的 dead 语义**:`dead` 仍表示投递彻底失败(fail 超过上限)。
- **不合并续跑消费者与 inbox 消费者**:两者职责不同,报告 S3 明确要求
  「保留不同职责,不机械合并成新的大文件」。
- **不动 5 秒周期**:周期不是缺陷,竞态才是。

## 6. 兼容性

- 无 schema 变更,无迁移。
- 行为变更(需在汇报中写明):顶层任务的完成事件不再被自动置 `dead`,
  会停留在 `pending` 直到收件人处理。依赖「顶层事件会被自动清掉」的观察方
  (若有)需要改按 inbox 契约消费。
- 已经被判死的历史事件**不回填**:它们对应的任务早已结束,复活它们只会
  触发一次无意义的迟到投递。需要时由人工按 taskId 处理。
