# Spec: 去重命中后不重新确认,事件永远收敛不到 delivered

> **状态**: Landed — L3 通过(2026-09-07),实现 `508ed1ec`;L3 两条 P3 观察见群内
> `review_result`(去重分支与 Step 1 的 claim 近似重复;`processEvent` 返回值语义
> 跨分支不一致,后者根因是本 spec §3 R3 只重定义了去重分支,要统一需 `spec_amended`)。
> **版本**: 1.0
> **日期**: 2026-09-07
> **来源**: [docs/implementation-optimization-review-2026-09-07.md](../docs/implementation-optimization-review-2026-09-07.md) R1
> **上游**: [callback-agent-command-driver.md](callback-agent-command-driver.md)(Landed)——本票修改其
> 「crash safety」段落描述的去重命中路径语义,不改命令驱动本身。

## 1. 背景与目标

### 1.1 现状证据

[`callback-agent.ts`](../packages/callback-agent/src/callback-agent.ts) 的 `processEvent()`
第 128–135 行:

```ts
if (this.dedupe.isDelivered(eventId)) {
  this.logger.info?.(`event ${eventId} already in dedupe store; acking only`);
  // Best-effort re-ack (idempotent if we still hold a valid lease token)
  return true; // event was seen, even if just for dedupe check
}
```

日志写「acking only」、注释写「Best-effort re-ack」,**但这一支里没有任何
`claimEvent` / `ackEvent` 调用**。类头注释第 37–38 行声称的
"the next run sees eventId in the dedupe store and only re-acks" 同样与实现不符。

2026-09-07 隔离验证(直接转译该分支、替换外部依赖):命中该分支时
`claimEvent` 与 `ackEvent` 调用次数**均为 0**,函数返回 `true`。

### 1.2 危害

`processEvent` 的成功路径是「执行命令 → 写 dedupe → ack」(第 188–197 行)。
**dedupe 已写、ack 失败**(网络中断 / 服务端 5xx / 进程被杀)时:

- 服务端该 event 仍是 `leased`(或 lease 过期后回到可认领);
- 下一轮 `listEvents` 会再次列出它(lease 过期即可认领,见
  `task-completion-events.ts` 列举条件);
- 但本地 dedupe 已有 eventId → 每一轮都命中上面那一支直接返回,
  **既不 claim 也不 ack,也不 fail**。

结果:该事件**永远到不了 `delivered`**,`attempts` 也不再增长(fail 没被调用,
因此走不到 `dead`)。它会被无限重扫,而宿主侧的副作用其实早就完成了。
`runOnce()` 的返回计数还把它算作「已处理」,日志显示一切正常。

### 1.3 目标

去重命中路径必须**把事件推进到 `delivered`**,同时保证**宿主命令只执行一次**;
处理计数与日志必须反映本轮实际发生的事,不得在没有 ack 时声称「acking only」。

## 2. 改动范围

| 文件 | 改什么 |
|---|---|
| `packages/callback-agent/src/callback-agent.ts` | `processEvent()` 去重命中分支;必要时调整该分支的返回值语义与日志 |
| `packages/callback-agent/test/callback-agent.test.ts` | 新增定向用例(见 §4) |

**不改**:服务端 `task-completion-events.ts` 任何端点;`DedupeStore` 的文件格式与
落盘时机;`executeDriver` / `ackWithRetry` / `fail` 的既有语义;轮询循环结构。

## 3. 详细改动

### R1. 去重命中 → 重新认领 → ack,不执行命令

`this.dedupe.isDelivered(eventId)` 为真时:

1. 调用 `this.client.claimEvent(eventId, this.config.consumerId, this.config.leaseMs)`
   重新领取一个**有效 lease**(旧 leaseToken 可能已随进程死亡丢失,不得复用
   内存里的旧 token,也不得凭空构造)。
2. claim 成功 → 用**新的** `leaseToken` 调 ack(复用既有 `ackWithRetry`)。
3. **任何情况下都不得调用 `executeDriver`**——命令的幂等性由宿主按 eventId 负责,
   但本路径的前提就是「命令已成功执行过」,再跑一次是回归。

### R2. claim 失败的处置

`claimEvent` 抛错时(服务端对不可认领事件返回 409,文案见
`task-completion-events.ts`:`event is not claimable (already leased, delivered, or not found)`):

