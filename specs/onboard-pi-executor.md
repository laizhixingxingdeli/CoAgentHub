# Spec: 接入 pi —— 实测记录与画像

> **状态**: Blocked — 依赖批2([executor-output-profile.md](executor-output-profile.md))
> **版本**: 2.0
> **日期**: 2026-08-29
> **ADR**: [ADR-0008](../docs/adr/0008-executor-adaptation-config-over-code.md)

## 修订记录

- **v2.0(2026-08-29)**:原 v1.0 按「新增内置执行器 + 专用解析器 + 专用收集器」
  写(三处代码改动)。ADR-0008 决定取消内置执行器、适配字段全部配置化后,这条
  路径作废。本版改为**实测记录 + 目标画像**:pi 的接入本身不再是代码工作,
  批1 落地后可纯界面接入(降级形态),批2 落地后画像生效。同时,本文件记录的
  实测数据是**批2 的验收 fixture**。
- v1.0(2026-08-29):内置执行器方案,已作废。

## 1. 实测事实(2026-08-29,pi 0.84.4,`~/.local/bin/pi`)

### 1.1 输出规模

一次**只调用一个 bash 工具**的最小任务:**97 行 / 28787 字节**。

```
message_update          77   79.4%   ← 逐 token 增量
message_start / _end     8
turn_start / turn_end    4
tool_execution_*         4
session/agent_start/agent_end/agent_settled  4
```

`message_update` 内层 `assistantMessageEvent.type` 分布:

```
thinking_delta 55 · toolcall_delta 13 · thinking_start/end 2/2
· toolcall_start/end 1/1 · text_start/delta/end 1/1/1
```

**每个 `message_update` 都完整重复一份 `usage` 对象(含 cost 明细)**,这是字节
占用的第二个来源。真实任务规模下会像 `codebuddy-output-not-parsed` 那次一样顶死
262143 上限。

### 1.2 有效动作只在这几种行里

```jsonc
{"type":"tool_execution_start","toolCallId":"bash_0","toolName":"bash","args":{"command":"ls specs | head -3"}}
{"type":"tool_execution_end","toolCallId":"bash_0","toolName":"bash","result":{"content":[…]},"isError":false}
{"type":"message_update", …,"assistantMessageEvent":{"type":"thinking_end","content":"完整思考正文"}}
{"type":"message_update", …,"assistantMessageEvent":{"type":"text_end","content":"完整汇报正文"}}
```

**`*_end` 事件已携带该内容块的完整正文**,所有 `*_delta` 都是它的前缀重复,
可整类丢弃而不丢信息 —— 这正是批2「增量-终值」通用规则的原型。

### 1.3 usage 是每条消息的,不累计 ⚠️

`agent_end.messages[]` 里两条 assistant 消息(同一次任务):

```
turn 1: input 3654, output 51, cacheRead 512,  totalTokens 4217
turn 2: input 166,  output 31, cacheRead 4096, totalTokens 4293
合计:   input 3820, output 82, cacheRead 4608, totalTokens 8510
```

- `totalTokens = input + output + cacheRead`;**cacheRead 是加性的,不是 input 的
  子集**(与 Codex 系相反)。
- 不跨轮累加。通用扫描「取最后一个 usage 对象」落到 pi 身上**只会报 166/31**,
  与 `codex-token-collection-never-matches` 同构的少报。
- `cacheRead` / `cacheWrite` 不在 `readUsageObject` 的别名表里(批1 R4 补齐)。

### 1.4 任务书传递

实测 `pi -p -- "@<路径>"` 会把任务书正文内联为 `<file name="…">…</file>` 进上下文,
**比让 agent 自己去读文件少一次工具往返、少一个失败面**。对应批1 的
`inputMode: "at-file"`。

## 2. 目标配置

批1 落地后可直接在接入界面填(无代码):

```jsonc
{
  "key": "pi", "agentName": "Pi", "type": "participant", "kind": "cli",
  "bin": "pi", "label": "pi",
  "args": ["-p", "--mode", "json", "--no-session", "--", "@{ticket}"],
  "inputMode": "at-file",
  "maxConcurrency": 1,      // 共享工作区,理由同 codex
  "model": null             // 不写死;模型由用户自己的 pi 配置决定
}
```

- **不写死 model**:实跑时为 `opencode-go / kimi-k2.6`,由 pi 自身配置决定。
  平台再定一次会产生两个真相源。
- **`--` 终止选项解析**,防任务书路径以 `-` 开头时被当作 flag。
- pi 在群内以什么角色入群决定它能否下发(ADR-0008 第三条);作为纯执行器接入时
  给 `executor` 角色即可。

## 3. 目标画像(批2 验收 fixture)

```jsonc
{
  "format": "jsonl",
  "discriminator": "type",
  "nested": "assistantMessageEvent.type",
  "rules": [
    { "when": "tool_execution_start", "kind": "tool",
      "name": "toolName", "argsKeys": "args", "detail": "args" },
    { "when": "tool_execution_end", "kind": "tool",
      "name": "toolName", "error": "isError",
      "command": "args.command", "detail": "result" },
    { "when": "*.thinking_end", "kind": "thinking",
      "text": "assistantMessageEvent.content", "fold": true },
    { "when": "*.text_end", "kind": "report",
      "text": "assistantMessageEvent.content" }
  ],
  "skip": ["*_delta", "*_start", "tool_execution_update",
           "session", "turn_*", "message_start", "message_end", "agent_*"],
  "usage": { "at": "agent_end", "each": "messages[].usage", "aggregate": "sum",
             "input": "input", "output": "output",
             "cached": "cacheRead", "total": "totalTokens" },
  "finalText": { "at": "agent_end", "path": "messages[-1].content[].text" }
}
```

## 4. 验收标准

批1 后(降级形态):

1. 纯界面接入 pi,不改任何代码;`maxConcurrency: 1` 生效(并发两票时第二票 `queued`)。
2. 下发一条真任务能达终态;token 字段非空(仍可能少报,见 1.3,批2 修正)。

批2 后(画像生效):

3. 用 §1 那份 97 行实跑输出喂解析:产出**不含**任何 `*_delta` 派生行;含
   `[命令] ls specs | head -3`;含 `[思考]` 一行要旨与 `[汇报]` 正文;
   摘要流字节 **≤ 原始 20%**;不含 `toolCallId` / `cost` / `responseId` 等信封。
4. 畸形 JSON 与未知 `type` 各一行:逐字出现在摘要流,字节不变。
5. `isError: true` 的 `tool_execution_end`:错误正文完整、未折叠。
6. 一行 JSONL 切成两个 chunk 分别喂入:拼接后只渲染一次。
7. token:`input=3820, output=82, cached=4608, total=8510`(**两轮求和**,
   而非末轮的 166/31)。
8. stdout 中无 `agent_end`(进程被杀):不猜、不编,最终记 `unavailable`。

批3 后:

9. 对 pi 跑接入探测:自动推断出的画像解析结果与 §3 手写画像一致,
   `aggregate` 被判为 `sum`。

## 5. 不涉及

- 不为 pi 写任何专用解析器 / 专用收集器 / 内置配置(ADR-0008 已排除这条路径)。
- 不改 pi 的 `--tools` 默认集合(read/bash/edit/write 开、grep/find/ls 关)。
- 不引入 pi 的 session 记忆(`--no-session`,任务书自包含)。
