# Spec: participant 名字不该是路由键

> **状态**: Ready for Implementation
> **版本**: 1.0
> **日期**: 2026-08-23
> **前置于**: `specs/role-identity-display.md`(改名要先解开这个绑定)

## 背景:名字既是显示文本,又是主键

`lib/executors.ts:14` 的注释写明了当前机制:

> audienceRef 命中本配置(**按 `participant.name === agentName` 匹配**)时创建 task 并 spawn

`ensureExecutorParticipants` 也按名字幂等注册(`executors.ts:671-678`:
`where(eq(participantTable.name, ex.agentName))`,不存在就 insert)。

**于是名字不能改。** 改名 = 匹配不上 = 派给它的任务 spawn 不起来;
只改常量不改库,启动时还会**凭空建一个新 participant**,原来那个变孤儿、群成员关系全指向旧的。

## 为什么现在非改不可

名字里编码了角色,而角色是**群级**的、可变的:

| participant 名 | 在「三层模式验证」群的角色 |
|---|---|
| **Codex 执行器** | `coordinator` |
| **AtomCode 执行器** | `executor` |

界面上于是显示成「Codex 执行器 · 协调者」——**自相矛盾**。

而设置页自己的副标题写着:「同一 participant 可在不同群组持有不同角色」。
**名字里写死角色从根上就是错的**,但因为名字是路由键,现在改不了。

顺带一提:`executor_key` 这个字段名也和「executor 角色」撞名(协调者也有 `executor_key: codex`)。
**那是另一件事,不在本票**——本票只解开「名字 = 键」这一条绑定。

---

## 要求

### R1. 换成稳定的绑定键

- 执行器配置与 participant 的关联**不再依赖 `participant.name`**
- 用什么当键自行判断并**在汇报里说明**。可考虑:配置里的 `key`(已存在,如
  `executor` / `codex`)、或在 participant 上加一列存配置键
- 换键后 `participant.name` 变成**纯显示文本**,可自由修改

### R2. 存量数据必须平滑迁移

库里已有 8 个 participant 按旧规则建的(`AtomCode 执行器`、`Codex 执行器` 等),
它们在多个群里有成员关系、有历史任务与消息。

- **不得孤立既有 participant**,不得凭空新建重复的
- 迁移后 `ensureExecutorParticipants` 幂等性保持:重启不产生新行
- ⚠️ **本票不改任何 participant 的名字**——改名是下游 `role-identity-display` 的事。
  本票只让改名**变得可能**

### R3. 验证「改名不再破坏路由」

这是本票唯一真正的验收信号:

- 加测试:改掉某个 participant 的 `name` 后,派给它的任务**仍能正确路由到对应执行器配置**
- 没有这条测试,本票等于没做

### R4. 不要顺手做别的

- **不改** `executor_key` 字段名(撞名问题另议)
- **不改** `agentName` 这个配置字段名(注释里说明它是历史遗留,改名会波及
  `executors.json` / DB 行)——若判定必须改,**先写进汇报**

---

## 验收标准

- [ ] 执行器配置 ↔ participant 的关联不再依赖 `participant.name`
- [ ] 所选的键已在汇报中说明
- [ ] **改掉 participant 名字后,任务路由仍正确**(有测试证明)
- [ ] 8 个存量 participant 未被孤立、未产生重复行
- [ ] `ensureExecutorParticipants` 重启幂等,不新增行
- [ ] 本票**未改动任何 participant 的名字**
- [ ] `executor_key` / `agentName` 字段名未改
- [ ] `pnpm --filter server test` 退出码 0,用例数不减(当前 430)

## 不涉及

- **不改**前端
- **不改**任何 participant 的显示名(下游票的事)
- **不改** `executor_key` 撞名问题
- 不引入新依赖

## 执行环境提示

- 本仓是 **pnpm** 项目
- 后端以 `pnpm --filter server start`(无 watch)在 3001 运行:改完需 build + restart
- ⚠️ **Schema 变更须确认迁移已应用**(启动守卫会拒绝启动并列名)
- ⚠️ **重启前先确认没有 running 任务**——`ce05c53` 已修「失败启动摧毁任务状态」,
  但正常重启仍会把 running 任务标 failed(那是设计如此)
