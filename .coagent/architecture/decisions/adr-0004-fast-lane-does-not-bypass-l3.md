# Fast Lane（Lightweight）不绕过 L3 / 审查权威

## 取舍

Lightweight 缩短 **L2 规划与协调者自验**，不缩短 **机器验收权威** 与 **L3 最终落地权**。

不采用：validator 通过即 `completed`；Executor 自报证据视为 accept；**把任何一条 Mission 自动合进 master（或项目的默认分支）**。

## 修订（2026-09-23）：集成分支上的机器 L3

原文的「不采用：自动 merge」一刀切。无人值守按方案推进（`plan-run`）需要腾改动名额——不合进去，下一个功能就一直派发不了——于是这里收窄为：

**L3 对 master 的落地权不变；集成分支上的推进由确定性证据放行，且该证据必须独立于单条 Mission 的 validator。**

具体约束（缺一条就不是机器 L3）：

1. **只合进方案声明的集成分支**，合并前现场核对项目仓确实在它上面；master 全程不动。集成分支 → master 仍由人放行。
2. **证据是合并之后在集成分支上跑出来的方案级验证**，不是 Mission 自己那份 validator 报告。validator 管「这个功能对不对」，集成验证管「有没有打坏别人」；两者来源不同，不能互相顶替。空命令表拒绝。
3. **验证夹在 merge 与 complete 之间**，红则退回合并前并留在 `awaiting_review`；Mission 只在验证通过后 `completed`。
4. **范围只有 lightweight + standard**；high_assurance 不得由机器 L3 放行，须用户确认后由检视者签名，或由人经既有入口放行。**已由 ADR-0006 修订：人或显式配置的高保证 Principal**（当前配置为按用户常设授权登记的检视者签名）；机器 L3 仍不得放行 HA。
5. **权威记名**：`FinalReview.authority` 四类分得清——人工放行（`human`）、机器放行（`machine`，指向那份集成验证报告）、方案放弃（`plan`）、用户确认后的检视者代签（`reviewer`，含 reviewerId / confirmedBy / 平台时钟 confirmedAt）。早上看记录，能分出每一条是谁放的。检视者代签不是人亲签，不得记成 `human`。
6. **概率判断只选路，不开门**：夜间检视者只能在隔离重跑 / 跳过 / 重划剩余范围 / 停之间选，永不宣布通过、永不自己发合并；路由分类用的是只读协调者交回的事实。开门只凭第 2 条的确定性证据。**没有用户确认的（夜间）概率判断不能开门。** 与 ADR-0002 对 Decision 的定位同源。本条仍适用于分类和 Jev SHADOW（ADR-0006 未改这条）。

入口：`Platform.finalizeMissionByMachine`（见 Living Spec `machine-final-review`），只由进程内的方案驱动调用，不接 HTTP / agent tools。检视者代签入口是 `Platform.finalizeMissionByReviewer`，只给 `l3` 终审三命令进程内调用，同样不接 HTTP / agent tools。

## 为什么

1. **落地权单点。** 与项目不变量一致：未经 L3 不得 completed。Fast Lane 若可自完成，Standard/Lightweight 会分裂成两套「完成」定义，审计与回滚无从对齐。机器 L3 仍是 L3——它走同一道 `awaiting_review → completed` 闸，只是凭的是确定性证据、落的是集成分支。
2. **执行者不能自验。** ReviewAuthority 无 executor 分支；Lightweight 的 accept 必须来自 ValidationEngine 签发的 validator authority，且 durable `ValidationReport` 联动一致。
3. **交卷 ≠ 完成。** `submitLightweightMissionForReview` 只到 `awaiting_review`；merge/send_back/abandon 仍走 `finalizeMission`（含目标 HEAD 校验与 memory 同提交落地）或机器 L3。
4. **集成分支是可丢的。** 合进去的东西离 master 还隔着一道人工放行；验证红了当场退回，最坏的结果是一个功能被挂起等人，不是主干被污染。这正是 master 不行、集成分支可以的原因。

## 后果

- Lightweight trusted 方法仅进程内 Orchestrator 使用，不绑 HTTP/agent tools，降低「外部直接 accept」面。
- Standard 仍可走 coordinator review；两种权威形状并存，但最终 completed 闸门相同。
- 晋升到 Standard 后恢复协调者路径，不解除 L3。
- 集成分支上的 Mission 可以没有人签字就 `completed`；它们的 `FinalReview.authority.kind` 是 `machine`。统计「人审过多少」要按 kind 数，不能按 completed 数。
- 集成验证的可靠性成了放行的前提：flaky 的测试会让好合并被退回、白占一次未解决名额。夜跑用降并发的命令，flake 在测试侧修，不在放行侧重试。

## 什么时候该推翻它

- 产品明确允许「机器全绿即自动入主干」且接受无 L3 收据；
- 另有独立合规签署服务替代 L3（需新 ADR 定义权威移交）；
- 集成验证长期不可靠（假红 / 假绿），机器 L3 的证据不再能当门——那时应停用机器 L3，而不是给它加重试。

在那之前，「Fast Lane 就是要快到跳过人工」不是理由——快的是协调，不是落地权。
