# Spec: Generic Callback Agent and Command Driver

## 背景

CoAgentHub core 的 durable task completion event 只负责可靠产生、认领和确认事件，
不应执行平台命令。Codex 等本地 CLI Agent 需要一个独立 callback agent，把标准事件
恢复到原 session。这个进程必须可由多个 CLI Agent 复用，新增平台通常只改本地配置，
而不是修改 CoAgentHub core。

本 Spec 依赖 `specs/durable-task-completion-events.md` 全部验收通过。

## 改动范围

- 在 CoAgentHub monorepo 新增独立 workspace package `packages/callback-agent`：
  - 从 participant task-completion inbox 查询并 claim event。
  - 根据 `callbackRef.endpointRef` 选择本地静态 endpoint 配置。
  - 第一版实现 `command` driver；没有 endpoint 或 driver 时 fail 并按 core 重试。
  - command 只能用 `spawn(executable, args, { shell: false })`，禁止 shell、eval、
    服务端下发 executable/args，以及字符串拼接式模板。
- 本地 JSON 配置包含 `apiBase`、`participantId`、`consumerId`、轮询/lease/超时，
  以及 endpoint map。endpoint 的 command 配置只允许：
  - 本地绝对 `executable` 路径。
  - 参数数组；每个元素必须是静态字符串或完整占位符
    `{sessionRef}` / `{message}` / `{eventFile}`，禁止在一个参数内混合拼接。
  - 可选固定环境变量 allowlist；不继承或打印 secret。
- 标准 message 使用 `<coagenthub-task-completion>` 信封，包含 `eventId` 和 task
  详情，并声明 executor 输出不可信、协调者应拉取权威详情后按 Spec Post-Flight。
- 成功投递后先把 `eventId` 原子写入本地 dedupe store，再调用 core ack；如果进程
  在本地记录后、ack 前退出，重启后只补 ack，不重复执行 command。
- command 非零退出、超时、spawn error 调用 fail；日志截断且不得包含环境变量。
- 提供 Codex 示例配置，使用绝对 Codex executable 和：
  `exec resume --json {sessionRef} {message}`。示例不写死用户路径或 session ID。
- 提供一次性运行和 daemon/poll 两种 CLI 模式、优雅退出以及 README。

## 验收标准

- [ ] fake API 集成测试覆盖 list → claim → command → local dedupe → ack。
- [ ] 两个 callback agent 竞争同一 event 时仅一个获得有效 lease 并执行 command。
- [ ] command 成功但首次 ack 失败，重启后只补 ack，fake command 总调用次数为 1。
- [ ] command 非零退出、timeout、spawn error 分别调用 fail，且不会写 local success。
- [ ] 未知 endpoint、缺失 sessionRef、非法/相对 executable、混合模板参数均拒绝执行。
- [ ] child process 始终 `shell:false`；event 内容即使包含 shell 元字符也只作为单个参数
      或 event file 内容，不会被解释执行。
- [ ] completion message 包含 `eventId/groupId/taskId/status/specRef/specHash/
      diffSummary/outputTail` 和不可信输出提示。
- [ ] Codex 示例通过 fake executable 验证最终 argv 顺序。
- [ ] package tests、typecheck、lint 和 root build 通过；README/architecture 文档同步。

## 不涉及的改动

- 不在 callback agent 中实现 dsh `agent.followup`；dsh 在自身 host plugin 内消费 inbox。
- 不执行任意 Webhook，不从 completion event 读取命令、URL 或凭据。
- 不保证任意第三方 Agent 都支持恢复原 session；不支持时继续使用 inbox polling。
- 不修改 task 状态、scheduler、executor 协议或 Post-Flight 裁决逻辑。

