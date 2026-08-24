# Spec: 下发只能钉死具体 participant,于是每次下发都替协调者做了执行方决定

> **状态**: Ready for Implementation
> **版本**: 1.0
> **日期**: 2026-08-25
> **发现于**: 用户追问「为什么还是 codex 在执行」后的数据核查

## 现象:八成的票没有 L1

全库统计(54 张有 specRef 的协调任务):

```
有执行子任务(L1 真发生)   11 张   20%
零子任务                     43 张   80%
```

而 `coordination-close-integrity` 的强制**是有效的** —— 分水岭很干净:

| 时段 | 零子任务 done | 其中声明了理由 |
|---|---|---|
| 强制落地前(11:12 之前) | 16 | **0** |
| 强制落地后 | 11 | **11(100%)** |

没有绕过强制。问题在于:**强制只保证「要么有 L1、要么写明理由」,挡不住
「每次都写个理由继续自己干」。**

## 根因:是检视者的下发方式,不是协调者违规

读那 11 条 `noExecutionReason`,**五条写的是同一句**:

> 本票由**发布者直接定向 codex** 完成实现,未创建下游执行子任务。

「发布者」是检视者。而它说得对 —— 检视者每次下发用的都是:

```json
{ "audience": "participant", "audienceRef": "<codex 的 participantId>" }
```

**任务书里写着「请下发给执行器」,API 却把票钉死在 codex 上。** 两个指令冲突,
协调者选择了更硬的那个(API 定向),并诚实地声明了理由。

### 而检视者别无选择

平台**不支持**「交给协调者角色、由它自行挑执行器」:

`maybeDispatchExecutorTask` 把 `audienceRef` 当 **participant id** 直接查
(`queue.ts:377-378`):

```ts
const participant = await db.query.participant.findFirst({
  where: (t, { eq }) => eq(t.id, audienceRef),
});
if (!participant) { /* 跳过,任务根本不创建 */ }
```

消息层的 `audience: "role"` 是合法值(`messages.ts:203`,校验角色名在
`GROUP_ROLES` 中),但派发层不认 —— 传角色名进去会「无对应 participant」直接
跳过,**任务不会被创建**。

**所以这是结构缺口,不是纪律问题。**

## 决策:派发层支持角色定向,由平台选出目标 participant

### R1. `audience: "role"` 时,派发层按角色解析目标

`maybeDispatchExecutorTask` 当 `audience === "role"` 时:

1. 查本群中 `roles` 含 `audienceRef` 的成员
2. 从中选出**一个**目标 participant(选取规则见 R2)
3. 其余流程(建任务、生成任务书、spawn)**完全不变**

`audience === "participant"` 时的现有行为**逐字不变**(回归,必测)。

### R2. 选取规则:复用既有的执行器可用性判定,不新造

多个成员持有该角色时,按以下顺序选取,**全部复用现有函数**:

1. 排除不在执行器配置中的(`findExecutorByParticipant` 返回空)
2. 排除处于限额冷却的(`isInCooldown`)
3. 排除已达并发上限的(`runningExecutorCount` vs `maxConcurrency`)
4. 余下的**取一个**;都不可用则**按现有排队机制排队**,不报错、不跳过

⚠️ **不要新写一套调度**。这些判定 `queue.ts` / `state.ts` 里都有,
另写一份必然与主路径漂移 —— 本轮已有先例(`isDetachedTask` 就是靠复用避免了这点)。

### R3. 角色不存在或无匹配成员时,明确失败

`audienceRef` 不是合法角色名,或本群无成员持有该角色 →
**记录明确原因并不创建任务**,原因要能被调用方看到。

**不要静默跳过** —— 现状就是静默跳过(`console.log` 后 `return`),
而这正是「消息发出去了但任务没创建」这类问题难查的原因(本轮踩过一次:
任务凭空挂 `running` 八小时)。

### R4. 不改消息层

`messages.ts` 对 `audience: "role"` 的校验**已经正确**(角色名须在 `GROUP_ROLES`
中),**不动**。本票只补派发层。

### R5. 不改 skill、不改任务书模板

协调者 skill §2.2 的执行器挑选纪律**保持不变** —— 本票解决的是「检视者不必替它
指定」,不是「平台替它挑」。平台按角色选出的是**接收这张协调任务的协调者**,
协调者收到后**仍应按 §2.2 自行挑选执行器**下发 L1。

⚠️ 这一点必须写进实现注释,避免后来者误以为平台已经代劳了执行器选择。

## 验收标准

- [ ] `audience: "role"` + `audienceRef: "coordinator"` → 任务被创建,
      目标是本群持有 coordinator 角色的成员
- [ ] `audience: "participant"` 的行为**逐字不变**(回归,必测)
- [ ] 多个成员持有该角色时,跳过不在执行器配置中的
- [ ] 跳过处于冷却的成员
- [ ] 跳过已达并发上限的成员
- [ ] 全部不可用时**排队**,不报错、不跳过
- [ ] 角色名非法 → 明确失败,原因可见,**不静默跳过**
- [ ] 本群无成员持有该角色 → 同上
- [ ] 选取逻辑**复用** `findExecutorByParticipant` / `isInCooldown` /
      `runningExecutorCount`,未另写一套
- [ ] 实现注释写明:平台按角色选的是**接收方**,执行器仍由协调者按 §2.2 自行挑选
- [ ] **未改动** `messages.ts` 的角色校验、`skills/`、任务书模板
- [ ] 后端测试全绿,贴出用例数

## 不涉及

- 协调者挑选执行器的纪律(R5,仍归 skill §2.2)
- 消息层校验(R4)
- 已有那 43 张零子任务任务的补救(历史数据,不回填)

## 执行环境提示

- 本仓 pnpm 项目,后端 `:3001`
- 关键位置:`lib/executor-task/queue.ts:377`(participant 解析)、
  `routes/group/messages.ts:203`(角色校验,已正确)
- 改完重启后端;**重启前确认无 running/queued 任务**;
  验收前用 `ps -o lstart=` 确认监听进程启动时间晚于本次提交
- ⚠️ 做完**记得提交**。本轮已连续多张票出现「实现完成但未提交」
