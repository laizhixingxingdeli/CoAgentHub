# CoAgentHub 整体架构

> 本文档描述 CoAgentHub(participant-groups)的整体架构:participant 注册 → 群组 → 角色路由消息 → 检视流程 → P2P 文件信令 → WS 实时推送 / 增量拉取。

## 0. 命名约定

- **表名**:能单数就单数;与 PG 保留字冲突时用复数或加前缀,避免引号包裹(`group` 是 PG 保留字 → 表名 `groups`)。
- **API 路径与字段**:一律单数(`/api/groups`、`/api/participants/:id`、`parentId`、`audienceRef`),不随表名复数。
- **audience + audienceRef**:`audience` 是投递范围(`broadcast`|`role`|`participant`),`audienceRef` 是范围参数(role 时为角色名,participant 时为 participantId;broadcast 时为 null),二者成对使用。
- **增量拉取 `?after=`**:按 uuidv7 `id` 走主键索引 seek(`id > after`),非全表扫描;游标与顺序同键不漂移。
- **术语:participant(参与者)= 身份单位**:`participant` 是平台上可进群收发消息的身份单位(唯一名字),任何主体——人(`human`)、CLI 工具(执行器)、常驻脚本(助手)、AI bot——都统一注册为一个 participant。平台不内置 AI、不托管模型,思考发生在各 participant 自己的客户端。**命名沿革**:该概念原名 `agent`,因易与「AI 智能体」混淆于 2026-08 改名为 participant;旧 API 路径 `/api/agents` 与旧 `audience=agent` 值仍兼容接受(归一存储)。token 认证已移除(局域网全信模型),`token_hash` 列保留待删。

## 1. 项目概览

一句话:CoAgentHub 让多个 participant(hermes / atomcode / openclaw / human / custom)以角色路由的方式围绕「一个任务一个群组」协作;群内 `fileRef` 的 P2P 信令路径只做协作调度与消息信令、不代理文件字节;另有独立的 `/api/file/*` LAN 文件存储会流式上传/下载字节。

| 域 | 说明 |
| --- | --- |
| LAN 文件存储 | `/api/file` 磁盘文件上传下载 |
| **participant 注册与群组协作** | `participant` / `groups` / `group_members` / `group_message` / `group_message_closure` / `task` |

## 2. 代码结构树

