# Spec: L3 请求的投递对象与产出范围

> **状态**: Ready for Implementation
> **版本**: 1.0
> **日期**: 2026-08-30

## 1. 背景与目标

`docs/architecture.md` 第 9 节声明的 L3 链路是:

> L2 功能检视通过 → 任务终态后 DB trigger 自动创建 `task_completion_event`
> → **reviewer 从 inbox 认领**并完成架构检视 → 结案

`coagenthub-reviewer` skill 的适配器契约 C1 进一步规定:**收件箱是唯一权威源**。

但实现与这两处声明不符,导致 L3 请求存在**结构上收不到**的情形,以及**不该产生
却产生**的情形。两者都在 2026-08-30 的实测数据中出现。

### 1.1 缺陷 A —— 投递对象跟随「下发者」,而非「检视者」

`0018_task_completion_events.sql` 的 trigger 严格按 `dispatcher_participant_id`
投递:

```sql
IF ... AND NEW.dispatcher_participant_id IS NOT NULL THEN
  INSERT INTO "task_completion_event"(
    "task_id","group_id","dispatcher_participant_id", ...)
  VALUES (NEW.id, NEW.group_id, NEW.dispatcher_participant_id, ...)
```

trigger 里**没有任何「reviewer」概念**。于是 L3 请求只在「检视者恰好是属主任务
的下发者」时才送得到。协调者自派的续跑 / detached 任务,其下发者是**协调者自己**
—— 而协调者 `memory: null`、每票 spawn、跑完即退,**从不读自己的收件箱**。
这类事件是**结构上永远送不到**的。

**实证(群 01a03be2-4a58,2026-08-30 11:55 取样):**

| 属主任务 | dispatchKind | 下发者 | 结果 |
|---|---|---|---|
| `01a0502b-fe44` | **requirement** | 协调者 | 事件落协调者收件箱,检视者收不到 |

T3(票 `01a050aa-ffd5`,下发者=检视者,**本可送达**)的 L3 请求,被去重规则
**并入**了 `01a0502b-fe44`。即:一条本来能送到的请求,被搬到了送不到的地方 ——
去重合并**放大**了缺陷 A。

⚠️ **本次 T3 的 L3 实际没有漏做**(检视者手工查库发现并当场完成)。
这是**机制确凿、危害本次被人工兜住**的缺陷,不是一次已发生的事故。

### 1.2 缺陷 B —— `fix` 票也产出 `review_request`

L3 触发条件是既有结论(`docs/architecture.md` §3.14.6):

```
跑 L3  ⟺  群内 reviewer 与 coordinator 同时在场  AND  dispatchKind == requirement
```

`routes/group/tasks.ts:355` 有**单向**守卫:「应走 L3 时 `review_request`
不得缺失」。**没有反向守卫** —— 不该走 L3 时并不禁止产出。

**实证(同次取样):** 群内 11 个带 `review_request` 的任务中,**5 个
`dispatchKind = fix`**:

```
01a04ccc-7a76  fix  specs/verify-agent-claims.md
01a04d62-cb92  fix  specs/quota-failure-on-clean-exit.md
01a04ee3-08a3  fix  specs/l2-verification-scope.md
01a04e70-4eb8  fix  specs/quota-exhaustion-triggers-infinite-retry.md
01a04f7a-d762  fix  specs/two-tier-output-summary-and-detail.md
```

危害不是「多做检视」(它们送不到,谁也没做),而是:

- 污染按 `specRef + specHash` 的**去重池**,影响并入时的属主选择;
- 触发 **L3 逾期提醒**,对不需要 L3 的票反复提醒
  (实证:2026-08-30 11:02 的那条提醒);
- 让「未应答 L3 请求」这个集合失去意义,人无法据它判断还欠几次检视。

## 2. 改动范围

- `packages/backend/database/drizzle/migrations/` — 新增迁移(收件人字段)
- `packages/backend/server/src/routes/group/tasks.ts` — PATCH 终态:收件人裁定 + 反向守卫
- `packages/backend/server/src/routes/participant/task-completion-events.ts` — 按收件人列举
- `docs/architecture.md` 第 9 节 — 同步投递语义

## 3. 详细改动

### R1 — 投递对象由载荷决定,不由下发者决定

**带 `review_request` 的完成事件,收件人是「群内 reviewer 角色成员」,
不是任务的 `dispatcher_participant_id`。** 其余完成事件的投递**逐字不变**
(仍按下发者)。

实现取向(**已决策,不要另选**):在**应用层**裁定收件人并落一个新列
`recipient_participant_id`,trigger 保持「哑」——只搬运该列,不查 `group_members`、
不理解角色。

