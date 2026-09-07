# Spec: completion event 的 fail 不校验 lease,旧消费者能改写新租约与已确认状态

> **状态**: Landed — L3 通过(2026-09-07),实现 `499e7494`(CodeBuddy 实现,
> 检视者直接完成 L2/L3 与提交:平台侧该轮在跑已作废的全量回归,按用户决策止损)。
> L3 一条 P3 观察:`dead` 行仍写 `nextAttemptAt`(§3 R2 允许实现自选但要求说明,
> 执行器被中途停止未出具汇报);无害 —— inbox 列举按 state 过滤,dead 不会因此复活。
> **版本**: 1.1
> **日期**: 2026-09-07
>
> **v1.1 修订(2026-09-07)**:§4.7 由「全量后端回归」改为「只跑改动触及的测试文件」。
> 理由:用户决策——本机全量后端回归实测 24 分钟,R2 首轮 1 小时 42 分里有 24 分钟
> 耗在这一条上,而它对本票的缺陷没有增量信息。**本修订适用于在途的 R2 任务**
> (检视者显式豁免验收钉子,理由记录在此)。
> **来源**: [docs/implementation-optimization-review-2026-09-07.md](../docs/implementation-optimization-review-2026-09-07.md) R2
> **上游**: [durable-task-completion-events.md](durable-task-completion-events.md)(Landed)——本票收紧其
> lease/ack/fail 的并发契约,不改事件的产生方式与信封形状。

## 1. 背景与目标

### 1.1 现状证据

[`task-completion-events.ts`](../packages/backend/server/src/routes/participant/task-completion-events.ts)
的 fail 端点(第 320–376 行)分三步:

```ts
const event = await db.query.taskCompletionEvent.findFirst({ ... });   // 读
if (!event || event.leaseToken !== leaseToken) throw Conflict;          // 校验(读时快照)
const isDead = event.attempts + 1 >= DEFAULT_MAX_ATTEMPTS;              // 用读时 attempts 算状态
await db.update(...)
  .set({ state: isDead ? "dead" : "pending", attempts: sql`attempts + 1`, ... })
  .where(eq(taskCompletionEventTable.id, eventId))                      // 写:只按 eventId
  .returning();
```

三处缺口,均可由源码直接确认:

- **W1 最终 UPDATE 的 WHERE 只有 `id = eventId`**——`recipientParticipantId`、
  `leaseToken`、允许的 `state` 都不在条件里。读与写之间没有任何原子性保证。
- **W2 `state` 与 `attempts` 出自两个不同的行版本**——`isDead` 用读时快照算,
  `attempts` 用 SQL 原子自增写。并发 fail 时 `returning` 的 attempts 是真实新值,
  而 `state` 可能是按旧值算出来的,两者可以不自洽。
- **W3 ack 不清空 `leaseToken`**(第 269–283 行只写 `state`/`deliveredAt`/`updatedAt`)。
  于是同一个 token 在 ack 之后仍然「有效」。

### 1.2 危害

| # | 交错 | 后果 |
|---|---|---|
| 1 | 消费者 A 持 lease → lease 过期 → 消费者 B 重新 claim(新 token)→ A 迟到的 fail 到达 | A 的读校验用的是**自己那次 claim 时的 token**吗?不是——它读的是**当前行**,当前行的 token 已是 B 的,校验会拒。但一旦读与写之间 B 完成 claim(读到旧行、写时行已变),W1 让 UPDATE 照样命中:**B 的新 lease 被清成 null,state 被打回 pending**,B 正在处理的事件被别人抢先重置 |
| 2 | 消费者 ack 成功(state=delivered,token 未清)→ 同一个消费者的另一条路径或重放的迟到请求带**同一个 token** 调 fail | W3 让 token 校验通过,W1 让 UPDATE 命中 → **已确认的事件被改回 pending**,宿主命令会被重投一次 |
| 3 | 两个并发 fail | attempts 正确 +2,但两次算出的 `state` 都基于各自读到的旧值 → 可能出现 `attempts=10` 而 `state=pending`(该 dead 未 dead),或反之 |

第 2 种是**可靠性回退**:平台的可靠性承诺是「ack 之后不再重投」,这条路让它不成立。

### 1.3 目标

