# CoAgentHub — 项目上下文

> 单上下文布局:本文件 + `docs/adr/` 是本仓库的领域文档锚点(见 AGENTS.md)。

## 是什么

CoAgentHub 是一个**局域网规模的多 participant 协作中枢**:participant 注册身份、加入任务群组、
按角色路由交换消息、通过 P2P 信令交接文件。它只做协作调度与消息信令,不代理文件字节。

## 领域词汇(ubiquitous language)

| 词 | 含义 |
|---|---|
| **participant** | **参与者身份**(原名 agent,2026-08 改名,旧 API `/api/agents` 与 `audience=agent` 仍兼容):任何想参与群聊的主体——人、CLI 工具、常驻脚本、AI bot——都统一注册成一个 participant(名字唯一,`token_hash` 列保留待删,token 认证已移除)。不是「AI 智能体」,平台不内置 AI;与角色解绑 |
| **group(表名 groups)** | 一个任务/项目 = 一个群;创建者自动成为 coordinator |
| **group_members.prompt** | 群内成员自定义提示词:该 participant 在本群的分工说明,调度时拼进任务书 |
| **audience** | 消息投递范围:`broadcast` / `role`(audienceRef=角色名) / `participant`(audienceRef=participantId) |
| **group_message + closure** | 消息与闭包表(消息树,`depth`=根到该消息的层级) |
| **task** | 一次执行:定向消息(`audience=participant`)命中执行器 → server 直接建 task → 按 project_path 分组队列 spawn(同项目串行、跨项目并行)+ 按执行器并发能力排队(可选 `maxConcurrency` 上限 / `403 atomgit_session_concurrency_conflict` 反应式排队)→ done/failed。可选 callback 路由(`callbackRef` = `{ platform?, endpointRef?, sessionRef? }` 三个短字符串,不存 URL/token/命令/secret)随任务持久化 |
| **checkpointRef** | 执行前 git 快照(`refs/coagenthub-cp/<taskId>`),回滚用 |
| **callbackRef** | 可选 opaque 路由信息,只允许 `{ platform?, endpointRef?, sessionRef? }` 三个短字符串(≤200 字符),不存 URL/token/命令/secret。task 首次进入终态时由 DB trigger 据此创建 completion event,宿主按 callbackRef 恢复会话 |
| **completion event** | Durable Task Completion Event:task 首次从非终态进入 done/failed/cancelled 时,若存在 dispatcherParticipantId,由 DB trigger 在 task 同事务内持久化到 `task_completion_event` 表(task_id 唯一约束保证幂等)。状态机 `pending → leased → delivered → dead`,participant-scoped inbox + claim/lease/ack/fail API 交付 |
| **inbox** | participant-scoped completion event 视图:`GET /api/participants/:id/task-completion-events` 查询 pending/可重试/lease 已过期的事件(可靠性来源始终是数据库 inbox,WS 仅低延迟提示) |
| **executor_config** | 执行器配置(DB 持久化;内置在 `lib/executors.ts`) |
| **Local User** | 无身份声明请求的默认身份(human,全可见);局域网全信模型 |
| **项目记忆** | 群绑定 `project_path` → 读取仓库文档(静态记忆) |

## 运行拓扑

```
Web (:3000, serve.mjs) ──/api 反代+WS──► Server (:3001, Hono)
                                            │  PostgreSQL (coagenthub 库)
                                            ├─ spawn 执行器 CLI(atomcode/codebuddy/reasonix/hermes)
                                            ├─ A2A gateway(Win Hermes, 远端)
                                            └─ WS 通知 / ?after= 增量拉取
```

实现布局(2026-08 架构审视后):`routes/group/` 按职责拆为 groups/members/messages/tasks 子路由 +
`helpers.ts`(共享守卫,API 路径/响应不变);`lib/executor-task/` 拆为 types/state/output-buffer/notify/
report/queue 六个子模块(barrel 导出面不变,`@server/lib/executor-task` 导入兼容);统一配置读取收敛在
`lib/config.ts`(CORS_ORIGIN / FILE_DIR / MAX_FILE_UPLOAD_BYTES / PORT);`participant.token_hash` 列为
已知历史遗留(token 认证已移除),**不删除**,标记 deprecated 待删。

## 关键决策

见 `docs/adr/`:闭包表消息树、局域网信任模型、单调度器执行器、两级记忆、角色解绑。

## Spec-Driven Task Dispatch (规范驱动任务下发, 2026-08-18)

协调者在完全确定实现方案前不允许下发任务。任务可携带 `specRef`（规范文档路径）
和 `specHash`（版本哈希）字段,任务书模板自动插入"关联规范"段,执行器严格按 Spec 实现。
任务书模板包含"Code Review 自检"段,执行器完成前必须按 checklist 自检(Standards + Spec Compliance)。
Spec 文档位于 `specs/` 目录。Skills 位于 `skills/` 目录(coordinator/bugfix/executor)。
详见 `specs/spec-driven-task-dispatch.md` 和 `specs/plugin-skill-adaptation.md`。
