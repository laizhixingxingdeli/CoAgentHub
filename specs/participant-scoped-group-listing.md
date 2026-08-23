# Spec: 缺少「按参与方过滤的群列表」,迫使插件端扫全平台

> **状态**: 待验收 — 实现已落地(`7c6c4a2`),**L2 与 L3 均未完成**
> **版本**: 1.0
> **日期**: 2026-08-23
> **来源**: dsh adapter-gaps(`f562a82`)L3 检视时发现,同一提交里独立命中两次

## 背景

`GET /groups`(`routes/group/groups.ts`)只支持 `status` / `q` / `limit` / `offset`
四个过滤参数,**没有「只给我这个参与方所在的群」这个能力**。

dsh 检视者适配(`053bc5d`)在实现 adapter-gaps 的两个不相关子功能时,
**各自独立**撞上了这同一个缺口,都用同一种绕法解决:

```ts
// 断线重连补拉订阅群列表用
getSubscribedGroupIds: async () => (await client.listGroups(100)).items.map(g => g.id)

// 送达档位同步用(syncDeliveryTier)
const groups = await client.listGroups(100)
await Promise.all(groups.items.map(async group => {
  const members = await client.getGroupMembers(group.id)
  const member = members.find(c => c.participantId === participantId)
  if (member === undefined) return  // 白扫一次
  ...
}))
```

两处都是「拉全平台前 100 个群,逐个查成员表,自己过滤出真正相关的那几个」。

## 为什么这是真问题

- **规模隐患**:平台群数一旦超过个位数,每次 WS 重连 / adapter 切换都要对
  「大多数用不上」的群各打一次 `getGroupMembers`——量随平台总群数增长,
  不随该参与方实际相关的群数增长
- **语义错位**:两处代码的真实意图都是「我关心的群」,写出来的却是
  「平台所有群,减去不相关的」——这是从错误的起点算减法,不是从对的起点算加法
- **会被反复重造**:同一个缺口这次在一个提交里独立撞见两次,
  说明它不是边角情况,是「参与方想知道自己在哪些群」这个常见需求
  缺一个直接的实现路径。codex/dsh 插件后续任何类似功能都会再撞一次

## 要求

- `GET /groups` 增加**可选**过滤参数(参数名自定,但语义须是
  「返回该参与方所属的群」),不破坏现有的 `status`/`q`/`limit`/`offset` 行为
- 过滤方式自行判断(join `group_members` 按 `participantId` 过滤是最直接的做法)
- **不要求** dsh/codex 插件在本票范围内改用新参数——那是后续对它们的独立跟进,
  本票只加平台能力
- `memberCount` 等既有响应字段保持不变

## 验收标准

- [ ] `GET /groups` 传入过滤参数时,只返回该参与方所属的群
- [ ] 不传时行为与现状完全一致(不破坏 dsh/codex 现有调用)
- [ ] 与 `status`/`q`/`limit`/`offset` 可组合使用
- [ ] 新增测试覆盖:传参过滤、不传保持现状、与其他过滤参数组合
- [ ] `pnpm --filter server test` 全绿(先跑一次确认基线,不得减少)

## 不涉及

- **不改** dsh-coagenthub / coagenthub-codex 插件代码(它们已用现有能力
  绕过实现,本票落地后是否切换用新参数,是另一件事,不在本票范围)
- **不改** `GET /groups/:id/members`(单群成员列表本身没问题)
- 不引入新依赖

## 执行环境提示

- 本仓是 **pnpm** 项目
- 后端以 `pnpm --filter server start`(无 watch)运行中:改完需手动 build + restart
