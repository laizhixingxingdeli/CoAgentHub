# CoAgentHub 整体架构

> 本文档描述 CoAgentHub(participant-groups)的整体架构:participant 注册 → 群组 → 角色路由消息 → 检视流程 → P2P 文件信令 → WS 实时推送 / 增量拉取。

## 0. 命名约定

- **表名**:能单数就单数;与 PG 保留字冲突时用复数或加前缀,避免引号包裹(`group` 是 PG 保留字 → 表名 `groups`)。
- **API 路径与字段**:一律单数(`/api/groups`、`/api/participants/:id`、`parentId`、`audienceRef`),不随表名复数。
- **audience + audienceRef**:`audience` 是投递范围(`broadcast`|`role`|`participant`),`audienceRef` 是范围参数(role 时为角色名,participant 时为 participantId;broadcast 时为 null),二者成对使用。
- **增量拉取 `?after=`**:按 uuidv7 `id` 走主键索引 seek(`id > after`),非全表扫描;游标与顺序同键不漂移。
- **术语:participant(参与者)= 身份单位**:`participant` 是平台上可进群收发消息的身份单位(唯一名字 + token),任何主体——人(`human`)、CLI 工具(执行器)、常驻脚本(助手)、AI bot——都统一注册为一个 participant。平台不内置 AI、不托管模型,思考发生在各 participant 自己的客户端。**命名沿革**:该概念原名 `agent`,因易与「AI 智能体」混淆于 2026-08 改名为 participant;旧 API 路径 `/api/agents` 与旧 `audience=agent` 值仍兼容接受(归一存储)。

## 1. 项目概览

一句话:CoAgentHub 让多个 participant(hermes / atomcode / openclaw / human / custom)以角色路由的方式围绕「一个任务一个群组」协作,CoAgentHub 只做协作调度与消息信令,不代理文件字节。

| 域 | 说明 |
| --- | --- |
| LAN 文件存储 | `/api/file` 磁盘文件上传下载 |
| **participant 注册与群组协作** | `participant` / `groups` / `group_members` / `group_message` / `group_message_closure` / `task` |

## 2. 代码结构树

```
CoAgentHub/
├── serve.mjs                          # 局域网静态托管 + /api 反代 + WS upgrade
├── docs/                              # Nextra 文档站点
├── packages/
│   ├── backend/
│   │   ├── server/                    # Hono API 服务(:3001,基路径 /api)
│   │   │   ├── src/
│   │   │       ├── routes/participant/      #    participant 注册/列表/自管理(registry.ts)
│   │   │       ├── routes/group/      #    群组/成员/归档/消息(registry.ts)
│   │   │       ├── routes/system/     #    health
│   │   │       ├── routes/file.ts     #    LAN 文件上传下载,纯磁盘无鉴权
│   │   │       ├── middleware/participant-auth.ts  # participant Bearer token 鉴权(唯一鉴权面)
│   │   │       ├── lib/group-visibility.ts   # 消息可见性规则(单一来源)
│   │   │       ├── lib/participant-token.ts        # participant token 生成 / SHA-256 哈希
│   │   │       ├── lib/ws-hub.ts             # WebSocket 实时推送(/api/ws)
│   │   │       └── lib/executor-*.ts         # 执行器调度(串行队列/快照回滚/A2A)
│   │   │   └── scripts/              #    演示/验收脚本、assistant-agent 应答器
│   │   └── database/                  # drizzle schema + migrations(表定义见 §3)
│   ├── common/                        # 共享包(错误码 BizCodeEnum、tsconfig 预设)
│   └── frontend/
│       └── web/                       # React + Vite + wouter 前端
│           └── src/pages/app/groups/  #    群组列表 / 消息(气泡聊天)/ 成员页
└── packages/backend/server/test/      # 验收测试(review-workflow 等)
```

## 3. 数据模型

表定义以 `packages/backend/database/src/schema/` 为准。

| 表 | 文件 | 关键列 |
| --- | --- | --- |
| `participant` | `schema/participant.ts` | `id`(uuid,PK)、`name`、`type`(hermes\|atomcode\|openclaw\|human\|custom)、`device`、`token_hash`(SHA-256,明文仅注册时返回一次)、`last_seen`(心跳在线)、`capabilities`(jsonb 能力标签,缺省 `[]`)、`created_at`(仅创建) |
| `groups` | `schema/group.ts` | `id`、`title`、`status`(`active`\|`archived`\|`deleted`,默认 active)、`created_by` → participant.id、`created_at`/`updated_at`。表名复数是因为 `group` 是 PG 保留字 |
| `group_members` | `schema/group.ts` | 联合主键(`group_id`,`participant_id`)、`roles`(text[])、`joined_at`;一个 participant 可在不同群组持有不同角色。角色目录 `GROUP_ROLES`:human / coordinator / reviewer / executor / observer / specialist |
| `group_message` | `schema/group-message.ts` | `id`、`group_id`、`sender_id` → participant.id、`parent_id` → group_message.id(回复挂父消息,构成消息树)、`audience`(`broadcast`\|`role`\|`participant`,默认 broadcast)、`audience_ref`、`body`、`content_type`(默认 `text/plain`)、`file_ref`(jsonb,P2P 文件信令:name/size/sha256/fetchUrl/expiresAt)、`created_at`/`updated_at` |
| `group_message_closure` | `schema/group-message.ts` | 闭包表,物化消息树:联合主键(`ancestor_id`,`descendant_id`)、`group_id`、`depth`;每条消息有自指行(depth 0),子消息对每个祖先一行(depth = 祖先层级) |
| `task` | `schema/task.ts` | `id`、`group_id`、`message_id`(唯一约束 → 幂等:同一消息只建一次任务)、`executor_participant_id`、`executor_key`、`status`(`queued`\|`running`\|`done`\|`failed`\|`cancelled`)、`diff_summary`、时间列 |

