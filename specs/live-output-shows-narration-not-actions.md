# Spec: 实时输出只有旁白,看不到 agent 做了什么

> **状态**: Landed — L3 通过(2026-08-27),实现 `7d3278ef`
> **版本**: 1.0
> **日期**: 2026-08-26

## 目标(用户原话)

> 我只想在实时输出里看到 agent 都做了什么。

"做了什么" = **工具调用与命令**:调了哪个工具、参数是什么、命令是什么、
退出码多少、成功还是失败。不是旁白,不是任务书回显。

## 现状实测

### AtomCode / CodeBuddy(`-y -p {ticket}`)

stdout 只有 assistant 正文。5 条已结案任务共 23879 字节,
工具调用 **0 条**,`thinking`/`reasoning` 各 **0 次**。全是这种句子:

```
Reading the spec first, then the target file and its tests.
Reading the full target file and its tests now.
Reading the full file content in one go.
Continuing task #1 — updating groupTasksBySpec to accept and thread members.
```

而且句与句之间**不带换行** —— `appendTaskOutput` 是裸 `prev + chunk`
(`output-buffer.ts:20`),几十句粘成一个段落。副作用:`OUTPUT_TAIL_MAX_LINES
= 1000` 在这种输入下永远够不着,实际只有 256KB 字节上限在起作用。

### Codex(`exec --approve-for-me --ephemeral --json`)

stdout 是 JSONL,每个 item 发 `item.started` + `item.completed` 各一次。
正在跑的 `01a03d87`,缓冲 262143 字节(**正好顶死 256KB 上限**),按类型拆:

| item_type | 条数 | 字节 | 占比 |
|---|---|---|---|
| `mcp_tool_call` | 26 | 96,318 | **65%** |
| `command_execution` | 30 | 16,420 | 11% |
| `agent_message` | 3 | **1,131** | **0.8%** |

那 65% 是 `arguments`/`result` 把整份任务书**六层转义**地回显了一遍:

```
\\\\\\\"brief\\\\\\\":\\\\\\\"# 任务:技能从未说过「不要自己实现」…
```

界面上看到的那一坨就是它。**动作信息本身是有的,被噪音埋了。**

## 关键发现:三家都能实时输出动作,只是开关没开

| 执行器 | 开关 | 通道 | 格式 |
|---|---|---|---|
| AtomCode | `-v` | **stderr** | `[tool→ name] {args}` 行前缀 |
| CodeBuddy | `--output-format stream-json` | stdout | JSONL |
| Codex | 已开 `--json` | stdout | JSONL(只是没解析) |

`atomcode --help` 原文:`-v, --verbose  在 stderr 上显示工具调用、token 用量和回合摘要`。

实跑 `atomcode -y -v -p "Read a.txt and tell me its contents."`,stderr 得到:

```
[thinking] The user wants me to read a.txt and tell them its contents. This is a
simple single-file read — no skill matches, no todo list needed.[tokens] prompt=17953 completion=82 cached=6656

[tool→ read_file] {"file_path": "a.txt"}
[tool← ok] 8 chars
[tokens] prompt=17880 completion=10 cached=11904
[done] 6.1s tokens=35.92K turns=2 tool_calls=1
```

`executor-runner.ts:121` **本来就把 stderr 送进同一个 `onOutput`**,
所以加 `-v` 之后这些行会自动进缓冲,无需改传输链路。

⚠️ 注意上面第 2 行:`...read the file.[tokens] prompt=` —— `[tokens]` 前没换行。
`[thinking]` 与 `[tokens]` 粘在一起,和 stdout 的粘连是同一个毛病。

## 要做的

### R1:AtomCode / CodeBuddy 打开动作输出

- `executors.ts` 的 `executor`(AtomCode)与 `codebuddy` 两条配置,
  args 增加各自的开关(AtomCode 用 `-v`;CodeBuddy 用
  `--output-format stream-json`,若与现有 `-p` 冲突则以实跑为准)。
- ⚠️ **改 args 前必须先实跑一次确认格式**,不要照抄本 spec 的样例 ——
  样例来自 2026-08-26 的版本,CLI 会变。

