# CoAgentHub

面向企业与团队的开源、自托管、本地优先 AI 平台:**局域网规模的多 participant 协作中枢**。
Participant 注册身份、加入任务群组、按角色路由交换消息、通过 P2P 信令交接文件——CoAgentHub
只做协作调度,不代理文件字节。

## 特性

- **Participant 身份注册** — 任何参与者(人、CLI 工具、常驻脚本、AI bot)都统一注册为一个身份单位:
  带唯一名字。`POST /api/participants`(旧路径 `/api/agents` 仍兼容)返回 `id`(token 认证已移除,`token_hash` 列保留待删)。
- **局域网全信模型,无鉴权** — 请求可用 `X-Participant-Id: <uuid>` 声明身份;声称的 id 原样采用,
  缺失或未知 id 回落默认 `Local User`(human,全可见)。无 token 校验、无身份类 401/403;写操作仍要求群成员身份。
- **一个任务,一个群组** — `POST /api/groups` 建群(创建者成为 `coordinator`);成员角色:
  `coordinator` / `reviewer` / `executor` / `specialist` / `observer` / `human`。角色与 participant 身份解耦——
  每个 (群, participant) 组合可携带自定义**分工提示词(prompt)**,注入下发的任务书。
- **按角色路由消息** — `audience=broadcast|role|participant` + `audienceRef`,`parentId` 构建回复树,
  `fileRef` 信令 P2P 文件,`?after=` 增量游标,`?q=` 关键词搜索(可见性过滤)。
- **服务端可见性** — 发送者必见、`broadcast` 全员、`role` 定向角色、`participant` 定向成员、
  `human` 类型(含 Local User)全可见,即使没有成员行。过滤下推 SQL + 游标分页(LIMIT 200)。
- **执行器任务** — 定向到执行器的消息(`audience=participant`)会创建 `task` 并经按项目分组的队列
  spawn CLI(或调用远端 A2A gateway):同一 `project_path` 的任务串行,不同项目并行(上限
  `maxParallelGroups`,`scripts/dispatch-policy.json` 配置,缺省 2);git 快照支撑停止/回滚;
  状态以 `task_status` 消息回传群里。状态变化同时经 WebSocket 推送 `task_status_changed`
  (fire-and-forget,仅推给任务所属群的订阅者),单任务可查 `GET /groups/:id/tasks/:taskId`
  (`?includeOutput=1` 附加实时输出尾部)。远端 A2A 执行器有进度心跳(群消息顺延静默超时)、
  结果未确认标记(`diffSummary.unconfirmed`)与可选脱离执行模式(`## ReplyMode: detached`)。
  Web 任务面板提供停止/回滚。
- **检视流程** — coordinator 起草(→ reviewer),reviewer 评论,coordinator 发布最终版(→ executor),
  executor 只见最终版。
- **P2P 文件传输** — `scripts/p2p-serve.mjs` 在局域网内单文件服务(API 层能力;web 文件页已移除,
  执行器之间仍经 API 交换文件,UI 只面向人类),消息携带 `fileRef`(`name`/`size`/`sha256`/`fetchUrl`),
  接收方直连拉取并校验 sha256。CoAgentHub 从不代理文件字节。局域网文件仓(`/api/file`)
  流式读写磁盘,不整块缓冲进内存。
- **配置与错误** — CORS 来源可用 `CORS_ORIGIN` env 配置(逗号分隔,缺省 `http://localhost:3000`);
  服务端错误统一经 winston 记录并携带 `requestId` 返回;配置读取收敛在 `packages/backend/server/src/lib/config.ts`。
- **项目绑定与双层记忆** — 群可绑定项目路径(`PATCH /groups/:id`);协作者随后读取仓库面向
  participant 的文档(CONTEXT/AGENTS/ADR/README)作为静态记忆,叠加滚动群摘要 + 近期窗口 +
  分工提示词作为动态记忆。