```
CoAgentHub/
├── serve.mjs                          # 局域网静态托管 + /api 反代 + WS upgrade
├── specs/                             # Spec 文档(Spec-Driven 工作流)
├── skills/                            # Agent Skills(coordinator/bugfix/executor/reviewer;bugfix 为索引)
├── docs/                              # 纯 Markdown 文档(usage/architecture/adr)
├── packages/
│   ├── callback-agent/                # 通用回调 Agent:消费 completion inbox 并恢复 CLI Agent 原 session
│   │   ├── src/                       #   api/dedupe/envelope/command-driver/callback-agent/cli
│   │   ├── test/                       #   fake API 集成测试 + 单测
│   │   └── examples/                   #   示例配置(Codex 等)
│   ├── backend/
│   │   ├── server/                    # Hono API 服务(:3001,基路径 /api)
│   │   │   ├── src/
│   │   │       ├── routes/participant/      #    participant 注册/列表/自管理(registry.ts)+ task-completion-events.ts(completion inbox/claim/ack/fail)
│   │   │       ├── routes/executor/   #    执行器配置管理(GET/POST/PATCH/DELETE /api/executors)
│   │   │       ├── routes/group/      #    群组路由(架构审视拆分,API 路径/响应不变)
│   │   │       │   ├── registry.ts   #      挂载入口(仅 route 汇总)
│   │   │       │   ├── groups.ts     #      群本体:建/列(分页+搜索)/详情/改名/归档/软删
│   │   │       │   ├── members.ts    #      成员:添加/列表/移除/角色与分工更新
│   │   │       │   ├── messages.ts   #      消息:发送/编辑/软删/列表(?after= 增量 + q 搜索)
│   │   │       │   ├── tasks.ts      #      任务:幂等创建/列表/详情/状态回写(PATCH)
│   │   │       │   └── helpers.ts    #      共享守卫(assertGroupWritable)
│   │   │       ├── routes/system/     #    health
│   │   │       ├── routes/file.ts     #    LAN 文件上传下载,纯磁盘无鉴权,流式读写
│   │   │       ├── routes/skills.ts   #    暴露 skills/{coordinator|executor|bugfix|reviewer}/SKILL.md(GET /api/skills[:/:name][/:name/digest]);正文接口带内容哈希 version
│   │   │       ├── middleware/participant-identity.ts  # X-Participant-Id 身份声明(无鉴权/校验)
│   │   │       ├── lib/config.ts             # 统一配置读取(CORS/FILE_DIR/上传上限/PORT)
│   │   │       ├── lib/group-visibility.ts   # 消息可见性规则(单一来源)
│   │   │       ├── lib/services/message-service.ts  # 消息域纯 db 逻辑(列表/编辑/软删/写入)
│   │   │       ├── lib/ws-hub.ts             # WebSocket 实时推送(/api/ws,成员短缓存)
│   │   │       ├── lib/orphan-task-reconciler.ts # 孤儿任务周期收敛(10s;判据=executorPid 经
│   │   │       │                             #   process.kill(pid,0) 抛 ESRCH 才判死,非「无输出超时」;
│   │   │       │                             #   协调任务(含 resumeOf 续跑任务)在「有非终态子任务」或「续跑尚未创建」窗口内豁免;
│   │   │       │                             #   无非终态子任务且无待建续跑时仍收敛;显式 enabled 开关供测试注入)
│   │   │       ├── lib/executor-availability.ts # 执行器可用性平台判定(复用冷却与存活口径;
│   │   │       │                             #   无可用执行器时产出 degradedToTwoParty 载荷,
│   │   │       │                             #   由平台写入,协调者自述不足以触发)
│   │   │       ├── lib/l3-overdue-reminder.ts # L3 请求逾期周期提醒(按请求去重,一条只提醒一次;
│   │   │       │                             #   只催办不裁决,不改任务状态)
│   │   │       └── lib/executor-task/        # 执行器调度(拆分 barrel,导出面兼容)
│   │   │           ├── types.ts       #      共享类型(队列条目/组队列/汇报结构)
│   │   │           ├── state.ts       #      模块级状态(组队列/超时/重试/冷却)+ 测试重置
│   │   │           ├── cooldown-store.ts #    task-backed 额度冷却持久化/清理
│   │   │           ├── output-buffer.ts #    实时输出缓冲(环形 tail,摘要流)
│   │   │           ├── output-parser.ts #    结构化条目解析(id/kind/summary/detail,摘要带 #id)
│   │   │           │                    #    分支:codex(item.completed;已知冗余事件 item.started/
│   │   │           │                    #      thread.started/turn.* 显式跳过并计数)、atomcode、
│   │   │           │                    #      codebuddy(stream-json)、default 通用语义解析(丢信封留正文)
│   │   │           │                    #    各分支均带 pending 行缓冲;解析失败/未知格式一律原样保留
│   │   │           ├── detail-store.ts  #    明细磁盘 JSONL(/tmp,14 天清理;不驻留内存、不进 diffSummary)
│   │   │           ├── notify.ts      #      状态通知(task_status_changed/回传/cancelled)
│   │   │           ├── report.ts      #      汇报解析与渲染(parseTaskReport/renderTaskCard;含 Token 消耗提取)
│   │   │           └── queue.ts       #      队列核心(入队/组调度/运行/取消排队/超时/重试)
│   │   │   └── scripts/              #    演示/验收脚本
│   │   └── database/                  # drizzle schema + migrations(表定义见 §3)
│   ├── common/                        # 共享包(错误码 BizCodeEnum、tsconfig 预设)
│   └── frontend/
│       └── web/                       # React + Vite + wouter 前端
│           └── src/pages/app/groups/  #    群组列表 / 消息(气泡聊天)/ 成员页
│           └── src/components/layout/context-panel/
│               ├── MarkdownBody.tsx   #    消息正文 markdown 渲染(react-markdown;
│               │                      #      不经 innerHTML、未启 rehype-raw,原始 HTML 转义)
│               ├── OutputDetailBlock.tsx # 实时输出摘要流:#id 行可展开明细、
│               │                      #      展开定位到底部、在底部时跟随、未完成命令显示已耗时
│               └── RequirementTimeline.tsx # 时间线:按 content_type 分渲染
│                                      #      (task_status=轻量状态提示 / text/plain=发言卡片)
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
| `executor_config` | `schema/executor-config.ts` | `id`、`key`/`agent_name`(唯一)、`kind`(`cli`\|`a2a`)、`bin`/`url`、`args`(jsonb)、`label`、`model`、`memory`、`prompt`;迁移 0027 新增可空 `max_concurrency`(声明式并发上限)、`input_mode`(`path`\|`inline`\|`at-file`\|`stdin`)、`env`(jsonb 键值对)、`output_profile`(jsonb,批2消费) |
| `task` | `schema/task.ts` | `id`、`group_id`(索引,迁移 0015)、`parent_task_id`(可空自引用+索引,迁移 0020)、`dispatch_kind`(可空,`requirement`\|`fix`,迁移 0024,检视者的逐票工作类型分流结果)、`supersedes_task_id`(可空自引用,迁移 0025,被替代的先前尝试)、`message_id`(唯一约束 → 幂等:同一消息只建一次任务)、`executor_participant_id`、`executor_key`、`executor_pid`(可空,迁移 0026,detached spawn 的进程组 id,终态后保留)、`status`(`queued`\|`running`\|`done`\|`failed`\|`cancelled`)、`diff_summary`(额度失败时含绝对时间 `executorCooldownEndMs`,服务启动恢复未到期记录并清理过期记录)、`spec_ref`(迁移 0017,规范文档路径)、`spec_hash`(迁移 0017,版本哈希)、`dispatcher_participant_id`/`dispatcher_session_id`(迁移 0016,任务下发者)、`callback_ref`(迁移 0018,opaque 路由 `{ platform?, endpointRef?, sessionRef? }`)、`recipient_participant_ids`(可空 `text[]`,迁移 0030,应用层在终态裁定的完成事件收件人;null → trigger 回落下发者)、时间列 |
| `task_completion_event` | `schema/task-completion-event.ts` | `id`(uuidv7)、`task_id`、`group_id`、`recipient_participant_id`(迁移 0030,投递对象;回填后 = 下发者,新事件由载荷裁定)、`dispatcher_participant_id`、`dispatcher_session_id`、`callback_ref`(jsonb,opaque 路由)、`state`(`pending`\|`leased`\|`delivered`\|`dead`)、`attempts`/`next_attempt_at`/`lease_token`/`lease_expires_at`/`delivered_at`/`last_error`、时间列。由 `trg_task_completion_event` trigger 在 task 首次进入终态时自动创建;(`task_id`,`recipient_participant_id`)唯一约束保证幂等 —— 同一 task 对同一收件人最多一条,群内多个 reviewer 各得一条 |

`dispatch_kind` 不是模式字段:模式(编制)仍由群成员构成实时推导、不落平台字段;它记录的是检视者对每一票作出的工作类型分流结果,与编制正交。`supersedes_task_id` 是可选的自引用,新任务填写它即可指向被替代的先前尝试,以保留执行器切换的完整现场。

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
| `/api/groups` | GET | 列群组,带 `memberCount`;`?status=active\|archived` 过滤、`?q=` 标题搜索、`?participantId=<uuid>` 按成员过滤(只返回该参与方所属的群:`group_members` 存在性判定,与 `memberCount` 的 join 分离,不影响计数)、`?limit=&offset=` 分页(limit 上限 100,缺省不截断),返回 `{ items, total }`(`total` 受过滤参数影响、与分页无关) |
| `/api/groups/:id` | GET | 群组详情(含 status) |
| `/api/groups/:id/members` | POST | 添加成员并分配角色(幂等 upsert,缺省 `["observer"]`);单角色校验:去重后 `roles.length > 1` → 400 |
| `/api/groups/:id/members` | GET | 列成员(participant 信息 + 群内角色,按加入时间升序) |
| `/api/groups/:id/members/:participantId` | DELETE/PATCH | 移除成员(群主不可移除)/更新角色(同单角色校验,`roles.length > 1` → 400) |
| `/api/groups/:id/archive`、`/unarchive` | POST | 归档/恢复(active ↔ archived) |
| `/api/groups/:id` | DELETE | 软删除(active\|archived → deleted;行保留,列表隐藏) |
| `/api/groups/:id/messages` | POST | 发消息(`body`/`fileRef` 至少其一;`parentId?`、`audience?`、`audienceRef?`、`contentType?`、`dispatchKind?`、`supersedesTaskId?`);返回带 `depth` 的完整消息;写后 fire-and-forget 推 WS。**human 角色成员默认 403**(群是 agent 协作空间)，但带完整 `specRef` + `specHash` 且定向到 `role`/`participant` 的规范驱动任务可作为外部触发入口放行。`review_result` 的 `verdict: "findings"` 必须定向到 coordinator 并带 `specRef` + `specHash`；显式 `dispatchKind` 优先，未显式指定时缺省为 `fix` 并在任务 `diffSummary` 留痕；广播形式返回 400。 |
| `/api/groups/:id/messages` | GET | 按接收顺序列当前成员可见消息(带 `depth`);`?after=<messageId>` 增量游标;`?limit=<n>` 限制返回条数(上限 200) |
| `/api/groups/:id/messages/:messageId` | PATCH/DELETE | 编辑正文(仅发送者)/软删除(占位符 `[消息已删除]`,树保持完整);human 角色成员 403(同写接口只读约束) |
| `/api/groups/:id/tasks` | POST | 建任务(`messageId` 唯一幂等——同一消息只建一次,重复 POST 返回既有行;body 快照写入 `brief`;接受 `dispatchKind?` 与 `supersedesTaskId?`) |
| `/api/groups/:id/tasks` | GET | 列群任务(createdAt 倒序),每行含 `executorPid` 与读时派生的 `pidAlive`(`null` = 无 pid 可核验);`?limit=&offset=` 分页(缺省 50,上限 100)、`?includeOutput=1` 附实时输出尾部 |
| `/api/groups/:id/tasks/:taskId` | GET | 任务详情(仅约定字段,不泄露 attempts/a2aContextId 等内部列),含 `executorPid` 与读时派生的 `pidAlive`(`null` = 无 pid 可核验);`?includeOutput=1` 附实时输出尾部 `outputTail`(running = 内存缓冲,已完成 = diffSummary 回填或留空);目标为协调任务时才派生 `l1`(`childCount`/`supersededCount`/`status`/`allTerminal`) 与 `l3`(`answered`/`verdict`/`awaitingSince`/`overdue`),非协调任务不含这两个字段;running 且非协调任务另含读时求值的 `liveness`(`warning`/`lastSignalAt`);任务为 failed 且带非空 `diffSummary.error`、运行时为陈旧构建时才含 `staleBuildSuspected:true` |
| `/api/groups/:id/tasks/:taskId` | PATCH | 更新任务(`status`/`diffSummary`/`checkpointRef`;仅该任务执行器 participant 可改,detached 模式回写终态用;status 实际变更时复用推送 `task_status_changed`) |
| `/api/groups/:id/tasks/:taskId/output?detail=1` | GET | 整份任务明细(spec two-tier-output-summary-and-detail R5):返回该任务明细 JSONL 全部条目(`{taskId, entries:[{id,kind,at,text}]}`);未带 `detail=1` → 400;明细文件不存在(已清理/该任务无明细)→ 404 并说明原因 |
| `/api/groups/:id/tasks/:taskId/output/:entryId` | GET | 单条明细展开(R5):按摘要行 `#id` 取回完整原文(`{id,kind,at,text}`);授权口径与 `includeOutput` 一致(群/任务存在性校验同任务详情路由,不放宽);`id 不存在` / `明细文件不存在` → 404 并说明原因 |
| `/api/participants/:id/task-completion-events` | GET | 列出**以该 participant 为收件人**的 completion event inbox(pending / 可重试 / lease 已过期);`?after=<eventId>` 游标、`?limit=<n>`(上限 100) |
| `/api/participants/:id/task-completion-events/:eventId/claim` | POST | 原子认领(lease):body `{ consumerId, leaseMs }` → `leaseToken + event`;仅收件人本人可认领,同一 event 在有效 lease 内只能被一个 consumer claim,错误 token 返回 409 |
| `/api/participants/:id/task-completion-events/:eventId/ack` | POST | 使用 `leaseToken` 标记 delivered(仅收件人本人);仅 `leased`/`delivered` 行可 ack(pending/dead 行的残留 token 不再能把事件改成 delivered);相同 token 重复 ack 幂等(ack 不清空 `leaseToken`) |
| `/api/participants/:id/task-completion-events/:eventId/fail` | POST | 记录截断错误、增加 attempts,按 `retryAfterMs` 回到 pending(仅收件人本人);超过 10 次进入 dead。单条原子 UPDATE,WHERE 含 eventId + 收件人 + `leaseToken` + `state='leased'`;`state` 与 `attempts` 在同一行版本内算出,必然自洽。命中 0 行 → 409 并按「事件不存在/不属于该收件人 · 已 delivered · 已 dead · lease 失效(过期/被重领/已 fail)」分类文案;**重复 fail 不幂等**(第二次 409,attempts 只 +1) |
| `/api/system/health` | GET | 健康检查(纯文本 ok 或 JSON) |
| `/api/health` | GET | 运行时新鲜度检查(返回 `startedAt` / `entryMtime` / `stale` / `staleReason`；源码扫描时附 `newestSourceMtime`；仅报告不拦截) |
| `/api/file/*` | POST/GET/DELETE | LAN 文件存储(`upload`/`list`/`:name`),纯磁盘无鉴权,文件名防穿越 |
| `/api/executors` | GET/POST | 列出 DB 持久化配置(GET 每条恒含可用性三字段 `available` / `unavailableReason` / `cooldownEndMs`,复用 `executor-availability.ts` 同源判定,不可用时为 `false`/文案/数值,杜绝「缺字段被读成可用」)/新增执行器配置并自动注册 participant(`agentName`、`kind=cli 或 a2a`、`bin` 或 `url`、`args`、`label`、`device`、`model`、`memory`、`prompt`、`maxConcurrency`、`inputMode`、`env`、`outputProfile`; 后四项可空) |
| `/api/executors/:key` | DELETE/PATCH | 删除/部分更新执行器配置(key 不可改;`memory` 仅 `kind=a2a` 生效;可部分更新 `maxConcurrency`/`inputMode`/`env`/`outputProfile`) |
| `/api/skills` | GET | 列出 `skills/` 下 skills(name + description + SKILL.md path) |
| `/api/skills/:name` | GET | 返回 `skills/<name>/SKILL.md` 内容与基于文件内容的 SHA-256 前 12 位 `version`(coordinator/executor/bugfix/reviewer;未知 404) |
| `/api/skills/:name/digest` | GET | 仅返回 skill 的内容哈希 `version`,不下载正文(未知 404) |
| `/api/docs`、`/api/openapi` | GET | Scalar API 文档与 OpenAPI 规范 |

