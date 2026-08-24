# Spec: 结构化载荷裸露成 JSON,同一份信息以最差形式重复出现

> **状态**: Landed — L3 通过(2026-08-24),实现 `1e5073a3`
> **版本**: 1.0
> **日期**: 2026-08-24

## 现象

需求详情的时间线里,直接糊着原始 JSON:

```
{"type": "review_result", "layer": 3, "taskId": "01a03014-9eac-747c-8674-
c2b81f97acf9", "specRef": "…
```

这是检视者公布的 **L3 裁决载荷**。用户想读的是「通过 / 有发现项 + 理由」,
看到的却是一串 uuid 和转义引号。

**更糟的是它是重复的**:同一份 `review_result` 在上方的 **L3 层卡片里已经被正确
解析并渲染过一次**(显示为「检视通过」+ 结论文本)。于是同一份信息出现两次,
**第二次是最差的形式**。

## 根因

`RequirementTimeline` 把群消息一律当**自由文本**渲染。而
`spec_published` / `spec_amended` / `review_request` / `review_result` 四种载荷
是**结构化协议数据**(schema 定义在 `coordination-payload.ts`),不是给人读的正文。

`RequirementDetailPanel` 已经会解析它们(`parseReviewResult`),
**但时间线不知道**,于是原样打印。

## 要求

### R1. 时间线识别结构化载荷,不再裸露

消息体解析为四种已知载荷之一时,**不渲染原始 JSON**,改为该载荷的**人读形式**:

| 载荷 | 时间线里应显示 |
|---|---|
| `spec_published` | 「公布规范 `<specRef>` @`<specHash>`」+ `summary` |
| `spec_amended` | 「修订规范 `<specRef>` → `<新 specHash>`」+ `reason` |
| `review_request` | 「交回 L3 检视」+ `diffSummary` 摘要 |
| `review_result` | 「L3 裁决:通过 / 有发现项」+ `note`;有 `findings` 时列出 |

**判据复用** `coordination-payload.ts` 的 `parseKnownCoordinationPayload`,
不要在前端另写一套解析(后端已有权威定义,两份会漂移)。

### R2. 解析失败必须显式标注,不静默回退

消息**看起来像**结构化载荷(trim 后以 `{` 开头且含 `"type"`)但解析失败时:

- 显示一行明确标注:**「无法解析的协作载荷」**
- 其下折叠展示原文,供排障

**不要**静默当普通文本渲染 —— 那正是现状,也正是这个问题藏了这么久的原因。

### R3. 消除重复:L3 裁决不在时间线重复展开

`review_result` 已在 L3 层卡片完整呈现。时间线里**只保留一行事件条目**
(如「检视者公布 L3 裁决 · 通过」+ 时间),**不重复正文**。

同理 `review_request`:L2 层卡片已展示其结论文本,时间线只留事件条目。

理由:时间线的价值是**发生了什么、什么时候**;内容的价值在层卡片里。
两处都铺全文,读者要读两遍才知道是同一件事。

### R4. 不改后端、不改载荷格式

`coordination-payload.ts` 的 schema **不动**;检视者/协调者公布载荷的方式**不动**。
本票纯前端渲染层。

### R5. 普通消息行为不变

不是结构化载荷的自由文本消息(任务书、群内对话)**渲染方式与改动前完全一致**。
这是最大的回归面。

## 验收标准

- [ ] 时间线中 `review_result` 显示为「L3 裁决:通过 / 有发现项」+ 理由,
      **不出现原始 JSON**
- [ ] 四种载荷各有对应的人读形式(逐一验证)
- [ ] `findings` 非空时,严重度与说明**可读地列出**
- [ ] 形似载荷但解析失败 → 显示「无法解析的协作载荷」+ 可折叠原文,
      **不静默当普通文本**
- [ ] `review_result` / `review_request` 在时间线**只留事件条目**,
      正文不与层卡片重复
- [ ] 解析判据**复用**后端 `parseKnownCoordinationPayload`,前端未另写一套
- [ ] 普通自由文本消息渲染**与改动前逐字一致**(回归,必测)
- [ ] 前端测试全绿,贴出用例数
- [ ] **未改动**后端与载荷 schema

## 不涉及

- 载荷格式本身(R4)
- 详情页布局重组(另票)
- 阶梯与层状态矛盾(另票 `layer-status-contradiction`)

## 执行环境提示

- 前端 `http://localhost:5173`
- **可复现样本**:群 `01a02f0f-21c3-71a3-979b-268f5d89ac18` 的任一需求详情,
  时间线里能看到裸 JSON
- 已有解析参照:`RequirementDetailPanel.tsx` 的 `parseReviewResult`
- 后端权威定义:`packages/backend/database/src/schema/coordination-payload.ts`
