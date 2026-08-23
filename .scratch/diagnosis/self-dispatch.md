# 自派任务诊断（2026-08-23）

## 范围与证据

本次只从当前指令与代码判断，不经平台下发任务，且 `outputTail` 已随后端重启丢失。

- 已核实的 task `01a02cc0-b842-76ee-918a-2a683b90b9ae` 中，触发
  `group_message.sender_id` 与 `task.executor_participant_id` 相同；目标是群内
  coordinator 角色的 Codex participant，而 AtomCode executor 当时空闲、健康。
- `skills/coordinator/SKILL.md` 原 §2 的普通 Dispatch 规则只要求调用方提供
  executor；它没有规定初次下发时必须枚举候选、排除自己的 participant ID，或在无
  他人可用时停止。§2.2 仅在已经收到限额错误后说“查群内其余执行器”，因此不能约束
  初次选择，也不能证明这一次是初派还是限额后的改派。
- §3.5 只要求确认目标 executor 的 `coagenthub-executor` skill 已加载；它不读取
  `participant.capabilities`，也没有把 capabilities 当作候选过滤条件。因此
  AtomCode 的 capabilities 为 `[]` 不是能解释这次变化的变量。
- `/Users/apple/Projects/coagenthub-codex/mcp-server/src/tools.ts` 的
  `coagenthub_dispatch_task` 接收调用者提供的 `executorParticipantId`，随后原样作为
  `audienceRef` POST；没有比较该值与下发者身份，也不选择候选。
- 平台的 `packages/backend/server/src/routes/group/messages.ts` 已同时取得
  `senderId` 和定向 `audienceRef`，并会识别 executor target、验证发送者权限，随后把
  两者交给 `maybeDispatchExecutorTask`。这里没有 `senderId === audienceRef` 的拒绝或
  警告，所以会创建自派 task。

## 结论

**不能定论这两次事件中调用方为什么给出了自己的 participant ID。**决策过程的原始
`outputTail` 已丢失，现有事实不能区分“初次选择遗漏了空闲执行器”“限额改派时错误地把
自己当成候选”或调用参数被人为/运行时错误填入。

但可定论系统有三层可复发缺口：coordinator skill 对初次目标选择缺少明确排除自身的
规则；MCP 工具完全信任调用方给出的目标；平台明知 sender 与 target 却没有安全护栏。
这三者叠加意味着一次错误目标选择会无提示地变成实际自派任务。`capabilities=[]`
不是本次根因的有效解释。

## 本次已实现

在 coordinator 的 Dispatch 规则中补了初派与改派共同的目标选择约束：先读取群成员和
任务状态，候选必须是非自身的 executor；没有健康、空闲的非自身 executor 时，必须在群
内报告阻塞而不是自派。该修改只收紧协调者指令，符合现有 §2.2 “其余执行器”的语义，且
不改变平台 API 或已有 task 数据。

## 建议由检视者立票的防护

1. 平台：对“coordinator 发送给同一 participant 的 executor task”至少给出稳定、可由
   MCP 消费的 `SELF_DISPATCH` 信号；是否直接拒绝需先决定单 participant / 故意本地执行
   是否是受支持场景。直接拒绝可能破坏这种场景，不能在无产品决策时作为低风险改动落地。
2. MCP：工具应在下发前读取当前 participant、群成员和任务状态，并拒绝或要求显式确认
   自派；这需要定义工具如何取得可靠的“当前 participant”身份及无空闲 executor 的交互。
3. 可观测性：task 持久化或 audit event 应记录“目标选择原因、候选、选择者”，不能只依赖
   内存 `outputTail`。有了该记录才能对下一次事件定因。
