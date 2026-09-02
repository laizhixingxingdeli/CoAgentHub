# Spec: 关票时不更新 spec 状态,目录整体失去可筛选性

> **状态**: Landed — L3 通过(2026-09-02),实现 `de9a1c7f`
> **版本**: 1.0
> **相关**: [ADR-0009](../docs/adr/0009-judgments-must-name-the-fact.md)

## 1. 现象(2026-09-02 全量盘点)

`specs/` 下 146 份文件,`> **状态**:` 是**唯一**能用来回答「还剩什么要做」的字段。
盘点结果:

| | 条数 |
|---|---|
| 标着 `Ready for Implementation` | 12 |
| **其中 DB 里已有 `done` 任务** | **11** |

```sql
-- 复算语句
select count(*) from task where spec_ref='specs/<file>.md' and status='done';
```

11 份的 done 任务数在 **4~20** 之间(`executor-config-over-code.md` 有 20 个)。
唯一状态本来就对的是 `skill-self-update.md`。

⇒ **该字段在 92% 的情况下是错的。** 于是 146 份看起来全是待办,
而订正后真正开放的只有 **7 份**。用户对 spec 目录的直接反馈是「有点太多了」——
数量不是病因,**状态不可信才是**。

同次盘点还发现状态行有 **111 种写法**(已由同批改动统一为 8 个值,见 AGENTS.md)。

## 2. 根因:关票流程里没有这一步

`skills/reviewer/SKILL.md` 的 L3 收尾表:

| verdict | 你要做的 |
|---|---|
| `pass` | 公布 `review_result` 留痕,**结束**。不需要唤醒任何人。 |

**「结束」之后没有「更新 spec 状态」。** 检视者是唯一知道「这张票过了」的角色,
也是唯一有权改 spec 的角色 —— 这一步不写进 skill,就没有任何人会做。

同文件 `spec-template` 仍写 `> **状态**: Ready for Implementation`,
而该取值已于 2026-09-02 并入 `Frozen`(AGENTS.md 状态词表)。

## 3. 要做的

### R1 L3 收尾表补一步(`skills/reviewer/SKILL.md`,verdict 表)

`pass` 行改为:

> 公布 `review_result` 留痕 → **把该 spec 的 `> **状态**:` 更新为 `Landed — L3 通过(日期),实现 `<commit>``** → 结束。

⚠️ 必须写明**状态值与格式**,不能只写「更新状态」—— 否则又长出新写法。
格式:`Landed — L3 通过(YYYY-MM-DD),实现 \`<commit>\``。

### R2 spec 模板改用现行词表

`spec-template` 的 `> **状态**:` 从 `Ready for Implementation` 改为 `Draft`,
并在模板下方注明:**冻结时改为 `Frozen`,关票时改为 `Landed`**,
取值必须来自 AGENTS.md 的 8 值词表。

### R3 spec 里的量化断言必须附取数语句

`spec-template` 增加一条写作要求:**凡在 spec 中写下数字或「X 会/不会」的断言,
必须附可复算的取数语句(SQL / 命令)**。

⚠️ 理由(2026-09-02 同夜两次实证):
`codex-token-collection-never-matches.md:31` 与
`task-status-line-duplicates-the-card.md` §1.1 都写下了**与真实系统相反**的断言,
且都**没有附取数方式**,因此无人复算,错误依据一路进了实现
(后者直接导致 `isSingleLine` 守卫,使该票主验收落空)。

### R4 同步到运行时

改完必须跑 `scripts/coagenthub-sync-skills.mjs`,否则运行时加载的仍是旧 skill。

## 4. 硬验收

1. **只读 `skills/reviewer/SKILL.md` 的 L3 收尾表即可知道**:pass 之后要改 spec 状态、
   改成什么值、什么格式。不得依赖读者去 AGENTS.md 推断格式。
2. `spec-template` 不再出现 `Ready for Implementation`;新建 spec 默认 `Draft`。
3. `coagenthub-sync-skills.mjs --check` 对全部 (runtime × role) 目标干净。
4. **端到端**:下一张 L3 pass 的票,其 spec 状态在关票后为 `Landed — …`,
   格式与 R1 一致。⚠️ 拿真实一轮验,不构造。

## 5. 不涉及

- 不改 AGENTS.md 的状态词表(同批已落地)。
- 不改 coordinator / executor skill(`preview-mistaken-for-dispatch.md` 另票)。
- 不做 `specs/INDEX.md` 生成(另议;词表统一后 grep 已够用)。
- 不追溯订正历史 spec(2026-09-02 已手工订正 13 份)。
