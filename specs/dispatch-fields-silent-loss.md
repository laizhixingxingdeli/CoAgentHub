# Spec: 验收钉子可静默丢失(消息自动派发 vs 显式建任务的竞争)

> **状态**: Ready for Implementation
> **版本**: 1.0
> **日期**: 2026-08-24
> **发现于**: `dispatch-kind-field` (`5373a2e`) 落地后的实测 —— 尝试用同一份任务书
>   先发消息、再补建任务,`specRef`/`specHash`/`dispatchKind` 全部丢失,无任何报错

## 背景:一个解释了本轮多次「specRef 没落库」的根因

本次会话里多次出现「下发时明明带了 `specRef`,任务详情里却是 `null`」的怪现象,
此前当作偶发问题略过。现已定位根因,是平台的**结构性缺陷**,不是操作失误。

### 两条独立的建任务路径

**路径 A(自动派发)**:`POST /groups/:id/messages`,`audience` 指向一个
`executor` 角色成员时,`routes/group/messages.ts:376` 在消息发送的同时
`void maybeDispatchExecutorTask(...)` 自动建任务。**它的 `specRef`/`specHash`
取自这次消息 POST 请求体自己携带的字段**(`messages.ts:78-79/385-386`),
与消息正文无关。

**路径 B(显式建任务)**:`POST /groups/:id/tasks`,接受 `specRef`/`specHash`/
`dispatchKind`,以 `messageId` 做幂等 upsert(`onConflictDoNothing`)。

### 竞争条件与静默丢失

若调用方(人 / 协调者 / 检视者)按直觉的顺序操作——**先发任务书消息,再单独
调用建任务接口附上 specRef/specHash/dispatchKind**——会发生:

1. 消息一发出,路径 A 已经用该 `messageId` 建好了任务,**字段为 null**
   (因为发消息时没在消息 POST 里带 specRef/specHash)
2. 调用方随后调路径 B,带上正确的字段,但 `messageId` 已被占用,
   `onConflictDoNothing` 命中 → **返回路径 A 建的旧行,响应 200,
   看起来像成功了,字段却全是 null**
3. **没有任何报错、任何警告能提示这次「附加」失败了**

### `dispatchKind` 完全没有第二个入口

即便调用方**在第一步就把 specRef/specHash 放进消息 POST**(避开上面的竞争),
`dispatchKind` 依然无处可去 —— `maybeDispatchExecutorTask` 与
`messages.ts` 的入参里**从未包含它**(B4 只改了路径 B)。

### 现有信号覆盖不到

`messages.ts:288` 有一条警告:

```ts
if (isExecutorTarget && !specHash?.trim()) {
  // ... 群内有 reviewer 时 push "SPEC_HASH_MISSING"
}
```

- 只查 `specHash`,不查 `specRef`,不查 `dispatchKind`
- 只在**群内有 reviewer** 时触发——两方编制下完全静默
- 是**警告**(`X-CoAgentHub-Warning` 响应头),不是拒绝,请求照常 200,
  且响应头在很多调用方式下根本不会被读取

而 spec 对 `specHash` 的定性是「**验收钉子……缺一不可**」——现状是这个钉子
可以被静默拔掉,拔掉后系统还告诉你成功了。

## 决策:统一到单一路径,拒绝而非静默丢弃

### R1. 路径 A 是唯一的建任务入口,`dispatchKind` 补齐进去

**不删除路径 B**(它承担纯 API 场景 / 无消息触发的建任务),但**修正竞争**:

- `maybeDispatchExecutorTask` 的 `DispatchExecutorInput` 增加 `dispatchKind`,
  `messages.ts` 的 zod schema 与 `maybeDispatchExecutorTask` 调用一并补上
  (照抄 `specRef`/`specHash` 现有写法)
- 建议:**在消息 POST 的 body 里传 `specRef`/`specHash`/`dispatchKind` 是主路径**,
  文档(skill)与此一致时,该竞争自然消失

### R2. 路径 B 遇到已存在的 messageId,不得静默返回不同内容的行

当前 `onConflictDoNothing` 是为**真幂等重复**设计的(同一请求重放)。但现在
它同时吞掉了「这个 messageId 已被路径 A 用不同字段建过任务」这种**不是真正重复
请求**的情况。

**要求**:路径 B 在命中已存在的行时,**比较请求体与已存在行的
`specRef`/`specHash`/`dispatchKind`**:

- 完全一致(或本次请求这些字段全部未传)→ 视为幂等重复,现状行为不变
- **不一致**(本次传了值,已存在行是别的值或 null)→ **返回 409**,
  响应体说明冲突字段,**不得静默返回旧行**

### R3. `SPEC_HASH_MISSING` 警告的判定漏洞一并修

`messages.ts:288` 的判定改为:**不论群内是否有 reviewer,只要目标是 executor
且 `specHash` 缺失,都要给出警告**。理由:两方编制同样需要验收钉子
(§3.14.6 已写明「spec 冻结是两方编制下唯一一次架构把关」),现状的
「只在有 reviewer 时警告」把两方编制的调用方蒙在鼓里。

**不要**把警告升级成拒绝——指令驱动任务(无 spec 的临时任务)是合法用法,
缺失是预期状态,不能一刀切。

## 要求补充

### R4. 不改路径 A 与路径 B 各自的语义

路径 A 仍然是「消息触发的自动派发」,路径 B 仍然是「显式建任务」。本票**只修
竞争与静默丢失**,不合并两条路径、不改变各自的触发时机。

### R5. 回归验证

用本票发现时的操作序列复现并确认已修复:

1. `POST /groups/:id/messages`,`audience: participant` 指向一个 executor,
   **消息体本身不带** `specRef`/`specHash`(模拟调用方的直觉错误)
2. 紧接着 `POST /groups/:id/tasks`,带上同一 `messageId` + 真实
   `specRef`/`specHash`/`dispatchKind`
3. **修复前**:第二步返回 200,字段是 null。**修复后**:第二步返回 409,
   响应体指出冲突字段

## 验收标准

- [ ] `maybeDispatchExecutorTask` 接受并落库 `dispatchKind`
- [ ] `POST /groups/:id/messages` 的 zod schema 接受 `dispatchKind`(照抄
      `specRef`/`specHash` 现有写法)
- [ ] R5 描述的复现步骤,修复后第二步返回 409 而非静默 200
- [ ] 409 响应体列出实际冲突的字段名
- [ ] 字段一致或全未传时,仍走原幂等返回(不得把正常重放也判成冲突)
- [ ] `SPEC_HASH_MISSING` 警告不再要求群内有 reviewer 才触发
- [ ] 新增测试覆盖:字段冲突 409 / 字段一致幂等放行 / 两方编制下也给警告,
      三条都要有
- [ ] 后端测试全绿,贴出用例数
- [ ] **未改动**前端

## 不涉及

- 合并路径 A 与路径 B
- 把 `SPEC_HASH_MISSING` 从警告升级为拒绝
- MCP 工具(`coagenthub_dispatch_task`)入参 —— 若插件侧已经只用路径 A 且
  正确传参,不受本票影响;若插件侧也有同样的调用顺序问题,**写进汇报**,
  不在本票修改插件仓

## 执行环境提示

- 本仓是 **pnpm** 项目,后端 `:3001`
- **这是本轮的第二个「未改动前端」票之一**,但优先级高于目前排队的展示类票——
  它影响的是验收钉子本身的可靠性,而其余票的验收都依赖这个钉子成立
