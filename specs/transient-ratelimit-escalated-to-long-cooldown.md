# Spec: 瞬时限流被升级为 5 小时冷却

> **状态**: v1.0 Landed(实现 `41fcbcf7`);
> **v1.1 新增 R7,Ready for Implementation**
> **版本**: 1.1
> **日期**: 2026-08-31(v1.1)

## 1. 现象

执行器输出 `try again in 5 seconds` 这类**秒级自愈**的限流通知时,平台会把它
升级为 **300 分钟**冷却,健康执行器被无故关停 5 小时。

**因果链(已核实代码路径):**

```
[rate-limited] try again in 5 seconds
  ↓ parseRateLimitRecoveryMs(executors.ts:121) 支持 "try again in N seconds"
now + 5000
  ↓ normalizeCooldownEnd(queue.ts) : endMs <= now + MIN_EFFECTIVE_COOLDOWN_MS(60s)
now + getRateLimitCooldownMs()  = now + 300 分钟
```

### 1.1 这是 R7 引入的回归,不是历史缺陷

`quota-exhaustion-triggers-infinite-retry` v1.1 **R7**(2026-08-30 落地,
`02ca2a3d`)把守卫从 `Math.max(now + 1, endMs)` 改为「解析值 ≤ now+60s 则回退
固定冷却」。改动之前,同样这行只产生 **5 秒**冷却(基本无害);改动之后变成
**5 小时**。

R7 的推理错在:把「解析出的时刻太近」一律当作「解析不可靠」。但
`try again in 5 seconds` 是**准确的解析** —— 供应方真就是让你等 5 秒。
R7 混淆了两件事:

| | 含义 | 应对 |
|---|---|---|
| 解析结果**是垃圾**(时刻已过去 / 明显失真) | 无法据此定冷却 | 回退固定冷却(**R7 本意,保留**) |
| 解析结果**准确但时长很短** | 供应方要求短暂退避 | **短退避后重试,不是长冷却** |

⚠️ **危害尚未在生产中兑现。** 2026-08-30 记录到的 5 次误判走的都不是这条路径
(`[rate-limited] auto-continuing in 3s…` 不匹配 `try again in N seconds` 格式,
解析返回 null → 直接落固定冷却兜底)。本 spec 修的是**已核实的机制**,
**不得在票面或提交信息中写成已发生的事故**。

## 2. 决策:瞬时限流走 per-run 退避,**不进执行器级冷却**

### 2.1 为什么不能用 `enterCooldown` 做短冷却

`isInCooldown(ex)` 是**单一布尔**,不区分瞬时与耗尽。而 2026-08-30 落地的
`executor-availability-visibility-and-queued-child-pinning` **R2**(`0382c12b`)
新增了这条判据:

```ts
// coordinator-resume.ts: queued 子任务仅当其执行器可派发时才豁免父协调者
if (isInCooldown(ex)) return false;
```

于是「短冷却 + 任务回 queued」会触发:

```
transient 冷却进 executorCooldowns
  ↓ isQueuedChildExecutorDispatchable → false
  ↓ 排队子任务不再豁免已死的父协调者(协调者 detached、派完即退,pid 恒已消失)
  ↓ 孤儿收敛器 10 秒一轮 → 父协调者在 120 秒退避期内被判死
```

**一次例行的秒级退避会杀掉整条协调链。**

### 2.2 决策取向(已定,实现不得另选)

**瞬时限流使用 `QueuedRun` 上已有的 per-run 延迟重试机制,不写
`executorCooldowns`。**

`types.ts:150/156` 已有 `concurrencyBlocked` / `concurrencyRetryAt`,
`isRunDispatchable`(`queue.ts:282-285`)已在消费它们。

三个理由:

1. **不破坏 R2 豁免**:`isInCooldown` 保持只表示「额度耗尽」一个含义。
2. **语义更准**:瞬时限流是「这一次调用被限流」,执行器本身没坏;
   给整个执行器上冷却会连带封锁它接其他任务的能力。
3. **不新增判据**:复用既有字段与既有分支。⚠️ 2026-08-30 的 AV-A 曾因
   「在路由里重拼一份判定」被 L2 驳回 —— **两套判据正是本轮反复咬人的根因**。

⚠️ **明确不采纳**:让 `isInCooldown` 接受 kind 参数、或让 R2 判据跳过 transient
冷却。那会制造两处必须同步的判定,与上面第 3 条冲突。

## 3. 改动范围

- `packages/backend/server/src/lib/executor-task/state.ts`(分级判定)
- `packages/backend/server/src/lib/executor-task/queue.ts`(三处调用点分流 + per-run 退避)
- `packages/backend/server/src/lib/executor-task/types.ts`(verdict 类型)
- `scripts/dispatch-policy.json`(新增配置键)

## 4. 详细改动

### R1 — 判定结果分级

`classifyQuotaFailure` 的返回值增加 `kind: "transient" | "exhausted" | null`
(`isQuota` 为 false 时为 null)。**分级逻辑收敛在该函数内单点**,
调用方只读 `kind` 分流,不得自行判定。