- **不执行命令、不 ack、不 fail**;
- 记一条 warn 级日志,写明 eventId 与失败原因原文;
- 本轮跳过,交给下一轮轮询重试。

409 的三种成因(已 delivered / 被他人持有有效 lease / 不存在)在 API 层不可区分,
**本票不要求区分**:三者的正确动作相同,都是跳过。已 `delivered` 的事件本来
就不会再出现在 inbox 列举里(列举条件只含 pending 与过期 leased),因此该分支
不会持续刷屏。

### R3. 处理计数与日志必须反映实际结果

`processEvent()` 的返回值定义(**本票只重新定义去重命中分支,其余分支行为逐字不变**):

| 去重命中分支的情形 | 返回 | 日志 |
|---|---|---|
| 重新 claim 成功且 ack 成功 | `true` | info:说明是「去重命中后补 ack」,已确认 |
| claim 失败 / ack 重试全部失败 | `false` | warn:写明 eventId 与原因 |

不得在没有实际 ack 的情况下输出「acking only」这类暗示已确认的措辞。

## 4. 验收标准

以下每条都必须**读最终产物**(fake API 上该 event 的 `state`、`callCounts`、
命令驱动的实际执行次数),**不得只断言 `processEvent` 的返回值或 `isDelivered()`
返回真**——那正是本次缺陷躲过既有用例的原因。

`packages/callback-agent/test/fake-api.ts` 已内建 `state` 与
`callCounts = { list, claim, ack, fail }`,直接复用,不要新造替身。

1. **首次 ack 失败 + 消费者重启 → 最终 delivered**
   构造:第一轮命令成功、dedupe 已写、ack 全部重试失败(fake API 让 ack 返回 5xx);
   随后恢复 ack 正常并再跑一轮 `runOnce()`。
   断言:该 event 在 fake API 上的最终 `state === "delivered"`;
   `callCounts.claim` 在第二轮 **+1**;`callCounts.ack` 在第二轮 **≥1**。

2. **命令只执行一次**
   同一场景下,断言命令驱动的实际执行次数在两轮结束后仍为 **1**
   (用 `fake-executable.ts` 或等价的可计数替身,断言执行痕迹,不是断言未被调用的
   内部方法)。

3. **claim 返回 409 → 跳过且不产生副作用**
   构造:dedupe 已写,fake API 对该 event 的 claim 返回 409。
   断言:命令执行次数为 **0**;`callCounts.ack === 0`;`callCounts.fail === 0`;
   `runOnce()` 的返回计数**不把它计入已处理**;日志有 warn 记录。

4. **既有用例不回退**
   ```
   cd packages/callback-agent && npx vitest run
   ```
   全绿。其中原有「dedupe 命中时跳过命令执行」这类用例若断言的是
   「claim 未被调用」,属于锁定旧行为,按本 spec 更新为新契约并在汇报中逐条列出
   改了哪几条、为什么(见 AGENTS.md「加强测试本身可能把『没做』固化成『通过』」)。

5. **类型检查**
   ```
   cd packages/callback-agent && npx tsc --noEmit -p tsconfig.json
   ```
   (若该包的 check-types 脚本口径不同,以 `package.json` 里的脚本为准并在汇报中写明。)

## 5. 不涉及的改动

- **不改服务端**:R2(`fail` 的原子 lease 校验)是独立一票
  [completion-event-fail-atomic-lease-guard.md](completion-event-fail-atomic-lease-guard.md),
  不要在本票里顺手改 `task-completion-events.ts`。
- **不做 lease 续租**:长命令的续租属于报告 R9,本票不涉及。
- **不改 dedupe 落盘路径**:`/tmp/callback-agent-dedupe.jsonl` 的 Windows 兼容性
  属于报告 R10,本票不涉及。
- **不宣称第三方副作用 exactly-once**:本票只保证「本 agent 不重复执行命令」,
  宿主命令自身的幂等仍按 eventId 由宿主负责。

## 6. 兼容性

- 服务端 API 无改动,旧 server 与新 agent 可混跑。
- dedupe 文件格式不变,升级后旧文件继续可读:里面已有的 eventId 在下一轮会
  触发一次「补 ack」,这正是本票要的收敛行为。
- 行为变更点(需在汇报中写明):去重命中分支现在会产生一次 claim + 一次 ack 的
  网络调用,`runOnce()` 的返回计数在该分支的口径随之改变。