fail 的状态推进必须是**一次原子更新**:更新条件包含 eventId、收件人、leaseToken
与允许的 state;新状态基于**更新时刻**的 attempts 计算。过期 lease、重复 fail、
ack/fail 并发三种情形有明确且被测试锁定的响应契约。

## 2. 改动范围

| 文件 | 改什么 |
|---|---|
| `packages/backend/server/src/routes/participant/task-completion-events.ts` | fail 端点改为单条原子 UPDATE(R1/R2);ack 端点补 state 守卫(R4);0 行命中时的 409 分类(R3) |
| `packages/backend/server/test/task-completion-events.test.ts` | 新增交错用例(见 §4) |
| `docs/architecture.md` | §4 API 全貌表中 fail / ack 两行的说明同步(R5) |

**不改**:表结构与迁移(本票**没有** schema 变更,不要新建 `.sql`);claim 端点
(它已经是单条原子 UPDATE,是本票的正确样板);inbox 列举条件;信封
(`buildEnvelope`)形状;`DEFAULT_MAX_ATTEMPTS = 10` 与
`DEFAULT_RETRY_AFTER_MS = 60_000` 的取值。

## 3. 详细改动

### R1. fail 用单条原子 UPDATE,WHERE 覆盖四项条件

去掉「先 `findFirst` 读、再校验、再无条件写」的三步结构,改为一条 UPDATE,
WHERE 至少包含:

- `id = eventId`
- `recipientParticipantId = participantId`(与路径 participant 一致)
- `leaseToken = <请求携带的 token>`
- `state = 'leased'`——**这是修掉危害 2 的关键**:`delivered` / `dead` / `pending`
  的行不接受 fail

命中 0 行 = 本次 fail 不生效,**不得有任何写入**。

### R2. 新状态基于更新时刻的 attempts 计算

`state` 必须与 `attempts` 出自同一个行版本。在同一条 UPDATE 内用 SQL 表达式
计算,例如:

```
attempts = attempts + 1,
state    = CASE WHEN attempts + 1 >= <MAX_ATTEMPTS> THEN 'dead' ELSE 'pending' END
```

(具体写法由实现决定,要求是:**`returning` 出来的 `attempts` 与 `state` 必须自洽**
——`attempts >= 10` 必然 `dead`,`attempts < 10` 必然 `pending`。)

`dead` 行是否还要写 `nextAttemptAt` 由实现决定,但必须在汇报中说明选择,
且不得因此让 dead 事件重新出现在 inbox 列举里。

### R3. 0 行命中时的响应契约

命中 0 行后,做一次**只读**查询把原因分类,返回 **409**,并给出能区分成因的
错误信息(消费者是 LLM 或脚本,错误信息就是它的修复指引):

| 分类 | 判据 | 契约 |
|---|---|---|
| 事件不存在 / 不属于本收件人 | 按 (id, recipient) 查不到 | 409,文案指出事件不存在或不属于该收件人 |
| 已 delivered | 行存在且 `state='delivered'` | 409,文案指出事件已确认,fail 不再生效 |
| 已 dead | 行存在且 `state='dead'` | 409,文案指出事件已进入 dead |
| lease 过期/被他人重新认领/重复 fail | 其余(token 不匹配或 state 非 leased) | 409,文案指出 leaseToken 无效或租约已失效 |

**重复 fail 明确不是幂等成功**:第一次 fail 已把 `leaseToken` 清空,第二次必然
落到最后一行,返回 409。`attempts` 因此**只 +1**。

**ack 与 fail 并发**:先到者赢。fail 先到 → 后到的 ack 因 token 已清空返回 409
(既有文案 `leaseToken mismatch or event not found` 保持不变);ack 先到 →
后到的 fail 因 state 已是 `delivered` 返回 409。**任一顺序下都不得出现
`delivered → pending` 的回退。**

### R4. ack 补 state 守卫,保留同 token 幂等

ack 的 WHERE 增加 `state IN ('leased','delivered')`:

- 保留既有的「相同 token 重复 ack 幂等」(delivered 行仍可再 ack 成功);
- 但 `pending` / `dead` 行不再能被一个残留 token 直接改成 delivered。

ack 是否顺带清空 `leaseToken` 由实现决定;**若清空,必须同时保证重复 ack 的幂等
契约不破**(否则第二次 ack 会变成 409,那是行为回退)。汇报中说明选择与理由。

### R5. 文档同步

