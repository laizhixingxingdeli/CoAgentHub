# Spec: 内置名字写死「执行器」,协调者据此判定要派给自己,死锁

> **状态**: Ready for Implementation
> **版本**: 1.0
> **日期**: 2026-08-26

## 现象:连续两张票停在同一句话上

```
无法按发布者指定下发给 codex:群内唯一 Codex participant 是本协调者,禁止自派;
非自身 executor 仅 AtomCode 与 CodeBuddy。需增加独立 Codex executor participant,
或由发布者明确允许改派。
```

两张票(`01a03d6a`、`01a03d6e`)以逐字相同的理由失败,**均未修改代码、未创建提交**。

## 根因:名字里的「执行器」与群内角色无关

`lib/executors.ts:135`:

```ts
key: "codex",
agentName: "Codex 执行器",
```

该 `agentName` 被用作 participant 名称,进而进入
`dispatchAudit.targetParticipantName`(`executor-task/queue.ts:1027`):

```json
"targetParticipantName": "Codex 执行器",
"targetParticipantId":   "…4a40",        // Codex,本群角色 coordinator
"candidates": [ AtomCode available, CodeBuddy available ]
```

协调者读到「本任务的目标是 Codex **执行器**」,合理地推断发布者要求派给 codex;
而群内唯一的 Codex 就是它自己 —— 禁止自派,于是停下报阻塞。

⚠️ **它的推理没有错,错的是标签。** 检视者下发时用的是
`audience: role / audienceRef: coordinator`,**从未指定过 codex**;
平台给的候选列表里两个执行器都是 `available`;
同一形态的上一张票(`01a03d4d`)正常派给了 AtomCode。
唯一的变量是它这次读到并采信了这个名字。

## 决策

### R1. 内置名称不得声明角色

`executors.ts` 中各内置条目的 `agentName` **去掉角色词**
(「执行器」/「Executor」之类)。名字只标明**是哪个工具**,例如 `Codex`。

⚠️ 角色是**按群**的(`group_members.roles`),同一个 participant 可以在这个群
当协调者、在那个群当执行器。把角色烙进全局名字必然与某些群冲突。

### R2. 判定角色只能查群成员表

任何「这个 participant 是不是执行器」的判断,**一律查 `group_members.roles`**,
不得从名称推断。

⚠️ 复用现成判据:前端已有 `member-role.ts` 的 `roleFromMemberRoles`
(`coordination-task-is-not-l1` 立的规矩),后端亦有成员角色查询。
**不要新写第三种角色查法。**

### R3. 已注册的 participant 名称需迁移

`ensureExecutorParticipants` 幂等注册时用的是 `agentName`,
库中已存在旧名(如「Codex 执行器」)。改名后需保证:

- 现有 participant **按 id 稳定**,不因改名产生新 participant(必测)
- 群成员关系、历史任务的 `executor_participant_id` 关联**不断**(必测)

⚠️ **不要**新建 participant 再迁移数据 —— 那会让历史任务失去归属。
就地更名。

### R4. 不改角色语义与派发规则

- **不改**「禁止自派」规则 —— 那条是对的,本票只让它不再被误触发
- **不改** `dispatchAudit` 的结构与其它字段
- **不改**执行器的 `key`、`bin`、`args` 等运行参数

## 验收标准

- [ ] 内置条目的 `agentName` 均不含角色词(读代码确认,必测)
- [ ] 改名后 participant **id 不变**,群成员关系与历史任务关联完好(必测)
- [ ] `dispatchAudit.targetParticipantName` 不再出现角色词(必测)
- [ ] 任何角色判定均来自 `group_members.roles`,代码中**没有**按名称含
      「执行器」/「executor」推断角色的分支(读代码确认,必测)
- [ ] 「禁止自派」规则行为逐字不变(回归,必测)
- [ ] **真实下发一张需求票给 `role: coordinator`,协调者成功派给 AtomCode
      或 CodeBuddy 并产生带 `Co-Authored-By` 的提交** —— 本票唯一的真验收信号
- [ ] 后端测试全绿,贴出用例数

## 不涉及

- 自派规则本身(R4)
- 执行器运行参数(R4)
- 协调者何时应当自己实现(另票 `dispatching-should-be-the-default`)

## 执行环境提示

- 名称定义:`packages/backend/server/src/lib/executors.ts`(各内置条目的 `agentName`)
- 审计写入:`packages/backend/server/src/lib/executor-task/queue.ts:1027`
- ⚠️ 本票**必须下发给执行器**完成 —— 但它要修的正是阻断派发的那个原因。
  若因该原因无法派发,**不要自己实现**:以 `failed` 结案并写明
  「被本票所述缺陷阻断」,由检视者处置
- ⚠️ 做完记得提交
