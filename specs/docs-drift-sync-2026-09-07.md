# Spec: 文档与当前行为的已确认漂移(2026-09-07 批次)

> **状态**: Frozen
> **版本**: 1.0
> **日期**: 2026-09-07
> **来源**: [docs/implementation-optimization-review-2026-09-07.md](../docs/implementation-optimization-review-2026-09-07.md)
> D1,**加上 2026-09-07 当天新产生的漂移**(测试口径变更、Windows 支持状态、L3 事件寿命)。

## 1. 背景与目标

文档写着的行为与代码实际行为不一致时,后来者会按文档做出错误决策 ——
本批次里最危险的一条(测试口径)已经在**当天**造成过实际损失:执行器按
AGENTS.md 跑全量回归,在一张票上白耗 40 分钟,而那条要求当天已被推翻。

**目标:把下列每一条改到与代码一致;凡是历史决策,保留原文并用「后续决策」引用说明演进,不抹改。**

## 2. 改动范围

只改文档:`AGENTS.md`、`CONTEXT.md`、`README.md`、`README_CN.md`、
`docs/architecture.md`、`docs/adr/**`。

**不改任何代码、测试、配置。** 本票**不产生**任何 `.ts` / `.sql` / `.json` 改动。

## 3. 详细改动(每条都已核实,附证据)

### D-1. AGENTS.md 的测试口径(最高优先,当天已造成损失)

**证据**:`AGENTS.md:79-82`

```
不要根 `pnpm test`(全量 77 文件 / 1140 用例,实测 **~490 秒**…)
全量回归由检视者在 L3 跑。
- **改动落在主干路径(`done` 分支、聚合函数、渲染入口)时必须跑全量。**
```

**两处都不对**:

- **数字**:`~490 秒` 是另一台主机的历史记录。**本机实测 1444 秒(24 分钟)**
  (2026-09-07 13:48 起跑,78 文件 / 1053 用例)。
- **规则**:用户 2026-09-07 决策 **不再跑全量,只跑改动触及的测试文件**。

**要改成**:说明当前口径是**由票面给出显式测试文件清单**,执行器照单跑;
并**保留**原规则作为历史,注明被 2026-09-07 用户决策取代及理由(全量在本机 24 分钟)。
同时**保留**原文里那条真正的教训 ——「只跑新增用例 = 只验证了我想到的那部分」,
把它重写为「清单列错就会漏」,因为风险从「跑不跑全量」转移到了「清单准不准」。

⚠️ 顺带核对同文件里 `**~490 秒**` 出现的所有位置,统一更正或标注为历史数值。

### D-2. CONTEXT.md 的 completion event 唯一约束

**证据**:`CONTEXT.md:22` 写「**task_id 唯一约束**保证幂等」。
而 `0030_add_task_completion_recipient.sql` 已经:

```sql
ALTER TABLE "task_completion_event" DROP CONSTRAINT IF EXISTS "task_completion_event_task_id_unique";
ALTER TABLE "task_completion_event" ADD CONSTRAINT
  "task_completion_event_task_id_recipient_participant_id_unique" UNIQUE("task_id","recipient_participant_id");
```

**要改成**:唯一约束是 `(task_id, recipient_participant_id)`,
去重粒度是「每收件人一条」(群内多个 reviewer 时每人一条事件)。

### D-3. ADR-0003 的「全局串行队列」

**证据**:`docs/adr/0003-single-scheduler-executors.md:9` 写
「建 task → **全局串行队列** spawn」。
而当前调度按 `projectPath` 分组并发,`scripts/dispatch-policy.json` 里
最大并行组数为 2、同工作树并发上限为 1。

**要改成**:**保留 ADR-0003 的原始决策文字不动**,在其后追加一条
「后续演进」说明:调度已从全局串行改为按 `projectPath` 分组、
同工作树串行 + 有限跨组并行,并指出当前配置位置。
**不得**把原文改写成现状 —— ADR 保留历史背景是仓库明规。

### D-4. 「不代理文件字节」的三处绝对化表述

**证据**(三处均已核实):

