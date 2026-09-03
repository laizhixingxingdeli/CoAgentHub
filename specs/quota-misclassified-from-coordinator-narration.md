# Spec: 协调者转述子任务限流,被判成自己额度耗尽并停派 5 小时

> **状态**: Frozen — 2026-09-03
> **相关**: `scripts/dispatch-policy.json` 的 `rateLimit`;
> [quota-exhaustion-triggers-infinite-retry.md](quota-exhaustion-triggers-infinite-retry.md)

## 1. 现象

2026-09-03,codex(本群协调者)被标记
`available=false / 额度冷却至 2026/9/3 22:35:44`,新票一直 `queued` 不 spawn。

**codex 实际并未被限流。** 检视者当场直接跑了一次:

```
{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"ok"}}
{"type":"turn.completed","usage":{"input_tokens":18338,...}}
```

正常返回,无 429。

## 2. 根因:命中的关键词在协调者**自己的汇报正文**里

触发冷却的两条任务,末 20 行里命中的是这些句子:

| 任务 | 命中 | 出处 |
|---|---|---|
| `01a0660f` codex | `429` | 「原因:上次 AtomCode 因 HTTP 429 限流,无代码、测试或提交产出」 |
| `01a06661` codex | `quota` | 「the child task has `status=failed`, `quotaKind=exhausted`」 |
| `01a06663` codebuddy | `quota` `429` | `"status":429,"code":6000,"category":"quota"` + 真实重置时刻 —— **这条是真的** |

codex 那两条,**协调者是在如实汇报子任务的限流状态** —— 这正是 coordinator skill
要求它做的事。它因为「说了 429 这三个字符」而被判成自己额度耗尽。

### 防线为什么没挡住

`classifyQuotaFailure`(`state.ts:263`)已有自指排除
(`isDetectPatternsDefinitionLine` / `isTaskBookEcho`)与结构证据要求:

```ts
const hasEvidence =
  nonzeroExit ||
  extractRateLimitRecoveryMs(line) !== null ||
  PROVIDER_ERROR_LINE_SHAPES.some((re) => re.test(line));
```

**`nonzeroExit` 单独就够。** 协调进程被后端重启杀掉 → 非零退出 → 只要正文里任何
一行提到 429/quota,即成立。而自指排除只覆盖「回显任务书」,不覆盖
「协调者转述子任务的状态」。

### 这个误判会自我复制

AtomCode 真的 429 → 协调者汇报它 → 协调者被冷却 → 平台拉起续跑协调者 →
它汇报「上一轮因额度失败」→ **也被冷却**。本次两条 codex 冷却正是这条链。
真限流一次,可以传染掉整条协调链。

### 冷却时长也是编的

`01a0660f`:`reconciledAt 09:35:44 + 300 分钟 = 14:35:44`,正好是
`dispatch-policy.json` 的 `cooldownMinutes: 300` 固定值 —— 不是执行器说的。
而 codebuddy 那条用的是真实重置时刻(21:30:33),说明**能解析真时间的路径是通的**,
只是在没有真时间时直接落了 5 小时默认值,没有任何降级标记。

## 3. 危害

误判一次 = 该执行器停派 5 小时。协调者被误判 = **整个群停止派发 5 小时**,
而且平台不会报错,只是票静静躺在 `queued` 里。本次若非人工发现,会白等到 14:35。

## 4. 要做的

**R1 `nonzeroExit` 不再单独构成结构证据。**
`hasEvidence` 收窄为「提供方错误行形状」或「可解析出真实恢复时刻」二者之一。
非零退出码可作为**加权**,但不得单独把一行普通叙述升格为限流证据。

**R2 自指排除扩到「转述他人状态」。**
命中行若同时含有对**另一个任务/执行器**的指代(子任务 id、其它执行器名、
`quotaKind=` 这类平台自有字段名),判为转述,不算本执行器限流。
判据要用结构特征,不得用「像不像在转述」的语义猜测。

**R3 无真实恢复时刻时不得静默落默认值。**
落 `cooldownMinutes` 默认值时,必须在 `diffSummary` 标记
`cooldownSource: "fallback"`(`PersistedExecutorCooldown.source` 已有该字段,
但未贯通到落库与展示),并在 `/api/executors` 的 `unavailableReason` 里
明确区分「执行器告知的恢复时刻」与「平台估算」。

**R4 误判可撤销。** 提供一条清除某执行器当前冷却的途径(API 或脚本),
不需要人直接改数据库。本次清除是靠手改 `task.diff_summary`
再重启后端才生效的 —— 冷却存活在内存,由带
`diffSummary.executorCooldownEndMs` 的任务行重建(`cooldown-store.ts`)。

## 5. 硬验收

1. **真实场景回归**:构造一条协调者输出,末 20 行含
   「上次 AtomCode 因 HTTP 429 限流」且退出码非零 → **不得**判为额度失败。
2. **真限流不得漏判**:用 `01a06663` 那条 codebuddy 的真实输出
   (含 `"status":429,"category":"quota"` 与真实重置时刻)→ 仍判额度失败,
   且恢复时刻取真实值 21:30:33,不是 now+300min。
3. **传染链断开**:续跑协调任务汇报「上一轮因额度失败」→ 不得被冷却。
4. R3 的 `cooldownSource` 在 `/api/executors` 响应里可见,fallback 与 parsed 可区分。

⚠️ 验收 1 与 2 必须用**真实输出文本**,不得用构造的关键词串 ——
这个 bug 恰恰是「关键词匹配」造成的,再用关键词串验收会继承同一个盲区。

## 6. 不涉及

- 不改 `rateLimit.detectPatterns` 的关键词表(问题不在关键词,在证据判定)。
- 不改冷却时长默认值 300 分钟。
- 不改真限流时的处置(不重试、冷却、❌ 注明恢复时间)。
