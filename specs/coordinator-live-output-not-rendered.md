# Spec: 协调者的实时输出在界面上完全不可见(L2 层不渲染任务项)

> **状态**: Landed — 2026-09-07(修复 `4d12dbe9`;L3 已 pass)
>
> 落地要点:L2 层不再写死 tasks=[],协调者实时输出可见

## 1. 现象

协调任务运行期间,需求详情面板的 L2 层只显示两行:

```
协调者 Codex
协调任务进行中,尚无 L2 结论
```

**没有任何实时输出。** 而同一面板的 L1 层(执行子任务)是有实时输出终端块的。

## 2. 根因:数据全都到位,前端不渲染

### 后端与传输层:正常

`queue.ts:1745` 的 `onOutput` 对**所有** spawn 的任务生效,不受 detached 影响:

```ts
appendTaskOutput(taskId, summaryText);
void wsHub.broadcastTaskOutput(groupId, taskId, summaryText);
```

⇒ 协调任务的输出**照常入环形缓冲、照常 WS 广播**。
前端 `use-group-ws.ts:339` 也照常收进 `liveOutputs[task.id]`。
终态后 `diffSummary.outputTail` 亦已回填
(见 `detached-close-never-backfills-outputtail.md`,2026-09-02 落地)。

### 前端:L2 层传了空数组

`RequirementDetailPanel.tsx` 三处时间线调用:

| 层 | `tasks` |
|---|---|
| L3(`:463`) | `[]` |
| **L2(`:511`)** | **`[]`** ← 协调者在这一层 |
| L1(`:551`) | `l1Tasks` |

而实时输出块是**挂在任务项上**渲染的
(`RequirementTimeline.tsx:479` `liveOutputs[task.id] ?? outputTail ?? ""`)。
L2 传空数组 ⇒ 无任务项 ⇒ **输出块根本不存在**。

⇒ 这不是过滤、不是权限、不是数据缺失,是**渲染入口没接上**。

## 3. 要做的

### R1 L2 层渲染协调任务项

`RequirementDetailPanel.tsx:511` 的 L2 时间线传入 `l2.task`(该层已有该对象,
见同文件 `:497` `l2.task ?`),使其任务项与实时输出块得以渲染。

### R2 不得与 L2 卡片既有内容重复

L2 卡片当前已单独显示「协调者 <名字>」与「协调任务进行中,尚无 L2 结论」。
接入任务项后若出现同义重复,应移除卡片上的冗余行,**以任务项为准**。

⚠️ 参照 `task-status-line-duplicates-the-card.md` 的教训:
**同一事实不要在同一屏出现两次**。

### R3 折叠态不得刷屏

沿用 L1 任务项既有的折叠口径(`RequirementTimeline.tsx:483`:
running 显示最后一非空行,done/failed 显示汇报摘要),**不新增展开逻辑**。

## 4. 硬验收

1. **端到端**:下发一张真票,协调任务 running 期间 L2 层出现实时输出
   (至少一行动作行),内容随执行推进而更新。⚠️ 拿真实一轮验,不构造。
2. 协调任务终态后,L2 层显示其 `diffSummary.outputTail`(回填值)。必测。
3. **L1 层渲染逐字不变**(回归):执行子任务的输出块、折叠预览、展开态均不变。
4. **无重复**:L2 卡片上不出现与任务项同义的重复信息。
5. 无协调任务时仍显示「该需求还没有协调任务(L2 未开始)」(回归)。

## 5. 不涉及

- 不改后端、WS、缓冲与回填(数据侧已全部就绪)。
- 不改 L3 层(`:463` 的 `tasks={[]}` 另议 —— L3 由检视者作出,当前无任务项可挂)。
- 不改 `RequirementTimeline` 的输出块实现本身。