### 身份声明与可见性

- 群组全部端点经 `middleware/participant-identity.ts`:`X-Participant-Id: <uuid>` → 该 id 存在则 `c.set("participantId")` 为声称身份;缺失或 id 不存在 → 回落 **Local User**。**不做任何 token 校验,无 401/403**(局域网全信模型,冒名无害)。WS(`/api/ws`)握手用 `?participantId=` 声明身份,同规则。
- 消息可见性由 `lib/group-visibility.ts` 的 `isMessageVisibleToMember` / `visibleMemberIds` 作为单一来源,GET 列表与 WS 推送共用,见 §5。

### 错误处理与配置(架构审视)

- **统一错误出口**(`server/src/index.ts` 的 `onError`):BizError → 业务码 + status;其余 → 500。一律经 winston logger 记录(含 `requestId`),响应体附 `requestId`(与 `hono/request-id` 中间件同源),便于客户端定位问题。
- **CORS 可配**:`CORS_ORIGIN` env(逗号分隔多个来源),缺省 `http://localhost:3000`(见 `lib/config.ts`)。
- **统一配置读取**收敛在 `lib/config.ts`(CORS / FILE_DIR / MAX_FILE_UPLOAD_BYTES / PORT);调度策略与执行器配置仍在各自领域模块读取。`scripts/dispatch-policy.json` 的 `maxConcurrentPerWorkspace` 缺省为 1(同一工作树串行),`l3ResponseMinutes` 缺省为 120(L3 应答超时:任务详情仍读时派生 `l3.overdue`;平台按请求去重在群内提醒一次,不改变任务状态、不代替 reviewer 裁决)。
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
- **human 只读仅约束写接口**:上面的「human 全可见」规则未变——human 角色成员(含
  Local User)仍可旁观全部消息;403 只发生在消息写接口(POST/PATCH/DELETE),不影响
  GET 列表与 WS 订阅。

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
  要求成员资格;控制指令(停止/回滚)要求 coordinator/human/reviewer
  (`CONTROL_ALLOWED_ROLES`;human 禁言后,紧急停止只能由检视者代发)。
