# ADR-0007: Core/Host 职责边界 — Durable Task Completion Events

**状态**:已接受(2026-08)

## 背景

CoAgentHub core 提供平台无关的持久化 task completion event,但宿主(Codex、dsh、
其他 Agent 客户端)各有自己的会话恢复机制。需要明确 core 与宿主各自负责什么,
避免能力重叠或遗漏。

## 决策

- **Core 负责**:
  - task 首次进入终态时持久化一个 `task_completion_event`(数据库 trigger 保证);
  - 保存 opaque `callbackRef` 路由信息(只允许 `{ platform?, endpointRef?, sessionRef? }`,
    不执行 URL、命令或平台 SDK);
  - 提供 participant-scoped inbox + claim/lease/ack/fail 协议交付;
  - WS 发轻量 `task_completion_available` 帧(仅低延迟提示,不作为可靠来源);
  - 读取或 claim 时联表读取当前 task,保证返回最终 `diffSummary/outputTail`。
- **宿主负责**:
  - 按 `eventId` 实现最终副作用幂等(核心只提供至少一次交付);
  - 把标准事件交给自己的会话恢复机制(Codex 用本地 command-template driver,
    dsh 用 host-native `agent.followup` driver);
  - 没有主动注入能力的 Agent 在 turn 开始时读取 inbox;
  - 命令模板和凭据留在宿主本地配置(callbackRef 不携带可执行内容或 secret)。

## 后果

- 新 Agent 通常只需配置通用 driver,不需要修改 CoAgentHub core;
- core/宿主重启后 completion event 仍可恢复投递,也能审计失败和 dead-letter;
- 无法保证第三方 Agent 宿主的 exactly-once,宿主必须持久化 eventId 去重;
- 信封明确标记 executor 输出为不可信数据,宿主必须在 Post-Flight 前重新验证。

## 关联

- 数据模型:`packages/backend/database/src/schema/task-completion-event.ts`
- 规范:`specs/durable-task-completion-events.md`
- 消费者:`specs/callback-agent-command-driver.md`、`specs/dsh-durable-task-completion-consumer.md`
