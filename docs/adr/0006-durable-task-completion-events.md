# ADR-0006:平台无关的持久化 task completion event

**状态**:已接受(2026-08)

## 背景

Skill 只在 Agent turn 内提供指令，不能常驻等待执行器完成。Codex 可通过 CLI 恢复
task，dsh 可通过 `agent.followup` 恢复 session，但这些能力属于宿主；如果每个插件
各自轮询 task，进程退出会丢通知，重试和去重语义也会漂移。

## 决策

- CoAgentHub core 在 task 首次进入终态时持久化一个平台无关 completion event。
- event 通过 participant-scoped inbox + claim/lease/ack/fail 协议交付；WS 只负责
  低延迟提示，不作为可靠来源。
- core 只保存 opaque `callbackRef` 路由信息，不执行 URL、命令或平台 SDK。
- event 读取时联表取得最新 task 详情，避免终态切换瞬间固化陈旧输出。
- 外部交付采用至少一次语义；core 用 task 唯一 event 和 lease 降低重复，宿主按
  `eventId` 实现最终副作用幂等。
- Codex 使用本地 command-template driver；dsh 使用 host-native
  `agent.followup` driver；没有主动注入能力的 Agent 在 turn 开始时读取 inbox。

## 后果

- 新 Agent 通常只需配置通用 driver，不需要修改 CoAgentHub core。
- core/宿主重启后 completion event 仍可恢复投递，也能审计失败和 dead-letter。
- 无法保证第三方 Agent 宿主的 exactly-once；宿主必须持久化 eventId 去重。
- callbackRef 不能携带可执行内容或 secret，命令模板和凭据必须留在宿主本地配置。

