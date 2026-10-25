---
name: coagent-l2
description: 以 L2 主控身份操作 CoAgentHub 的两层协作 Mission（coordinationMode 为 direct）：本会话负责计划、契约核对、冻结工单、派发、逐条验收与交卷，平台只跑执行者。与 coagent-l3 技能一起使用。
---

# CoAgentHub：Claude 当 L2 主控（direct 模式）

这是入口，不是规则本身。**规则在 [docs/direct-controller.md](../../../../docs/direct-controller.md)，先完整读一遍**，冲突时听它的；这里不复述它的条款。

## 什么时候用

Mission 建成 `coordinationMode: "direct"` 且本会话是主控时。**direct 模式 = 两个技能一起看**：本技能管主控的活（L2 职责：计划、契约核对、冻结工单、派发、逐条验收），[coagent-l3](../coagent-l3/SKILL.md) 管终审、边界与红线。平台只跑执行者，不派协调者模型；主控动作留痕 `direct.controller_action`。

## 收尾有两步，缺一不可

1. 全部工单验收后，以主控身份 `coagenthub_direct_control` 的 `submit` 交卷——提交不等于合入；
2. Mission 进入 `awaiting_review` 后，换回 [coagent-l3](../coagent-l3/SKILL.md) 走终审签字。终审的核查清单是签字的前置，不是停下来的理由。

平台不会替你自动做任何一步。