- **human 群内只读**:human 角色成员对消息写接口(PATCH/DELETE)与普通 POST 仍返回 403
  (共享守卫 `assertMemberNotHuman`,措辞「群是 agent 协作空间,请与检视者 agent 直接
  对话」);仅带完整 `specRef` + `specHash` 且定向到 `role`/`participant` 的 POST
  可作为规范驱动的外部任务触发入口。GET 列表与 WS 订阅不受影响——用户仍可在网页旁观
  全部消息,只是不能自由发言/编辑/删除。Local User(非群成员)不受影响,其 POST 本就
  过不了成员资格检查。

## 9. 执行器与任务

**三角色职责分离 + 三层检视闭环**:检视者(reviewer)与用户直接对话、生成并冻结 spec;协调者(coordinator)据冻结 spec 下发任务;执行者(executor)按任务书实现。三层检视:L1 执行者会话内自检(Standards + Spec 双轴)/ L2 协调者功能检视(对照 spec 验收标准,✅ 放行 / ❌ 重下发)/ L3 检视者架构检视(是否最佳实现、ADR 合规、领域词汇;发现项 → 修订 spec)。检视编排由三个 skill 的纪律承载,平台不建编排引擎;L3 架构检视由 reviewer 通过 **task_completion_event inbox 认领**触发,不再以任务形式下发。