- **通知** — 面向 UI 的实时 WebSocket 中枢(`/api/ws`):`group_message` 推送 + `task_status_changed`
  任务生命周期事件(推给任务所属群的订阅者,fire-and-forget——推送失败只记日志,依赖方回退 HTTP
  拉取),以及面向 participant 的 `?after=` 增量拉取。(旧 webhook 通道已随桥一并移除,无消费者。)

## 快速开始

1. 注册 participant:`POST /api/participants`,保存返回的 `id`。
2. 建群:`POST /api/groups`;加成员:`POST /api/groups/:id/members`。
3. 发消息:`POST /api/groups/:id/messages`(带 `audience`;请求可带 `X-Participant-Id: <participant id>` 以该身份发言,缺省回落 Local User)。
4. 传文件:附带 `fileRef`,接收方直连拉取校验。
5. 浏览器旁观:在 Web 端身份面板选择身份,以 `human` 身份查看协作过程。

## 接入你的 Participant

server 是**唯一的调度器**(任务桥已退役):开机时自动注册执行器配置里的 participant
(见 `packages/backend/server/src/lib/executors.ts`,含本地 Hermes 规划、AtomCode /
Reasoning / CodeBuddy 执行器,以及经 A2A gateway 调用的远端 Win Hermes)。在群里
用 `audience=participant` 定向到某个执行器 participant 即触发任务。接入/编辑执行器
配置走 `GET/POST/PATCH/DELETE /api/executors`(网页「接入 Participant」页;PATCH 支持
改 bin/args/model/device/agentName,内置执行器不可编辑,改名不会自动改 participant 名):

```
任务消息 → POST /messages(audience=participant, audienceRef=<执行器 participant id>)
         → server 建 task + 按项目分组的并行队列 spawn CLI(或 A2A 调用)
         → git 快照/回滚兜底 → 完成后 ✅/❌ task_status 消息回传群里
```

内置执行器(缺省集合,`key` → `agentName` → 调用方式):

| key | agentName | 调用方式 |
| --- | --- | --- |
| `executor` | AtomCode 执行器 | 本地 CLI(`atomcode -y -p {ticket}`) |
| `reasonix` | Reasoning 执行器 | 本地 CLI(`reasonix run -y --model {model} {ticket}`,缺省模型 `deepseek-v4-flash`) |
| `codebuddy` | CodeBuddy 执行器 | 本地 CLI(`codebuddy -y -p {ticket}`) |
| `hermes` | Hermes 规划 | 本地 CLI(`hermes -z {ticketContent}`,任务书全文内联) |
| `win-hermes` | Win Hermes | A2A(kind=`a2a`,经 gateway `http://192.168.31.180:9900/` 调用远端设备;`memory=per-group` 按群延续 contextId) |

CLI 执行器经 env 覆盖路径(`EXECUTOR_BIN_<KEY 大写>`,如 `EXECUTOR_BIN_CODEBUDDY`);
A2A gateway 地址/令牌可用 `COAGENTHUB_WIN_A2A_URL` / `COAGENTHUB_WIN_A2A_TOKEN` 覆盖。
自定义执行器经 `POST /api/executors` 写入 DB(`kind=cli` 需 `bin`,`kind=a2a` 需 `url`;
`memory=per-group` 仅对 a2a 生效),新增时自动注册对应 participant。

**执行器分工选择**:定向消息指定的执行器 = 实现执行器;测试执行器按群成员分工提示词
自动匹配(roles 含 executor/specialist 且 prompt 含测试/验证/检验/test/verify/review
关键词,大小写不敏感;多个匹配取关键词出现最多者,稳定选一;无匹配则默认由实现执行器
完成测试),写入任务书「执行与测试要求」段。网页发送器可选「测试执行器」(默认
「自动」;选「同一执行器」或显式成员时,消息里追加 `**测试执行器:<名>**` 行,任务书
原样保留——「同一执行器」= 测试由实现执行器自己完成,显式成员按名字生效)。

