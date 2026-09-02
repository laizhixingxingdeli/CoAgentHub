# Spec: detached 任务经 PATCH 结案时从不回填 outputTail,协调者的过程记录永久丢失

> **状态**: Landed — L3 通过(2026-09-02),实现 `34740724`
> **相关**: [ADR-0009](../docs/adr/0009-judgments-must-name-the-fact.md)

## 1. 现象:56 / 56 全空

```sql
select count(*) filter (where diff_summary ? 'outputTail')      as 有,
       count(*) filter (where not (diff_summary ? 'outputTail')) as 无
from task where executor_key='codex' and status='done' and parent_task_id is null;
--  有 = 0 | 无 = 56        (2026-09-02 实测)
```

**正常结案的协调任务里,`outputTail` 一次都没被写成功过。**

## 2. 根因:三个写入点都不在 detached 的结案路径上

`diffSummary.outputTail` 全仓库仅三处写入:

| 位置 | 触发条件 | detached 会走吗 |
|---|---|---|
| `queue.ts:2213` | 进程退出后的 **done 分支** | **否** |
| `queue.ts:2593` | `failTask`(失败) | 仅失败时 |
| `orphan-task-reconciler.ts:152` | 孤儿收敛 | 仅被判死时 |

而协调任务**一律 detached**(`queue.ts:1592` `detached = detachedByReplyMode || isCoordinator`),
detached CLI 路径 spawn 后立即 return、**不走 done 分支**,终态由执行方
**PATCH 回写**(`routes/group/tasks.ts:1645` 的 `.set({...})`)—— **该处无回填**。

⚠️ **反直觉的分布**:被孤儿收敛判死的协调者**反而有记录**,正常完成的没有。
排障时这个分布会误导人。

### 读取侧因此永久落空

`routes/group/tasks.ts:977` / `:1088`:`buffered ?? backfilled ?? undefined`。
任务终态后内存缓冲已 `releaseTaskOutput`,`backfilled` 又从未写入 ⇒ **恒为 null**。

## 3. 危害:不是「记录缺失」,是**检视做不了**

2026-09-02 一夜内**两次**直接妨碍 L3:

1. **任务 `01a05e17-7b49`** 判 `failed`,错误文本 `executor pid 47803 no longer exists`
   指向「进程崩溃」。实际是协调者只做了 `planOnly` 预览就退出。
   `outputTail` 为空 → 只能靠**明细存储**(`$TMPDIR/coagenthub-task-detail-<id>.jsonl`)
   才查出真相。**明细存 /tmp、14 天清理,不是可依赖的审计源。**
2. **任务 `01a0603f-e952`** 在 6 个执行器全部 available 时选择兼任实现。
   按 coordinator skill「不得静默自派」这需要理由 —— **理由查不到**,
   `outputTail` 空、群内无说明消息 ⇒ 「兼任是否正当」**不可判定**,L3 只能放行。

⇒ 协调者是三层里唯一没有过程留痕的一层。L2 结论、派发理由、选型依据全部易失。

## 4. 要做的

### R1 PATCH 终态回写时回填 outputTail

`routes/group/tasks.ts` 的 PATCH 终态分支(`:1645` 的 `.set({...})` 之前),
当 `isTerminalTaskStatus(status)` 且该任务存在内存缓冲时,
把最近 500 行写入 `diffSummary.outputTail`,与 done 分支
(`queue.ts:2213` `taskOutputTailLines(taskId)`)**同口径**。

⚠️ **顺序**:必须**先取后释放**。`queue.ts:2864` 既有注释已记录同款教训
(「failTask 会回填 outputTail,必须先取后释放」)。

⚠️ **不得覆盖调用方显式提供的 `outputTail`**:PATCH 载荷若自带该键,以载荷为准
(与既有 `preserveDispatchKindNote` / `preserveRollbackSkipped` 同款「显式键优先」)。

### R2 缺失时留痕,不静默

内存缓冲已不存在(进程早退、服务重启过)→ 写入
`diffSummary.outputTailMissing = "<原因>"`,**不要什么都不写**。
静默缺失正是本缺陷难以察觉的原因:56 份全空,而没有任何一条记录说明为什么。

## 5. 硬验收

1. **端到端**:新起一条协调任务并正常结案后,
   `select diff_summary ? 'outputTail' from task where id='<新任务>'` 为 **true**。
   ⚠️ 拿真实一轮验,不构造。
2. **既有三条路径逐字不变**(回归,必测):done 分支、`failTask`、孤儿收敛器的
   回填内容与时机不变。
3. **显式键优先**:PATCH 载荷自带 `outputTail` 时,以载荷为准,不被覆盖。必测。
4. **缺失留痕**:无缓冲时 `outputTailMissing` 有值且说明原因。必测。
5. 顺序正确:回填发生在 `releaseTaskOutput` 之前(可用「缓冲已释放后回填为空」
   的反向用例证明)。必测。

## 6. 不涉及

- 不改内存环形缓冲的上限(1000 行 / 256KB)与 500 行截断口径。
- 不改明细存储(`/tmp` JSONL)的位置与保留期 —— 另议。
- 不改 detached 的结案语义(仍由执行方 PATCH 决定终态)。
- 不改孤儿收敛器。