- **协作模式(三层 / 两层,由成员构成推导)**:模式**不是配置项、不落 `groups.mode` 字段**——群成员里有没有 `reviewer` 角色成员决定:有 `reviewer` = **三层**(L1 执行者自检 + L2 协调者功能检视 + L3 检视者架构检视);无 `reviewer` = **两层**(协调者兼任检视者的写 spec 职责,L2 通过即结案,跳过 L3)。两模式唯一差异是 L2 通过后是否进入 L3 架构检视:三层有 reviewer 在场,L2 通过即触发 completion event,由 reviewer inbox 认领完成检视;两层无 reviewer,L2 通过即结案。平台不感知模式。两层下协调者**按需加载 `skills/reviewer/SKILL.md` 的「职责 A」**自行 grill + 写 spec + 冻结公布(严禁把内容复制回 coordinator skill);取舍见 spec §3.14.4——更少跳转 vs L3 变自审、写与验收同一方。
  - **L2 之后的分支**:三层下 L2 功能检视通过 → 任务终态后 DB trigger 自动创建 `task_completion_event` → reviewer 从 inbox 认领并完成架构检视 → 结案;两层下 L2 通过即结案,跳过 L3。结案时若存在上游 detached 任务仍须 `PATCH` 回写终态(与模式无关)。
  - **L3 检视通过 completion event 唤醒**:三层模式下 L2 通过后,协调者不再向 reviewer participant 直接下发 task;任务终态时 DB trigger 自动创建 `task_completion_event`,reviewer 从 inbox 认领并完成架构检视。reviewer 不对应执行器配置,其消息走普通消息/控制指令路径。
  - **completion event 的投递对象由载荷决定,不由下发者决定**(specs/l3-request-delivery-and-scope.md R1/R2):终态 `diffSummary` **带 `review_request`** → 收件人是**群内 reviewer 角色成员**(多个 reviewer 各得一条事件);其余完成事件 → 收件人仍是下发者。收件人由**应用层**在落终态时裁定并写入 `task.recipient_participant_ids`(与 `status` 同一条 UPDATE),trigger 只搬运该列 —— 它不查 `group_members`、不理解角色,角色语义只有应用层这一个权威源。未裁定的路径(队列完成 / 停止 / 控制回滚 / 孤儿收敛)回落下发者,行为逐字不变。inbox 的列举 / claim / ack / fail 一律按 `recipient_participant_id` 归属。这条修掉的缺陷是:协调者自派(续跑 / detached)的属主任务,其下发者是协调者自己,而协调者 `memory: null`、每票 spawn、跑完即退、从不读自己的收件箱 —— 按下发者投递时这类 L3 请求**结构上永远送不到**。
  - **协调者用 detached 需自行注册执行器**:协调者若要使用 spec §3.5 的会话延续(`detached`),需自行 `POST /api/executors` 注册为可被唤醒的执行器(`kind=cli`);下发权由群内角色裁定(spec R3 / ADR-0008 第三条),不依赖执行器配置上的标记。

- **server 是唯一调度器**(旧任务桥已退役,webhook 通道已移除):`POST /messages` 定向到
  执行器 participant(`audience=participant` + `audienceRef`)时,由 server 直接建 task
  (fire-and-forget,幂等靠 `message_id` 唯一约束),不再有独立的调度进程。
- 执行器配置:`executor_config` 表是**唯一真相源**(DB 持久化,`/api/executors`
  管理);0028 迁移把旧 6 条内置配置写成 seed 行(幂等,`ON CONFLICT DO NOTHING`),不再有代码内置默认执行器。participant 与角色解绑,群内分工由 `group_members.prompt` 表达,调度时拼进任务书。执行器 participant 通过 `participant.executor_key` 稳定绑定配置 `key`,显示名 (`participant.name`) 仅是可修改的身份文本,不得作为调度路由键。reviewer 不对应执行器配置(0028 不 seed,`participant.executor_key = 'reviewer'` 已被迁移清空),其消息走普通消息/控制指令路径。
