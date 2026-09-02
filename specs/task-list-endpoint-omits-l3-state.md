# Spec: 列表端点不输出 l3,需求面板的 L3 步恒显示 running

> **状态**: Frozen — 2026-09-02
> **相关**: [l3-verdict-observability](l3-verdict-observability.md)

## 1. 现象(实测)

2026-09-02 补正裁决载荷后,详情端点已正确应答:

```bash
curl -H 'X-Participant-Id: <reviewer>' \
  "$API/groups/$GID/tasks/01a0605a-da7c-766b-8f9c-9eab197f2cef" | jq .l3
# {"answered": true, "verdict": "pass", "awaitingSince": null, "overdue": false}
```

**但界面上该需求的 L3 步仍是 `running`。** 刷新、重建前端均无变化。

## 2. 根因:面板的数据源根本不带这个字段

需求面板取数(`requirement-workspace.tsx:334` / `:363`):

```ts
fetch(`/api/groups/${groupId}/tasks?includeOutput=1`)   // ← 列表端点
```

而列表端点(`routes/group/tasks.ts:960-982`)只做两件事:

```ts
const withPidAlive = tasks.map((task) => ({ ...task, pidAlive: pidAliveOf(task.executorPid) }));
if (!wantOutput) return c.json(withPidAlive);
// …附加 outputTail…
```

**从不附加 `l3`。** `l3` 的推导只存在于**详情**端点(`/tasks/:id`)。

实测确认(列表端点响应):

```
01a0605a-da7c   l3 键=**不存在**
01a05ddc-a8d8   l3 键=**不存在**
```

⇒ 前端 `deriveL3` 拿到 `apiL3 === undefined`,退到默认分支 → **恒渲染 running**。

⚠️ 这与裁决是否登记**无关**:即使 `answered=true`,面板也看不见。
本缺陷使「L3 是否完成」这一层在界面上**结构性不可观测**。

## 3. 要做的

### R1 列表端点按详情端点同口径输出 `l3`

复用详情端点已有的 L3 派生(`routes/group/tasks.ts:643` 一带,
「协调任务 + done + 带 review_request」才输出,否则不输出该键),
在列表映射中对每条任务同样求值。

⚠️ **同一事实一个判定出处**(ADR-0009):**必须复用同一个派生函数**,
不得在列表端点另写一份判定。若该派生当前内联在详情处理器里,先抽成共享函数。

⚠️ **不满足触发条件时仍不输出该键**(与详情端点逐字一致),
避免前端把「不适用」误读为「未应答」。

### R2 N+1 查询防护

详情端点的 L3 派生涉及 `hasReviewResult`,后者**全表扫本群 `review_result` 消息**
(`l3-overdue-reminder.ts:44`)。列表端点一次返回上百条任务,
逐条调用会产生 N 次全表扫。

⇒ 列表路径必须**批量求值**(一次取全群 review_result 消息,在内存中按 taskId 归并),
不得对每条任务各查一次。

⚠️ 验收须包含查询次数断言或耗时上界,否则该风险不可见。

## 4. 硬验收

1. **端到端**:已应答的任务(如 `01a0605a-da7c`)在**列表端点**响应中
   `l3.answered === true`、`l3.verdict === "pass"`;界面该需求的 L3 步显示为
   已完成而非 `running`。⚠️ 拿真实数据验,不构造。
2. **不适用的任务不输出该键**(非协调任务 / 未 done / 无 review_request):
   与详情端点逐字一致。必测。
3. **判定唯一**:`grep` 可证列表与详情走同一个派生函数,不存在第二份实现。必测。
4. **批量求值**:列表端点对 N 条任务的 `review_result` 查询次数与 N **无关**
   (常数次)。必测 —— 断言查询次数或给出耗时上界。
5. 既有列表端点行为不变:`pidAlive` 与 `includeOutput` 的 `outputTail` 逐字不变(回归)。

## 5. 不涉及

- 不改 L3 派生的**语义**(触发条件、`answered`/`verdict`/`overdue` 口径不变)。
- 不改详情端点。
- 不改前端 `deriveL3` 的回退逻辑(它拿到字段后自然正确)。
- 不修 `hasReviewResult` 的全表扫本身(仅要求列表路径批量化);
  其索引优化另议。
