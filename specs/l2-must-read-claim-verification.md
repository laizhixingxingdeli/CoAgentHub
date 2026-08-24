# Spec: L2 必须直面提交核实结论 —— `claimVerification` 不能只是个没人读的字段

> **状态**: Ready for Implementation
> **版本**: 1.0
> **日期**: 2026-08-24
> **前置**: `specs/coordination-close-integrity.md`(`89f8ddba`)、
>   `specs/l3-verdict-observability.md`(`adb698cd`)—— 本票补齐执行器侧那一环

## 背景:三个角色里,执行器的产出是唯一没人对质的

本轮已经补上两环强制:

| 环节 | 机制 |
|---|---|
| L1 → L2 | 零子任务不许落 `done` |
| L2 → L3 | 缺 `review_request` 不许落 `done` |
| L3 → 结案 | 载荷强校验 + `answered`/`overdue` 可观测 |

但**执行器汇报的提交是否真实存在,至今没有任何环节必须面对**。

`verify-agent-claims` 已经在做核实(`lib/executor-task/claim-verification.ts`),
四种结论:

| status | 含义 |
|---|---|
| `verified` | 提交存在且在本次执行时间窗内 |
| `not_found` | **仓库里根本没有这个提交** |
| `outside_window` | 提交存在,但早于本次执行开始 —— 可能是拿旧提交冒充 |
| `skipped` | a2a 模式无本地仓库,无法核实 |

结论会写进 `diffSummary.claimVerification`,然后**没有然后**:不拦截任何状态转移,
也不要求任何人读它。

它上线第一天就抓到过一次真实误报(AtomCode 汇报 `7c6c4a2`,实际提交是 `a5b808b`),
但那次是**人眼在界面上看见的**。换一个不看界面的检视者,或者干脆没人看,
`not_found` 就是一行没人读的日志。

### 为什么不能直接拦截

`verify-agent-claims` 的设计原则是「**只标记,不裁决**」,这条要保留:

- `outside_window` 有合法情形:执行器复用了上一轮已提交的成果、或提交发生在
  时间窗计算的边界上;
- `skipped` 是环境限制,不是过错;
- 平台无法判断「这个 hash 对不对」背后的语义 —— 那需要看代码,是 L2 的职责。

**平台该做的不是替 L2 下判断,而是不让 L2 假装没看见。**

## 决策:把它变成协调者必须显式表态的一项

协调任务落 `done` 时,若其**任一执行子任务**的 `claimVerification.status` 属于
**需要表态的集合**(`not_found` / `outside_window`),则 `diffSummary` 必须包含
对该子任务的显式裁决,否则 **400**。

这与 `coordination-close-integrity` 的 R4 逃生舱同构:不禁止放行,但**逼你把
放行的理由写下来**。

### R1. 需要表态的集合

- **`not_found`** → 必须表态
- **`outside_window`** → 必须表态
- `verified` → 无需表态
- `skipped` → **无需表态**(环境限制,不是执行器的过错;强制表态只会制造噪音)

### R2. 表态的形式

`diffSummary` 中提供 `claimAdjudication`,按子任务 id 索引:

```json
{
  "claimAdjudication": {
    "<childTaskId>": {
      "accepted": true,
      "reason": "执行器复用了上一轮已提交的成果,已核对 diff 内容一致"
    }
  }
}
```

- `accepted`: 布尔,必填。`true` = L2 采信该成果;`false` = 不采信
  (此时协调者本应重下发而非落 `done`,但平台不替它判断,只要求它说清楚)。
- `reason`: **非空字符串**,必填。空串/纯空白 → 400。
- 集合中**每一个**需表态的子任务都必须有对应条目;缺任一 → 400,
  错误信息点明缺哪个子任务、它的核实结论是什么。

### R3. 只管 `done`,不管 `failed`

与 `coordination-close-integrity` R3 同一理由:对失败追加门槛只会逼 agent
谎报成 `done`。**这是设计意图,不是遗漏。**

### R4. 复用既有判定,不另写

- 「协调任务」判定复用 `lib/detached-task-liveness.ts` 的 `isDetachedTask()`
- 子任务查找复用 `parentTaskId` 关系
- **不要**改动 `claim-verification.ts` 的核实逻辑本身(R5)

### R5. 不改这些

- **不改** `verify-agent-claims` 的核实算法与「只标记不裁决」原则
- **不改**执行器侧任何行为 —— 执行器照常汇报,核实照常进行
- **不改**前端
- **不改** skill

## 验收标准

- [ ] 子任务 `claimVerification.status = not_found`,协调任务落 `done` 且无
      `claimAdjudication` → **400**,信息点明子任务 id 与其核实结论
- [ ] 同上,提供 `accepted:true` + 非空 `reason` → **放行**
- [ ] 同上,`reason` 为空串/纯空白 → **400**
- [ ] 同上,`accepted` 缺失或非布尔 → **400**
- [ ] `outside_window` 同样需要表态(与 `not_found` 行为一致)
- [ ] `skipped` **不**需要表态,无 `claimAdjudication` 也放行
- [ ] `verified` **不**需要表态
- [ ] 多个需表态子任务时,只给其中一个 → **400**,点明缺哪个
- [ ] PATCH 至 **`failed`** 时本规则不生效(回归,必测)
- [ ] **非协调任务**落 `done` 行为完全不变(回归,必测)
- [ ] 无子任务的协调任务(走 R4 逃生舱 `noExecutionReason`)不受本规则影响
- [ ] 协调任务判定复用 `isDetachedTask()`,未另写
- [ ] `claim-verification.ts` 未被改动
- [ ] 后端测试全绿,贴出用例数;上述每条验收都要有对应用例
- [ ] **未改动**前端、`skills/`

## 不涉及

- 核实算法本身(时间窗口计算、hash 匹配规则)
- 让平台判断 hash 对应的改动是否符合 spec —— 那是 L2 的语义职责,平台做不到
- 前端展示 `claimAdjudication`(另开票)

## 执行环境提示

- 本仓 pnpm 项目,后端 `:3001`
- 改完重启后端;重启前确认无 running/queued 任务;验收前用 `ps -o lstart=`
  确认监听进程启动时间晚于本次提交
- 构造测试数据时注意:`claimVerification` 写在子任务的 `diffSummary` 里,
  不是协调任务的