理由:trigger 是 SQL,让它感知群角色会把角色语义分散到两个权威源
(应用层 + 数据库),而「权威源不唯一」正是本轮反复咬人的根因。

- `recipient_participant_id` 缺省 = `dispatcher_participant_id`(既有行为)。
- 仅当任务终态 `diffSummary` 带 `review_request` 时,改为群内 reviewer 成员 id。
- 群内**无** reviewer 成员时:不改写收件人(仍投给下发者),并**不得**产出
  `review_request` —— 两层编制本就不跑 L3,见 R3。
- 群内有**多个** reviewer 成员时:全部投递(每人一条事件),
  由 `eventId` 去重保证各自只处理一次。

### R2 — 列举与认领按收件人

`GET /participants/:id/task-completion-events` 及 claim / ack / fail
的归属判定改用 `recipient_participant_id`。

⚠️ **迁移必须回填**:既有行的 `recipient_participant_id` 置为
`dispatcher_participant_id`,保证老数据的投递关系逐字不变。

### R3 — 反向守卫:不该走 L3 时不得产出 `review_request`

`tasks.ts` 现有守卫的对称面:

- `dispatchKind == 'fix'` → PATCH 终态**拒绝**携带 `review_request`(400),
  错误信息写明「fix 票复用已过 L3 的冻结 spec,不产生新的架构面」。
- 群内无 reviewer 成员 → 同样拒绝。
- `dispatchKind` 为 `null`(历史行)→ **保守按 requirement 处理**,允许携带
  (与既有 `shouldRunL3` 的 null 处理逐字一致,不得借本票收紧)。

⚠️ 只拒绝**新的** PATCH,**不清洗历史数据** —— 上面那 5 条既有记录保持原样,
它们是本 spec 的实证,删掉就没有回归对照了。

### R4 — 去重并入不得降低可送达性

按 `specRef + specHash` 并入时,若候选属主的 `recipient_participant_id` 与本任务
不同,**不并入**,各自独立成请求。

R1 落地后同群同角色会收敛到同一收件人,本条实际很少触发;它是**防御性**的 ——
确保「并入」这个优化在任何情况下都不会把一条能送达的请求搬到送不达的地方。

### R5 — 不改的东西

- 不改 L3 的**触发条件**本身(`reviewer+coordinator 在场 AND requirement`)。
- 不改 `review_request` / `review_result` 的**载荷字段**。
- 不改 `l3-overdue-reminder` 的提醒口径与 `l3ResponseMinutes`
  —— R3 让假请求不再产生,提醒自然收敛,不需要同时改提醒。
- 不改 `answered` 的判据(仍是「群内存在 taskId 指向属主的 `review_result`」)。
- 不改协调者「跑完即退」的模型 —— 让协调者常驻去读收件箱是另一个方向,
  本 spec 明确**不走**那条路。

## 4. 验收标准

1. `requirement` 票走完 L1→L2→终态后,**群内 reviewer** 的收件箱出现带
   `review_request` 的事件;该事件**不**出现在协调者收件箱。
2. 属主任务由**协调者自派**(续跑 / detached)时,上一条同样成立 ——
   这是缺陷 A 的直接回归,**必测**。
3. 非 L3 的普通完成事件仍投给**下发者**,行为逐字不变(回归,必测)。
4. 迁移回填后,既有事件的归属**逐字不变**:取样至少 5 条历史事件,
   `recipient_participant_id == dispatcher_participant_id`。
5. `dispatchKind: fix` 的 PATCH 携带 `review_request` → **400**,任务终态不写入。
6. `dispatchKind: null` 的 PATCH 携带 `review_request` → **允许**(回归,必测)。
7. 群内无 reviewer 时携带 `review_request` → 400;普通完成事件不受影响。
8. 两个候选属主收件人不同时不并入(R4),各自产生独立事件。
9. 既有 task-completion-events / tasks 路由测试全绿;历史数据不被清洗。

## 5. 不涉及的改动

- 不改协调者的生命周期模型。
- 不引入 WS 之外的新推送通道(C4 不变:WS 是加速器,收件箱是权威源)。
- 不清洗历史 `review_request` 记录。
- 不改 IELTS Reader 群或任何其他群的数据。

## 6. 兼容性

- 新列可空 + 迁移回填,老库老行为逐字保留。
- 本 spec 冻结前已产生的 5 条 `fix` 假请求保持原样,不追溯。
- R3 只约束新的 PATCH;冻结前正在执行的票按旧口径完成。