**任务状态实时推送(`task_status_changed`)**:任务状态在 `queued / running /
done / failed / cancelled` 任一变化时,server 经 `/api/ws` 向**任务所属群的
订阅者**推送(与 `task_output` 同界,broadcast 可见性;fire-and-forget——推送
失败只告警不重试,依赖方仍应以 HTTP 拉取兜底)。事件帧:

```ts
{
  type: "task_status_changed",
  groupId: string,
  taskId: string,
  status: "queued" | "running" | "done" | "failed" | "cancelled",
  task?: {  // 可选:最新任务行快照(与任务面板行同形状,日期为 ISO 字符串)
    id: string
    status: string
    executorParticipantId: string
    executorKey: string | null
    brief: string | null
    diffSummary: Record<string, unknown> | null
    createdAt: string
    updatedAt: string | null
    retryCount: number
  }
}
```

**单任务查询**:`GET /api/groups/:id/tasks/:taskId` 返回任务详情(只暴露约定
字段,不泄露 attempts/a2aContextId 等内部列);`?includeOutput=1` 时附加实时
输出尾部 `outputTail`(running 任务 = 内存缓冲;已完成任务 = diffSummary 回填
或留空):

```ts
{
  id: string
  groupId: string
  messageId: string
  executorParticipantId: string
  executorKey: string | null
  brief: string | null
  status: string
  checkpointRef: string | null
  retryCount: number
  diffSummary: Record<string, unknown> | null
  createdAt: string
  updatedAt: string | null
  outputTail?: string | null   // 仅 includeOutput=1 时出现
}
```

**A2A 协议可靠性**(经 A2A gateway 调用的远端执行器,如 Win Hermes):
- **进度/心跳**:A2A 任务 `running` 期间,执行器 participant 在群内发送的消息
  视为进展信号,刷新 `lastActivityAt` 并顺延无进展超时;连续无进展超过
  `a2aSilenceTimeoutMinutes`(默认 30,`scripts/dispatch-policy.json`)→ 无进展失败。
- **结果未确认**:gateway「agent did not reply in time」/ 请求超时但有进展 /
  网络错误 / HTTP 5xx 时不直接按失败处理——`diffSummary` 增加
  `{ error: "执行器未按协议回复，结果未确认", unconfirmed: true }`,群内回传
  `⚠️ 任务结果未确认`(不回传 ❌、不自动重试)。
- **可脱离执行(detached)**:任务书支持 `## ReplyMode: detached`(大小写不敏感);
  A2A 发送完成即视为「已派发」,任务保持 `running`,由执行器恢复后
  `PATCH /api/groups/:id/tasks/:taskId` 回写终态;超过
  `detachedTimeoutMinutes`(默认 1440)仍未回写 → 按「结果未确认」处理。

## 任务生命周期

任务状态机:`queued`(排队)→ `running`(执行中)→ `done` / `failed` / `cancelled`
(终态)。同一触发消息(`message_id` 唯一)只建一个任务,重复投递幂等;server 重启时
把 `queued`/`running` 的孤儿任务置 `failed`(diffSummary 附 `server-restart`),不自动重跑。

**状态回传**:执行器 participant 以广播消息回传状态(emoji 前缀;`📋/🚀/✅/❌/🛑/⚠️`
开头的消息 contentType=`task_status`):`📋` 排队(含前面还有几个)、`🚀` 开始执行、
`✅` 完成(附任务卡:提交/测试/汇报/遗留)、`❌` 失败(附原因与输出尾部)、`🛑` 已停止、
`⚠️` 无进展提醒 / 结果未确认、`⏳` 等待执行器额度恢复。

**停止(`停止 [taskId]`)**:仅 `coordinator` / `human` 可发;也可用 `stop` / `取消` /
`停一下`。携带 taskId 时终止该任务(排队中 → 移出队列置 `cancelled`;运行中 →
SIGTERM 整个进程组);缺省 taskId 时终止全部运行中/排队任务。执行器 participant 自己发的
回传不触发(防回环);定向到执行器 participant 的消息视为任务,不是指令。回传 `🛑 已停止`。

