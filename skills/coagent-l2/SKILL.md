---
name: coagent-l2
description: 以 L2 主控身份操作 CoAgentHub 的两层协作 Mission（coordinationMode 为 direct）：本会话负责计划、契约核对、冻结工单、派发、逐条验收与交卷，平台只跑执行者。与 coagent-l3 技能一起使用。用户提到 direct、主控、两层协作、当前会话主控时使用。
---

# CoAgentHub：L2 主控（direct 模式）

这是入口，不是规则本身。**规则在 [docs/direct-controller.md](../docs/direct-controller.md)，先完整读一遍**，冲突时听它的；这里不复述它的条款。

## 什么时候用

Mission 建成 `coordinationMode: "direct"` 且本会话是主控时。**direct 模式 = 两个技能一起看**：本技能管主控的活（L2 职责：计划、契约核对、冻结工单、派发、逐条验收），[coagent-l3](../coagent-l3/SKILL.md) 管终审、边界与红线。平台只跑执行者，不派协调者模型；主控动作复用协调者业务权限，留痕 `direct.controller_action`。

## 操作顺序

`coagenthub_create_mission`（显式传 `coordinationMode: "direct"`，冻结契约）→ `coagenthub_direct_control`：`plan` → `contract_check` → `create_work_item` → `dispatch` → `coagenthub_start_mission` 跑执行者 → 平台等你（`waiting_l3`）时逐条 `review`。

- 工单要带非空的结构化 `validation.commands`（argv 加 `timeoutMs`）；只有 `verification` 文字说明不能当机器验证依据。
- `review` 的 accept 用**当前受评 Attempt** 的可信机器验证报告；旧提交的报告或调用方自报的 `passed: true` 都不算。reject 必须写 `requiredChanges`。

## 等执行者时不要密查

direct 模式在执行者跑完、平台停在 `waiting_l3` 等主控验收时**不发通报**（升级和交卷仍会进收件箱）。派发并 `coagenthub_start_mission` 开跑之后：

- **Claude**：用 Bash 的后台模式跑 `node scripts/coagent.mjs watch <missionId>`，退出即唤醒。
- **其他宿主（含 Codex）**：每 5 分钟以上只读一次 `coagenthub_get_mission_live`（可选 `cursor`；不消费、不 ACK 投递）。不要 45 秒一查，不要在一轮里 sleep 再轮询。

## 收尾有两步，缺一不可

1. 全部工单验收后，以主控身份 `coagenthub_direct_control` 的 `submit` 交卷——提交不等于合入；
2. Mission 进入 `awaiting_review` 后，换回 [coagent-l3](../coagent-l3/SKILL.md) 走终审签字。终审的核查清单是签字的前置，不是停下来的理由。

平台不会替你自动做任何一步。**若本会话只当主控**（终审由另一个检视者会话负责），`submit` 之后就是本会话的收尾：报告交卷完成、把终审留给检视者会话，不要再动终审。

## 边界

- 在途需求变化先由你确认，等当前执行与验证安全结束后再修订、派发；需要平台自动协调变化的任务建 hierarchical。
- 你的主控用量平台看不见：平台只记执行者费用，费用视图不代表这单的全部成本。
- 红线与 coagent-l3 相同：不编 `confirmedBy`；平台读回来的才是事实；你判断与验收，不代 L1 写代码——缺活就打回并写明问题。
