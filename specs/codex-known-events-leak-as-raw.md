# Spec: codex 已知事件走兜底透传,输出噪音翻倍

> **状态**: Frozen — 待实现
> **版本**: 1.0
> **日期**: 2026-08-27

## 现象

codex 解析器只渲染 `type === "item.completed"` 的三类 item,
其余一律走「解析不出 → 原样保留」的兜底(R3)。但实测泄漏出来的
**没有一条是真正「不认识」的**,全是已知事件类型。

实测运行中的 codex 任务 `01a0437d`,52 行输出中原始 JSON 占 23 行、
渲染动作行 23 行 —— **噪音与有效信息各占一半**:

```
item.started/command_execution   13   命令开始,信息被随后的 completed 完全覆盖
item.started/mcp_tool_call        2   工具开始,同上
error                             4   顶层错误(如 "Reconnecting... 5/5")
item.completed/error              1   错误事件,当前无渲染分支
thread.started                    1   会话生命周期
turn.started                      1   会话生命周期
turn.completed                    1   会话生命周期
```

用户观察到的现象是「每条命令出现两个记录,第二个没有内容」——
第二个正是 `item.started`:它本就不带结果,只有命令行,还被截断。

## 决策:把「已知但不渲染」与「不认识」分开

R3(解析失败逐字保留)的初衷是**防止格式变了却悄悄吞掉输出**。
`item.started` 等不是解析失败,是**明确识别出来、且信息冗余**的事件。
让它们走兜底,等于把 R3 的防御变成噪音来源。

### R1 — 已知冗余事件静默跳过

以下事件识别后**不产出任何条目**:

```
item.started(全部 item 类型)   信息被随后的 item.completed 覆盖
thread.started / turn.started / turn.completed   会话生命周期,无动作信息
```

⚠️ 必须是**显式识别后跳过**,不得靠「匹配不上就丢弃」——
那会把真正的未知格式也一起吞掉。

### R2 — 错误事件渲染为动作行,不折叠

```
顶层 { "type": "error", "message": ... }        → [错误] <message>
item.completed 且 item.type === "error"          → [错误] <message>
```

⚠️ 错误**永不折叠**(沿用 two-tier-output R3):
`summary` 即完整错误信息,不进明细、不截断到看不懂。

### R3 — ⚠️ 真正不认识的仍逐字保留

未知 `type`、未知 `item.type`、非法 JSON、半截行 → **原样进缓冲**。
此为历次硬要求,不得因本票放宽。

### R4 — ⚠️ 跳过必须可观测

被跳过的已知事件应有**计数或去重日志**,便于确认「跳过的是预期的那些」,
而不是悄悄吞掉了别的东西。
⚠️ 日志需去重或限频,不能每行一条。

### R5 — ⚠️ 不得改动其他分支

`createAtomCodeParser` / `createCodeBuddyParser` / `createGenericParser`
及其既有用例一律不动。

## 验收要点

- ⚠️ **必须以真实 codex 任务实跑采样为准**,统计各事件类型的泄漏行数
  (参照本 spec 上表),验证:
  - `item.started` / `thread.started` / `turn.started` / `turn.completed`
    **不再出现在摘要流中**
  - 原始 JSON 行占比由约 **50% 降至 < 5%**
- 错误事件渲染为 `[错误] <message>` 且**未被折叠进明细**(必测)
- 构造一条**未知 type** 的行,验证仍逐字保留(R3,必测)
- 构造**半截 JSON**,验证仍逐字保留(R3,必测)
- 跳过计数/日志存在且限频(R4)
- atomcode / codebuddy / 通用解析器既有单测**一字未改**且全通过(R5)
- 测试全绿,贴出用例数

## 注意

⚠️ 本票**必须下发给执行器**完成,**不限定是哪一个**。
⚠️ 票中的 `codex` / `atomcode` / `codebuddy` 是
**代码里的 executorKey 字符串常量,与派给谁无关**。
⚠️ specHash 不是 commit,汇报时不要混用。
⚠️ 若全量测试出现「等任务终态」类用例超时,那是负载所致、非本票引起 ——
   如实回报,**不要反复重跑碰运气**。
⚠️ 提交前先 `git status` 确认工作树,不要把无关的暂存文件一并提交。
⚠️ 结案若被守卫拒绝,如实回报原文,**不要自行重启后端,也不要以 failed 收场**。
⚠️ 做完记得提交。
