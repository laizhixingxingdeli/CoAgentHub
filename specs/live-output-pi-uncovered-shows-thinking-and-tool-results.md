# Spec: Pi 的实时输出未被判据表覆盖,界面显示思考与工具结果

> **状态**: Frozen — 2026-09-03
> **依赖**: [live-output-only-agent-narration.md](live-output-only-agent-narration.md)(v1.2,已落地)
> **性质**: 补前一票判据表的洞。前一票的实现按冻结 spec 做对了,本票不追溯其裁决。

## 1. 问题

[live-output-only-agent-narration.md](live-output-only-agent-narration.md) 的
R1 判据表只列了 codex / codebuddy / atomcode 三家,硬验收也只有这三家的样本。
**Pi 从头到尾没被写进去** —— 写那张 spec 时手上没有 Pi 的真实样本。

而 Pi 已于 2026-09-02 成为本群**默认执行器**(见群成员 prompt)。
「界面只显示 agent 汇报」这件事,对现在最常用的执行器基本没生效。

### 实证一:真实任务

已完成的 Pi 任务 `01a06611-71e0`,走 `includeOutput` 拉取:

```
行数 853   非 [汇报] 行数 529
  ✗               eq(taskTable.id, taskId),
  ✗               eq(taskTable.groupId, groupId),
```

529 行是源码正文 —— 工具读文件的结果,被当成汇报显示了。

### 实证二:最小样本(本票新增 fixture)

`.scratch/probe/samples/pi-run.jsonl`,2026-09-03 实跑
`pi -p --mode json --no-session -- @<ticket>`,任务是「读取 a.txt 并告诉我它有几行」。
一个两行文件的问答,解析出 **11 条 `kind=report`**:

| 条目 | 内容 | 应属 |
|---|---|---|
| `#t2` | `<file name="…/t.md">` + 票面正文 | 不进界面(票面回显) |
| `#t6` | `The user wants me to read the file…` | **thinking** |
| `#t11` | 票面正文再回显一次 | 不进界面 |
| `#t19` | `The file t.md contains the instruction…` | **thinking** |
| `#t20` | `好的，我来读取 a.txt 并统计行数` | ✅ 汇报 |
| `#t25` | `hello` / `world` | **工具结果** |
| `#t34` | `The file a.txt has 2 lines. Let me also use bash…` | **thinking** |
| `#t35` | 空白 | 不进界面 |
| `#t45` | `       2 /tmp/…/a.txt` | **工具结果**(wc 输出) |
| `#t56` | `The file has 2 lines.` | **thinking** |
| `#t57` | `` `a.txt` 的内容为：… **共有 2 行。** `` | ✅ 汇报 |

11 条里只有 2 条是用户该看的。其余是**英文内部推理**与**工具结果**——
恰是前一票明确要挡在界面之外的两类。

## 2. 根因:判据表没有 Pi,解析器落到了宽口径

Pi 的事件流自己分得很干净(同一份样本的二级事件计数):

```
message_update.thinking_end   4     ← 全部是英文内部推理
message_update.text_end       3     ← 全部是给人看的正文
message_update.toolcall_end   3
tool_execution_end            3
```

`text_end` 恰好 3 条,逐字就是用户在交互式 CLI 里会看到的三段:
`好的，我来读取…` / `\n` / 最终答案。**结构判据现成,只是没人写进 spec。**

## 3. 要做的

### R1 Pi 的判据

在 [live-output-only-agent-narration.md](live-output-only-agent-narration.md)
的 R1 判据表中补一行,并按此实现:

| 执行器 | 界面保留 |
|---|---|
| pi | `assistantMessageEvent.type === "text_end"` 的 `content`(**全部,含中途旁白**) |

其余一律不进界面:
- `thinking_end` → `thinking`(全文进明细与持久化,不进界面)
- `toolcall_*` / `tool_execution_*` → `tool`
- 票面回显、`session` / `turn_*` / `message_*` 骨架、`*_delta` 增量 → 不进界面

**不得用文本特征判断**(如「是不是英文」「像不像代码」)。判据必须是事件类型 ——
`text_end` 是 Pi 自己给出的事实,和 AtomCode 用 stdout/stderr 是同一种做法。

### R2 空白正文不进界面

`text_end` 的 `content` 去除首尾空白后为空(样本里的 `'\n'`)→ 不进界面。
现有 `liveStreamText` 只挡 `summary.length === 0`,挡不住纯空白。

### R3 持久化口径不变

与前一票 R3 同:`appendTaskOutput` 继续收未经界面过滤的全量摘要流。
本票只收窄界面,不减少 DB 记录。**thinking 仍按既有规则不进摘要流、进明细。**

## 4. 硬验收

以 `.scratch/probe/samples/pi-run.jsonl` 这份真实样本为准:

1. 界面输出**恰好 2 行**:
   - `好的，我来读取 \`a.txt\` 并统计行数`
   - `` `a.txt` 的内容为：…**共有 2 行。** ``(多行正文算一条)
2. 界面**不含**任何英文推理句(`The user wants…` / `Let me also use bash…` 等)。
3. 界面**不含** `hello` / `world` 与 `wc` 输出这两条工具结果。
4. 界面**不含**票面正文回显。
5. 另三家(codex / codebuddy / atomcode)**不回归**:仍为 2 / 1 / 1 行,
   且 `outputTail` 与本票改动前逐字节相同。核对脚本 `.scratch/probe/l3-summ.ts`。

⚠️ 验收脚本必须 **import 生产代码的 `liveStreamText`**,不得内联复制一份 ——
上一票的探针内联了,结果证明不了生产函数的行为。

## 5. 不涉及

- 不改另三家的判据。
- 不改明细存储、`parseTaskReport`、token 账目。
- 不改 `diffSummary.liveOutputTail` 的落库与读取链路(前一票已验收通过)。
