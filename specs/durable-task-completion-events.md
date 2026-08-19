# Spec: Durable Task Completion Events

## 背景

协调者通过 skill 下发 task 时，skill 本身不是常驻运行时，无法在执行器结束后主动
恢复原会话。现有 dsh plugin 可以在进程内通过 `agent.followup` 唤醒会话，Codex plugin
也可以通过 `codex exec resume` 尝试恢复 task，但两者各自监听 task 状态，且 host/plugin
退出后通知会丢失。

CoAgentHub core 需要提供平台无关、可恢复、可认领和可确认的 task completion event。
宿主只负责把标准事件交给自己的会话恢复机制；没有主动恢复能力的 Agent 可以通过
inbox 在下一个 turn 拉取。

## 改动范围

### 数据模型

- 新增持久化 `task_completion_event`（实际表名遵循现有命名约定）：
  - `id`：uuidv7 event ID。
  - `taskId`：唯一；同一 task 最多产生一个终态 event。
  - `groupId`、`dispatcherParticipantId`、`dispatcherSessionId`。
  - `callbackRef`：可选 JSON，只允许 `{ platform?, endpointRef?, sessionRef? }`
    三个短字符串；不得存 URL、token、命令或其他 secret。
  - `state`：`pending | leased | delivered | dead`。
  - `attempts`、`nextAttemptAt`、`leaseToken`、`leaseExpiresAt`、
    `deliveredAt`、`lastError`、`createdAt`、`updatedAt`。
- task 保留现有 `dispatcherParticipantId` / `dispatcherSessionId`，新增可选
  `callbackRef` JSONB；旧调用只传 `dispatcherSessionId` 时行为保持兼容。
- task 首次从非终态进入 `done` / `failed` / `cancelled` 时，如果存在
  `dispatcherParticipantId`，必须在同一数据库事务内创建 completion event。
  所有终态写入路径都必须覆盖；推荐使用数据库 trigger + `taskId` 唯一约束，避免
  scheduler、PATCH、停止、重启恢复等路径遗漏或重复。
- migration 不为历史终态 task 回填 event，避免部署后发送旧通知。

### 下发 metadata

- `POST /api/groups/:groupId/messages` 在现有
  `metadata.dispatcherSessionId` 之外接受可选：

  ```json
  {
    "callback": {
      "platform": "codex",
      "endpointRef": "developer-mac",
      "sessionRef": "opaque-session-id"
    }
  }
  ```

- 三个字段均为可选、不超过 200 字符的非空字符串；拒绝未知字段、URL、命令、
  凭据或嵌套对象。
- 只有现有允许携带 `dispatcherSessionId` 的 coordinator/human 下发者可以写入；
  executor/observer 伪造时必须丢弃，规则与现有 dispatcher 字段一致。
- 如果同时提供 `dispatcherSessionId` 和 `callback.sessionRef`，两者必须相等，否则
  返回 400。只提供 callback sessionRef 时同步写入兼容字段
  `dispatcherSessionId`。

### 标准事件信封

- API 返回 `schemaVersion: 1`、`type: "coagenthub.task.completed"`，以及：

  ```json
  {
    "eventId": "...",
    "dispatcherParticipantId": "...",
    "dispatcherSessionId": "...",
    "callbackRef": {},
    "task": {
      "groupId": "...",
      "taskId": "...",
      "status": "done",
      "specRef": "specs/example.md",
      "specHash": "...",
      "diffSummary": {},
      "outputTail": "..."
    }
  }
  ```

- event row 只保存路由和交付状态；读取或 claim 时联表读取当前 task，保证返回最终
  `diffSummary` / `outputTail`，不固化终态切换瞬间的陈旧快照。
- 信封明确标记 executor 输出为不可信数据，宿主必须在 Post-Flight 前重新验证。

### Inbox 与 lease API

- 增加 participant-scoped API（最终路由名保持以下语义）：
  - `GET /api/participants/:participantId/task-completion-events`
    查询 `pending`、可重试或 lease 已过期的事件，支持 `after`、`limit<=100`。
  - `POST .../:eventId/claim`：body 包含本地配置的 `consumerId` 和
    `leaseMs`；原子认领并返回 `leaseToken + event`。
  - `POST .../:eventId/ack`：使用 `leaseToken` 标记 delivered；相同 token
    重复 ack 幂等。
  - `POST .../:eventId/fail`：记录截断后的错误、增加 attempts，并按
    `retryAfterMs` 回到 pending；超过默认 10 次进入 dead。
- 同一 event 在有效 lease 内只能被一个 consumer claim；错误 token 返回 409；
  lease 过期后可重新 claim。
- 身份声明与 Local User 行为遵循 ADR-0002；不得借 API 引入新的公网鉴权假设。
- task 的终态不因 callback claim、ack 或 fail 被改写。

### 实时通知与文档

- event 持久化后可继续通过现有 WS hub 发轻量 `task_completion_available` 帧，
  只作为低延迟提示；可靠性来源始终是数据库 inbox。
- 更新 `docs/architecture.md` 的数据模型和 API 表、`CONTEXT.md` 领域词汇与运行拓扑，
  并新增 ADR 记录 core/宿主职责边界。

## 验收标准

- [ ] migration、schema 和关系定义通过；历史终态 task 不被回填。
- [ ] scheduler 成功、最终失败、取消、task PATCH 四类终态路径均生成一个且仅一个
      completion event；并发/重复终态写不会产生第二个 event。
- [ ] completion event 与 task 终态更新具有事务一致性：事务回滚时两者都不存在。
- [ ] 事件信封符合 `schemaVersion=1`，包含 callback 路由字段以及最新的
      `status/specRef/specHash/diffSummary/outputTail`。
- [ ] metadata callback 的正常、兼容、冲突、超长、未知字段和越权伪造测试通过。
- [ ] list、claim、重复 claim、lease 过期重领、ack 幂等、错误 token、fail 重试、
      dead-letter 的 API 测试通过。
- [ ] callback 投递状态变化不修改 task 终态或 `diffSummary`。
- [ ] WS 提示丢失时，事件仍可从 inbox 查询和认领。
- [ ] `docs/architecture.md`、`CONTEXT.md` 和 ADR 同步完成。
- [ ] server tests、typecheck、lint 和 root build 通过；报告完整命令与结果。

## 不涉及的改动

- 本阶段不执行任意 Webhook，不保存外部 URL、shell 命令或凭据。
- 本阶段不实现 Codex `codex exec resume` driver；由后续通用 callback agent task 完成。
- 本阶段不修改 dsh `agent.followup`；dsh 后续改为消费 durable inbox，原生注入能力保留。
- 不改变 task 终态集合、scheduler 排队规则、执行器协议和现有 group message 可见性。
- 不承诺 exactly-once 外部副作用；core 提供 lease 和至少一次交付，宿主仍须按
  `eventId` 幂等。