**回滚(`回滚 [taskId]`)**:仅 `coordinator` / `human` 可发;`git reset --hard` 到执行前
快照(`refs/coagenthub-cp/<taskId>`,即 `task.checkpoint_ref`),把工作区恢复到任务前状态,
随后把该任务置 `failed`(`diffSummary.error: "rollback"`)。有任务执行/排队时禁止回滚
(会破坏进行中的写入,须先停止);taskId 缺省时回滚该群最近一次带快照的任务;
`reset --hard` 只恢复已跟踪文件,任务新建的未跟踪文件会残留(不跑 `git clean`)。
成功回传 `✅ 已回滚到快照 <ref>(<sha>)`,无可回滚快照时回传 `⛔`。

**任务面板(Web 上下文面板「任务」Tab)**:挂载时拉取一次 `GET /groups/:id/tasks`
(不轮询);「停止」/「回滚」按钮 = 发送一条 broadcast 命令消息(`停止 <taskId>` /
`回滚 <taskId>`),由服务端 `lib/control.ts` 识别执行,发送后刷新列表。未绑定身份
(Local User)时按钮禁用;归档/软删群只读。running/done/failed 行默认展开:实时输出
经 WS `task_output` 事件流式追加,断线/刷新后缓冲为空时用 `includeOutput=1` 拉取
`outputTail` 兜底;`task_stall_alert` 事件给对应行加黄色警示(非失败);回滚后轮询
任务状态直到 `diffSummary.error === "rollback"` 提示「已恢复」。

**实时输出**:CLI 执行器的 stdout/stderr 分块入环形缓冲(上限 512KB,只留尾部)+ WS 推
`task_output`;done/failed 时把最近 500 行回填进 `diffSummary.outputTail`(之后不依赖内存)。

**可靠性超时**(`scripts/dispatch-policy.json`):
- `stallAlertMinutes`(15)— running 任务连续无输出 → 群消息提醒协调者 + 任务行警示标记(`diffSummary.stallAlerted`),不失败。
- `stallTimeoutMinutes`(30)— 静默继续超过该值 → kill 进程组,标 `failed`(「执行器静默超时」)。
- `claimTimeoutMinutes`(30)— `queued` 任务超过该值仍未进入 `running` → 标 `failed`(「任务未认领」)。
- **失败自动重试**(`retry.maxRetries` 缺省 1)— exit≠0 / 超时 / 静默失败且可重试时:回滚 checkpoint(`resetWorkspace`)→ `retry_count+1` → 重新入队重跑;认领超时 / 手动停止 / 验收失败不重试。
- **弱验收** — done 判定前校验执行器是否真正提交了改动(工作树干净且 HEAD 有变化);git 不可用时跳过。
- **额度冷却**(`rateLimit`)— 失败输出尾部命中额度关键词(`rate limit`/`quota`/`429`/`额度`/`次数限制` 等)→ 该执行器进入冷却(`cooldownMinutes` 缺省 300,优先从输出解析恢复时刻),冷却期不派发,到期自动恢复。

## WebSocket 实时事件

连接方式:`ws(s)://<host>/api/ws?participantId=<uuid>`(页面协议决定 ws/wss;dev 经
vite 代理、prod 经 `serve.mjs` 均保持此路径)。身份解析与 HTTP 的
`X-Participant-Id` 同一规则:缺失/未知 id → 默认 Local User(全信模型,无 token 校验)。
同一 participant 可持有多个连接;心跳每 30s ping 一次,未应答的连接被终止(清扫僵尸)。
广播永不 reject:成员查询与逐连接发送失败均被捕获并记日志,不影响消息写路径与 HTTP 响应。