| 文件 | 行 | 原文 |
|---|---|---|
| `CONTEXT.md` | 8 | 「只做协作调度与消息信令,**不代理文件字节**」 |
| `AGENTS.md` | 12 | 「does coordination and messaging only — **it does not proxy file bytes**」 |
| `docs/architecture.md` | 15 | 同 CONTEXT 表述 |

而 `POST /api/file/upload` 会把文件**流式写盘**、`GET /api/file/:name` 会
**流式下载**(`routes/file.ts`),`/api/file/*` 在 architecture.md §4 里
自己写着「LAN 文件存储…纯磁盘无鉴权」。

**要改成**:把「不代理文件字节」限定到 **group `fileRef` 的 P2P 信令路径**,
并明确 `/api/file/*` 是独立的 LAN 文件存储、确实传输字节。
三处表述要一致(不要只改一处)。

### D-5. Windows 本地执行的支持状态(当天新增)

`specs/windows-cmd-executor-spawn.md` 已 Landed(`cf41405e`):
Windows 上 `.cmd` 垫片现在会被解析成真实目标再 spawn。

但**这不构成平台支持承诺** —— R10 的另两项(临时目录硬编码 `/tmp`、
进程树终止用负 PID)仍未解决。文档里若有「支持/不支持 Windows」的表述,
按这个口径写清楚:**当前可跑,但临时目录与进程树终止仍是已知缺口**。
若文档里没有相关表述,**不要新造一节** —— 在汇报里说明「未发现需要改的位置」即可。

### D-6. L3 完成事件的寿命(当天新增)

`specs/resume-consumer-kills-reviewer-inbox-events.md` 已 Landed(`3c6e5d92`):
续跑消费者不再处置顶层任务的完成事件,顶层事件保持 `pending` 由收件人消费。

若 `docs/architecture.md` 或 ADR-0006/0007 里有「完成事件何时被判 dead」的描述,
按新行为更正。**同样:没有就不要新造。**

### D-7. 需要核对但尚未证实的一条

报告提到「ADR-0008 输出画像方向与后续适配器注册表 Frozen spec」可能有漂移。
**这条我没有独立核实。** 请你自己核对
`docs/adr/0008-executor-adaptation-config-over-code.md` 与
`specs/executor-adapter-registry.md`:

- 若确有冲突 → 按 D-3 的方式(保留原决策 + 追加后续决策引用)处理;
- 若无冲突 → 在汇报里写明「已核对,无需改动」及依据。

**不要为了凑改动而改。**

## 4. 验收标准

本票是文档票,验收看的是 **diff 与一致性**,不是测试。

1. **逐条对照**:D-1 ~ D-7 每一条给出「改了什么 / 或为什么不用改」,
   并附 `git diff` 片段或核对依据。
2. **历史不被抹改**:D-3(以及 D-7 若命中)必须能看出**原决策文字保留**,
   新内容以「后续演进 / 后续决策」形式追加。汇报中贴出该段 diff 证明。
3. **三处一致**:D-4 的三个文件表述一致,不得只改一处。
   用 `grep -rn "不代理文件字节\|does not proxy file bytes" .` 自证已全部处理。
4. **数字可复算**:D-1 里若保留或更新耗时数字,必须标注它是**哪台机器、哪次实测**;
   不得再写一个无出处的数字。
5. **零代码改动**:`git show --stat` 里**不得出现**任何 `.ts` / `.sql` / `.json` / `.mjs` 文件。
   这是硬约束 —— 出现即不合格。
6. **不跑测试**:本票不改代码,**不要**跑 vitest(省时间)。
   若你认为某处文档改动暗示了代码问题,**写进汇报**,不要顺手改代码。

## 5. 不涉及的改动

- **不改任何代码/测试/配置**(§4.5 是硬约束)。
- **不新增 ADR** —— 本票只同步既有文档;若你认为需要新 ADR,写进汇报由检视者决定。
- **不重写 ADR 的历史决策**(D-3)。
- **不改 skills/** 下的任何文件(工作流变更是另一批票)。
- 不为「文档更好看」做与上述七条无关的润色。

## 6. 兼容性

纯文档改动,无运行时影响,无迁移。
