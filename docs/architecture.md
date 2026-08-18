# CoAgentHub 整体架构

> 本文档描述 CoAgentHub(participant-groups)的整体架构:participant 注册 → 群组 → 角色路由消息 → 检视流程 → P2P 文件信令 → WS 实时推送 / 增量拉取。

## 0. 命名约定

- **表名**:能单数就单数;与 PG 保留字冲突时用复数或加前缀,避免引号包裹(`group` 是 PG 保留字 → 表名 `groups`)。
- **API 路径与字段**:一律单数(`/api/groups`、`/api/participants/:id`、`parentId`、`audienceRef`),不随表名复数。
- **audience + audienceRef**:`audience` 是投递范围(`broadcast`|`role`|`participant`),`audienceRef` 是范围参数(role 时为角色名,participant 时为 participantId;broadcast 时为 null),二者成对使用。
- **增量拉取 `?after=`**:按 uuidv7 `id` 走主键索引 seek(`id > after`),非全表扫描;游标与顺序同键不漂移。
- **术语:participant(参与者)= 身份单位**:`participant` 是平台上可进群收发消息的身份单位(唯一名字),任何主体——人(`human`)、CLI 工具(执行器)、常驻脚本(助手)、AI bot——都统一注册为一个 participant。平台不内置 AI、不托管模型,思考发生在各 participant 自己的客户端。**命名沿革**:该概念原名 `agent`,因易与「AI 智能体」混淆于 2026-08 改名为 participant;旧 API 路径 `/api/agents` 与旧 `audience=agent` 值仍兼容接受(归一存储)。token 认证已移除(局域网全信模型),`token_hash` 列保留待删。

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
├── specs/                             # Spec 文档(Spec-Driven 工作流)
├── skills/                            # Agent Skills(coordinator/bugfix/executor)
├── docs/                              # 纯 Markdown 文档(usage/architecture/adr)
├── packages/
│   ├── backend/
│   │   ├── server/                    # Hono API 服务(:3001,基路径 /api)
│   │   │   ├── src/
│   │   │       ├── routes/participant/      #    participant 注册/列表/自管理(registry.ts)
│   │   │       ├── routes/group/      #    群组路由(架构审视拆分,API 路径/响应不变)
│   │   │       │   ├── registry.ts   #      挂载入口(仅 route 汇总)
│   │   │       │   ├── groups.ts     #      群本体:建/列(分页+搜索)/详情/改名/归档/软删
│   │   │       │   ├── members.ts    #      成员:添加/列表/移除/角色与分工更新
│   │   │       │   ├── messages.ts   #      消息:发送/编辑/软删/列表(?after= 增量 + q 搜索)
│   │   │       │   ├── tasks.ts      #      任务:幂等创建/列表/详情/状态回写(PATCH)
│   │   │       │   └── helpers.ts    #      共享守卫(assertGroupWritable)
│   │   │       ├── routes/system/     #    health
│   │   │       ├── routes/file.ts     #    LAN 文件上传下载,纯磁盘无鉴权,流式读写
│   │   │       ├── middleware/participant-identity.ts  # X-Participant-Id 身份声明(无鉴权/校验)
│   │   │       ├── lib/config.ts             # 统一配置读取(CORS/FILE_DIR/上传上限/PORT)
│   │   │       ├── lib/group-visibility.ts   # 消息可见性规则(单一来源)
│   │   │       ├── lib/services/message-service.ts  # 消息域纯 db 逻辑(列表/编辑/软删/写入)
│   │   │       ├── lib/ws-hub.ts             # WebSocket 实时推送(/api/ws,成员短缓存)
│   │   │       └── lib/executor-task/        # 执行器调度(拆分 barrel,导出面兼容)
│   │   │           ├── types.ts       #      共享类型(队列条目/组队列/汇报结构)
│   │   │           ├── state.ts       #      模块级状态(组队列/超时/重试/冷却)+ 测试重置
│   │   │           ├── output-buffer.ts #    实时输出缓冲(环形 tail)
│   │   │           ├── notify.ts      #      状态通知(task_status_changed/回传/cancelled)
│   │   │           ├── report.ts      #      汇报解析与渲染(parseTaskReport/renderTaskCard)
│   │   │           └── queue.ts       #      队列核心(入队/组调度/运行/停止/超时/重试)
│   │   │   └── scripts/              #    演示/验收脚本
│   │   └── database/                  # drizzle schema + migrations(表定义见 §3)
│   ├── common/                        # 共享包(错误码 BizCodeEnum、tsconfig 预设)
│   └── frontend/
│       └── web/                       # React + Vite + wouter 前端
│           └── src/pages/app/groups/  #    群组列表 / 消息(气泡聊天)/ 成员页
│           └── src/hooks/             #    use-groups-page / use-messages-page / use-group-ws
└── packages/backend/server/test/      # 验收测试(review-workflow 等)
```

## 3. 数据模型

表定义以 `packages/backend/database/src/schema/` 为准。

| 表 | 文件 | 关键列 |
| --- | --- | --- |
| `participant` | `schema/participant.ts` | `id`(uuid,PK)、`name`、`device`、`token_hash`(列保留待删,token 认证已移除,插占位空串)、`last_seen`(心跳在线)、`capabilities`(jsonb 能力标签,缺省 `[]`)、`created_at`(仅创建) |
| `groups` | `schema/group.ts` | `id`、`title`、`status`(`active`\|`archived`\|`deleted`,默认 active)、`created_by` → participant.id、`created_at`/`updated_at`。表名复数是因为 `group` 是 PG 保留字 |
| `group_members` | `schema/group.ts` | 联合主键(`group_id`,`participant_id`)、`roles`(text[])、`joined_at`;一个 participant 可在不同群组持有不同角色。角色目录 `GROUP_ROLES`:human / coordinator / reviewer / executor / observer / specialist |
| `group_message` | `schema/group-message.ts` | `id`、`group_id`(索引,迁移 0015)、`sender_id` → participant.id、`parent_id` → group_message.id(回复挂父消息,构成消息树)、`audience`(`broadcast`\|`role`\|`participant`,默认 broadcast)、`audience_ref`、`body`、`content_type`(默认 `text/plain`)、`file_ref`(jsonb,P2P 文件信令:name/size/sha256/fetchUrl/expiresAt)、`created_at`/`updated_at` |
| `group_message_closure` | `schema/group-message.ts` | 闭包表,物化消息树:联合主键(`ancestor_id`,`descendant_id`)、`group_id`(索引)、`depth`;每条消息有自指行(depth 0),子消息对每个祖先一行(depth = 祖先层级) |
| `task` | `schema/task.ts` | `id`、`group_id`(索引,迁移 0015)、`message_id`(唯一约束 → 幂等:同一消息只建一次任务)、`executor_participant_id`、`executor_key`、`status`(`queued`\|`running`\|`done`\|`failed`\|`cancelled`)、`diff_summary`、`spec_ref`(迁移 0017,规范文档路径)、`spec_hash`(迁移 0017,版本哈希)、时间列 |

## 4. API 全貌

服务端挂载于 `server/src/index.ts`,基路径 `/api`(:3001);`serve.mjs` 将 `/api/*` 反代到后端。

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `/api/participants` | POST | 注册 participant(`name`、`device?`、`capabilities?`);返回 `id`(不含 token) |
| `/api/participants` | GET | 列出全部 participant(含 `capabilities`;`token_hash` 永不返回) |
| `/api/participants/:id` | PATCH | 更新 participant 的 `name`/`device`/`capabilities`(全信模型:任何声称的身份都可更新任意 participant) |
| `/api/participants/:id/heartbeat` | PUT | 上报在线,写 `last_seen`;在线判定 = WS 在线 ∪ REST 心跳新鲜 |
| `/api/participants/:id` | DELETE | 删除 participant(成员关系与消息同事务清理;建过群或消息被引用为父消息 → 409) |
| `/api/groups` | POST | 建群(`title`);创建者同一事务内自动加入并持 `coordinator` 角色 |
| `/api/groups` | GET | 列群组,带 `memberCount`;`?status=active\|archived` 过滤、`?q=` 标题搜索、`?limit=&offset=` 分页(limit 上限 100,缺省不截断),返回 `{ items, total }` |
| `/api/groups/:id` | GET | 群组详情(含 status) |
| `/api/groups/:id/members` | POST | 添加成员并分配角色(幂等 upsert,缺省 `["observer"]`) |
| `/api/groups/:id/members` | GET | 列成员(participant 信息 + 群内角色,按加入时间升序) |
| `/api/groups/:id/members/:participantId` | DELETE/PATCH | 移除成员(群主不可移除)/更新角色 |
| `/api/groups/:id/archive`、`/unarchive` | POST | 归档/恢复(active ↔ archived) |
| `/api/groups/:id` | DELETE | 软删除(active\|archived → deleted;行保留,列表隐藏) |
| `/api/groups/:id/messages` | POST | 发消息(`body`/`fileRef` 至少其一;`parentId?`、`audience?`、`audienceRef?`、`contentType?`);返回带 `depth` 的完整消息;写后 fire-and-forget 推 WS |
| `/api/groups/:id/messages` | GET | 按接收顺序列当前成员可见消息(带 `depth`);`?after=<messageId>` 增量游标 |
| `/api/groups/:id/messages/:messageId` | PATCH/DELETE | 编辑正文(仅发送者)/软删除(占位符 `[消息已删除]`,树保持完整) |
| `/api/groups/:id/tasks` | POST | 建任务(`messageId` 唯一幂等——同一消息只建一次,重复 POST 返回既有行;body 快照写入 `brief`) |
| `/api/groups/:id/tasks` | GET | 列群任务(createdAt 倒序);`?limit=&offset=` 分页(缺省 50,上限 100)、`?includeOutput=1` 附实时输出尾部 |
| `/api/groups/:id/tasks/:taskId` | GET | 任务详情(仅约定字段,不泄露 attempts/a2aContextId 等内部列);`?includeOutput=1` 附实时输出尾部 `outputTail`(running = 内存缓冲,已完成 = diffSummary 回填或留空) |
| `/api/groups/:id/tasks/:taskId` | PATCH | 更新任务(`status`/`diffSummary`/`checkpointRef`;仅该任务执行器 participant 可改,detached 模式回写终态用;status 实际变更时复用推送 `task_status_changed`) |
| `/api/system/health` | GET | 健康检查(纯文本 ok 或 JSON) |
| `/api/file/*` | POST/GET/DELETE | LAN 文件存储(`upload`/`list`/`:name`),纯磁盘无鉴权,文件名防穿越 |
| `/api/docs`、`/api/openapi` | GET | Scalar API 文档与 OpenAPI 规范 |

### 身份声明与可见性

- 群组全部端点经 `middleware/participant-identity.ts`:`X-Participant-Id: <uuid>` → 该 id 存在则 `c.set("participantId")` 为声称身份;缺失或 id 不存在 → 回落 **Local User**。**不做任何 token 校验,无 401/403**(局域网全信模型,冒名无害)。WS(`/api/ws`)握手用 `?participantId=` 声明身份,同规则。
- 消息可见性由 `lib/group-visibility.ts` 的 `isMessageVisibleToMember` / `visibleMemberIds` 作为单一来源,GET 列表与 WS 推送共用,见 §5。

### 错误处理与配置(架构审视)

- **统一错误出口**(`server/src/index.ts` 的 `onError`):BizError → 业务码 + status;其余 → 500。一律经 winston logger 记录(含 `requestId`),响应体附 `requestId`(与 `hono/request-id` 中间件同源),便于客户端定位问题。
- **CORS 可配**:`CORS_ORIGIN` env(逗号分隔多个来源),缺省 `http://localhost:3000`(见 `lib/config.ts`)。
- **统一配置读取**收敛在 `lib/config.ts`(CORS / FILE_DIR / MAX_FILE_UPLOAD_BYTES / PORT);调度策略与执行器配置仍在各自领域模块读取。
- **文件流式读写**:`/api/file/upload` 从 File 流式写盘(不再构造整块 Buffer 二次拷贝),`GET /api/file/:name` 流式下载(createReadStream),`serve.mjs` 静态文件同样流式返回且路径穿越校验使用 `path.sep` 组件边界。
- **DB 索引**:迁移 0015 为 `group_message.group_id` 与 `task.group_id` 补索引(列表查询按群过滤 + 排序分页,此前无索引会全表扫描);`group_message_closure` 的 group_id/ancestor_id/descendant_id 索引与 `group_members` 联合主键已在库中。

## 5. 消息树与可见性

### 闭包表与 depth

- **写入**(`POST /:id/messages` 事务内):每条消息写自指行 `(ancestor=自身, descendant=自身, depth=0)`;若带 `parentId`,则把父消息闭包表中父的所有祖先行各复制一行 `(ancestor, 新消息, depth+1)`。
- **读取**:消息的 `depth = max(depth)`(闭包表按 `descendant_id` 过滤),即根消息为 0、一级回复为 1,依此类推;`parentId` 链即消息树。
- **增量拉取**:uuidv7 的 `id` 内嵌服务端接收时间,`?after=` 按 `id > after` 过滤、按 `id` 升序返回,游标与顺序同键不漂移。

### 可见性规则(`isMessageVisibleToMember`)

```
消息对成员可见,当且仅当:
  参与者 type = human           → 全可见(人类观察者,不要求是群成员;Local User 即属此类)
  成员 = 发送者                → 永远可见(自己发的必见)
  成员持有 human 角色          → 全可见(用户旁观整个协作过程)
  audience = broadcast        → 全体成员可见
  audience = role             → audienceRef ∈ 成员在本群的角色
  audience = participant            → audienceRef = 成员自己的 participantId
```

- `participantType` 由调用处(路由 / ws-hub)判定后传入:Local User 解析为
  `human`,其余参与者按成员角色走原规则;两种表示(JS 谓词与 SQL 谓词)共用
  同一参数,`visibility-sql.test.ts` 断言二者一致。
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

1. **注册** — `POST /api/participants` 提交 `name`/`device?`/`capabilities?`,保存返回的 `id`。
2. **建群 / 加成员** — `POST /api/groups` 建群(创建者自动为 coordinator),再 `POST /api/groups/:id/members` 给其他 participant 分配角色。
3. **订阅** — UI 经 WS(`/api/ws`)实时推送;participant 用 `GET /api/groups/:id/messages?after=<lastId>` 增量拉取。
4. **收发** — 后续请求带 `X-Participant-Id: <participant id>` 声明身份;`POST …/messages` 按 `audience` 定向投递,`parentId` 挂回复,`fileRef` 传 P2P 文件信令。web 端在身份面板选择身份后以 `human` 身份旁观全程。

## 8. 权限与身份(局域网全信模型)

- `participantIdentity` 中间件:带 `X-Participant-Id` 且 id 存在 → 以该身份处理;
  缺失或未知 id → 回落 **Local User**(全可见)。**token 认证已移除**:不再生成/校验
  token,无 401/403,`token_hash` 列保留待删。
- 读接口(消息/任务列表/成员)对非成员放开(可见性过滤);写接口(POST 消息/成员/task)
  要求成员资格;控制指令(停止/回滚)要求 coordinator/human。

## 9. 执行器与任务

- **server 是唯一调度器**(旧任务桥已退役,webhook 通道已移除):`POST /messages` 定向到
  执行器 participant(`audience=participant` + `audienceRef`)时,由 server 直接建 task
  (fire-and-forget,幂等靠 `message_id` 唯一约束),不再有独立的调度进程。
- 执行器配置:`lib/executors.ts` 内置 + `executor_config` 表(DB 持久化,`/api/executors`
  管理);participant 与角色解绑,群内分工由 `group_members.prompt` 表达,调度时拼进任务书。
- **执行器分工选择**:定向消息(`audience=participant`)指定的执行器 = **实现执行器**;
  **测试执行器**按群成员分工提示词自动选择(`resolveTestExecutor`,纯函数可单测):
  群成员中 roles 含 executor/specialist 且 prompt 文本匹配测试职责(关键词:测试/验证/
  检验/test/verify/review,大小写不敏感)的执行器;匹配多个 → 取测试关键词出现次数
  最多的(并列按名字字典序,稳定);无匹配 → null。任务书「执行与测试要求」段固定输出
  实现执行器与测试执行器(解析结果或「默认由实现执行器完成测试」),并强制「完成后必须
  运行测试并验证改动,汇报需包含测试结果」。前端发送器提供「测试执行器」下拉(纯辅助,
  不改消息 schema):默认「自动(按分工提示词)」不追加;选「同一执行器」或显式成员时在
  消息 body 追加一行 `**测试执行器:<名>**`,由 buildTicket 原样保留进任务书(「同一
  执行器」= 测试由实现执行器自己完成,与自动解析的固定段并存,执行器以显式行为准)。
- 任务:定向消息命中执行器 → server 建 task(queued)→ **按 project_path 分组的并行队列**
  (同一 `project_path` 组内串行、不同项目并行,并行组数 ≤ `maxParallelGroups`,
  `scripts/dispatch-policy.json` 配置,缺省 2;未绑定 project_path 的群任务归默认组)
  → spawn(CLI 或 A2A)→ git 快照(checkpointRef)→ done/failed;默认超时 120 分钟
  (EXECUTOR_TIMEOUT_MS)。
- **按执行器并发能力排队(设计修正)**:执行器可配 `maxConcurrency`(可选,声明式并发
  上限;如 AtomCode = 1 —— atomgit session 同一时间只能跑一个任务,并发会触发
  `403 atomgit_session_concurrency_conflict`)。目标执行器当前 running 数 ≥
  `maxConcurrency` 时,新任务保持 queued,等既有任务终态后自动出队;未配置的执行器
  默认不限并发(可并发执行器允许多个任务同时 running,不做无谓串行),先按 running
  尝试下发,若执行器返回 `403 atomgit_session_concurrency_conflict` 则**不判失败**,
  转 queued,并在既有 running 任务终态后自动重试(反应式排队;无既有任务时按 3s 退避
  防空转,如外部会话占用)。
- **任务书自包含原则**:每次任务由任务书(含 body 与本群分工 prompt)独立驱动,验收
  不依赖记忆。纯粹执行器(无 `memory` 标记)保持新鲜上下文,每次任务独立执行。
  任务书模板包含「Code Review 自检」段(Standards + Spec Compliance checklist),
  执行器完成前必须自检并在汇报中包含自检结果。Spec-Driven 模式下(specRef 非空),
  任务书额外插入「关联规范」段,执行器严格按 Spec 实现。
- **按群记忆(协调器专属)**:仅 `memory="per-group"` 的执行器(默认 win-hermes)启用
  a2a 跨任务 contextId 延续——调用前按 (executorKey, groupId) 取本群最近非 cancelled
  任务的 `a2a_context_id`,调用后回写;按群隔离,跨群不串。记忆只是加速器,缺失/失败
  只影响延续,不影响任务执行本身。
  - API 侧 `memory` 仅对 `kind=a2a` 生效(POST/PATCH 对 cli 拒绝);升级前已在 DB 注册
    的 a2a 执行器默认无记忆(行为变更:不再延续上下文),如需延续请显式 PATCH
    `memory="per-group"`。
- **无进展提醒(stall alert)**:`stallAlertMinutes`(默认 15,`dispatch-policy.json`)内
  无输出的 running 任务 → 发 ⚠️ 提醒消息给协调者 + 任务面板警示行(不失败);继续静默到
  `stallTimeoutMinutes`(默认 30)才标 failed。
- **任务状态实时推送(`task_status_changed`)**:任务 `queued / running / done /
  failed / cancelled` 任一状态变化落库后,经 WS 中枢推给**任务所属群的订阅者**
  (与 task_output 同界,broadcast 可见性);帧为 `{type:"task_status_changed",
  groupId, taskId, status, task?}`——`task` 可选,为最新任务行快照(日期 ISO 化,
  与任务面板行同形状)。fire-and-forget:推送失败仅告警,不影响任务主流程;依赖方
  (插件/前端)仍以 HTTP 拉取兜底(`GET /groups/:id/tasks/:taskId`)。路由层 PATCH
  推进状态(仅 status 实际变更时)复用同一出口。
- **A2A 协议可靠性**(经 A2A gateway 调用的远端执行器,如 win-hermes):
  - **进度/心跳**:A2A 任务 `running` 期间,执行器 participant 在群内发送的消息
    视为进展信号,刷新 `lastActivityAt` 并顺延无进展超时;连续无进展超过
    `a2aSilenceTimeoutMinutes`(默认 30,`dispatch-policy.json`)→ 无进展失败。
  - **结果未确认**:gateway「agent did not reply in time」/ A2A 请求超时
    (EXECUTOR_TIMEOUT_MS)但有进展 / 网络错误 / HTTP 5xx 时,不直接按失败处理——
    `diffSummary` 增加 `{ error: "执行器未按协议回复，结果未确认", unconfirmed: true }`,
    群内回传 `⚠️ 任务结果未确认`(不回传 ❌、不自动重试);HTTP 4xx 不标记 unconfirmed。
  - **可脱离执行(detached)**:任务书支持 `## ReplyMode: detached`(大小写不敏感);
    A2A 发送完成即视为「已派发」,任务保持 `running`,由执行器恢复后
    `PATCH /groups/:id/tasks/:taskId` 回写终态(队列槽位照常释放);超过
    `detachedTimeoutMinutes`(默认 1440)未回写 → 按「结果未确认」处理。
- **弱验收钩子**:done 前校验工作树干净 + HEAD 有变化(仅本地 CLI);失败原因含「未提交」。
- **human 全可见**:参与者 `type=human`(含 Local User)对任何群的消息无条件可见
  (含定向消息,不要求群成员);audience 仍是 agent 间的路由机制。前端对定向消息显示
  「📨 定向给 <执行器名>」标签。

## 10. 消息搜索与分组

- `GET /groups/:id/messages?q=` 关键词搜索(ILIKE,`%`/`_` 转义),与可见性过滤和
  `?after=` 游标组合;`GET /groups?q=` 群标题搜索。

## 11. 架构审视验证记录

> 验证日期:2026-08-16(架构审视提交 adb55fc 之后,main 全量验证)

| 验证命令 | 结果 |
| --- | --- |
| `pnpm --filter @laizhixingxingdeli/server test` | ✅ 264/264 通过 |
| `pnpm --filter @laizhixingxingdeli/web test` | ✅ 254/254 通过 |
| `pnpm --filter @laizhixingxingdeli/server check-types` | ✅ 通过(`tsc -b`) |
| `pnpm --filter @laizhixingxingdeli/web check-types` | ✅ 通过(`tsc -b`) |
| `pnpm build`(turbo run build,`--force` 冷构建) | ✅ 5/5 任务成功 |

结论:架构审视提交 adb55fc 之后的 main 全量测试、类型检查、构建全绿,未发现需要修复的
测试/类型/构建问题,未改动产品代码;`pnpm build` 产物已由 `--force` 冷构建确认,
git 工作树干净。备注:web 构建中 sentry-vite-plugin 因未配置 `SENTRY_AUTH_TOKEN`
打印非致命告警(不阻断产物生成),与本架构审视无关。

