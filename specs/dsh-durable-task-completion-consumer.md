# Spec: dsh Durable Task Completion Consumer

## 背景

dsh-coagenthub 已能通过 `Agent.followup(UserMessage)` 主动唤醒原 session，但当前
`TaskWatcher` 依赖 WS 帧和逐 group task 轮询；插件退出期间的终态只能靠重新观察
task 猜测，且本地 notification queue 不是 durable。CoAgentHub core 提供 durable
task completion inbox 后，dsh 应把它作为终态通知的唯一可靠来源，保留 WS 作为
低延迟提示和 `agent.followup` 作为 host-native sink。

本 Spec 依赖 `specs/durable-task-completion-events.md` 全部验收通过。

## 改动范围

- 在 dsh-coagenthub client 增加 completion event list/claim/ack/fail 方法和类型。
- `TaskWatcher` 对终态通知改为：
  - 收到 `task_completion_available` WS 帧时立即触发一次 inbox consume。
  - 使用低频 timer 查询 inbox 作为 WS 丢失/重连的可靠兜底。
  - 不再逐 group 拉取 task 并通过内存 `previousStatuses` 推断终态。
  - stall 等非终态即时通知继续使用现有 WS 路径，不进入 completion inbox。
- consumer 使用稳定、非 secret 的本地 `consumerId` 和 lease；只消费当前插件
  participant 的事件。
- 将标准 event 转成带 `eventId` 的 `CoAgentHubNotification`，优先按
  `dispatcherSessionId` 找 live agent，再按 participant+group 和 cwd 规则回退。
- `agent.followup` 成功后，先把 eventId 原子记录到有界本地 dedupe store，再 ack；
  ack 失败重试时不得再次 followup。dedupe 至少保留最近 1000 个 eventId。
- 找不到 live agent、followup 抛错或 host 不支持 agents registry 时，不得仅写入
  进程内 queue 后 ack；调用 fail/等待 lease 过期，使事件继续保留在 core inbox。
- `coagenthub_get_notifications` 增加 durable catch-up：没有主动唤醒能力时，由当前
  session 调用工具 claim 与其 session/group 匹配的 event，返回标准通知并完成
  dedupe + ack。其他 session/group 的事件不得被误领或 ack。
- 对尚未提供 completion inbox API 的旧 CoAgentHub server，返回明确兼容状态；
  是否保留旧 watcher fallback 由实现选择，但不得造成新旧链路双重通知。

## 验收标准

- [ ] WS 提示触发 consume，WS 完全丢失时 timer 仍能消费并 followup。
- [ ] 插件停止期间产生 event，插件重启后能从 core inbox 恢复并注入原 session。
- [ ] `dispatcherSessionId` 命中指定 live agent，其他 session 不收到通知。
- [ ] 两个 consume 并发时 lease 保证只有一个 followup。
- [ ] followup 成功、ack 首次失败并重启后，只补 ack，followup 总次数为 1。
- [ ] 无 live agent、followup error、agents registry 缺失时 event 保持可重试，
      不被错误 ack。
- [ ] `coagenthub_get_notifications` 只处理当前 session/group 可见事件，返回后 ack；
      不泄漏或确认其他会话事件。
- [ ] 终态不再依赖逐 group `listTasks` 和 `previousStatuses` 推断；非终态 stall 行为保持。
- [ ] 新旧 server 兼容测试、全部 plugin tests、typecheck、build 通过。
- [ ] README/版本说明解释 durable inbox、followup 和手动 catch-up 三层语义。

## 不涉及的改动

- 不把 `agent.followup` 移到 CoAgentHub core 或通用 callback agent。
- 不让服务端保存 dsh Agent 句柄、命令、URL 或凭据。
- 不修改 CoAgentHub scheduler、task 终态和 dsh session 数据模型。
- 不用进程内 notification queue 冒充跨重启持久化存储。

