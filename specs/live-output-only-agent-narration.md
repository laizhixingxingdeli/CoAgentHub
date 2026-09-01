# Spec: 实时输出只显示 agent 汇报,持久化口径不变

> **状态**: Draft — R4 范围待用户裁定后冻结
> **版本**: 1.1
> **日期**: 2026-09-02
> **相关**: [live-output-hide-thinking-and-autoscroll.md](live-output-hide-thinking-and-autoscroll.md)
> **相关**: [two-tier-output-summary-and-detail.md](two-tier-output-summary-and-detail.md)

## 背景

`live-output-hide-thinking-and-autoscroll` 把 thinking 挡在摘要流外,动作行
(`[工具]`/`[命令]`/`[汇报]`/`[错误]`)保留。实跑下来用户的诉求更进一步:
**界面上只要看到 agent 自己的汇报正文**,工具/命令/错误行属于排障材料,
不该占据时间线。

同时,出问题后的分析依赖持久化记录,**持久化口径本次不变**。

### 实证:codebuddy 界面流 88% 是未处理的信封行

真实样本 `.scratch/probe/samples/codebuddy-run.jsonl`(2026-09-02 实跑):

```
条目 10 条 | raw 兜底 3 条 | 摘要流 3365 字节 / stdout 10655 字节
```

raw 兜底的 3 行合计 **2977 字节,占摘要流的 88%**,全部是 JSON 信封:

| 行形状 | 为何落 raw |
|---|---|
| `{"type":"system","subtype":"init",…}` | `subtype != task_started` → `renderCodeBuddyLine` system 分支逐字保留;单行约 2.6KB(tools + slash_commands 全表) |
| `{"type":"system","subtype":"status",…}` | 同上 |
| `{"type":"file-history-snapshot",…}` | **未知顶层 type** → default 分支逐字保留 |

⚠️ 这三个形状此前从未被任何 spec 记录过。R1 一旦生效它们自然不再进界面,
但**它们仍会进持久化**(R3),排障时可见 —— 这正是本 spec 分层的意义。

⚠️ 已提出的反对意见与决策:检视者指出只留汇报会失去「动作证据」
(agent 声称跑了测试时无法证伪,`outputTail` 是 L2/L3 的审计材料)。
用户在了解该代价后确认按本 spec 执行。该权衡已记录,不在本票内重开。

## 现状约束(实证)

### C1:界面与持久化目前是同一个字符串

`queue.ts:1684-1688`(以及 flush 分支 `1853-1857`):

```ts
const summaryText = summaryStreamText(entries);
if (summaryText.length > 0) {
  appendTaskOutput(taskId, summaryText);              // → 环形缓冲 → outputTail → DB
  void wsHub.broadcastTaskOutput(groupId, taskId, summaryText);  // → 界面
}
```

同一个 `summaryText` 同时喂给持久化与界面。**「界面变少、DB 不变」必须在此分叉**。

### C2:界面出口有两个

- `wsHub.broadcastTaskOutput`(实时推送)
- `includeOutput` 拉取(断线重连 / 首次进入读环形缓冲)

**两个都过滤**,否则刷新页面即回到全量,前后不一致。

### C3:AtomCode 的 stdout / stderr 是干净两分,但 runner 把它们合并了

真实样本 `.scratch/probe/samples/atomcode-run.{stdout,stderr}`(2026-09-02 实跑):

| 流 | 字节 | 内容 |
|---|---|---|
| stdout | 28 | 4 个空行 + `` `a.txt` 共有 2 行。`` —— **纯最终答案** |
| stderr | 1811 | `[headless]` / `[thinking]`×7 / `[tokens]`×2 / `[tool→]` / `[tool←]` / `[done]` |

**现状是反的**:界面显示 `[headless]` / `[tool→ bash]` / `[tool← ok]` / `[done]` 四行,
而唯一的答案行**被吞掉** —— 它来自 stdout、首字符是反引号,
`isBareNarrativeLine`(`output-parser.ts:490`)判为裸叙述 → `kind=thinking` → 摘要抑制。