- **下发门与控制门**:`DISPATCH_ALLOWED_ROLES`(`lib/executor-task/types.ts`,管**下发**)与
  `CONTROL_ALLOWED_ROLES`(`lib/control.ts`,管**停止/回滚**)是两个独立常量,均含
  coordinator/human/reviewer。dispatcher/callback 路由判据只检查群内角色(spec R3 /
  ADR-0008 第三条):发送者群内角色命中 `DISPATCH_ALLOWED_ROLES` 即可携带,不再叠加
  「是否命中执行器配置」的全局否决——群内持 coordinator 角色的 participant 即便同时
  命中执行器配置,其携带的路由信息仍保留;只持 executor 角色者仍被剥离并产生
  `CALLBACK_STRIPPED_NOT_AUTHORIZED` 警告。
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
  (同一 `project_path` 组内并行数 ≤ `maxConcurrentPerWorkspace`,`scripts/dispatch-policy.json`
  配置,缺省 1 = 串行;不同项目并行,并行组数 ≤ `maxParallelGroups`,缺省 2;未绑定
  project_path 的群任务归默认组,不参与工作树闸,单槽不变)
  → spawn(CLI 或 A2A)→ git 快照(checkpointRef)→ done/failed;默认超时 120 分钟
  (EXECUTOR_TIMEOUT_MS)。
- **停止/取消语义(2026-08 收窄)**:只能取消**排队中**的任务(`cancelQueuedTasks(groupId,
  taskId?)`,taskId 缺省 = 本群全部排队任务);**运行中任务不可中断**,只能等其终态后由
  协调者下发修正任务(fix-forward)。kill 运行中任务进程组的能力保留,但仅由服务端自身的
  静默超时(`stallTimeoutMinutes`)/执行超时(`EXECUTOR_TIMEOUT_MS`)触发,不再接受用户指令。
  `currentRunningTask`/`queuedExecutorTaskCount`/回滚前置检查均按 `groupId` 过滤(原先跨
  群全局,属既有缺陷,一并修复为按群隔离)。
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
  任务书模板以精简的「**执行方式**」段触发 `coagenthub-executor` skill(读规范→写
  代码→测试→Code Review 自检→汇报;未安装 skill 时任务书提示 `GET /api/skills/executor`
  获取内容)。执行器自检(Code Review 自检,Standards + Spec Compliance 双轴)改由
  **skill 承载**,不再固化进任务书正文。四个 skills(coordinator/bugfix/executor/reviewer,
  bugfix 为索引——诊断/分流归检视者、方案与下发/验收归协调者)对齐
  **Matt 协议 v1.2.3**,只改 SKILL.md 即时生效(GET /api/skills/:name 从磁盘实时读取)。
- **汇报格式要求(任务书模板固定五行)**:`提交: <commit hash>` / `测试: <测试结果摘要>` /
  `Token: <消耗 token 数量>` / `汇报: <做了什么,3-5 句>` / `遗留: <未完成事项>`。stdout
  四段解析由 `lib/executor-task/report.ts` 的 `parseTaskReport` 完成,其中 `Token:` 段
  被清洗为纯数字(tokenUsage:去空格与千分位逗号、非法/空值省略),不会把描述性文字当
  token 落库。提取判据用**位置**不用内容形态(spec:
  report-extraction-ingests-test-fixtures):hash 只采信汇报段结构化字段与汇报块内的
  `commit/hash <hex>` 声明行,stdout 其余位置的十六进制串(测试夹具、任务书 specHash、
  工具回显)一律不取;无汇报段时 summary 留空并给 `reportMissingReason` 原因标注,
  不回退「取输出尾部若干行」。
- **Spec-Driven 模式**:specRef 非空时,任务书在「任务内容」前额外插入「关联规范」段
  (文档路径 + 版本哈希 + 指令「以 Spec 为准」),执行器严格按 Spec 实现,冲突以 Spec 为准。
- **specHash（验收钉子）——算法与语义**:`specHash` 是冻结时刻 spec 文件的 `git hash-object <file>` 输出，即 Git blob SHA-1（40 位小写十六进制；Git 在计算时对文件内容前置 `blob <字节长度>\0` 头，与裸内容的 SHA-1/SHA-256 结果不同，不可互换）。它不是 commit hash（`git rev-parse HEAD` 等），也不是文件内容的裸哈希。计算对象是工作树中的文件；冻结工作流要求先 `git commit` 再 `git hash-object`，此时 HEAD 版本与工作树一致，hash 同时锚定已提交的契约。验收锚点语义：spec 任何内容改动都会导致 hash 变化；修订 spec 后必须用新 `specHash` 重新下发，后续新任务按新 hash 验收，在途任务仍按下发时刻的旧 `specHash` 口径验收，不受后续修订影响（见 coordinator skill 的验收钉子规则）。平台现状：服务端仅存储与透传 `specHash`（`task.spec_hash` / 消息载荷 `specRef`+`specHash` / WS `task_status_changed` 事件透传），当前不做校验——一致性由“冻结→公布 `spec_published`/`spec_amended`→按 hash 下发→按 hash 验收”的流程纪律保证，读者不应假设有代码兜底。例证（工作树实测 `git hash-object`，与群内在用值一致）：`git hash-object specs/executor-config-over-code.md` → `c0d882c0a5198c7dc6c1e89f9b8701210375c093`；`git hash-object specs/quota-exhaustion-triggers-infinite-retry.md` → `7c2b4df562581e47719d3e7c6a62ae0637d81ea4`；可任选其一复核：`git hash-object <file>` 应与任务书/群消息中携带的 `specHash` 逐字一致。
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
  - **可脱离执行(detached)**:任务书支持 `## ReplyMode: detached`(大小写不敏感),
    **CLI 与 A2A 均生效**——发送完成即视为「已派发」,任务保持 `running`,队列槽位照常
    释放(不解析 stdout 汇报);收件方(协调者/检视者)结案时显式
    `PATCH /groups/:id/tasks/:taskId` 回写终态;下发方在 `callback.sessionRef` 填当前
    会话 id,回传经 completion event → callback-agent `resume <sessionRef>` 回到下发时
    的同一会话;超过 `detachedTimeoutMinutes`(默认 1440)未回写 → 按「结果未确认」处理。
