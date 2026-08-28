# Spec: 每条任务各发一份 L3 请求,同一个 spec 被要求检视两三次

> **状态**: Landed — L3 通过(2026-08-28),实现 `01c88f34`
> **版本**: 1.0
> **日期**: 2026-08-26

## 现象:四条 L3 请求永远等不到答复

本群实况(`diffSummary.review_request` 逐条统计):

| spec | 发出 L3 请求的任务 | 条数 |
|---|---|---|
| `coordinator-exits-after-dispatch` | `01a03bfa` + `01a03c00`(续跑) | 2 |
| `coordination-task-is-not-l1` | `01a03c3d` + `01a03c53`(续跑) + `01a03c70` | 3 |
| `token-fields-clobbered-by-close` | `01a03d4d` + `01a03d62` + `01a03d6e` | 3 |

对应的应答状态:

```
01a03c00  续跑  answered=False  overdue=True
01a03c53  续跑  answered=False  overdue=True
01a03d62  普通  answered=False
```

**检视者对每个 spec 都已裁决**,但检视是**按 spec** 做的、一个 spec 只裁一次;
而请求是**按 task** 发的,于是多出来的那些永远悬着。

⚠️ 这正是界面上「L3 检视一直没完成」的来源 —— 不是检视者漏了,
是同一个 spec 被要求检视了两三次,只可能答上其中一次。

## 根因

`coordinator-exits-after-dispatch`(`3645c741`)落地后,协调者派完即退,
平台创建**续跑任务**接手 L2。续跑任务完成 L2 后同样按既有流程带
`review_request` 结案 —— 于是父任务发一条、续跑任务再发一条,
findings 派生的修正任务又发一条。

**每一条单看都合规**,合起来就是同一份规范被要求裁决 N 次。

## 决策

### R1. L3 请求按 spec 去重

同一 `specRef` + `specHash` 已存在**未应答**的 L3 请求时,
不再新增第二条;新的 L2 结论**并入**已存在的那条请求。

⚠️ **不要**靠删除或覆盖旧请求来实现 —— 那会丢掉先前的 L2 结论。
并入,不是替换。

### R2. 已应答的 spec 允许再次请求

同一 `specRef` + `specHash` 的上一条请求**已被应答**(如 findings 打回后重做)时,
**允许**新建请求。本票去重的是「同时悬着多条」,不是「一个 spec 一辈子只检一次」。

### R3. 续跑任务不单独发起 L3

续跑任务(`diffSummary.platform.resumeOf` 非空)完成 L2 后,
其 L2 结论并入父任务已发出的那条请求,**不新起一条**。

⚠️ 判据用 `resumeOf` 标记(平台自己写的),这里是**识别续跑任务**,
与 `coordination-task-is-not-l1` 禁止用它做分层判定不冲突 ——
那条禁的是「用它替代角色判定」,本条是「识别平台自建的续跑任务」,
属该标记的本来用途。

### R4. 应答要落到被合并的所有任务

检视者对合并后的请求给出裁决时,该裁决对参与合并的**全部任务**生效
(`l3.answered` 均变为 true),不得只更新其中一条。

### R5. 不改 L3 的判定条件与语义

- **不改** §4.1 那个布尔式(何时该跑 L3)
- **不改** `review_request` 的载荷结构与字段名
- **不改**检视者的应答方式

## 验收标准

- [ ] 同一 specRef+specHash 已有未应答请求时,再次结案**不新增**请求,
      L2 结论并入原请求(核心场景,必测)
- [ ] 并入后**先前的 L2 结论仍可见**,未被覆盖(必测)
- [ ] 上一条已应答 → 允许新建请求(R2,必测)
- [ ] 续跑任务完成 L2 → 不新起请求(R3,必测)
- [ ] 一次裁决使参与合并的全部任务 `l3.answered = true`(R4,必测)
- [ ] specHash 不同(spec 改版)→ 视为不同请求,允许并存(必测)
- [ ] §4.1 布尔式与 `review_request` 结构逐字不变(回归,必测)
- [ ] **修复后跑一张真实需求票(含一次续跑),该 spec 全程只产生一条
      未应答的 L3 请求** —— 真验收信号
- [ ] 后端测试全绿,贴出用例数

## 不涉及

- L3 逾期如何提醒(另票 `l3-overdue-should-actually-remind`)
- 何时该跑 L3(R5)
- 历史遗留的悬空请求:本票只管新增行为;是否清理由检视者另行处置

## 执行环境提示

- L3 派生:`routes/group/tasks.ts` 的 `deriveL3Answer`;
  请求写入在协调者 PATCH 结案路径
- 复现:`select left(id::text,8), spec_ref, diff_summary->'platform'->>'resumeOf'
  from task where diff_summary->'review_request' is not null order by created_at;`
- ⚠️ 本票**必须下发给执行器**完成
- ⚠️ 做完记得提交