```
条目 24 条 | raw 兜底 11 条 | 被抑制 20 条 | 摘要流 213 字节 / 原始 1839 字节
```

⚠️ 根因是 `executor-runner.ts:116-125` 把 stdout 与 stderr **合并**喂进同一个
`onOutput(chunk)`,来源信息在进解析器前就丢了,解析器只能靠首字符猜 —— 并猜错。

### C4:`agent_message` 是 codex 的字段名,跨执行器的等价物是 `kind === "report"`

各执行器解析器产出的 kind:

| 执行器 | 产出的 kind |
|---|---|
| codex | report / command / tool / error |
| codebuddy | report / tool / result / thinking / command / error |
| atomcode(executor) | **thinking / tool / result / raw —— 无 report** |

**AtomCode 的裸叙述行被判为 thinking**(`output-parser.ts:490` `isBareNarrativeLine`
→ 走 thinking 抑制通道)。若不处理,本 spec 会让 **AtomCode 的实时输出全空**。

### C5:协调者任务的 outputTail 从不落库(detached 路径缺回填)

**协调者不是独立执行器类型** —— 它是群内带 `coordinator` 角色的 participant
(`queue.ts:401` `isCoordinatorTask` 只查 `group_members.roles`),跑的仍是
codex / codebuddy / atomcode 之一。因此 **R1 的判据表对协调者同样适用**,
实时输出流照常产生。

但持久化是断的:

- 协调者任务一律 detached(`queue.ts:1519` `detached = detachedByReplyMode || isCoordinator`);
- detached CLI 路径(`queue.ts:1753`)spawn 后立即 return,**不走 done 分支**,
  终态由协调者自己 PATCH 回写;
- `diffSummary.outputTail` 全仓库仅三个写入点 —— done 分支(`2127`)、
  `failTask`(`2507`)、`orphan-task-reconciler.ts:141`。**PATCH 结案路由无回填。**

⇒ **协调者任务正常结案时,outputTail 从未落库。** 输出只活在内存环形缓冲,
任务结束即消失。读取侧 `routes/group/tasks.ts:977` 是
`buffered ?? backfilled ?? undefined`,协调者完成后两者皆空 → 界面与 DB 都是 null。

⚠️ 这使 R3(「持久化口径不变」)对协调者失去意义:不变 = 继续什么都不存。

## 要做的

### R1 界面只渲染「正常用户在交互式 CLI 里看到的文字」

判据由用户给出:**执行器在交互式 CLI 中显示给人看的正文**。落到各执行器:

| 执行器 | 界面保留 | 三份真实样本实测 |
|---|---|---|
| codex | `item.completed` 且 `item.type == "agent_message"` → `item.text`(**全部,含中途旁白**) | 2 条 |
| codebuddy | `assistant` 消息的 `text` 块;`result.result` 与末条 `text` 逐字相同,由既有 R5 折叠去重 | 1 条 |
| atomcode | **stdout** 的正文(见 C3 / R2) | 1 条(现被吞) |

内部统一为 `kind === "report"`。其余类别(tool / command / result / thinking /
error / raw)不进界面。

⚠️ **中途旁白必须保留**,不是只留最后一条:只留终稿会让运行中的任务界面全空,
实时输出不再实时。

**`error` 不进界面,但全量进数据库 —— 用户已明确确认(2026-09-02)。**
曾有歧义:用户先说「只需要看到 agent_message」(排除 error),后说「正常用户能在
CLI 上看到的文字」(真实 codex CLI 会显示 `Reconnecting... 2/5`,该读法包含 error)。
**已裁定取前者:error 不进界面,进数据库。** 此点不再重开。

错误仍全量进持久化与明细,只是不占时间线 —— 既有「错误永不折叠」规则约束的是
「错误不得被静默丢弃」,本 spec 不推翻它。实现时须在 `summaryStreamText` 注释中记下,
避免后人误读。

