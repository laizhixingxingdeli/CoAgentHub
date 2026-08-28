# Spec: token 采集按 CLI 写死,新执行器一律 unsupported

> **状态**: Landed — L3 通过(2026-08-28),实现 `c2b4cb33`
> **版本**: 1.0
> **日期**: 2026-08-28

## 现象

`lib/executor-task/token-usage.ts` 的 `collectTokenUsage`(约 382 行)
按 `executorKey` 硬分支:

```
executorKey === "codex"      → 只认 type === "token_count"
executorKey === "executor"   → AtomCode session meta
executorKey === "codebuddy"  → ...
executorKey === "claude"     → ...
其余                          → reason: "unsupported"
```

配置中已有 7 个 executorKey,**`reasonix` / `hermes` / `win-hermes` / `reviewer`
一律 `unsupported`**,每接一个新 CLI 就要再写一个分支。

## ⚠️ 与输出解析是同一个病根

`generic-executor-output-parsing`(已 Landed `6de49213`)治的就是这个形态:
键名层通用,**定位层却按 CLI 写死**。该票的兜底实测把 codex 输出
从 268589 B 压到 1958 B,证明「通用兜底 + 定制加速」的结构可行。

✅ **本票的有利条件**:键名适配**已经做好了**。`readUsageObject` 现认 18 种变体:

```
input_tokens / inputTokens / input
output_tokens / outputTokens / output / completion_tokens
cached_input_tokens / cachedInputTokens / cached_tokens / cached_input / cachedTokens
cache_read_input_tokens / cacheReadInputTokens
cache_creation_input_tokens / cacheCreationInputTokens
total_tokens / totalTokens
```

缺的只是**「去哪找」**这一层。

## 要做的

### R1 — 增加通用兜底,定制分支降级为加速路径

```
1  先试各 CLI 的现有定制路径(准、快)
2  未命中 → 通用兜底:扫全部 JSONL 行,递归查找任何可被 readUsageObject
           解析出 input 或 output 的对象;取最后一条(累计值通常在末尾)
3  仍未命中 → 如实记 unavailable
```

⚠️ 判据必须**按语义而非按 CLI**:任何对象只要能解析出 input 或 output
就是候选,不预设它挂在哪个 type 或哪层嵌套下。

### R2 — ⚠️ 复用现有解析件

`readUsageObject` 认键名、`finishTotals` 负责汇总。
**只新增定位逻辑**,不要新写一套键名映射或汇总。

### R3 — ⚠️ 总量口径不得因兜底而走样

`totalTokens` 必须是真实总消耗。
⚠️ 各 CLI 对「cached 是否已含在 input 内」「reasoning 是否已含在 output 内」
口径不同,兜底路径**必须沿用与定制路径一致的判定**,不得两套算法给出两个数。
若无法判定某字段是否为子集,采用保守口径并在实现注释中写明。

### R4 — ⚠️ 采不到仍如实记 unavailable

不得估算、不得回退到别处的数字、不得填 0。此为历次硬要求。

### R5 — ⚠️ 不得改动已生效的定制分支

`codex` / `executor`(AtomCode)/ `codebuddy` / `claude` 四个分支
及其既有用例**逐字不变**(回归,必测)。

### R6 — 兜底命中需可观测

通过兜底路径采到的用量,`source` 字段应可区分(如 `generic-jsonl-scan`),
便于事后分辨哪些是精确采集、哪些是兜底推断。

## 验收要点

- ⚠️ **兜底真实性验证(必测)**:把 codex 的 executorKey 临时改成一个
  **不存在的值**使其走兜底,重放同一份真实 codex stdout,
  验证采到的 `totalTokens` 与定制路径**一致**(贴出两者数值对照)
- 同样方式验证 AtomCode 走兜底的结果与定制路径一致
- `reasonix` / `hermes` / `win-hermes` 各构造一份代表性输入,
  验证不再返回 `unsupported`(贴出采到的数值)
- 完全无用量信息的输入 → 仍记 `unavailable`,不估算(R4,必测)
- 兜底命中的 `source` 可区分(R6)
- 四个定制分支既有单测**一字未改**且全通过(R5)
- 测试全绿,贴出用例数

## 注意

⚠️ 本票**必须下发给执行器**完成,**不限定是哪一个**。
⚠️ 票中的 `codex` / `atomcode` / `codebuddy` / `reasonix` 是
**代码里的 executorKey 字符串常量,与派给谁无关**。
⚠️ 依赖 `codex-token-collection-never-matches` 先落地(它修正 codex 定制路径);
   若那票尚未合入,先如实回报,不要抢跑。
⚠️ specHash 不是 commit,汇报时不要混用。
⚠️ 提交前先 `git status` 确认工作树,不要把无关的暂存文件一并提交。
⚠️ 做完记得提交。
