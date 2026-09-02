# Spec: 发现项驱动的票被硬钉成 `fix`,闸二失效、L3 被绕开

> **状态**: Landed — (2026-09-02 状态订正:DB 中该 specRef 有 7 个 done 任务为证;此前状态未随关票更新)
> **版本**: 1.0
> **日期**: 2026-08-31

## 1. 现象

检视者公布 `review_result` / `verdict: findings` 后,平台据此创建的协调者任务
**无条件**记为 `dispatchKind: "fix"`:

```ts
// routes/group/messages.ts:548
dispatchKind: findingsReviewResult ? "fix" : (dispatchKind ?? null),
```

三元的真分支不看任何输入 —— 检视者即使在同一次请求里**显式传
`dispatchKind: "requirement"`,也会被覆盖**。这条通道上发不出 `requirement` 票。

### 1.1 实证(2026-08-31,任务 `01a053cb-0cae`)

P1-1 的 L3 给出两条发现项,两条都**大到需要改 spec**,检视者按流程做了修订并冻结:

```
specs/transient-ratelimit-escalated-to-long-cooldown.md  v1.0 → v1.1(新增 R7)
specs/quota-failure-on-clean-exit.md                     v1.1 → v1.2(新增 R9)
```

协调者读懂了正文,给子任务 `01a053cc-b7c7` 用了**正确的新 specHash**
`88af9003…`。但父票 `01a053cb-0cae` 被平台钉为 `fix`,于是:

```
跑 L3 ⟺ reviewer+coordinator 在场 AND dispatchKind == requirement
```

**这轮改了 spec 的工作不会跑 L3。**

## 2. 根因:把「谁触发的」当成了「是什么性质的」

`fix` 与 `requirement` 的分界是**这次工作动没动冻结的 spec**:

| | 复用哪份 spec | 引入新架构面 | 该跑 L3 |
|---|---|---|---|
| `fix` | 已过 L3 的**同一份**冻结 spec | 否 | 否 |
| `requirement` | **新的或修订过的** spec | 是 | 是 |

`fix` 不跑 L3 的理由不是省事,是**它复用的那份 spec 当初冻结时已经过了 L3** ——
修复是在一份已被架构检视过的契约内部作业。一旦 spec 被修订,这个前提就没了。

平台却拿**触发来源**(是不是 findings 消息)当判据。发现项**通常**是 `fix`
(检视者技能里也这么写),但「通常」不是「总是」:检视技能第 11 步明写
「若某条发现项大到需要改 spec → 走 `spec_amended`,并**升级为 `requirement`**(闸二)」。
硬编码把这个升级通道整个焊死了。

⚠️ 这是本轮反复出现的同一个形状:**拿一个近似量代替它所指代的事实**
(近似量=消息类型,事实=spec 动没动)。与 `quota-failure-on-clean-exit` R9、
`transient-ratelimit-escalated-to-long-cooldown` R7 同源。

### 2.1 为什么这条比前两条更严重

闸二存在的**全部理由**就是防止「在修复名义下改动架构」绕开 L3
(检视技能:「**绝不允许在『修复』名义下改动架构** —— 那正好绕开了 L3」)。
前两条是判据不准会误判;这一条是**唯一那道防绕开的闸,被实现无条件短路了**,
而且不需要任何人有意绕 —— 走正常流程就会自动发生,已经发生了一次。

## 3. 改动范围

- `packages/backend/server/src/routes/group/messages.ts`(dispatchKind 裁定)

## 4. 详细改动

### R1 — 显式传入的 `dispatchKind` 必须优先

`review_result` 消息携带 `dispatchKind` 时,**以携带值为准**,不得被
`findingsReviewResult` 分支覆盖。

```ts
dispatchKind: dispatchKind ?? (findingsReviewResult ? "fix" : null)
```

⚠️ 只调整**优先级**,不改缺省值 —— 未显式传入时仍缺省 `fix`(发现项通常是修复,
这个缺省是对的,错的是它不可推翻)。

### R2 — 缺省不得静默

缺省为 `fix` 时(即未显式传入),在任务 `diffSummary` 留一条可读记录说明
「dispatchKind 由 findings 缺省推定为 fix,未由检视者显式指定」。
⚠️ 目的是让「这票为什么没跑 L3」在事后可查,而不是只能靠读代码推。

### R3 — 分流权归检视者,不得由其他角色改写

⚠️ 除检视者显式携带外,**任何路径**(协调者 PATCH、执行器汇报)都不得改写
已落库的 `dispatchKind`。分流权在检视者手上是闸一;闸一与闸二共用同一个字段,
让下游能改写它等于同时废掉两道闸。

### R4 — 不涉及

- 不改 L3 触发条件本身(`reviewer+coordinator 在场 AND dispatchKind == requirement`)。
- 不改 `spec_amended` / `spec_published` 的既有处理。
- 不改 `review_result` 的既有校验(定向 coordinator + 必带 specRef/specHash)。

## 5. 验收标准

1. `review_result` / `verdict: findings` + **显式** `dispatchKind: "requirement"`
   → 创建的任务落库 `dispatchKind = "requirement"`,且 L3 触发条件成立。
   ⚠️ 这是本票存在的直接理由,必测。
2. `review_result` / `verdict: findings` + **不带** `dispatchKind`
   → 落库 `"fix"`(既有行为,逐字回归),且 R2 的缺省留痕存在。必测。
3. `review_result` / `verdict: findings` + 显式 `dispatchKind: "fix"` → `"fix"`。
4. **非 findings** 消息的 dispatchKind 处理**逐字不变**(回归,必测)。
5. 任务落库后,协调者 PATCH 携带不同的 `dispatchKind` → **不改写**已落库值(R3)。必测。

## 6. 不涉及的改动

- 不改检视者技能文本(它已写对:改 spec → 升级为 requirement)。
- 不回溯修正历史任务的 `dispatchKind`。
- 不为「该不该改 spec」加自动判定 —— 那是检视者的判断,不是平台的。

## 7. 兼容性

- 不传 `dispatchKind` 的既有调用方行为完全不变(缺省仍是 `fix`)。
- 本票只放开一条此前被焊死的通道,不改变任何既有取值。