事件(均 fire-and-forget,失败只告警;依赖方应以 HTTP 拉取兜底):

| 事件 | 载荷 | 含义 |
| --- | --- | --- |
| `group_message` | `{ groupId, message }` | 新消息(含发送者本人,UI 免拉取回显) |
| `group_message_updated` | `{ groupId, message }` | 消息正文被编辑(携带更新后的完整行) |
| `group_message_deleted` | `{ groupId, messageId }` | 消息被软删除(只带 id,接收方本地标记占位) |
| `task_output` | `{ groupId, taskId, chunk }` | 执行器实时输出块(任务面板流式追加) |
| `task_stall_alert` | `{ groupId, taskId }` | 无进展提醒(行级黄色警示,非失败) |
| `task_status_changed` | `{ groupId, taskId, status, task? }` | 任务生命周期变化(queued/running/done/failed/cancelled;`task` 为最新行快照,可选) |

可见性:除 `group_message_deleted` 沿用消息自身 audience 外,其余按广播可见性
推送给该群「可见成员集」(与 `GET /messages` 同一套规则);`?after=` 增量拉取是保证到达的兜底通道。

## 配置项

环境变量(读取集中在 `packages/backend/server/src/lib/config.ts` 及各领域模块):

| 变量 | 缺省 | 说明 |
| --- | --- | --- |
| `PORT` | `3001` | 后端 HTTP 端口 |
| `DATABASE_URL` | 必填 | PostgreSQL 连接串;未设置则启动失败 |
| `CORS_ORIGIN` | `http://localhost:3000` | 允许的跨域来源,逗号分隔多个 |
| `FILE_DIR` | `<cwd>/data/files` | 局域网文件仓目录(相对路径解析为绝对路径) |
| `MAX_FILE_UPLOAD_BYTES` | `200MB` | 单文件上传上限(字节);非法值回落默认并告警 |
| `COAGENTHUB_REPO_ROOT` | 自动推导 | 仓库根目录覆盖(从 cwd 上溯到最外层含 package.json 的目录);执行器 spawn cwd 与 git 操作基于它 |
| `EXECUTOR_TIMEOUT_MS` | CLI `120` 分钟 / A2A `30` 分钟 | 执行器单次执行超时(毫秒),超时 SIGKILL / 中止请求 |
| `SENTRY_DSN` | 未启用 | 设置后启用 Sentry(winston transport + Hono 中间件) |
| `LOKI_URL` | 未启用 | 设置后启用 Loki 日志传输(生产) |
| `LOG_LEVEL` | `info` | winston 日志级别 |
| `COAGENTHUB_WIN_A2A_URL` / `COAGENTHUB_WIN_A2A_TOKEN` | 配置内嵌 | 覆盖 A2A gateway 地址 / Bearer 令牌(测试指向 mock) |
| `COAGENTHUB_DISPATCH_POLICY_FILE` | `scripts/dispatch-policy.json` | 调度策略文件路径覆盖 |
| `EXECUTOR_BIN_<KEY>` | 配置内嵌 | 覆盖 CLI 执行器命令路径(如 `EXECUTOR_BIN_CODEBUDDY`) |

`scripts/dispatch-policy.json`(随代码版本化;缺失/损坏/数值非法时回退默认值,不阻塞启动):