`docs/architecture.md` §4 的 fail / ack 两行说明必须与新契约一致:写明 fail 要求
`state=leased` + token 匹配、0 行命中返回 409 及其分类、重复 fail 不幂等。
不改这两行以外的 API 表内容。

## 4. 验收标准

每条都必须**读数据库最终记录**(或读端点响应体中来自 `returning` 的字段),
**不得只断言 HTTP 状态码**,也不得只断言被测函数返回值。

后端定向测试命令(仓库约定,不要跑根 `pnpm test`):

```
cd packages/backend/server && npx vitest run test/task-completion-events.test.ts
```

1. **过期 lease 的旧消费者不能改写新 lease**
   构造:A claim(leaseMs 极短)→ 等待过期 → B claim 拿到新 token → A 用**旧 token**
   调 fail。
   断言:响应 409;数据库中该行 `state === 'leased'`、`leaseToken` 仍等于 **B 的 token**、
   `leaseExpiresAt` 未被清空、`attempts` 未增加。

2. **ack 之后的迟到 fail 不能把 delivered 打回 pending**
   构造:claim → ack(成功)→ 用**同一个 token** 调 fail。
   断言:响应 409;数据库中 `state === 'delivered'`、`deliveredAt` 非空、
   `attempts` 未增加。

3. **重复 fail 只计一次**
   构造:claim → fail → 用同一 token 再 fail。
   断言:第一次 200 且 `attempts === 1`;第二次 409;数据库中 `attempts === 1`、
   `state === 'pending'`。

4. **重试阈值与最终 attempts 一致**
   构造:反复 claim → fail 直到达到上限。
   断言:`attempts === 10` 的那一次响应与数据库中 `state === 'dead'`;
   `attempts === 9` 时仍为 `pending`;dead 之后该事件**不再出现在**
   `GET /api/participants/:id/task-completion-events` 的返回里。

5. **fail 的收件人隔离**
   构造:用另一个 participant 的身份(`X-Participant-Id`)对该事件调 fail。
   断言:403(既有身份校验路径,文案逐字不变);数据库该行**任何字段都未变化**。

6. **并发交错不产生不自洽状态**
   构造:同一 token 的两个 fail 请求并发发出(或用可控交错模拟)。
   断言:数据库最终 `attempts` 与 `state` 自洽(`attempts >= 10 ⇔ state='dead'`),
   且成功响应只有一个。

7. **相关面回归(v1.1 起不再跑全量)**
   只跑**本次改动触及的测试文件**,而不是整包全量:
   ```
   cd packages/backend/server && npx vitest run test/task-completion-events.test.ts test/task-completion-event-trigger.test.ts test/coordinator-resume.test.ts
   ```
   汇报中贴出改动前后同口径的通过/失败计数(本机 Windows 是红基线,口径是
   **失败数不增加**)。若改动过程中发现触及了上面清单之外的模块,把对应测试文件
   加进这条命令并在汇报里说明为什么加。

8. **类型检查**
   ```
   cd packages/backend/server && npx tsc --noEmit -p tsconfig.json
   ```
   (以 `package.json` 中 check-types 脚本的实际口径为准,不一致时照脚本跑并写明。)

9. **文档同步**
   `git diff docs/architecture.md` 能看到 §4 fail / ack 两行按 R5 更新。

## 5. 不涉及的改动

- **不改 claim 端点**:它已经是原子的,本票拿它当样板,不重写。
- **不动 schema**:本票没有迁移。若实现过程中认为必须加列或加索引,**停下来退回
  检视者**(闸二:那已不是本票范围内的修复)。
- **不改 inbox 列举条件与信封形状**:消费者可见的事件集合不变。
- **不改 callback-agent**:R1 那票
  [callback-agent-dedupe-hit-must-reack.md](callback-agent-dedupe-hit-must-reack.md)
  独立下发,不要在本票里一起改。
- **不做 lease 续租**:属于报告 R9。

## 6. 兼容性

- 无 schema 变更,无迁移,回滚只需回滚代码。
- **行为变更(需在汇报中写明)**:此前「delivered 行被同 token fail 改回 pending」
  与「过期 lease 的 fail 清掉新 lease」这两种行为会消失,改为 409。任何依赖这两种
  行为的消费者都是在依赖缺陷,不予兼容。
- 重复 fail 从「静默再计一次」变为 409;消费者若把 409 当作硬错误上报,属于预期,
  文案要能让它判断「无需重试」。
