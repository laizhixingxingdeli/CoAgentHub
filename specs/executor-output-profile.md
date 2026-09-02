# Spec: 执行器输出画像(批2)——三个适配点改读配置

> **状态**: Deferred — 2026-09-02 改走适配器注册表,见
> [executor-adapter-registry.md](executor-adapter-registry.md)。
> 暂缓理由:画像表达不了 token 采集(四家里三家读家目录会话文件,
> 需扫目录/解析文件/时间窗筛选/唯一性断言),§3 硬验收当场卡住;
> 且以最小代码为目标,解释器投入大于它省下的分支。
> **画像未被否决**——注册表是容器,`declarativeAdapter(profile)` 可作为其中一员
> 将来共存。`executor_config.output_profile` 列保留不动。
> **版本**: 0.1
> **日期**: 2026-08-29
> **ADR**: [ADR-0008](../docs/adr/0008-executor-adaptation-config-over-code.md)
> **依赖**: [executor-config-over-code.md](executor-config-over-code.md)(批1,提供 `output_profile` 列)

## 1. 目标

把今天按执行器 key 分支的三个适配点,全部改为读同一份**输出画像**
(`executor_config.output_profile`):

| 适配点 | 今天 | 改后 |
|---|---|---|
| 实时输出解析 | `createExecutorOutputParser` 的 `switch` | 画像 `rules` / `skip` |
| token 账目 | `collectTokenUsage` 的 `if-else` 链 | 画像 `usage` |
| 最终汇报正文 | `queue.ts` 三元链(无兜底) | 画像 `finalText` |

画像只含**路径与枚举**,没有条件、没有循环——是字段映射表,不是 DSL(ADR-0008)。

## 2. 画像结构(草案)

```jsonc
{
  "format": "jsonl" | "prefixed-text",
  // --- jsonl ---
  "discriminator": "type",                   // 一级事件类型字段路径
  "nested": "assistantMessageEvent.type",    // 可选二级判别(pi)
  "blocks": "message.content[]",             // 可选内容块展开(codebuddy)
  "rules": [
    { "when": "tool_execution_start", "kind": "tool",
      "name": "toolName", "argsKeys": "args", "detail": "args" },
    { "when": "tool_execution_end",   "kind": "tool",
      "name": "toolName", "error": "isError",
      "command": "args.command", "detail": "result" },
    { "when": "*.thinking_end", "kind": "thinking",
      "text": "assistantMessageEvent.content", "fold": true },
    { "when": "*.text_end",     "kind": "report",
      "text": "assistantMessageEvent.content" }
  ],
  "skip": ["*_delta", "*_start", "session", "turn_*", "message_*"],
  "usage": { "at": "agent_end", "each": "messages[].usage",
             "aggregate": "sum" | "last",
             "input": "input", "output": "output",
             "cached": "cacheRead", "total": "totalTokens" },
  "finalText": { "at": "agent_end", "path": "messages[-1].content[].text" },
  // --- prefixed-text(atomcode 形态)---
  "prefixes": { "[tool→ ": "tool", "[thinking] ": "thinking", "[done] ": "result" }
}
```

`kind` 取值沿用既有 `OutputEntryKind`(`thinking` / `tool` / `command` / `result` /
`report` / `error` / `raw`),渲染口径(`[工具]` / `[命令]` / `[汇报]` / `#id`)不变。

## 3. 硬验收:必须能重写现有四家

**这是本批能否收工的判据,不是可选项。**

用画像重写 codex / codebuddy / atomcode / pi 四家,`output-parser.test.ts` 与
`token-usage.test.ts` 的**既有用例逐字节全绿,不得修改用例**。

某一家写不出来 → 说明画像表达力不足,**当场补足画像结构**,不得保留一个 key 分支
「特事特办」。否则半年后又回到 ADR-0008 描述的「三处分散 + 静默漂移」。

## 4. 必须保留的既有硬规则

以下规则与画像无关,任何画像配置都不得绕过:

- **R3 逐字保留**:解析失败 / 路径未命中 / 类型不认识的行,原样进缓冲,字节不变。
  这是画像配错时的安全网 —— 最坏退化到今天的通用解析器水平,不会更差。
- **错误永不折叠**:`error` 条目全文留在摘要流。
- **跨 chunk 行缓冲**:JSONL 行被切成两半时拼接后渲染一次;进程结束 flush 残留。
- **跳过要可见**:被 `skip` 命中的事件按签名计数 + 去重记一次日志
  (`codex-known-events-leak-as-raw` 的教训)。
- **账目不猜**:画像未命中 → 通用扫描 → 仍未命中记 `unavailable`。永不编造。

## 5. 通用兜底同步升级

无画像的执行器仍走通用解析器,但补两条通用规则(对未来任何流式 CLI 都生效):

- **增量-终值**:同一流内某行携带 `*_delta`,且流中存在对应 `*_end` / 终值字段
  携带完整正文 → 整类丢弃增量行。
- **usage 聚合判别**:多个互不嵌套的 usage 对象,若数值跨出现**单调递增** →
  按累计式取最后一个;若各自独立 → 求和。⚠️ 判别规则的误判代价是账目错报,
  需在实现前用四家真实输出验证判别函数本身。

## 6. 不涉及

- 不做接入向导与画像自动推断(批3)。
- 不改渲染口径、不改明细存储格式、不改 `parseTaskReport` 的五段解析。
- 不引入表达式求值 / 条件 / 循环 —— 一旦画像需要这些,说明该项属于「机制」,
  归代码(ADR-0008 判据)。
