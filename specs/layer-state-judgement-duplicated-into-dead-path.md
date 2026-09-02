# Spec: L1 层级判定被复制进一条死路径,测试断言的正是死的那份

> **状态**: Landed — L3 通过(2026-09-02),实现 `f548c734`
> **版本**: 1.0
> **ADR**: [ADR-0009](../docs/adr/0009-judgments-must-name-the-fact.md)

## 1. 现象

「L1 步显示什么状态」这个判定,在前端存在**两份实现**:

> **⚠️ 事实更正(2026-09-02,L3 后)**:本文原写「两份**完全相同**的实现」——**错的,
> 它们早已漂移**。依据是修复期间新落库的协调者过程记录(执行器自述):
> live 推导在「两方编制、无 reviewer」时返回 `na-no-reviewer`,
> 而 dead 那份**固定写 `pending`**。测试断言的正是 dead 那份,
> 所以该漂移一直未被发现。
> ⇒ 本文预言的失效模式**不是「将来会发生」,是已经发生了**;修法与结论不变,
> 但原文对严重性的判断偏轻。
> ⚠️ 这条更正只有靠 `detached-close-never-backfills-outputtail` 的回填才拿得到。


| 位置 | 是否影响 UI |
|---|---|
| `requirement-layer-state.ts` `deriveL1` | **是**(live) |
| `group-tasks-by-spec.ts:202` | **否**(dead) |

`requirement-workspace.tsx:117-125`:

```ts
const grouped = groupTasksBySpec(observedTasks, members).map((requirement) => {
  const layerState = deriveRequirementLayerState(requirement, messages, members);
  states.set(requirement.id, layerState);
  return { ...requirement, steps: layerState.steps };   // ← 覆盖掉上一份
});
```

`groupTasksBySpec` 算出的 `steps` **被立即覆盖**,已核实无第二个消费者
(`RequirementList.tsx:122` 渲染的 `req.steps` 此时已是 `layerState.steps`)。

### 危害:测试与 UI 走的是不同的两份

- **UI 走 live 那份**(`requirement-layer-state`);
- **`group-tasks-by-spec.test.ts` 断言的是 dead 那份**;

⇒ 两份一旦漂移,**测试会在死路径上继续全绿,而 UI 已经错了**。
这比单纯的重复更坏 —— 重复至少两份都生效,现在是「改错了没人告诉你」。

## 2. 根因与历史

该重复**早于** `coordinator-served` 标记票:原先两处各有一份
`reason ? "na-declared" : aggregateTaskStatuses(...)`。
`coordinator-served-execution-marker`(`2d735f45`)沿用了既有形态,
把条件从 1 项扩到 3 项(零子执行任务 + 带 review_request + 无豁免理由),
**漂移面随之变大**,因此本项从「可容忍的历史债」升级为须修。

⚠️ 检视者备注:`coordinator-served-execution-marker.md` R1 写了
「推导点在 `requirement-layer-state.ts`」,但**没写「不得在别处复制」**——
实现照既有形态复制并不违规。**这是 spec 的表达缺陷,不是实现走样。**

## 3. 要做的

### R1 抽成单一判定函数

把 L1 状态判定抽成一个导出函数(建议置于 `group-tasks-by-spec.ts`,
因两处都已依赖该模块的 `noExecutionReasonForTask` /
`executionTasksForRequirement` / `coordinationTaskForTasks`),
两处**调用它**,不再各写一份 if/else。

⚠️ **同一事实只允许一个判定出处**(ADR-0009)。抽出后须确认全仓库
`grep -n 'coordinator-served'` 的判定分支**只出现一次**。

### R2 测试改为断言 live 路径

`group-tasks-by-spec.test.ts` 中断言 `steps` 的用例,改为经
`deriveRequirementLayerState`(或经 `requirement-workspace` 的实际组合路径)断言,
使**测试与 UI 走同一条路**。

⚠️ 不得只把 dead 那份删掉了事 —— 若 `groupTasksBySpec` 的返回类型仍带 `steps`
字段,后人仍会以为它有用。要么去掉该字段,要么在类型上注明其值会被覆盖。

## 4. 硬验收

1. **全仓库判定分支唯一**:L1 三态(`na-declared` / `coordinator-served` /
   `aggregateTaskStatuses`)的 if/else **只存在一处**。必测(grep 可证)。
2. **实测反向验证**:临时把该唯一判定改坏(如让 `coordinator-served` 恒不命中),
   `group-tasks-by-spec.test.ts` 与 context-panel 全部测试**必须失败**。
   ⚠️ 这是本票的核心 —— 证明测试真的守在 live 路径上,而不只是「测试还全绿」。
3. 真实数据回归:CD 票与 RS 票的 L1 仍为 `coordinator-served`,
   有子执行任务的票仍为 `done`。拿真实数据验,不构造。
4. context-panel 既有测试全绿(2026-09-02 基线 192 passed)。

## 5. 不涉及

- 不改判定的**语义**(三态判据逐字不变,纯重构)。
- 不改后端、API、数据库。
- 不改 `na-no-reviewer` 与 L2/L3 的推导。