| 分级 | 判据(命中行满足其一) |
|---|---|
| `exhausted` | `usage limit` / `window exhausted` / `quota exceeded` / `limit reached` / `额度` / `次数限制`;或恢复时刻为**绝对时刻**(`resets around HH:MM` / `try again at HH:MM`) |
| `transient` | 恢复时刻为**短相对时长**(`try again in N seconds/minutes`,N 小于阈值);或行内同时出现 `429` 与 retry/backoff 类动词且**无** exhausted 关键词 |

⚠️ **先判 exhausted,再判 transient** —— 同时命中时按 exhausted 处理(保守)。

### R2 — 分流处置

- `exhausted`:**现有路径逐字不变**(解析恢复时刻 → `normalizeCooldownEnd` →
  失败回传 ❌ + 预计恢复时间)。
- `transient`:
  - **不调 `enterCooldown`**;设置该 run 的 per-run 重试时刻
    (`now + transientBackoffSeconds`,缺省 120s);
  - 任务**不判 failed**,保持可重试语义;
  - **连续 transient 计数**达上限(缺省 3)→ 升级为 `exhausted` 处理,防退避死循环。

⚠️ queue.ts 三处调用点(执行超时 / 进程退出 / 成功尾部)**口径必须一致**。

### R3 — R7 的本意保留

解析所得时刻**已过去**(≤ now)→ 仍按 R7 回退固定冷却。
本 spec 只把「准确但短」从「垃圾解析」里分出来,**不撤销 R7**。

### R4 — 留痕

`diffSummary.quotaKind: "transient" | "exhausted"` 与既有 `quotaMatchedLine`
并列落库,事后可审计分级准确性。

### R5 — 配置

`scripts/dispatch-policy.json` 的 `rateLimit` 段新增:

```json
"transientBackoffSeconds": 120,
"transientEscalationLimit": 3
```

缺省值即上述值;**读不到配置时回落 exhausted 语义**(fail-safe:宁可长冷却
也不要无限退避)。

### R6 — 不涉及

- 不改 `parseRateLimitRecoveryMs` 的解析规则。
- 不改 `getRateLimitCooldownMs()` 取值(300 分钟)。
- 不改 `enterCooldown` / `clearPersistedExecutorCooldown`。
- 不改 R2 豁免判据(`isQueuedChildExecutorDispatchable`)—— 本 spec 的设计
  取向正是为了**不必**改它。
- 不改 R6(干净退出以有无产出为闸)。

## 5. 验收标准

1. `try again in 5 seconds` + 结构证据 → `kind: "transient"`;
   **`isInCooldown(ex)` 为 false**(未进执行器级冷却);该 run 的重试时刻
   ≈ now + transientBackoffSeconds。必测。
2. `usage limit reached, resets around 13:33` → `kind: "exhausted"`,
   冷却至 13:33,行为与现状**逐字一致**(回归)。必测。
3. **R2 交互回归(本 spec 的核心)**:构造「父协调者 pid 已消失 + 子任务因
   transient 退避而 queued」→ **父协调者仍被豁免,不被孤儿收敛判死**。
   ⚠️ 这条是本 spec 存在的直接理由,不得省略。
4. 同一 run 连续 3 次 transient → 第 3 次按 exhausted 处理(防死循环)。必测。
5. 解析所得时刻**已过去** → 仍回退固定冷却(R7 本意保留,回归)。必测。
6. 仅关键词命中、无结构证据(源码回显 quota 字样)→ `isQuota: false`(既有回归)。
7. 三处调用点分流口径一致(各有断言)。
8. 既有 quota 相关测试全绿。

## R7 — 分级必须按「距恢复还有多久」判,不得按措辞判(v1.1 新增)

R1 的判据表把分级挂在**英文措辞**上(`usage limit` / `try again in N seconds`
/ `resets around HH:MM`)。实现 `41fcbcf7` 逐字照做,L2 逐条对照全绿 ——
三方都没错,但**这张票在它最可能发生的形态上原封不动**。

### 实证(2026-08-31,拿真实输入实跑落地后的判据)

```
transient  | [rate-limited] try again in 5 seconds
exhausted  | usage limit reached, resets around 13:33
exhausted  | 429 您的使用量已超出频率限制,将在 2026-08-31 18:03:10 重置
exhausted  | 429 请求过于频繁,请稍后重试            ← 应为 transient
exhausted  | 429 触发限流,请 10 秒后重试            ← 应为 transient
transient  | 429 too many requests, retrying in a moment
exhausted  | 您的额度已用尽
```

群内三个执行器(AtomCode / CodeBuddy / Pi)的限流回显都是中文。
它们真正的**瞬时**限流全部落到兜底 `exhausted` → 吃 300 分钟冷却,
**正是本 spec 要修的那个病**。方向安全(fail-safe),但覆盖为零。