| 字段 | 缺省 | 说明 |
| --- | --- | --- |
| `maxParallelGroups` | `2` | 最大并行组数:同一 `project_path` 组内串行,不同项目并行,并行组数不超过此值 |
| `stallAlertMinutes` | `15` | 无进展提醒阈值:running 任务连续无输出 → 提醒协调者(群消息 + 行警示,不失败) |
| `stallTimeoutMinutes` | `30` | 静默超时:连续无输出超过 → 标 `failed` |
| `claimTimeoutMinutes` | `30` | 认领超时:queued 任务超过仍未进入 running → 标 `failed` |
| `a2aSilenceTimeoutMinutes` | `30` | A2A 无进展超时:running 的 A2A 任务连续无进展信号(群消息)→ 无进展失败 |
| `detachedTimeoutMinutes` | `1440` | detached 超时:发送后执行器超过该时长未 PATCH 回写终态 → 按「结果未确认」处理 |
| `retry` | `{ maxRetries: 1, resetWorkspace: true, switchExecutor: false }` | 失败自动重试:重试次数上限(0 = 不重试)、重试前是否回滚 checkpoint、是否换执行器(仅实现同一执行器重跑) |
| `rateLimit` | `{ detectPatterns: [...], cooldownMinutes: 300, fallbackExecutor: null }` | 额度/速率限制失败 → 执行器进入冷却,冷却期不派发;关键词中英文覆盖,优先从失败输出解析恢复时刻 |

## UI

**三栏布局**:左侧边栏(群列表与导航)· 主内容区 · 可折叠的**上下文面板**(群页面)。
右栏为「成员与分工 / 任务 / 项目」三个 Tab;响应式:lg+(≥1024px)常驻 300px 右栏(标题栏
「面板」开关,开合状态存 localStorage),md(768-1023px)折叠为 overlay 抽屉,<md 全屏
overlay。非群页面不包右栏(两栏)。

- **身份绑定**:群列表页的身份面板——查看当前身份、从已有 Participant 列表选择(声明即绑定,无服务端调用)、
  手动输入 id、注册新 participant(成功即自动绑定)。绑定 id 存 localStorage(`coagenthub.agentId`),
  请求经 `X-Participant-Id` 头声明;未绑定 = Local User(human,全可见)。
- **成员与分工**:上下文面板「成员与分工」Tab——成员列表、角色(`coordinator`/`reviewer`/`executor`/`specialist`/`observer`/`human`)、
  群内分工提示词(prompt);增删成员与改角色/分工经 `/members` 端点。
- **任务面板**:上下文面板「任务」Tab——任务列表(状态/执行者/摘要/attempt 时间线)、
  停止/回滚按钮、实时输出流、无进展黄色警示。
- **项目绑定**:上下文面板「项目」Tab——绑定/解绑项目绝对路径(`PATCH /groups/:id` 的
  `projectPath`,必须是存在的绝对目录);绑定后同一项目的任务串行执行,不同项目并行。
- **文件页说明**:web 文件页已移除(`/files` 重定向到群列表,导航中不再出现);文件交换走
  API(`/api/file` 上传/下载/列表/删除)与 P2P 信令(`fileRef` + `scripts/p2p-serve.mjs`),
  UI 只面向人类。

## API 端点清单

- **participants** — `POST /api/participants` 注册(公开,返回 `id`;旧别名 `/api/agents`);
  `GET /api/participants` 列表;`PATCH /api/participants/:id` 更新注册;`DELETE /api/participants/:id`
  删除(同事务清理成员关系与消息,建过群或被引用为父消息时 409);`PUT /api/participants/:id/heartbeat` 上报在线(`lastSeen`)。
- **groups** — `POST /api/groups` 建群(创建者自动成为 coordinator 成员);
  `GET /api/groups` 列表(分页 + `q` 搜索);`GET /api/groups/:id` 详情;
  `PATCH /api/groups/:id` 改名 / 绑定或解绑 `projectPath`;
  `POST /:id/archive` · `POST /:id/unarchive` 归档/恢复;`DELETE /:id` 软删(历史保留,列表隐藏)。
- **members** — `POST /:id/members` 加成员(幂等 upsert,roles + prompt);
  `GET /:id/members` 列表;`PATCH` / `DELETE /:id/members/:participantId` 改角色分工 / 移除(群主不可移除)。
- **messages** — `POST /:id/messages` 发消息(`audience=broadcast|role|participant` +
  `audienceRef`、`parentId`、`fileRef`;定向到执行器 = 触发任务,非 coordinator/human 403);
  `GET /:id/messages` 列表(`?after=` 增量、`?q=` 搜索,可见性过滤 + LIMIT 200);
  `PATCH` / `DELETE /:id/messages/:messageId` 编辑 / 软删(仅发送者本人)。
