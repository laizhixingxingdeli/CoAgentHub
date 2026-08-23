# Spec: 阶梯进度条的单位不统一(占位算法的收尾)

> **状态**: Ready for Implementation
> **版本**: 1.0
> **日期**: 2026-08-23
> **依据**: `specs/reviewer-role-spec-generation.md` v4.0 §3.14.6

## 背景:一张欠了很久的票

`group-tasks-by-spec.ts:69` 的 `stepStatusFromTask` 自己写着:

> `⚠️ 占位算法(非最终实现)` … 「后续票会基于检视/协调/执行的语义替换为精确层级判定」

**那张后续票从来没写。** 于是阶梯每一步的单位是**任务**:一个任务一个圈。
一条需求只有一个任务 → 孤零零一个圈;重试过三次 → 三个圈,看起来像三个阶段。

更糟的是 `RequirementDetailPanel.tsx:424-427` 后来又在末尾**追加了一个 L3 步**:

```ts
const stepStatuses = requirement.tasks.map((task) => stepStatusFromTask(task.status));
stepStatuses.push(l3.status === "na" ? "pending" : l3.status);
```

于是**同一条阶梯上混着两种单位** —— 前面几步的单位是「任务」,最后一步的单位是
「层」。这才是它读起来别扭的真正原因,不是样式问题。

## 决策:单位统一为「层」

阶梯表达的是**这条需求走到了三层检视的哪一层**,固定三步:

| 步 | 含义 | 状态从哪来 |
|---|---|---|
| **L1 执行** | 执行器实现 + 自检 | 该需求下**执行任务**的聚合状态 |
| **L2 协调** | 协调者功能检视 | 协调任务的状态 / 其 `diffSummary.review_request` |
| **L3 检视** | 检视者架构检视 | `review_result` 载荷 + 缺层判定(见 R3) |

**重试不再增加步数** —— 三次重试是 L1 这一步内部的事,由该步自己表达(见 R2),
不是三个阶段。

## 要求

### R1. 阶梯固定三步,单位是层

替换 `stepStatusFromTask` 的占位算法与 `RequirementDetailPanel` 里「任务数组 + 追加
L3」的拼法。**把占位注释一并删掉** —— 它已经不成立了。

### R2. L1 步要表达重试,但不占额外步数

L1 的状态由该需求下所有执行任务聚合:

- 有 `running` → `running`
- 全部 `done` → `done`
- 存在 `failed` 且无后续成功 → `failed`
- 其余 → `pending`

重试次数以**该步的附属信息**呈现(例如步标签后缀「· 重试 2 次」),
**不得**因重试而增加圈数。

### R3. L3 三态,不得压成一个「不适用」

按 spec v4.0 §3.14.6:

| 状态 | 含义 | 判据 | 呈现 |
|---|---|---|---|
| **已检视** | L3 跑过 | 存在该 taskId 的 `review_result` | 正常状态色 |
| **不适用 · 修复** | 设计如此 | `dispatchKind == "fix"` | 中性 |
| **未检视 · 群内无检视者** | 编制所致,**可行动** | 群成员里 reviewer 与 coordinator 未同时在场 | **中性色,不是警告色** |

⚠️ **后两者必须分开。** 「因为是修复」是设计决定;「因为群里没检视者」是编制状况,
拉一个检视者进群就变了——**混成一个「不适用」就抹掉了一条可行动信息**。

⚠️ **第三种用中性色。** 只部署两方是合法且常见的选择,每条需求都亮告警会退化成
噪音。它是陈述,不是告警。

### R4. 判据对齐 v3.9/v4.0

- 「群内有无检视者」判的是 **reviewer 与 coordinator 是否同时在场**
  (v3.9 §3.14.5),**不是**「有无 reviewer 成员」。现有 `RequirementDetailPanel`
  若仍按旧判据,一并对齐。
- `dispatchKind` 为 `null`(历史任务)时**按 `requirement` 处理**——宁可显示
  「未检视」也不要显示「不适用」,后者会让一条真的漏检看起来像设计如此。

### R5. 依赖

`dispatchKind` 字段由 `specs/dispatch-kind-field.md` 提供。**若下发本票时该字段
尚未落地**,R3 的「不适用 · 修复」一档按 `null` 处理(即全部落到「已检视 / 未检视」
两态),**不要自己造字段**,并在汇报中写明。

## 验收标准

- [ ] 阶梯固定三步(L1 / L2 / L3),不随任务数变化
- [ ] 一条只有一个任务的需求,阶梯仍显示三步
- [ ] 一条重试过 N 次的需求,阶梯仍是三步,重试次数在 L1 步的标签上体现
- [ ] `stepStatusFromTask` 的占位算法与「占位」注释已删除
- [ ] L3 三态各自可复现并显示正确文案
- [ ] 「未检视 · 无检视者」用中性色,**非**警告/危险色
- [ ] 「无检视者」判的是两个角色同时在场,不是只判 reviewer
- [ ] `dispatchKind` 为 null 时落「未检视 / 已检视」,不落「不适用」
- [ ] 前端测试全绿,贴出用例数
- [ ] **未改动**后端

## 不涉及

- 阶梯的图标与配色实现(现有 SVG/token 方案保留,只改语义)
- 控制条位置(`requirement-detail-control-placement`)
- 展开折叠(`fold-affordance-and-length-cap`)
- 任务状态药丸样式(`task-status-legibility`)

## 执行环境提示

- 前端 `http://localhost:5173`
- 群 `01a02f0f-21c3-71a3-979b-268f5d89ac18` 是三方在场(reviewer+coordinator+executor),
  可复现「已检视 / 未检视」;两方场景可临时另建一个只有 coordinator+executor 的群验证
