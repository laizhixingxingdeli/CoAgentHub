# Spec: 冷却对协调者不可见,且排队子任务会钉住已死的协调者链

> **状态**: Ready for Implementation
> **版本**: 1.0
> **日期**: 2026-08-30

## 1. 背景

2026-08-30 14:16–14:20,队列出现一次约 4 分钟的停滞,最终由检视者重启服务恢复。
排查后确认是**两个独立缺陷叠加**,两者都已在代码中核实,不是推断。

⚠️ **本次的直接触发条件是一次误判冷却**(见
`specs/quota-failure-on-clean-exit.md` v1.1 R6),但下面两条**与那次误判无关** ——
换成任何一次真实的 5 小时冷却,同样会发生,而且没有人会去清它。

## 2. 缺陷 A —— `/api/executors` 不暴露可用性,协调者据此选执行器必然踩空

平台**有**可用性判定:`lib/executor-availability.ts` 能给出
`额度冷却至 <ETA>` 这样的结论。但**没有任何路由把它暴露出去**。

`GET /api/executors` 的返回字段:

```
agentName  args  bin  env  inputMode  key  kind  label
maxConcurrency  memory  model  outputProfile  prompt  type  url
```

没有 `cooldownEndMs`,没有 `available`,没有 `unavailableReason`。

**实证:** 协调者在派发前探测可用性,执行的是(服务端日志原文):

```
curl -sS 'http://localhost:3001/api/executors' \
  | jq '[.[]? // .items[]? | {key,agentName,label,participantId,cooldownEndMs,maxConcurrency}]'
```

`cooldownEndMs` 字段不存在 → `jq` 返回 `null` → 协调者读作「未冷却」→
把票 `01a0514f-b3ca` 派给了正在冷却中的 AtomCode → 任务落 `queued`,
被 `isRunDispatchable` 的第一行 `isInCooldown(run.ex)` 挡住,干等。

**协调者不是判断错了,是它看不到。** 同一个坑也把检视者骗了一次:
用同样的方式读到 `null`,误判为「冷却已解除」。

⚠️ **「字段不存在」与「值为空」在 JSON 上不可区分**,这是本条危害的放大器:
消费方无法自证读到的是真相还是缺字段。

### R1 — 暴露可用性,且让「缺字段」不可能被误读为「可用」

- `GET /api/executors` 每条返回中**必须**包含可用性:
  - `available: boolean`
  - `unavailableReason: string | null`(复用 `executor-availability.ts`
    既有文案,如 `额度冷却至 2026/8/30 18:22:51`,**不得另写一套文案**)
  - `cooldownEndMs: number | null`
- ⚠️ 三个字段**恒定出现**,不可用时也要出现(值为 `null`/`false`)——
  正是为了消灭「缺字段被读成可用」这条路径。
- ⚠️ **复用 `executor-availability.ts`,不得在路由里新写判定逻辑**;
  它已是 `tasks.ts` 在用的同一权威源,不得出现第二套。
- 协调者 skill 中「探测可用执行器」的示例改用这些字段(本 spec 不改 skill 正文,
  由后续票处理;此处仅记录依赖关系)。

## 3. 缺陷 B —— 排队中(从未启动)的子任务会无限期钉住已死的协调者链

孤儿收敛器对协调者任务有一条豁免(`orphan-task-reconciler.ts:88-95`):

```ts
if ((await isCoordinatorTask(...)) &&
    ((await hasNonTerminalChildTask(db, task.id)) ||
     (await hasPendingResumeEvent(db, task.id)))) {
  continue;
}
```

而 `hasNonTerminalChildTask` 的口径是(`coordinator-resume.ts:39`):

```ts
const NON_TERMINAL_TASK_STATUSES = ["queued", "running"] as const;
```

**`queued` 也算「子任务还在干活」。**

豁免的本意是对的:协调者进程退出、子任务仍在跑,是正常态,不该判死。
漏的是:**`queued` 且从未启动的子任务并不在干活** —— 它可能因执行器冷却
(最长 300 分钟)而数小时不动。这段时间里:

- 已死的协调者链在 DB 中始终显示 `running`,前端看上去「在跑」;
- 周期收敛器每 10 秒扫一次,每次都跳过;
- 整棵子树没有任何进展,也没有任何告警。

**实证:** 任务 `01a05129-51c7` 与 `01a05148-b62d` 两个协调者进程
(pid 16017 / 63941)已死,DB 状态却持续 `running` 逾 4 分钟;
其后代 `01a0514f-b3ca` 为 `queued` 且 `executor_pid` 为空(从未启动)。
若非人工重启,该状态会持续到冷却结束(18:22),即约 4 小时。

### R2 — 从未启动的排队子任务不构成收敛豁免

- 收敛豁免的判定改为:子任务 `running`,**或** `queued` 且**其执行器当前可派发**
  (即不在冷却、未被并发上限挡住)。
- `queued` 且执行器**不可派发**时,该子任务**不构成豁免** —— 父协调者按普通
  孤儿收敛处理(pid 已消失 → 判死并留痕)。
- ⚠️ **不得改动**子任务本身的状态:排队任务继续排队,冷却结束后照常启动。
  本条只解除**父任务**的豁免,不动子任务。
- ⚠️ `hasPendingResumeEvent` 那一半豁免**逐字不变**。
- ⚠️ `running` 子任务的豁免**逐字不变** —— 那是本机制存在的理由,不得收紧。

## 4. 验收标准

1. `GET /api/executors` 每条恒含 `available` / `unavailableReason` /
   `cooldownEndMs` 三字段;执行器冷却中时三者分别为
   `false` / 冷却文案 / 数值。必测。
2. 执行器**不在**冷却时三字段为 `true` / `null` / `null`(而非缺失)。必测。
3. 路由返回的 `unavailableReason` 与 `executor-availability.ts` 的输出**逐字相同**
   (同一权威源,不得有第二套文案)。
4. 构造:协调者任务 pid 已消失 + 子任务 `queued` + 该子任务执行器**在冷却中**
   → 父协调者**被收敛为 failed**,子任务**仍为 queued**(不被连带改状态)。必测。
5. 构造:协调者任务 pid 已消失 + 子任务 `queued` + 执行器**可派发**
   → 父协调者**仍被豁免**(不判死),因为该子任务马上就会启动。必测。
6. 构造:协调者任务 pid 已消失 + 子任务 `running` → **仍被豁免**(回归,必测)。
7. `hasPendingResumeEvent` 豁免路径行为逐字不变(回归)。
8. 既有 orphan-task-reconciler / coordinator-resume / executor 路由测试全绿。

## 5. 不涉及的改动

- 不改冷却时长、不改额度判定(那是 `quota-*` 两份 spec)。
- 不改 `isRunDispatchable` 的出队条件。
- 不改协调者「跑完即退」模型。
- 不改前端。
- 不清洗历史数据。

## 6. 兼容性

- R1 是纯新增字段,既有消费方不受影响。
- R2 只在「子任务 queued 且执行器不可派发」这一新条件下改变行为;
  其余分支逐字不变。