### R2:按执行器解析成"动作行"

统一渲染为三类,**只保留动作,丢掉参数体**:

```
[工具] read_file  file_path=specs/foo.md
[命令] git status --short                    exit 0
[命令] curl -sS http://localhost:3001/...    exit 5
[汇报] Dispatch succeeded: child task 01a03d88 is running under AtomCode
```

- **codex**:遍历 JSONL,只取 `type == "item.completed"`,按
  `item.item_type` 分三类 —— `mcp_tool_call` 取 `tool`/`status`/`error`,
  `command_execution` 取 `command`/`exit_code`,`agent_message` 取 `text`。
  ⚠️ **不要渲染 `arguments` 和 `result` 的全文**,那正是 65% 噪音的来源;
  需要时只取参数的键名或前 N 字符。
- **atomcode**:按 `[tool→ ` / `[tool← ` / `[done] ` 行前缀解析。
- 实测压缩比:codex 那条任务 **262143 字节 → 4909 字节(1.9%)**,54 条可读事件。

### R3:解析不出来的行原样保留

任何一行解析失败(不是合法 JSON、前缀不认识、格式变了),
**原样进缓冲,不丢弃**。排查问题时那些行恰恰最要紧。
⚠️ 这条是硬要求:宁可多显示,不可静默吞掉。

### R4:chunk 边界补换行

`appendTaskOutput` 追加时,若 `prev` 不以换行结尾且 `chunk` 不以换行开头,
补一个 `\n`。治 AtomCode 的粘连,顺带让 `OUTPUT_TAIL_MAX_LINES` 真的开始工作。

## 不做的

- **不过滤旁白**。三家输出格式各不相同,靠关键词猜哪句是废话,
  规则会一直漏、一直误杀,最后变成没人敢动的黑盒。R2 是**按结构挑出动作**,
  不是**按内容剔除废话** —— 两者不要混。
- **不改折叠/展开逻辑**,不改 `LiveOutput` 的 `max-h-96`。
  本票只改进入缓冲的内容,不改容器。
- **不碰 token 采集**。`-v` 的 `[tokens]` 行虽然含 token,
  但采集口径是另一张票的事,本票只把它当普通动作行显示。

## 验收

- [ ] AtomCode 任务运行中,实时输出出现 `[tool→ ` 行,能看到工具名与参数
- [ ] Codex 协调任务运行中,实时输出出现命令行与 `exit` 码,
      **且不含 `\\\\\\\"brief\\\\\\\"` 这类多层转义的任务书回显**
- [ ] 同一条 codex 协调任务,缓冲字节数比改动前下降一个数量级以上
      (基线:`01a03d87` = 262143 字节,顶死上限)
- [ ] 构造一行故意不合法的输出,该行**原样出现**在实时输出里(R3,必测)
- [ ] AtomCode 输出不再出现多句粘成一段(R4)
- [ ] ⚠️ 反向断言:`OUTPUT_TAIL_MAX_LINES` 截断在真实 AtomCode 输出上
      **确实生效**(改动前它形同虚设,是本票的隐含回归点)

## 附:本票范围外但已查实,另行立票

1. **协调者派完仍在轮询空转**。同一条 `01a03d87` 里 `sleep` 出现 19 次、
   累计 590 秒 ≈ 9.8 分钟,`coagenthub_get_task` 轮询 20 次。
   `coordinator-exits-after-dispatch`(冻结 `0a38e59e`,已 Landed `3645c741`)
   判过通过,但**行为还在** —— 当时 L3 只验了文本改动,没验运行时行为。
   ⚠️ 这是检视者的口径疏漏,与实现无关。
2. **codex token 数据根本不存在**。`~/.codex/sessions/2026/08/26/` 今天只有
   一个文件,`session_meta.originator = "Codex Desktop"`,而平台今天跑了
   十来条 codex 任务 —— `--ephemeral` 不落 rollout,stdout 又不发
   `token_count`。所以 `codex-token-collection-never-matches` 的根因**不是**
   解析器写错了类型名或嵌套,是数据两头都没有。修法应是去掉 `--ephemeral`
   或给每个任务单独设 `CODEX_HOME`,而不是改解析。