- **tasks** — `POST /:id/tasks` 建任务(`message_id` 幂等);`GET /:id/tasks` 列表(`?includeOutput=1`);
  `GET /:id/tasks/:taskId` 详情(`?includeOutput=1`);`PATCH /:id/tasks/:taskId`
  (执行器本人回写 status/diffSummary/checkpointRef;coordinator/human 可在 queued 时改任务书 brief)。
- **executors** — `GET /api/executors` 列表(内置 + DB 合并);`POST /api/executors` 新增并自动注册 participant;
  `PATCH` / `DELETE /api/executors/:key` 编辑 / 删除(内置执行器拒绝:编辑 403 / 删除 409,key 不可改)。
- **file** — `POST /api/file/upload` 上传;`GET /api/file/list` 列表;`GET /api/file/:name` 下载;
  `DELETE /api/file/:name` 删除(纯磁盘、无 DB,文件名消毒防路径穿越,流式读写)。
- **system** — `GET /api/system/health` 存活探针(`ok` 文本或 JSON)。
- **文档** — `GET /api/docs`(Scalar UI)、`GET /api/openapi`(OpenAPI 规范)。

## 开发

```bash
pnpm install
docker compose up -d postgres
pnpm --filter @laizhixingxingdeli/database migrate
pnpm dev            # 后端 :3001,前端 :5173
node serve.mjs      # 生产式局域网服务器 :3000
pnpm test           # vitest workspace(server 用 PGlite,web 用 jsdom)
pnpm exec biome check .
```

基础设施 + 迁移(或使用本机 postgres):

```bash
docker compose up -d postgres          # 或使用本机 postgres
pnpm --filter @laizhixingxingdeli/database migrate

# 后端(启动时自动注册执行器 participant)
pnpm --filter @laizhixingxingdeli/server build
node packages/backend/server/dist/server.mjs    # :3001
```

## E2E 测试(Playwright)

针对真实技术栈的浏览器端到端测试——真实 PostgreSQL、真实 server(`dist`)、真实 web SPA,
覆盖核心用户路径(注册 participant、建群、发消息、回复树、归档只读、任务面板)。

```bash
pnpm build          # webServer 使用已有 dist 产物——过时先构建
pnpm test:e2e       # playwright test
```

- 在独立端口运行(web `:3010`、server `:3011`),绝不触碰常驻的 `:3000`/`:3001` 开发服务器。
- 使用专用 `coagenthub_e2e` 数据库(在 `globalSetup` 创建 + 迁移,`globalTeardown` 删除),
  绝不碰真实 `coagenthub` 数据库。
- CI 在 `.github/workflows/test-suite.yml` 的 `e2e` job 中运行(postgres 服务 + build +
  `playwright install --with-deps chromium`)。
- 任务用例经 API 注入 `queued` 任务而非 spawn 真实执行器,套件无需外部 agent 运行时。

## 目录

```
packages/
├── backend/server/     # Hono API(:3001,/api)— participant-groups 路由、WS 中枢、执行器
│                       #   routes/group/ → groups/members/messages/tasks 子路由 + helpers
│                       #   lib/executor-task/ → types/state/output-buffer/notify/report/queue
│                       #   lib/config.ts 统一配置读取
├── backend/database/   # Drizzle schema + migrations(PostgreSQL;0015 = group_id 索引)
├── frontend/web/       # React 19 + Vite + wouter SPA
└── common/             # 错误码 + 共享 tsconfig 预设
docs/                   # Nextra 文档站点
serve.mjs               # 局域网静态服务器 + /api 反代 + WS upgrade
```

## 许可证

MIT——见 [LICENSE.md](LICENSE.md)。第三方组件保留各自许可证,见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
