# Spec: token 用量采到了,但界面永远不显示

> **状态**: Landed — L3 通过(2026-08-26),实现 `28dcd5d9`
> **版本**: 1.0
> **日期**: 2026-08-26

## 现象

界面上找不到任何 token 消耗。代码里**有这个位置**,但它永远不会渲染。

`RequirementTimeline.tsx:403`:

```ts
const tokenUsage = readText(task.diffSummary, "tokenUsage");
```

`readText`(同文件 `:152`):

```ts
const value = diffSummary[key];
return typeof value === "string" && value.trim().length > 0 ? value : null;
```

而 `tokenUsage` 是**对象**:

```json
{"source":"atomcode-session-meta","inputTokens":81924,"outputTokens":17387,
 "cachedInputTokens":807936,"totalTokens":907247}
```

`typeof` 不是 `"string"` → 恒为 `null` → `:551` 的 `{tokenUsage && (…)}` 永不渲染。

**采集侧是好的**,库里数据真实存在(AtomCode 三次任务:907,247 / 673,642 /
10,365,075)。坏的只有显示。

## 决策

### R1. 按对象读,并显示可读的数字

新增一个读取器(不要改 `readText` 的语义 —— 其它字段还在用它),
从 `diffSummary.tokenUsage` 取 `totalTokens`,渲染为带千分位的整数,
例如 `Token 907,247`。

### R2. 缺失与不可用要能区分

- 无 `tokenUsage` 且无 `tokenUsageReason` → **不显示**该条(保持现状,不占位)
- 有 `tokenUsageReason`(如 `unavailable` / `unsupported`)→ 显示
  `Token 未采集`,并把原因放进 `title` 属性供悬停查看
- ⚠️ **不要**在采不到时显示 `Token 0` —— 那会把「没采到」误报成「没花钱」

### R3. 数据来源不变

**不改**后端采集、不改 `diffSummary` 结构、不新增接口字段。
本票只改前端怎么读已有数据。

### R4. 不动同一行的其它指标

`耗时` 等既有指标的渲染逐字不变(回归)。

## 验收标准

- [ ] `tokenUsage.totalTokens` 存在 → 渲染 `Token <带千分位数字>`(必测)
- [ ] 用真实形状做夹具(含 `source`/`inputTokens`/`outputTokens`/
      `cachedInputTokens`/`totalTokens`),断言显示的是 `totalTokens`
- [ ] 无 `tokenUsage` 且无 `tokenUsageReason` → 该条**不出现**(必测)
- [ ] 有 `tokenUsageReason` → 显示 `Token 未采集`,`title` 含原因(必测)
- [ ] 采不到时**不显示** `Token 0`(反向断言,防回退)
- [ ] `readText` 本身未被改动(回归,读代码确认)
- [ ] 同一行 `耗时` 指标渲染逐字不变(回归,必测)
- [ ] 前端测试全绿,贴出用例数

## 不涉及

- 后端采集逻辑(R3)——协调者采不到是另一票
- `diffSummary` 结构

## 执行环境提示

- 位置:`components/layout/context-panel/RequirementTimeline.tsx`
  的 `:403` 读取与 `:551` 渲染
- 真实数据可从库里取:
  `select attempts->-1->'tokenUsage' from task where attempts->-1->'tokenUsage' is not null;`
- ⚠️ 本票**必须下发给执行器**完成
- ⚠️ 做完记得提交
