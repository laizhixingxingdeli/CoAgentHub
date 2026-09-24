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

## 与状态、事件一起提交（单事务命令）

交卷（Standard / Lightweight）与升级是**单事务命令**（设计 §8.1）：改状态、记终态事件、建投递、记 `delivery.created` 要么一起落下，要么一个都不落。崩在中间重启后，不会出现「状态说已交卷、收件箱里没有」或「收件箱里有、状态还在执行」；重放命令恰好得到一条终态事件、一条投递。

平台依赖 `transaction?: CommandTransaction`（`ports.ts`，`run(fn)`）；不注入就直接跑（内存版）。

**覆盖哪些命令**（C4 起）：平台所有「改状态 + 记事件」的命令都是单事务命令——建 / 分类建 / 重跑 Mission、改契约、开始 / 结束 / 续租 attempt、作废工作项、等待原因、取消 / 暂停 / 恢复、发现与方案、建工作项（含 Lightweight）、两种派发、评审、记工作区、轮次 / 预算 / 命令计数事实、升级与答复、交卷（两种）、方案放弃、证据、执行结果、报告受阻、各种升级 Standard、L3 的 send_back / abandon。写法统一：公开方法 → `this.#tx(() => this.#私有实现(...))`，方法体不动；嵌套调用并进外层。

例外与切段：

- **Lightweight 机器验收**：跑验收命令（可能几分钟）在事务外；之后一个事务重取工作项，报告、`validation.reported`、validator accept 一起提交。authority 对不上时照旧保留报告——事务里只做标记，提交之后再抛。验收引擎在事务外发报告号，崩掉时这个号跳过（发号单调，跳号无害）。
- **派发**：PRE shadow 在事务里（缺省不开；开了事务最多多占一个超时）。
- **不包**：L3 merge 与机器 L3（git 合并是外部副作用：合并成功后提交丢了，重放会因为目标分支已前移判合并失败——要可重入的合并检测，留给外部副作用受控 Adapter）；POST shadow（Jev 调用，只记一条事件）。
- 事务之间串行，事务里不能有长等待。

**崩溃注入（C4）**：一份确定性脚本覆盖上面的命令（每一步恰好一条平台命令）；参考运行记下每一步结束时的持久化内容；然后对第 k 次记事件（取遍全部）分别在 append 之前、之后抛错——重开后（文件版整份状态文件；PG 新开 store 读快照、事件、投递）必须恰好等于上一条命令结束时。任何一条命令漏包事务，都会有检查点对不上。

**文件版**（`FileStateStore` 实现，`buildPersistentPlatform` 注入；C2）：

- 事务里的写（活对象、事件、投递、各记录数组、发号）不单独落盘，`fn` 结束后一次原子写（临时文件 + rename）。
- `fn` 抛错或那一次写失败：活对象（只换改过的）与各数组回到开事务时，盘上还是之前的文件；之后别处的写不会把半截改动带下去。发号计数不回滚——单调递增，跳号无害，回滚反而会重发已发出去的号。
- 事务外的写不混进开着的事务：异步写（`save` / `ensure` / `append` / `create` / `acknowledge` / 查询、验收报告、候选池）先等它结束；同步落盘（发号、`persist`）推迟到它结束——回滚了也照样补写。
- 事务串行，嵌套并进外层；事务开着时不重读状态文件，也不能归档。
- 只包短命令：事务之间串行，长等待（L3 合并、机器验收）不能包进来（C4 按提交段切）。
- 已知代价：事务开着时别处直接改了同一个活对象却不 `save`（如心跳），回滚时会被一起恢复——心跳尽力而为，下一次再打。

**PG 版**（`PgStateStore` 实现，`buildPgPlatform` 注入；C3）：

- 事务里的事件与投递（含投递确认）先暂存，快照 flush 不写；`fn` 结束后**一个数据库事务**：变了的 Project 快照（`WHERE version = 期望版本`）→ 事件 → 投递 `ON CONFLICT (mission_id, idempotency_key) DO NOTHING` → 确认 → `COMMIT`。事务里读得到自己暂存的事件与投递（`list` / `all` / `get` / `pending`）；同键重复建拿回暂存那条，库里已有的原样拿回。
- `fn` 抛错或提交失败——包括**提交时版本冲突**（别的进程抢先改了同一个 Project）——数据库回滚，改过的活对象回到开事务时，暂存丢弃。版本号与「已落库」记账只在 `COMMIT` 成功后前移（普通快照 flush 同样修正：早先边写边前移，回滚后记账不退，之后每次写都顶成冲突）。
- 事务外：快照 flush（含 API 的 `persist`）推迟到事务结束；`save` / `ensure` / `append` / `create` / `acknowledge` 先等；从库重读（`refresh`）事务里跳过、事务外先等——重读会换掉事务正在改的活对象。开事务前先等在途的快照 flush 与重读排空。
- 范围：只覆盖快照、事件、投递（设计 §8.1 的 aggregate + events + outbox）。查询、验收报告、候选池、实时输出各有各的表，仍是即时写。
- 已知限制：另一个进程恰好同时新建同一个投递键时，本事务暂存的投递 id 在库里不存在（`ON CONFLICT` 什么都没写），`delivery.created` 里的 id 对不上——单写者下几乎不可能。

## 没做的

- 终态却没有投递的补建（C5）；L3 merge / 机器 L3 的可重入合并检测。
- 同一次工具调用被重发（agent 超时重试）会记成两次升级、两条投递——那是请求级幂等，不在这里。

## 权威源 / 测试

- 源：`delivery.ts`、`file-store.ts`（含 `run` 事务）、`pg-store.ts`（含 `run` 事务）、`platform.ts`（三处建投递、`#tx`）、`ports.ts`（`CommandTransaction`）、`main.ts`（注入）
- 测：`delivery-idempotency.test.ts`（三个实现的去重语义、平台三条路径、文件旧数据、真 PG 迁移——独立库）、`pg-store.test.ts`、`command-transaction.test.ts`（事务语义；三条命令 × 四个写边界的崩溃注入：重开状态文件后全有或全无、重放恰好一条）、`pg-command-transaction.test.ts`（真库、独立库：同一套语义；崩溃点含提交时版本冲突；新开 store 读库全有或全无）、`command-transaction-checkpoints.test.ts`（全命令脚本 × 每一次记事件前后崩溃 × 两种存储的检查点比对；机器验收 authority 对不上时报告落盘）
