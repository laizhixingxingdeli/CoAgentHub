# Spec: 协调者结案时把平台写的 token 字段整个冲掉

> **状态**: Landed — L3 通过(2026-08-29),实现 `9aeea237`
> **版本**: 1.0
> **日期**: 2026-08-26

## 现象:执行器有 token,协调者永远空白

界面上展开 L1 行能看到 `Token 279,888`,但 **L2 协调那一行只有
「提交 / commit 已核实 / 测试 / 耗时」,没有 Token**。

实况:

| 任务 | `attempts[-1]` | `diffSummary` |
|---|---|---|
| 执行子任务(AtomCode) | 有 `tokenUsage` | **有** `tokenUsage` |
| 协调任务(Codex) | `tokenUsageReason = unavailable` | **两个字段都没有** |

## 根因:PATCH 整体替换,不是采集失败

平台在任务结束时确实写了(`executor-task/queue.ts:1665-1668`):

```ts
if (tokenUsage !== undefined) diffSummary.tokenUsage = tokenUsage;
if (tokenUsageReason) diffSummary.tokenUsageReason = tokenUsageReason;
```

但协调任务由**协调者自己 PATCH 结案**,而 PATCH 是**整体替换**
(`routes/group/tasks.ts:1144`):

```ts
...(diffSummary !== undefined ? { diffSummary: summaryToWrite } : {})
```

协调者提交的载荷里只有 `summary` / `hash` / `review_request` /
`alreadySatisfied` 等它自己的字段 —— **平台写的两个 token 字段被整个冲掉**。

执行子任务不受影响:它们由平台关闭,`diffSummary` 全程由平台撰写。

⚠️ 所以这**不是采集问题**。协调者的 `unavailable` 是另一张票
(`codex-token-collection-never-matches`)的事;即使那张票修好、
协调者能采到 token,**本缺陷仍会把结果冲掉**。两票互不替代。

## 连带后果

`token-usage-never-renders` 的 R2 规定「有 `tokenUsageReason` → 显示
`Token 未采集`」。因为 reason 到不了 `diffSummary`,**该分支在真实数据上
永远不会触发** —— 单元测试用夹具造出了它,真实链路进不去。

⚠️ 这是当时我(检视者)spec 写漏的:只规定了前端怎么读 `diffSummary`,
没核实 reason 是否真能到达 `diffSummary`。与那次实现的质量无关。

## 决策

### R1. 平台写的 token 字段必须在 PATCH 后仍然保留

PATCH 结案写回 `diffSummary` 时,若平台此前已写入 `tokenUsage` /
`tokenUsageReason`,而调用方载荷中**不含**这两个键,则**保留原值**。

⚠️ **照 `l1Bypass` 的既有模式做**(同文件,平台在 PATCH 时补写平台字段),
不要新建表、不加列、不改采集。

### R2. 调用方显式提供时以调用方为准

若调用方载荷中**含有**这两个键,则用调用方的值(含显式 `null`)。
本票只解决「没提供就被清空」,不是把字段变成只读。

### R3. 其它平台字段不受影响

`l1Bypass`、`claimVerification` 等既有平台字段的行为**逐字不变**(回归,必测)。

### R4. 不改采集、不改前端

- **不改** `token-usage.ts` 的任何采集逻辑
- **不改**前端读取与渲染 —— 前端读 `diffSummary` 是对的,
  本票让 `diffSummary` 里真的有东西

## 验收标准

- [ ] 平台已写 `tokenUsage`,调用方 PATCH 的载荷不含该键 → 结案后**仍在**(必测)
- [ ] `tokenUsageReason` 同上(必测)
- [ ] 调用方显式提供该键 → 以调用方为准(必测)
- [ ] 调用方显式传 `null` → 按 `null` 写入,不被"保留"逻辑覆盖(必测)
- [ ] `l1Bypass` / `claimVerification` 行为逐字不变(回归,必测)
- [ ] **真实跑一条协调任务**,结案后其 `diffSummary.tokenUsageReason`
      非空(当前为 `unavailable`)—— 本票的真验收信号
- [ ] 界面上 L2 协调行随即显示 `Token 未采集`(端到端,必测)
- [ ] 后端测试全绿,贴出用例数

## 不涉及

- codex 采集为何 `unavailable`(另票 `codex-token-collection-never-matches`)
- 前端读取与渲染(R4)
- token 显示的层级与可发现性(另议)

## 执行环境提示

- 平台补写模式参考同文件的 `l1Bypass` 分支,**复用不要另起一套**
- 复现:跑一条协调任务,结案后查
  `select diff_summary->>'tokenUsageReason', attempts->-1->>'tokenUsageReason' from task where id=...`
  —— 当前前者为空、后者为 `unavailable`
- ⚠️ 本票**必须下发给执行器**完成
- ⚠️ 结案若被旧构建守卫拒绝,不要自行重启后端,以 `failed` 结案并写明
- ⚠️ 做完记得提交