- **done 判定**:仅依据执行器进程 exit code + `parseTaskReport` 汇报解析(提交/测试/
  Token/汇报/遗留五段),不再对工作区做旁路 git 检查。
- **L2 重试完整性(L2 retry integrity)**:平台将两项 previously skill-only 的约束提升为
  平台可见的强约束。① 续跑任务书(`coordinator-resume.ts`)在构建时,若本次终态子任务
  带有 `supersedesTaskId`,则读取被替代任务的 `brief`,提取其中的验收标准与红线段落
  并原文回显到续跑任务书中,清楚标注来源 task id;缺失时显式说明无法取得,不得伪造。
  ② L2 重发路径中,调用方未显式传 `supersedesTaskId` 时,平台根据当前续跑上下文
  (`diffSummary.platform.resumeForChild`)自动补齐为刚结束的子任务;首次派发(无续跑上下文)
  不补、协调者自派不补、跨父任务不串链。显式合法值保持兼容。
- **human 全可见**:参与者 `type=human`(含 Local User)对任何群的消息无条件可见
  (含定向消息,不要求群成员);audience 仍是 agent 间的路由机制。前端对定向消息显示
  「📨 定向给 <执行器名>」标签。

## 9.9 平台下发的运维约束(2026-08-22 实测)

以下四条**只有真正走平台下发才会暴露**,直调 CLI 时碰不到。每条都有实测依据。

### 9.9.1 后端必须能拿到代理环境变量

`executor-runner.ts` 的 `spawn(bin, args, {...})` **不传 `env`**,Node 因此让子进程
**完整继承后端进程的环境**。这是正确行为,无需改代码——但意味着:

> **后端进程没有 `HTTP_PROXY`/`HTTPS_PROXY`,执行器就也没有。**

实测数据(需代理才能出网的环境):

| | 结果 | 耗时 |
|---|---|---|
| 无代理直连 `api.openai.com` | `000` | 8s 超时 |
| 经代理 | `401`(正常响应) | 0.54s |

后果:执行器先尝试直连 → 必然超时 → 重试 5 轮 → 降级传输方式才连上,
**每票确定性浪费约 2 分钟**。注入代理变量后重连次数降为 0。

启动后端时务必带上代理变量(若你的网络需要代理)。

### 9.9.2 后端开发与生产/验收启动模式

后端入口统一先加载 `dotenv/config`，因此两种启动方式都会读取同一套
`DATABASE_URL` 等环境变量；开发模式由 `tsx` 直接执行源码，生产/验收模式由
`dist/server.mjs` 执行打包产物。

| 模式 | 命令 | 何时用 | 改完源码 |
|---|---|---|---|
| 开发期 | `pnpm --filter server dev` (`tsx watch src/index.ts`) | 日常协作、执行票 | **自动重载** |
| 生产/验收 | `pnpm --filter server start` (`node dist/server.mjs`) | 需要验证打包产物时 | 手动重启 |

日常协作与执行票应使用开发期 watch 模式；只有验证打包产物时才切生产/验收模式。
用生产模式跑开发流程，是本轮 4 次任务失败的根因：执行器停掉后端做验证后，
监工任务失去宿主进程，任务无法回写终态并被记录为 `server-restart`。不做平台层
自动重启；生产模式仍保留手动重启语义，`stale-runtime-detection` 与
`executor-task-liveness` 仍按各自职责工作。

### 9.9.3 codex 执行器带沙箱:禁网络、禁写 `.git/`

平台用 `exec --approve-for-me --ephemeral --json` 调用 codex,该模式带 workspace-write 沙箱；
`--json` 的 stdout JSONL 同时提供原生 `token_count` 事件，供平台在任务终态采集。
实测(`codex sandbox -- ...` 直接验证):

- 沙箱内**完全禁网**:直连 `000`、经代理 `000`、DNS `FAIL`
- 沙箱内**禁止监听 127.0.0.1**:需起本地服务的测试报 `listen EPERM`
- 沙箱内**禁止写 `.git/`**:执行器无法自行 `git commit`

试过 `-c network_access=true` 与 `-c sandbox_workspace_write.network_access=true`,
**均未解除**(仍 `000`)。

因此约定:

- **全量测试由协调者代跑**,票面应写明;执行器只跑定向测试与类型检查。
  这与「L2 独立复核、不信执行器自报」的既有纪律一致,不额外放宽沙箱。
- 执行器需提交时会申请非沙箱操作,属正常流程。

### 9.9.4 执行器会把工作区既有的暂存文件带进提交

即使执行器声明「不会触碰」,`git commit` 不带 `--only` 仍会把**已在暂存区**的
无关文件一并提交。协调者应在执行器提交前确认暂存区干净。

## 9.10 静默降级必须有可见信号

凡是「调用方本意要生效、实际没生效」的路径,必须有可见信号——报错、响应里的警告字段、
或群内消息,不能什么都不说。静默丢弃未声明字段(zod 默认行为)、静默回落默认值、
静默跳过某项处理,在本项目里都属于需要显式处理的情况,不是可接受的默认。