### R2 `onOutput` 携带来源,AtomCode 按来源判 `report`

**R2.1** `executor-runner.ts` 的 `onOutput` 签名加来源参数
(`onOutput?(chunk: string, source: "stdout" | "stderr")`),
两处 `on("data")` 分别传入。其余执行器忽略该参数,行为逐字不变。

**R2.2** AtomCode 解析器:来自 **stdout** 的非空行判为 `report`(进界面);
来自 stderr 的行维持现有判定逐字不变(`[thinking]` / `[tokens]` 抑制、
`[tool→` / `[tool←` 为 tool/result、`[done]` / `[headless]` 为 raw)。

⚠️ 为什么不用「首字符非 `[` 非 `{`」这个结构判据:它现在就在生产里,
而且**正是它把答案吞掉的**。来源是执行器免费给出的事实,猜它本身就是缺陷来源。

⚠️ 样本量:stdout 纯答案、stderr 全带前缀 —— 这个两分目前只有**一份**样本支撑。
实现时须再取 2 份不同任务形态的 atomcode 样本确认(尤其是**任务失败**与
**多轮工具调用**两种),若发现 stdout 也会出现非答案内容,R2.2 需回到结构判据。

### R3 持久化口径逐字不变

- `appendTaskOutput` 继续接收**未经 R1 过滤**的全量摘要流;
- `outputTail`(500 行)、明细 JSONL、`diffSummary` 各字段口径不变;
- `appendTaskDetail` 对未过滤的 entries 逐条落盘,不变。

**验收:改动前后 `diffSummary.outputTail` 对同一份 stdout 逐字节相同。**

### R4 detached 任务结案时回填 outputTail

PATCH 结案路径(协调者自己回写终态)与 done 分支同口径回填
`diffSummary.outputTail`(最近 500 行,取自内存缓冲),回填后再
`releaseTaskOutput`。顺序不可颠倒(与 `queue.ts:2864` 既有注释同一教训)。

⚠️ **范围待定** —— 本条是 C5 暴露的独立缺陷,不是 R1/R2/R3 的必要组成。
若判定超出本票范围,应拆为独立票,但**必须与本票同批落地**:
否则 R1 生效后协调者界面变成一行、DB 仍是 null,
协调者的输出将同时在两处消失。

## 硬验收

以 `.scratch/probe/samples/` 下的真实样本为准(不是构造数据):

1. **codex 错误样本**(`codex-error-run.jsonl`,含 4 条 Reconnecting + 1 条传输降级
   + 1 条 exit 1 的失败命令):界面输出**恰好 2 行**(中途旁白 + 终稿,两条都要)——
   `[汇报] 我先读取 a.txt 并统计其行数。` 与
   `[汇报] 当前目录下未找到 a.txt,因此无法统计行数。`
2. **同一样本**的 `outputTail` 与改动前逐字节相同(8 行,含全部错误与命令行)。
3. **codebuddy 样本**(`codebuddy-run.jsonl`):界面输出**恰好 1 行**——
   `[汇报] a.txt 共 2 行内容（hello、world，文件以换行结尾）。`
   且 `outputTail` 与改动前逐字节相同(含那 3 行共 2977 字节的信封)。
4. **AtomCode 样本**(`atomcode-run.stdout` + `atomcode-run.stderr`):
   界面输出**恰好 1 行**—— `` `a.txt` 共有 2 行。``
   且 `outputTail` 仍含全部 24 条(含 `[tool→ bash]` / `[done]` / 11 条 raw)。
5. 前端刷新页面(走 `includeOutput` 路径)后显示内容与 WS 推送期间**一致**。

## 不涉及

- 不改解析器对各类别的判定(除 R2 一处)。
- 不改明细存储、不改 `parseTaskReport`、不改 token 账目。
- 不改 `/tmp` 明细保留期与落盘位置(独立议题)。
- 不合并 error 同源折叠(独立票)。
- 不修 codex `extractCodexExecText` 提取器未命中(独立票,现正在丢用户可见内容)。
