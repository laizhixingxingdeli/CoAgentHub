# 当前会话主控的两层协作

两层协作由当前会话负责分析、计划、冻结工单和验收，执行者负责修改代码、提交证据。平台不再自动启动一个独立的协调者模型；工单、执行记录、验证、费用门禁和最终合入流程仍由平台管理。

`coordinationMode` 表示由谁主控，与 `executionMode` 分开：

| 字段 | 值 | 含义 |
| --- | --- | --- |
| `coordinationMode` | `hierarchical` | 原来的平台协调者模式；旧记录和未指定时的默认值 |
| `coordinationMode` | `direct` | 当前外部会话担任主控，平台只自动运行执行者 |
| `executionMode` | `lightweight` / `standard` / `high_assurance` | 既有执行与验证等级，不新增 `direct` 值 |

第一版两层协作支持 `standard`、`mutation` Mission。它不把高保证任务降为普通任务，也不跳过最终检视；主分支合入仍需要用户批准。协作方式在创建时确定，不能通过工单或执行者工具中途更换。

direct 也不会启动可选影响监督中的协调者模型；这类协调判断由当前会话承担。在途需求变化应先由主控确认，待当前执行与验证安全结束后再修订、派发。需要平台自动协调这些变化的任务，可在创建时选择 hierarchical。

## MCP 操作顺序

1. 当前会话分析需求，冻结 Contract，通过 `coagenthub_create_mission` 创建任务，显式传 `coordinationMode: "direct"`。投递目标仍使用真实绑定的会话。
2. 使用 `coagenthub_direct_control` 写入 Plan、契约核对和 Frozen WorkOrder，再派发工单。工单应包含非空 `validation.commands`（结构化的 `argv` 与 `timeoutMs`）；只有 `verification` 文字说明不能作为机器验证依据。
3. 使用现有 `coagenthub_start_mission` 启动执行者。HTTP 受理不表示执行完成，应继续读取 hosted run、Mission、活动和验证报告。
4. 执行和机器验证后，平台以 `waiting_l3` 等待当前主控，不自动另起协调者或自动安排返工。
5. 主控阅读当前提交、差异、证据及对应验证报告，逐条给出 accept / reject。reject 必须说明 requiredChanges；需要返工时由主控修订、派发并再次启动。
6. 所有目标完成后，主控提交 Mission Result，任务进入既有最终检视流程。提交结果不等于合入，更不等于合入 master。

创建示例：

```json
{
  "projectId": "your-project",
  "missionId": "your-direct-mission",
  "coordinationMode": "direct",
  "contract": {
    "intent": "修复已定位的问题",
    "acceptance": ["明确、可验证的验收条件"],
    "constraints": [],
    "nonGoals": [],
    "guardrails": []
  }
}
```

主控工具的外层参数是 `missionId` 和 `command`；`command.action` 支持：

| action | 内容 |
| --- | --- |
| `plan` | `plan`：沿用 PlanBody，记录 findings、direction、decisions、risks 等 |
| `contract_check` | `check`：核对契约，含 verdict、summary、issues（可选） |
| `create_work_item` | `title`、`order`、`workItemId`（可选）：创建冻结工单 |
| `revise_work_order` | `workItemId`、`order`：在原有状态规则内修订工单 |
| `dispatch` | `workItemIds`：派发已冻结工单，仍需通过契约核对和项目名额门禁 |
| `review` | `workItemId`、`verdict`、`reasons`、`requiredChanges`、`acceptanceResults`：逐条验收 |
| `submit` | `result`：沿用 MissionResultBody，提交完整交付结果 |

例如写入计划：

```json
{
  "missionId": "your-direct-mission",
  "command": {
    "action": "plan",
    "plan": {
      "findings": "已核实的代码事实",
      "rejectedHypotheses": [],
      "decisions": ["已决定的实现方式"],
      "direction": "先完成冻结范围内的修复，再运行指定验证",
      "risks": []
    }
  }
}
```

## 责任、证据与恢复

主控操作复用现有协调者业务权限，以外部主控的管理动作留痕；这不表示平台调用了另一个协调者模型。主控模型由宿主会话选择，不由平台的协调者候选池派发。平台无法获知当前宿主会话的模型用量，不把未知用量或费用填成零；平台显示的费用不能代表宿主会话与执行者的全部费用。执行者的真实调用继续由现有运行时与 Langfuse 观测。

主控 accept 需要当前受评 Attempt 对应的可信机器验证报告，不能使用旧提交的报告或调用方自报的 `passed: true`。机器验证通过也不替代主控的逐条验收。

HTTP 控制面遵守现有权限策略。执行者 Run Token 不是主控凭据；接口不会向主控调用方发放一张伪造的协调者 Run Token。既有本机控制面的安全假设保持不变，不能把角色门禁理解成对本机任意进程的隔离。

主控会话中断后，Mission、工单和验证记录仍保留。恢复时先读权威 Mission 和当前运行状态，再决定继续验收还是再次派发；不要把 hosted 请求断开当作执行者已停止。平台不会因为主控离线而擅自换成另一个协调者模型。通过既有 rerun 创建派生 Mission 时，也保留原任务的协作方式。

## 启用

平台代码需要服务重新加载后生效，MCP 工具需要构建并由宿主重新加载相应服务器。合并代码本身不会重启服务。已有三层任务不会因升级自动转换为两层任务。
