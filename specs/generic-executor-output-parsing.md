# Spec: 通用执行器输出解析 —— 新接入的 agent 不应再踩「缓冲顶满」

> **状态**: Landed — L3 通过(2026-08-27),实现 `6de49213`
> **版本**: 1.0
> **日期**: 2026-08-27

## 现象

`output-parser.ts` 的 `createExecutorOutputParser` 按 executorKey 分支,
`default` 落到 `createIdentityParser()`(原样透传)。配置中已有 **7 个 key**,
解析器只覆盖 3 个:

```
已配置   executor / reasonix / codebuddy / codex / reviewer / hermes / win-hermes
已解析   codex / atomcode(=executor) / codebuddy
未覆盖   reasonix / hermes / win-hermes / reviewer   ← 一律原样透传
```

「缓冲顶满 262143」因此不是个别 bug,而是**每接一个新 agent 必然重演一次**。
已实测复现两轮:codex(修复前 262143 B)、codebuddy(262143 B)。

## 决策:通用解析为主,定制分支降级为可选优化

### R1 — `default` 换成通用解析器

`default` 分支不再返回 `createIdentityParser()`,改为返回通用解析器。
逐行判定顺序:

```
1. 该行能 JSON.parse       → 走 R2 的通用 JSON 提取
2. 匹配 [前缀] 形式         → 前缀作为动作类型渲染
3. 都不是                   → 逐字保留
```

### R2 — 通用 JSON 提取按「丢信封,留正文」

⚠️ **不得逐格式白名单** —— 那正是当前设计的病根。改为按**字段语义**处理,
使未见过的 agent 也能降级可用:

```
丢弃(信封)  uuid / session_id / request_id / _requestId / parent_tool_use_id
            / model / usage / stop_reason / stop_sequence / 纯 id 与时间戳字段
保留(摘要)  工具名、命令行、参数键名、简短文本、错误
截断        超过阈值的长文本值只保留前 N 字符 + 省略号
```

字段识别用通用启发,并对嵌套结构递归:

- 键名含 `tool` / `function` / `command` / `cmd` → 动作
- 键名含 `text` / `content` / `message` / `output` / `result` → 正文
- 键名以 `_` 开头,或名为 `id` / `*_id` / `*Id` → 视为信封

渲染口径**沿用现有标记**(`[工具]` / `[命令]` / `[汇报]`),不新造体系。

### R3 — ⚠️ 解析失败一律逐字保留

任何一行 JSON 解析失败、结构不认识、提取不出正文 → **原样进缓冲,不得丢弃**。
宁可多显示,不可静默吞掉。此为硬要求,与既有 R3 一致。

### R4 — 定制分支保留,但不再是正确性前提

`createCodexParser` / `createAtomCodeParser` / `createCodeBuddyParser` 三个分支
**保留不动**(它们渲染更准)。但通用解析器必须能独立兜住任何格式:
去掉任一定制分支后,摘要可以变粗,**缓冲不得顶满**。

### R5 — ⚠️ 未知 key 的观测日志保留

现有 `observeUnknownExecutorKey` 的去重逻辑(`Set` 记一次)**保留**。
走通用解析器不等于「已支持」,仍需记录以便发现新接入的 agent。

## 验收要点

- ⚠️ **兜底真实性验证(必测)**:把 codex 的 executorKey 临时改成一个
  不存在的值,使其走 `default`,重放同一份 codex 实跑输出,
  验证**缓冲不顶满**且能看到动作行(贴出前后字节数)
- 同样方式验证 codebuddy 走 default 的兜底效果
- 未覆盖的 key(`reasonix` / `hermes` / `win-hermes`)各构造一份代表性
  JSONL 或文本输入,验证通用路径产出动作行且不含信封字段
- 解析失败的行逐字保留,有单测覆盖(R3)
- codex / atomcode / codebuddy 三个定制分支的既有单测**一字未改**且全通过(R4)
- 未知 key 观测日志仍只记一次(R5)
- 测试全绿,贴出用例数;**基线 711**

## 不在本票范围

- 摘要 / 明细两层输出与展开 API —— 后续独立票
- 前端展开交互 —— 后续独立票
- thinking 折叠 —— 依赖两层输出,后续票

## 注意

⚠️ 本票**必须下发给执行器**完成,**不限定是哪一个**。
⚠️ 票中的 `codex` / `atomcode` / `codebuddy` / `reasonix` 等是
**代码里的 executorKey 字符串常量,与派给谁无关**。
⚠️ specHash 不是 commit,汇报提交时不要混用。
⚠️ 提交前先 `git status` 确认工作树,不要把无关的暂存文件一并提交。
⚠️ 结案若被守卫拒绝,如实回报原文,**不要自行重启后端,也不要以 failed 收场**。
⚠️ 做完记得提交。