⚠️ 这是**本 spec 自己的账**,不是实现的账:R1 的判据表就是这么写的。
`quota-exhaustion-triggers-infinite-retry` R1 早写过「不要为每个 CLI 写一套正则」,
v1.0 违反的是同一条 —— 只不过它写的不是「一个 CLI 一套」,是「一种语言一套」。

### 根因:判据挂在措辞上,而事实是时长

真正决定 transient / exhausted 的事实只有一个:**距离恢复还有多久**。
措辞只是这个事实的一种表达,而表达随供应方和语言变。v1.0 把**表达**当成了
**事实**,于是每多一种表达就多一个盲区 —— 这是本轮反复出现的同一个形状。

### 要求

- **R7-a(必须):分级的主轴改为恢复时长,与语言无关。**
  从命中行提取恢复信息,只分三种结构,不分措辞:

  | 结构 | 例 | 分级 |
  |---|---|---|
  | **相对时长**(数字 + 时间单位) | `in 5 seconds` / `10 秒后` / `1 分钟后` | 时长 ≤ `TRANSIENT_RECOVERY_MAX_MS` → `transient`,否则 `exhausted` |
  | **绝对时刻**(时钟或日期时间) | `resets around 13:33` / `将在 2026-08-31 18:03:10 重置` | 距 now ≤ `TRANSIENT_RECOVERY_MAX_MS` → `transient`,否则 `exhausted` |
  | **无恢复信息** | `429 请求过于频繁` | 见 R7-b |

  时间单位至少覆盖:`s/sec/secs/second(s)/秒`、`m/min/mins/minute(s)/分/分钟`、
  `h/hr/hour(s)/小时`。⚠️ 这是**单位表**,不是措辞表 —— 它随语言增长,
  但不随供应方增长,且每一项都指向同一个可计算的量。

- **R7-b(必须):无恢复信息时,才回落到关键词。**
  耗尽关键词(`usage limit` / `quota exceeded` / `额度` / `用尽` / `次数限制` 等)
  命中 → `exhausted`;瞬时动词(`retry` / `backoff` / `重试` / `稍后` / `请求过于频繁`)
  命中且**无**耗尽关键词 → `transient`;都不命中 → `exhausted`(fail-safe,不变)。
  ⚠️ 关键词表**必须中英双语**,且**必须**在 spec 与实现里都标注为「兜底,非主轴」。

- **R7-c(必须):耗尽关键词仍先于时长判定。**
  `usage limit reached, resets around 13:33` 同时含耗尽关键词与绝对时刻 →
  仍判 `exhausted`(保守方向,v1.0 R1 的既有口径逐字保留)。

- ⚠️ **判定仍收敛在 `classifyQuotaFailure` 单点**,不得新增第二处。
- ⚠️ **不改** `TRANSIENT_RECOVERY_MAX_MS` 取值、不改 R2 的分流处置、
  不改 R3/R5/R6,不改 `handleTransientQuotaBackoff`。本条只换分级的判据。

### 验收标准(v1.1)

1. 中文瞬时形态 `429 请求过于频繁,请稍后重试` → `transient`。必测。
2. 中文相对时长 `429 触发限流,请 10 秒后重试` → `transient`;
   `请 10 分钟后重试` → `exhausted`。必测(同一结构、跨越阈值的两侧)。
3. 中文绝对时刻 `429 您的使用量已超出频率限制,将在 <明日某时> 重置` → `exhausted`。必测。
4. v1.0 的全部英文用例**逐字回归**:`try again in 5 seconds` → `transient`;
   `usage limit reached, resets around 13:33` → `exhausted`(R7-c);
   `429 too many requests, retrying in a moment` → `transient`。必测。
5. 无恢复信息、无任何关键词 → `exhausted`(fail-safe 回归)。必测。
6. 验收 1–5 必须以**表驱动**形式落成一张用例表,新增一种语言/单位时
   只加行不改判定逻辑 —— 这是本条能否防住下一次盲区的判据。


## 6. 不涉及的改动

- 不做下发前配额预检(提案 P2-2,依赖本 spec 的 `quotaKind` 留痕,另立)。
- 不做 token 聚合(提案 P1-2,因口径不可加总而阻塞)。
- 不清洗历史记录。

## 7. 兼容性

- 配置缺省即新行为;删除两个配置键 → 回落 exhausted 语义(等价于现状)。
- `quotaKind` 是 `diffSummary` 附加键,不影响既有消费方。
- 无 schema 变更、无迁移。

## 8. 修订记录

- **v1.1(2026-08-31)**:新增 R7。起因:v1.0 落地(`41fcbcf7`)后,拿真实输入
  实跑落地的判据,发现分级只认英文措辞 —— 群内三个中文执行器的瞬时限流
  全部落到兜底 `exhausted`,本 spec 要修的病在它最可能发生的形态上原封不动。
  这是 spec R1 判据表自身的缺陷,实现逐字照做无过,L2 对着验收标准也查不出
  (验收标准同样只写了英文用例)。R7 把分级主轴从**措辞**换成**恢复时长**。