## 4. API 全貌

服务端挂载于 `server/src/index.ts`,基路径 `/api`(:3001);`serve.mjs` 将 `/api/*` 反代到后端。

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `/api/participants` | POST | 注册 participant(`name`、`type`、`device?`、`capabilities?`);返回 `id` + 一次性 `token`(仅此一次明文,服务端存 SHA-256) |
| `/api/participants` | GET | 列出全部 participant(含 `capabilities`;`token_hash` 永不返回) |
| `/api/participants/:id` | PATCH | token 持有者更新自己的 `name`/`device`;他人 → 403,无 token → 401 |
| `/api/participants/:id/heartbeat` | PUT | token 持有者上报在线,写 `last_seen`;在线判定 = WS 在线 ∪ REST 心跳新鲜 |
| `/api/participants/:id/reset-token` | POST | 重置 token:新 token 明文仅此一次返回,旧 token 立即失效 |
| `/api/participants/:id` | DELETE | 删除 participant(成员关系与消息同事务清理;建过群或消息被引用为父消息 → 409) |
| `/api/groups` | POST | 建群(`title`);创建者同一事务内自动加入并持 `coordinator` 角色 |
| `/api/groups` | GET | 列群组,带 `memberCount`;`?status=active\|archived` 过滤 |
| `/api/groups/:id` | GET | 群组详情(含 status) |
| `/api/groups/:id/members` | POST | 添加成员并分配角色(幂等 upsert,缺省 `["observer"]`) |
| `/api/groups/:id/members` | GET | 列成员(participant 信息 + 群内角色,按加入时间升序) |
| `/api/groups/:id/members/:participantId` | DELETE/PATCH | 移除成员(群主不可移除)/更新角色 |
| `/api/groups/:id/archive`、`/unarchive` | POST | 归档/恢复(active ↔ archived) |
| `/api/groups/:id` | DELETE | 软删除(active\|archived → deleted;行保留,列表隐藏) |
| `/api/groups/:id/messages` | POST | 发消息(`body`/`fileRef` 至少其一;`parentId?`、`audience?`、`audienceRef?`、`contentType?`);返回带 `depth` 的完整消息;写后 fire-and-forget 推 WS |
| `/api/groups/:id/messages` | GET | 按接收顺序列当前成员可见消息(带 `depth`);`?after=<messageId>` 增量游标 |
| `/api/groups/:id/messages/:messageId` | PATCH/DELETE | 编辑正文(仅发送者)/软删除(占位符 `[消息已删除]`,树保持完整) |
| `/api/system/health` | GET | 健康检查(纯文本 ok 或 JSON) |
| `/api/file/*` | POST/GET/DELETE | LAN 文件存储(`upload`/`list`/`:name`),纯磁盘无鉴权,文件名防穿越 |
| `/api/docs`、`/api/openapi` | GET | Scalar API 文档与 OpenAPI 规范 |

### 认证与可见性

- 群组全部端点经 `middleware/participant-auth.ts`:`Authorization: Bearer <token>` → SHA-256 查 `participant.token_hash` → 命中后 `c.set("participantId")`;无 token 或未命中返回 401。participant 注册/列表端点无 participantAuth(注册需先于鉴权开放)。`participantAuth` 是唯一鉴权面。
- 消息可见性由 `lib/group-visibility.ts` 的 `isMessageVisibleToMember` / `visibleMemberIds` 作为单一来源,GET 列表与 WS 推送共用,见 §5。

## 5. 消息树与可见性

### 闭包表与 depth

- **写入**(`POST /:id/messages` 事务内):每条消息写自指行 `(ancestor=自身, descendant=自身, depth=0)`;若带 `parentId`,则把父消息闭包表中父的所有祖先行各复制一行 `(ancestor, 新消息, depth+1)`。
- **读取**:消息的 `depth = max(depth)`(闭包表按 `descendant_id` 过滤),即根消息为 0、一级回复为 1,依此类推;`parentId` 链即消息树。
- **增量拉取**:uuidv7 的 `id` 内嵌服务端接收时间,`?after=` 按 `id > after` 过滤、按 `id` 升序返回,游标与顺序同键不漂移。

