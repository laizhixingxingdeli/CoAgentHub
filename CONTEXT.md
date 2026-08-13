# CoAgentHub — 项目上下文

> 单上下文布局:本文件 + `docs/adr/` 是本仓库的领域文档锚点(见 AGENTS.md)。

## 是什么

CoAgentHub 是一个**局域网规模的多 agent 协作中枢**:agent 注册身份、加入任务群组、
按角色路由交换消息、通过 P2P 信令交接文件。它只做协作调度与消息信令,不代理文件字节。

## 领域词汇(ubiquitous language)

| 词 | 含义 |
|---|---|
| **agent** | 一个可调度的 AI 工具/身份(名字唯一,token 后端管理);agent 与角色解绑 |
| **group(表名 groups)** | 一个任务/项目 = 一个群;创建者自动成为 coordinator |
| **group_members.prompt** | 群内成员自定义提示词:该 agent 在本群的分工说明,调度时拼进任务书 |
| **audience** | 消息投递范围:`broadcast` / `role`(audienceRef=角色名) / `agent`(audienceRef=agentId) |
| **group_message + closure** | 消息与闭包表(消息树,`depth`=根到该消息的层级) |
| **task** | 一次执行:定向消息命中执行器 → 建 task → 串行队列 spawn → done/failed |
| **checkpointRef** | 执行前 git 快照(`refs/coagenthub-cp/<taskId>`),回滚用 |
| **executor_config** | 执行器配置(DB 持久化;内置在 `lib/executors.ts`) |
| **Local User** | 无 token 请求的默认身份(human,全可见);局域网信任模型 |
| **群记忆** | 按群的滚动摘要 + 最近窗口 + 本群分工(assistant-agent) |
| **项目记忆** | 群绑定 `project_path` → 读取仓库文档(静态记忆) |

## 运行拓扑

```
Web (:3000, serve.mjs) ──/api 反代+WS──► Server (:3001, Hono)
                                            │  PostgreSQL (coagenthub 库)
                                            ├─ spawn 执行器 CLI(atomcode/codebuddy/reasonix/hermes)
                                            ├─ A2A gateway(Win Hermes, 远端)
                                            └─ webhook/WS 通知
assistant-agent.mjs ──轮询 ?after= ──► Server(按群记忆 + 项目文档应答)
```

## 关键决策

见 `docs/adr/`:闭包表消息树、局域网信任模型、单调度器执行器、两级记忆、角色解绑。
