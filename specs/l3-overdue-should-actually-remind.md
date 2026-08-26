# Spec: L3 逾期只在读详情时算一个布尔值,没人读就等于没发生

> **状态**: Ready for Implementation
> **版本**: 1.0
> **日期**: 2026-08-26

## 现象:两条请求已逾期,谁都没被告知

本群实况:

```
01a03c00  续跑  coordinator-exits-after-dispatch   answered=False  overdue=True
01a03c53  续跑  coordination-task-is-not-l1        answered=False  overdue=True
```

两条 L3 请求已超过 `l3ResponseMinutes`(默认 120 分钟)未获裁决,
`overdue` 都已为 `true` —— **检视者没收到任何提醒,群里也没有任何记录**。

我(检视者)是在为别的事翻库时才发现的。

## 根因:派生值,不是事件

`routes/group/tasks.ts:548` 在**读取任务详情时**现算:

```ts
const overdue = …;
return { answered, verdict, awaitingSince, overdue };
```

配置注释(`executors.ts:560`)也写明了当前定位:

> 时长仍未公布 review_result → 任务详情派生 `l3.overdue=true`(**只观测不强制**)

所以它是个**读取时的瞬时结论**,不是持久状态,也不触发任何动作。
**没人打开那条任务详情,这个标记就等于不存在。**

## 决策

### R1. 逾期要在群里留一条消息

L3 请求超过 `l3ResponseMinutes` 未获裁决时,由**平台**在群内发一条消息,
点明:哪个 `specRef`、等待了多久、该由谁裁决(群内 reviewer)。

⚠️ 复用现成的发消息路径(`executor-task/notify.ts` 的 `postStatus` 一带),
**不新建通道、不加表**。

### R2. 必须去重

同一条 L3 请求**只提醒一次**,不得每次轮询/每次读详情都发。

⚠️ 这条是本票的成败关键 —— 一个每小时刷一遍的提醒比不提醒更糟,
群消息会被淹没,真正的信号反而看不见。
参考 `unknown-participant-is-not-forbidden` R3 的去重做法。

### R3. 被应答后要能再次提醒

若该请求后来被裁决,去重标记随之失效;若同一 spec 之后又产生新的未应答请求
并再次逾期,**允许**再提醒一次。去重的是「同一条请求反复提醒」。

### R4. 不改判定阈值与 overdue 派生

- **不改** `l3ResponseMinutes` 的默认值与读取方式
- **不改** `l3.overdue` 的派生逻辑与返回结构(回归,必测)
- **不做**自动催办以外的动作:不自动通过、不自动打回、不改任务状态

⚠️ **逾期是提醒,不是裁决。** 平台不得代替检视者做任何判断。

### R5. 不与去重票冲突

`l3-is-per-spec-not-per-task` 落地后,同一 spec 只会有一条未应答请求。
本票按**请求**去重,两者叠加后的效果是「一个 spec 逾期只提醒一次」,
不需要额外协调。

## 验收标准

- [ ] L3 请求逾期 → 群内出现一条提醒消息,含 `specRef`、已等待时长、
      应裁决方(核心场景,必测)
- [ ] 同一条请求**只提醒一次**,重复触发不重复发消息(R2,必测)
- [ ] 未逾期时**不发**提醒(必测)
- [ ] 已被裁决的请求**不发**提醒(必测)
- [ ] 被裁决后又出现新的未应答请求并逾期 → 允许再次提醒(R3,必测)
- [ ] `l3.overdue` 的派生逻辑与任务详情返回结构逐字不变(回归,必测)
- [ ] 平台**不改变**任何任务状态、不自动裁决(反向断言,必测)
- [ ] 后端测试全绿,贴出用例数

## 不涉及

- 同一 spec 多条请求的去重(另票 `l3-is-per-spec-not-per-task`)
- `l3ResponseMinutes` 的取值(R4)
- 历史上已逾期的两条:本票只管新增行为,是否补发由检视者另行处置

## 执行环境提示

- 派生位置:`routes/group/tasks.ts:493-551`
- 阈值:`scripts/dispatch-policy.json` 的 `l3ResponseMinutes`(默认 120)
- 发消息:复用 `lib/executor-task/notify.ts`
- 测试可把阈值调到 1 分钟(`state.ts:299` 注释说明该退化路径已支持)
- ⚠️ 本票**必须下发给执行器**完成
- ⚠️ 做完记得提交
