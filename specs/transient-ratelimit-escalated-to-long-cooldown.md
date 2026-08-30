# Spec: 瞬时限流被升级为 5 小时冷却

> **状态**: Ready for Implementation
> **版本**: 1.0
> **日期**: 2026-08-31

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

## 6. 不涉及的改动

- 不做下发前配额预检(提案 P2-2,依赖本 spec 的 `quotaKind` 留痕,另立)。
- 不做 token 聚合(提案 P1-2,因口径不可加总而阻塞)。
- 不清洗历史记录。

## 7. 兼容性

- 配置缺省即新行为;删除两个配置键 → 回落 exhausted 语义(等价于现状)。
- `quotaKind` 是 `diffSummary` 附加键,不影响既有消费方。
- 无 schema 变更、无迁移。
