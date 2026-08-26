# Spec: L3 发现项到不了协调者,`review_result` 是一条死记录

> **状态**: Landed — L3 通过(2026-08-26),实现 `29d00adb`
> **版本**: 1.0
> **日期**: 2026-08-25
> **落实**: spec §3.14.7 记录的孤儿契约

## 现象

检视者公布 `verdict: "findings"` 后,**协调者没有任何反应**。发现项停在那里,
除非检视者自己再手动下发一张修正票。本轮实测已发生一次。

## 根因:载荷被校验、被渲染,但没有任何代码对它动作

全仓检索 `review_result`,后端只有两处触碰它:

- `routes/group/messages.ts:171` —— 校验 `taskId` 指向本群真实任务
- `routes/group/tasks.ts:257` —— 任务详情读它派生 `l3.verdict` 展示

**没有任何一处让它产生后果。** 前端也只是渲染。

而它偏偏是用**广播消息**发的,广播唤不醒协调者:协调者
`memory: null`、每任务新建进程、PATCH 完终态即退出。**没有任何东西在监听。**
v3.8 移除完成回调后,这个契约就失去了传输层(§3.14.7)。

## 为什么不能靠 skill 说明解决

「检视者发完 findings 要再下发一张修正票」写进 skill 是**说明**层手段。
本轮的实证:**我自己就是有记忆的检视者,也还是靠人工补发的那一张票**。
换成没记忆的检视者,发现项必然永久悬空。

按本项目一贯的取舍(说明 / 结构 / 强制),这里要的是**结构 + 强制**:
让发现项**只能**走已经跑通的派发通道,并在平台层拒绝走不通的那种发法。

## 决策:findings 走派发通道,平台强制

### R1. `verdict: "findings"` 必须定向下发给协调者

带 `review_result` 且 `verdict === "findings"` 的消息,必须满足:

- `audience` 为 `role`(`audienceRef: "coordinator"`)或 `participant`(指向协调者成员)
- 携带 `specRef` + `specHash`

满足时走**现有派发路径**(与检视者下发需求票完全同一条路,已跑通),
自动生成一条协调任务,协调者被新进程唤醒并读到发现项。

**不新增传输机制** —— 复用 `POST /messages` 的定向派发,这是本 spec 的核心取舍:
新造一条通道会多一个失败面,而现有这条每天都在用。

### R2. 平台拒绝广播形式的 findings

`audience === "broadcast"` 且载荷是 `review_result` + `verdict: "findings"`
→ **400**,错误信息必须点明正确发法(定向到 coordinator + 带 specRef/specHash),
不能只说「不允许」。

⚠️ **`verdict: "pass"` 不受限制**,广播照旧 —— pass 不需要任何人做事,
把它一起管起来是过度约束。

### R3. 发现项要进任务书,不是只在载荷里

生成的协调任务,其任务书需包含**逐条列出的 findings**
(`severity` + `note`),位置显眼。

理由:协调者读的是任务书。发现项只存在于消息载荷里而任务书不提,
等于又回到「靠对方自己去翻」——本票要消除的正是这个。

### R4. 该协调任务按 fix 处理

自动生成的这条协调任务 `dispatchKind` 记为 `fix`:它是对已有实现的修正,
**不再走一轮 L3**(与 §3.14.6 的 `跑 L3 ⟺ 三方在场 AND dispatchKind != 'fix'` 一致)。

### R5. 不改这些

- **不改** `verdict: "pass"` 的现有行为
- **不改** `review_result` 的字段结构(§3.10 契约不动)
- **不改**任务详情派生 `l3.verdict` 的展示逻辑
- **不恢复** v3.8 移除的完成回调
- **不做**平台自行判断该采纳哪些发现项 —— 采纳与否仍是协调者的裁量

## 验收标准

- [ ] 定向到 coordinator + 带 specRef/specHash 的 findings → **生成协调任务**,
      `parent_task_id` 为 null(根任务),`dispatch_kind = 'fix'`
- [ ] 该任务的 `brief` 中**逐条出现**每个 finding 的 severity 与 note
- [ ] 广播形式的 findings → **400**,错误信息包含正确发法
- [ ] 广播形式的 `verdict: "pass"` → **200**(回归,必测)
- [ ] 定向但缺 `specHash` 的 findings → 沿用现有 403/400,不新增放行口子
- [ ] 非 `review_result` 的广播消息不受影响(回归,必测)
- [ ] `review_result` 的 taskId 存在性校验仍生效(回归)
- [ ] 任务详情的 `l3.verdict` 展示未改动(回归)
- [ ] **端到端实测**:公布一条 findings → 查库确认协调任务已生成且 brief 含发现项
      —— 这是本票唯一的真验收信号
- [ ] 后端测试全绿,贴出用例数

## 不涉及

- 协调者收到后如何裁量采纳(仍是协调者的判断,平台不介入)
- `review_request`(L2→L3 方向)—— 那条链路已跑通
- 前端展示
- 完成回调的恢复

## 执行环境提示

- 实现位置:`packages/backend/server/src/routes/group/messages.ts`
  (载荷判定与拒绝)+ 现有派发路径(`routes/group/helpers.ts` 一带)
- 派发路径**已经存在且每天在用** —— 先读懂检视者下发需求票走的是哪几行,
  再决定接入点;不要另起一套
- ⚠️ 做完记得提交
