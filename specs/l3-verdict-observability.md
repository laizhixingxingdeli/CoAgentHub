# Spec: L3 裁决的可观测与校验 —— 交出去之后不能进黑洞

> **状态**: Ready for Implementation
> **版本**: 1.0
> **日期**: 2026-08-24
> **前置**: `specs/coordination-close-integrity.md`(已落地 `89f8ddba`)补齐了
>   L1→L2、L2→L3 两环的强制;本票补第三环

## 背景:强制层留下的不对称

刚落地的完整性校验补上了链路的前两环,但第三环是空的:

| 环节 | 强制 / 观测 |
|---|---|
| L1 → L2 | ✅ 零子任务不许落 `done` |
| L2 → L3 | ✅ 缺 `review_request` 不许落 `done` |
| **L3 → 结案** | ❌ **什么都没有** |

### 症状一:交出去之后无人过问

协调任务落 `done` 并带上 `review_request` 之后,检视者应当做 L3 并公布
`review_result`。**没有任何机制追踪这件事是否发生。**

前端的兜底(`RequirementDetailPanel` 的 `deriveL3`)是:

```ts
status: l2.task?.status === "done" ? "running" : "pending"
```

也就是说 **L2 完成但 L3 从未答复,会永远显示 `running`** —— 与「检视者正在认真
检视」在界面上**完全无法区分**。

这不是假设。本轮检视者连续 16 次判 pass 而全部误判,靠的正是这个盲区:
没有任何东西会指出「这条链交出去了但没人应答」。

### 症状二:检视者是唯一零校验的角色

执行器有 `claimVerification`(虽只标记不拦截),协调者现在有 R1/R2 强制,
**只有检视者的产出完全不经过任何校验** —— 而本轮恰恰证明了检视者是最容易出错
的那一个。

### 症状三:已有的校验因为一个字段没设而从未生效

`coordination-payload.ts` **已经定义了 `reviewResultPayload` schema**,
`parseKnownCoordinationPayload` 也认识 `review_result`。但
`routes/group/messages.ts:135` 的调用条件是:

```ts
if (contentType === "application/json") { parseKnownCoordinationPayload(body ?? ""); }
```

而检视者发消息时**从不设置这个 `contentType` 字段**(HTTP 请求头的
`Content-Type` 与消息体里的 `contentType` 是两回事)。结果:本轮公布的 15 条
`review_result` **一次校验都没走过**。

写错 `taskId`、拼错 `verdict`,平台照单全收,前端匹配不上,该需求就永远停在
「L3 进行中」。**又一个静默失败面**,与 `dispatch-fields-silent-loss` 同构。

## 要求

### R1. 载荷校验不再依赖调用方声明 contentType

`messages.ts` 的协作载荷校验条件改为:**消息体看起来像结构化载荷就校验**。

判据:trim 后以 `{` 开头且能 `JSON.parse` 成对象、且含 `type` 字段属于已知集合
(`spec_published` / `spec_amended` / `review_request` / `review_result`)
→ 走 `parseKnownCoordinationPayload`,形状不合 → **400**。

- 保留 `contentType === "application/json"` 时的现有行为(仍校验)。
- **不是**结构化载荷的普通消息(自由文本、任务书 markdown)**行为完全不变**,
  不得因本票开始报错(回归,必测)。
- `type` 不属于已知集合的 JSON 消息**放行**,不做校验 —— 群消息允许承载
  其它约定,本票只管这四种。

### R2. `review_result` 的 `taskId` 必须指向本群一条真实任务

校验通过形状之后,追加引用校验:`taskId` 必须是**本群内存在的任务**。
不存在 → **400**,错误信息点明「review_result 引用的 taskId 在本群不存在」。

理由:拼错 taskId 是最容易犯、也最难发现的错 —— 它不会报错,只会让该需求
永远显示「L3 进行中」。这条把静默失败变成即时失败。

⚠️ **不校验该任务是否带 `review_request`。** 检视者对未经协调者交接的任务
主动出具架构意见是合法的(spec §4「也可主动发起架构治理」),不该被挡。

### R3. 协调任务详情透出 L3 应答状态

`GET /groups/:id/tasks/:taskId` 在目标是**协调任务且已落 `done` 且带
`review_request`** 时,增加派生字段:

```json
"l3": {
  "answered": false,
  "verdict": null,              // pass | findings | null
  "awaitingSince": "2026-08-24T03:12:44.799Z",   // 落 done 的时刻
  "overdue": true
}
```

- `answered` / `verdict`:本群消息中是否存在 `taskId` 指向本任务的
  `review_result` 载荷,以及它的 `verdict`。
- `overdue`:`now - awaitingSince > l3ResponseMinutes` 且 `answered === false`。
- 不满足触发条件的任务**不输出** `l3` 字段(不是输出空对象),保持载荷不变。

### R4. 阈值

`scripts/dispatch-policy.json` 新增 `l3ResponseMinutes`,**缺省 120**。

理由:检视者运行在常驻会话里,收到完成事件后通常分钟级响应;但它可能正在与
用户对话,给足余量。**这个数字不是精确结论** —— 若执行者有更好依据可提出并
说明理由,不要拍脑袋改。

### R5. 只观测,不强制

本票**不拒绝任何终态**。协调任务此刻已经是终态,没有可拒绝的对象;伪造一个
「L3 未答复就回滚协调任务」只会制造更混乱的状态机。

**本票的手段是让"没人应答"变得可见**,而不是让它不可能发生。这是诚实的定位:
检视者的产出无法被平台判定质量,能做的只有确认它**出现过**。

### R6. 不改这些

- **不改**前端 —— 前端拿到 `l3` 字段后如何展示,另开票
- **不改** `review_result` 是群消息这一协议(§3.14.7 刚确立)
- **不改**检视者 skill
- **不改**已有的 `review_request` 形状校验与 `coordination-close-integrity` 的强制

## 验收标准

- [ ] 不设 `contentType` 发送形状错误的 `review_result` → **400**(本票核心:
      此前静默放行)
- [ ] 不设 `contentType` 发送形状正确的四种载荷 → 放行
- [ ] 普通自由文本消息、任务书 markdown → 行为**与改动前完全一致**(回归,必测)
- [ ] `type` 为未知值的 JSON 消息 → 放行,不校验
- [ ] `review_result` 的 `taskId` 不在本群 → **400**,信息点明原因
- [ ] `taskId` 存在但该任务无 `review_request` → **放行**(R2 的例外)
- [ ] 协调任务 done + 带 `review_request` + 无 `review_result` → 详情含
      `l3.answered=false`
- [ ] 同上,超过 `l3ResponseMinutes` → `l3.overdue=true`
- [ ] 已有 `review_result` → `l3.answered=true` 且 `verdict` 正确
- [ ] 不满足触发条件的任务详情**不含** `l3` 字段,其余载荷逐字不变(回归)
- [ ] `l3ResponseMinutes` 可通过 `dispatch-policy.json` 配置,缺省 120
- [ ] 后端测试全绿,贴出用例数
- [ ] **未改动**前端、`skills/`

## 不涉及

- 前端展示 L3 未答复(另开票)
- 对检视者产出质量的任何判定(R5)
- `claimVerification` 在 L2 的采信规则(另一张票)

## 执行环境提示

- 本仓 pnpm 项目,后端 `:3001`
- 改完重启后端;重启前确认无 running/queued 任务;验收前用 `ps -o lstart=`
  确认监听进程启动时间晚于本次提交
- ⚠️ **本票落地后检视者发 `review_result` 会被校验** —— 这是预期的,也是本票的目的