本原则的已知实例:

| 现象 | 后果 | 处置 |
|---|---|---|
| `POST /groups` 丢弃 `projectPath` | 群未绑定项目 | 已修复 |
| 建群者角色写死 coordinator | 协作模式静默退化 | 已修复 |
| 加群无条件发 skill 引导 | 重复引导消息 | 已修复 |
| ANSI 未剥离 | 前端乱码 | 已修复 |
| callback 被无权发送者携带 | 完成后无法回调下发者 | `X-CoAgentHub-Warning: CALLBACK_STRIPPED_NOT_AUTHORIZED` |
| reviewer 群下发缺 `specHash` | 验收钉子缺失 | `X-CoAgentHub-Warning: SPEC_HASH_MISSING`,但不拒绝下发 |
| 解析器 `default` 原样透传 | 新接入 agent 的输出顶满缓冲被截断 | 已修复:default 走通用语义解析,未知 key 仍记一次观测日志 |
| token 采集按 CLI 写死 | 未覆盖的 executorKey 一律 `unsupported` | 已修复:定制路径未命中则走通用 JSONL 兜底 |
| `restart` 在 PID 文件失准时空转 | 报告成功但进程未替换,重建后验证全部失真 | 已修复:stop 回退按端口查实际监听者,restart 校验 pid 确已更换 |
| 额度耗尽被当作普通进程消失 | 10 秒一轮无限重派,耗尽额度需人工停机 | 已修复:识别配额失败进入冷却 + 重派熔断(与原因识别无关的兜底)|
| 冷却状态仅存内存 | 重启即失忆,熔断被削弱 | 已修复:冷却持久化,启动时恢复未到期记录 |
| 续跑任务被孤儿收敛误杀 | 子任务干完无人结案,L2 整层跳过 | 已修复:续跑任务与协调根任务适用同一豁免 |
| 收敛写回整体替换 `diffSummary` | 抹掉 `platform.*` / `tokenUsage`,事后无法追溯 | 已修复:改为合并,仅新增收敛三键 |
| 协调者 PATCH 结案整体替换 `diffSummary` | 平台采集的 token 被冲掉 | 已修复:载荷不含该键时从 attempts 回填 |

## 9.11 运维语义速查(2026-08-29)

不看代码不会知道、但直接影响判断的约定:

| 机制 | 判据 | 边界 |
|---|---|---|
| 孤儿收敛 | `process.kill(pid,0)` 抛 ESRCH 才判死,**不是**「无输出超时」 | 周期 10s;协调根任务与**续跑任务**在「有非终态子任务」或「续跑待建」时豁免;两者都无事可做才收敛 |
| 额度熔断 | 输出含 `usage limit` / `rate limit` / `429` / `try again at` 等语义特征 | 冷却至解析出的恢复时刻,解析不出则保守固定冷却;**另有与原因无关的兜底**:同一父任务连续失败达阈值即停止重派 |
| 冷却持久化 | 存**绝对到期时刻**(epoch ms),非剩余时长 | 启动时恢复未到期记录并重建定时器,已过期的清理不复活 |
| 实时输出 | 摘要流按 `kind` 过滤:`thinking` **不进摘要流但照常落盘明细** | 明细存 `/tmp/coagenthub-task-detail-<taskId>.jsonl`,14 天留存,`?detail=1` 可取回 |
| 消息渲染 | 按 `content_type` 分流 | `task_status` → 轻量状态提示;`text/plain` → 发言卡片(markdown 渲染,不经 innerHTML)|
| L3 请求 | 按 `specRef` + `specHash` 去重 | 已有未应答请求时**并入**而非新增;一次裁决使参与合并的全部任务 `answered=true`;候选属主的收件人与本任务不同时**不并入**(并入不得降低可送达性) |

⚠️ **重启前必须当场复查在途任务**。「队列已空」的旧快照不可信 ——
协调者可能在其后派出新子任务,贸然重启会把整条链路打断(实测一次打断 5 条)。

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

## 12. Callback Agent (独立 package)

`packages/callback-agent` 是独立于 CoAgentHub core 的通用回调 Agent,消费 participant 的
completion-event inbox 并恢复 CLI Agent 原 session。**不在 callback agent 中执行 Webhook、
不从 event 读取命令/URL/凭据**——endpoint 配置是本地静态 JSON,仅允许绝对路径 executable
+ 静态参数或完整占位符(`{sessionRef}`/`{message}`/`{eventFile}`),`spawn(executable, args, { shell: false })`。

| 关注点 | 实现 |
| --- | --- |
| 轮询 | `GET /api/participants/:id/task-completion-events`(`?after=` 游标增量) |
| 认领 | `POST .../:eventId/claim`(`consumerId` + `leaseMs`)→ `leaseToken` |
| 执行 | 按 `callbackRef.endpointRef` 选本地 endpoint 配置 → 占位符解析 → `shell:false` spawn |
| 去重 | 成功投递后先原子写本地 dedupe store → 再 ack;进程在写后 ack 前退出 → 重启只补 ack |
| 失败 | command 非零退出 / timeout / spawn error → `POST .../:eventId/fail`(按 core 重试策略) |
| CLI 模式 | 一次性 `run` + 持续 `daemon`(`SIGINT`/`SIGTERM` 优雅退出) |

详见 `packages/callback-agent/README.md` 与 `specs/callback-agent-command-driver.md`。
