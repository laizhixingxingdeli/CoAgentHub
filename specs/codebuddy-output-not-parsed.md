# Spec: CodeBuddy 的实时输出未被解析,缓冲顶满上限

> **状态**: Frozen(v1.1 修订)— 待实现
> **版本**: 1.0
> **日期**: 2026-08-27

## 现象

`output-parser.ts` 的 `createExecutorOutputParser` switch 只覆盖三个 key:

```ts
case "codex":               → createCodexParser()
case "atomcode": case "executor": → createAtomCodeParser()
default:                    → createIdentityParser()   // 原样透传
```

群内实际有**三个**执行器在承接任务:

| 参与者 | executorKey | 解析情况 |
|---|---|---|
| Codex | `codex` | 已覆盖 |
| AtomCode | `executor` | 已覆盖 |
| **CodeBuddy** | **`codebuddy`** | **落 default,原样透传** |

实测运行中的 CodeBuddy 任务 `01a03eb9`:缓冲 **262142 字节,顶死 262143 上限**,
输出全是未压缩的原始 JSONL。这正是
`live-output-shows-narration-not-actions` 要治的那个基线数字,
在第三个执行器身上原样复现。

## CodeBuddy 输出形态(实测)

Claude Code 风格 JSONL,type 分布与字节占用:

```
assistant              131911 B   55.6%
user                    94197 B   39.7%
file-history-snapshot    5636 B    2.4%
result                   3150 B    1.3%
system                   2207 B    0.9%
```

`assistant` 行结构:

```
顶层键   type / uuid / session_id / message / parent_tool_use_id
         / __timestamp / _requestId
message  id / content / model / role / stop_reason / stop_sequence
         / type / usage
content[] 元素形如 { type: "text", text: ... };工具调用为 tool_use 类型
```

噪音来源与 codex 那次同构:**有用的只是 `message.content[]` 里的文本与工具调用,
其余 uuid / session_id / model / usage / _requestId 等全是信封**。

## ⚠️ 测试已存在,实现尚未存在

`packages/backend/server/test/output-parser.test.ts` 中已有 **9 个 codebuddy 用例**
(来自子任务 `01a03eca`,该任务因额度耗尽只留下测试;检视者在冻结本 spec 时
误将其一并提交于 `439f03eb`,已如实记录)。当前**全部失败**,因为实现缺失。

这些用例形状取自 `01a03eb9` 实跑,覆盖面比本 spec 原列更细:

```
tool_use 块    → [工具] 工具名 + input 键名,不带 uuid/session_id/input 值
text 块        → [汇报] 正文
tool_result 块 → [工具] 工具名(按 tool_use_id 关联) + ok/error
system task_started(Bash) → [命令] description(命令可见)
result 事件    → [汇报] 最终正文
流式跨 chunk   → JSONL 行被切成两半,拼接后渲染一次
进程结束 flush → 吐出未成行残留(逐字,R3)
R5 压缩比      → 动作行可见且不含 uuid/session_id 噪音
未知 key       → 不解析,创建时只记一次观测日志
```

⚠️ **以这批用例为准**:实现要让它们全部通过。
若某条用例的期望与本 spec 正文冲突,**以用例为准**并在汇报中指出冲突点。
⚠️ 不得为了让测试通过而删改这些用例;确需调整的,先在汇报中说明理由。

## 要做的

### R1 — 新增 `codebuddy` 解析分支

在 switch 中为 `codebuddy` 增加分支,渲染动作行并压缩 JSONL 噪音。
渲染口径**对齐已有的 codex 分支**(`[工具]` / `[命令]` / `[汇报]`),
不要新造一套标记体系。

- `assistant` → 取 `message.content[]`:`text` 渲染为汇报行;
  `tool_use` 渲染为工具行(工具名 + **参数键名**)
- `user` → 工具结果,只渲染**结果长度或摘要**,不渲染全文
- `system` / `result` / `file-history-snapshot` → 渲染为单行摘要

⚠️ **不渲染 arguments/result 全文** —— 那正是 55.6% + 39.7% 噪音的来源。
已有 codex 分支的 `compactArgKeys` 是现成口径,复用它。

### R2 — ⚠️ R3 硬要求不变

任何一行解析失败、格式不认识、type 未知 → **原样进缓冲,不得丢弃**。
宁可多显示,不可静默吞掉。

### R3 — ⚠️ 不得改动已生效的分支

`createCodexParser` / `createAtomCodeParser` 及其测试**一律不动**。

### R4 — default 分支加可见性

switch 落到 `default`(未知 executorKey)时记一条日志,
让下一个新执行器接入时能立刻被发现,而不是等缓冲顶满才察觉。
⚠️ 日志需**去重或限频**,不能每行输出记一条。

## 验收要点

- 新起一条真实 CodeBuddy 任务,运行中采样实时缓冲:
  **总字节较 262142 下降至少一个数量级**(参照 codex 修复后实测 3847 字节)
- 同一采样中能看到 `[工具]` / `[命令]` / `[汇报]` 动作行,
  且**看不到** uuid / session_id / _requestId / usage 等信封字段
- 碎片行(长度 ≤6)占比 < 5%,无断成半截的动作行
- 解析失败的行原样保留,有单测覆盖(R2)
- 未知 executorKey 记日志且限频,有单测覆盖(R4)
- codex / atomcode 既有单测**一字未改**且全部通过(R3)
- 测试全绿,贴出用例数;**基线 694**

## 注意

⚠️ 本票**必须下发给执行器**完成。
⚠️ `574c3847…` 之类的 **specHash 不是 commit**,汇报提交时不要混用。
⚠️ 结案若被守卫拒绝,如实回报拒绝原文,**不要自行重启后端,也不要以 failed 收场**。
⚠️ 做完记得提交。
