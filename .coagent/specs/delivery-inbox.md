# 投递收件箱（delivery-inbox）

Mission 的结果与升级要回到发起方：发起的会话可能已经关了，所以投递**留在收件箱里等**，Host 恢复后自己来取（`pending`）、取完确认（`acknowledge`）。只写进平台状态不算数——「进收件箱才叫升级」。

## 什么时候投

| 平台命令 | outcome | 幂等键 |
| --- | --- | --- |
| `escalateToL3` | `escalated` | `escalated:<该 Mission 的第几次升级>`（从 0 数，与 `mission.escalations` 的下标一致） |
| `submitMissionResult`（Standard） | `delivered` / `blocked` | `result:<提交它的协调者 attemptId>` |
| `submitLightweightMissionForReview` | `delivered` | `result:<那份 ValidationReport 的 id>`（没有协调者） |

每条投递之后记一条 `delivery.created` 事件（带 `deliveryId`）。

## 去重

- **同一 Mission 内同一个幂等键只有一条投递**；重建（崩溃后重放、补建）拿回原来那条，确认过的也不会再投。
- 键只由持久化状态决定，所以同一次升级 / 同一次交卷怎么重建都是同一个键；**不同的**升级、L3 打回后的**重新**交卷是新键，照投。
- 早先按 (mission, outcome) 去重：第二次升级（前一次已答复）和打回后的重新交卷都被当成重复吞掉，收件箱里永远看不到（C1 修掉）。
- `pending` / `acknowledge` 语义不变：确认幂等，重复确认不刷新确认时间。

## 存储

- **内存 / 文件**：按 `(missionId, idempotencyKey)` 查已有行。文件版读入状态文件时给加键之前的旧行补键：升级那行只可能是第一次升级 → `escalated:0`；交卷那行 → `result:legacy:<outcome>`（不会与新键相撞）。归档包有 sha256 钉着，盘上不改，读出来的副本补键；重跑归档时两边按同一规则补键再比。
- **PG**：唯一索引 `deliveries_mission_key_idx (mission_id, idempotency_key)`，`INSERT … ON CONFLICT DO NOTHING` 再回查，不靠「先查再写」。打开库时的迁移可重复执行：加列 → 按上面的规则回填旧行 → 设 NOT NULL → 建新唯一索引 → 最后才删旧的 `deliveries_mission_outcome_idx`，任何时刻都有一条唯一约束在。
- `Delivery.idempotencyKey` 是对外字段（只增不改）。

### PG 迁移是单向的

迁移后的库不能再给 C1 之前的代码用：旧代码写投递用的是 `ON CONFLICT (mission_id, outcome)`，旧索引删掉之后这条语句直接报错（找不到匹配的唯一约束）。文件版没有这个问题——旧代码不认识多出来的字段，照旧按结局去重。

真要退回旧代码，先手工把库退回旧约束（**会丢掉**同一 Mission 同一结局的第二条及以后的投递——那正是旧规则吞掉的东西）：

```sql
DELETE FROM deliveries d USING deliveries e
 WHERE d.mission_id = e.mission_id AND d.outcome = e.outcome
   AND (d.created_at, d.delivery_id) > (e.created_at, e.delivery_id);
CREATE UNIQUE INDEX IF NOT EXISTS deliveries_mission_outcome_idx ON deliveries (mission_id, outcome);
DROP INDEX IF EXISTS deliveries_mission_key_idx;
ALTER TABLE deliveries ALTER COLUMN idempotency_key DROP NOT NULL;
```

## 没做的

- 投递与状态、事件同一事务提交（C2 / C3）；终态却没有投递的补建（C5）。
- 同一次工具调用被重发（agent 超时重试）会记成两次升级、两条投递——那是请求级幂等，不在这里。

## 权威源 / 测试

- 源：`delivery.ts`、`file-store.ts`、`pg-store.ts`、`platform.ts`（三处建投递）
- 测：`delivery-idempotency.test.ts`（三个实现的去重语义、平台三条路径、文件旧数据、真 PG 迁移——独立库）、`pg-store.test.ts`