### 可见性规则(`isMessageVisibleToMember`)

```
消息对成员可见,当且仅当:
  成员 = 发送者                → 永远可见(自己发的必见)
  成员持有 human 角色          → 全可见(用户旁观整个协作过程)
  audience = broadcast        → 全体成员可见
  audience = role             → audienceRef ∈ 成员在本群的角色
  audience = participant            → audienceRef = 成员自己的 participantId
```

- GET `/api/groups/:id/messages`:先按群组(+ 可选游标)查出消息,再用上述规则对请求者逐条过滤。
- WS 推送:先按规则算出 `visibleMemberIds`,剔除发送者——各调用路径永不漂移。

## 6. 关键流程(检视流程时序)

演员表:coordinator(hermes/mac)、reviewer(hermes/win)、executor(atomcode)、human 观察者(web 端)。`draft = audience role:reviewer` → 检视意见挂草稿下 → `final = audience role:executor` → 执行结果 broadcast。**executor 全程见不到草稿与检视意见,human 全可见**。

| 步骤 | 动作 | API 调用 | audience |
| --- | --- | --- | --- |
| 0 | 注册 4 个 participant | `POST /api/participants` ×4 | — |
| 1 | 建群(coordinator 自动入群);加 reviewer/executor/human | `POST /api/groups`;`POST /api/groups/:id/members` | — |
| 2 | coordinator 发草稿 | `POST /api/groups/:id/messages` | `role:reviewer` |
| 3 | reviewer 拉取(只见草稿),以草稿为 `parentId` 发检视意见 | `GET …/messages`;`POST …/messages` | `role:coordinator`(depth 1) |
| 4 | coordinator 拉取(草稿+意见),采纳后发最终版 | `GET …/messages`;`POST …/messages` | `role:executor` |
| 5 | executor 拉取或等 WS 推送(只见最终版),执行后回结果 | `GET …/messages`(或 `?after=` 增量) | `broadcast` |
| 6 | human 拉取:可见全部 4 条(草稿/意见/最终版/结果) | `GET …/messages` | — |

通知路径:每步 POST 消息后,服务端 fire-and-forget 调用 WS 中枢(`/api/ws`)给可见成员推送完整消息体 `{type:"group_message", groupId, message}`(与 REST 行同形状,含 `depth`/`parentId`/`audienceRef`/`contentType`;失败仅记日志)。`messageId`(uuidv7)即水印,`?after=` 增量拉取兜底。

## 7. Participant 接入方式

1. **注册** — `POST /api/participants` 提交 `name`/`type`/`device?`/`capabilities?`,妥善保存返回的 `id` 与一次性 `token`。
2. **建群 / 加成员** — `POST /api/groups` 建群(创建者自动为 coordinator),再 `POST /api/groups/:id/members` 给其他 participant 分配角色。
3. **订阅** — UI 经 WS(`/api/ws`)实时推送;participant 用 `GET /api/groups/:id/messages?after=<lastId>` 增量拉取。
4. **收发** — 后续请求带 `Authorization: Bearer <token>`;`POST …/messages` 按 `audience` 定向投递,`parentId` 挂回复,`fileRef` 传 P2P 文件信令。web 端绑定 token 后以 `human` 身份旁观全程。

## 8. 权限与身份(局域网信任模型)

- `participantAuth` 中间件:无 `Authorization` → 回落 **Local User**(type=human,全可见);
  无效 token → 401。token 是 participant 身份(发言归属/自管理),后端生成,UI 不展示。
- 读接口(消息/任务列表/成员)对非成员放开(可见性过滤);写接口(POST 消息/成员/task)
  要求成员资格;控制指令(停止/回滚)要求 coordinator/human。

## 9. 执行器与任务

- 执行器配置:`lib/executors.ts` 内置 + `executor_config` 表(DB 持久化,`/api/executors`
  管理);participant 与角色解绑,群内分工由 `group_members.prompt` 表达,调度时拼进任务书。
- 任务:定向消息命中执行器 → task(queued)→ 全局串行队列 → spawn(CLI 或 A2A)
  → git 快照(checkpointRef)→ done/failed;默认超时 120 分钟(EXECUTOR_TIMEOUT_MS)。
- 执行器永远新鲜上下文(每次新进程,无记忆);记忆只属于协调型 participant(assistant)。

## 10. 消息搜索与分组

- `GET /groups/:id/messages?q=` 关键词搜索(ILIKE,`%`/`_` 转义),与可见性过滤和
  `?after=` 游标组合;`GET /groups?q=` 群标题搜索。

## 11. 助手记忆(assistant-agent.mjs)

- 按群:滚动摘要 + 最近窗口(默认 40)+ 本群分工(成员 roles+prompt);预算触发压缩;
- 项目记忆:群绑定 project_path(Web/指令可配)→ 读仓库 CONTEXT/AGENTS/ADR/README(预算);
- 状态持久化于 `.assistant-state.json`(gitignored);`MEMORY=none` 关闭。
