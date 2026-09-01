# Spec: `planOnly` 预览被当作已下发,协调者据此结案退出

> **状态**: Frozen — 2026-09-02
> **版本**: 1.0
> **相关**: [ADR-0009](../docs/adr/0009-judgments-must-name-the-fact.md)

## 1. 现象(生产已兑现,2026-09-02 01:50)

协调任务 `01a05e17-7b49` 被平台判 `failed`
(`executor pid 47803 no longer exists`)。查明细后确认**不是进程异常**:

1. 协调者正确做出了角色判断 —— 「三方在场且有非自身 executor(Pi),
   协调者不得自派」,决定派给 Pi(**这一步是对的**);
2. 调用 `coagenthub_dispatch_task(..., planOnly, ...)`;
3. MCP 正确返回 `{"status":"preview","body":"# CoAgentHub Task..."}`
   —— **这是预览,不是下发**(`coagenthub-codex` 的 `d91d53c` 实现了该语义);
4. 协调者据此汇报「子任务已成功下发至 Pi」,按「派发后结束」退出;
5. **该协调任务名下子任务数 = 0**,Pi 从未收到任何东西;
6. 无子任务 → 不满足孤儿豁免(`coordinator-resume.ts` `hasExemptingChildTask`)
   → 收敛器判 `failed`。**收敛器行为正确**,是上游没做完。

净代价:一张票白跑一轮,且失败原因(`executor pid no longer exists`)
**完全指向错误方向** —— 看起来像进程崩溃,实际是流程只走了一半。

## 2. 根因:skill 教了第一步,没教第二步,也没有收尾自证

`skills/coordinator/SKILL.md:90`(`<dispatch-rules>` 内):

```
- Use `planOnly: true` first to preview the task ticket before sending.
```

`SKILL.md:487`(工具速查表)另有一行 `Preview task ticket | planOnly: true`。

两处都只描述**预览**这一步:

- 「before sending」暗示还有一次真实下发,但**那一步没有被写成一条指令**;
- **没有任何一处要求核实子任务确已创建**;
- 速查表把「Dispatch task」与「Preview task ticket」并列成两行,
  读起来像**两个可选的下发方式**,而不是同一流程的两个必经步骤。

⚠️ 这是 ADR-0009 的同一模式:拿「MCP 调用返回成功」这个近似量,
代替「子任务确已创建」这个事实。沉默的前提是「调用成功即下发成功」——
被 `planOnly` 破掉。

## 3. 要做的

### R1 `<dispatch-rules>` 补成完整两步 + 自证

把 `SKILL.md:90` 那一行替换为:

- 预览:`planOnly: true` 先看任务书;
- **真实下发:必须再调用一次不带 `planOnly` 的 `coagenthub_dispatch_task`**;
- **自证:汇报里必须贴出新建子任务的 id。拿不出 id 就不算下发。**

### R2 速查表消歧

`SKILL.md:487` 的 `Preview task ticket` 一行标注「预览,**不创建任务**;
真实下发见上一行」,消除「两个并列下发方式」的误读。

### R3 结案前自查

协调者「派发后结束」的收尾处补一条:退出前确认
**该协调任务名下子任务数 > 0**(或本轮为兼任实现、工作树确有提交)。
二者皆无 → 不得按「已派发」结束。

### R4 同步到运行时

`skills/` 改动**必须**跑 `scripts/coagenthub-sync-skills.mjs`
才对执行器/协调者生效(HANDOFF §3 已有此教训:
skill 改了没同步 → 加载的还是旧版,新自检不会发生)。

## 4. 硬验收

1. **改后 `SKILL.md` 中「下发」流程可被单独读懂** —— 只读
   `<dispatch-rules>` 一段即可知道需要两次调用、且需贴子任务 id。
   不得依赖读者去别处推断。
2. `coagenthub-sync-skills.mjs --check` 对全部 (runtime × role) 目标干净。
3. **端到端**:下发一张真票,协调者的汇报里出现新建子任务 id,
   且 DB 中该协调任务 `parent_task_id` 子任务数 > 0。
   ⚠️ 拿真实一轮验,不构造。

## 5. 不涉及

- **不改 MCP 的 `planOnly` 语义** —— 返回 `status: "preview"` 是正确且明确的,
  缺陷在读法不在返回值。
- 不改孤儿收敛器(本次判 `failed` 是正确行为)。
- 不改 `coagenthub-codex` 仓(另一个 repo,本票只动本仓 `skills/`)。
- 不追溯已 failed 的 `01a05e17-7b49`(已由检视者重发 `01a05e1b-b57a`)。
