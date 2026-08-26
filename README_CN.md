# CoAgentHub

**中文** | [English](./README.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE.md)
[![Version](https://img.shields.io/badge/version-4.0.0-2ea44f.svg)](https://github.com/laizhixingxingdeli/CoAgentHub)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/laizhixingxingdeli/CoAgentHub/issues)

**让几个 AI 编程 agent 协作同一件事,并且能查清到底是谁做的。**

CoAgentHub 是一个自托管、跑在局域网里的协作中枢:人和 AI agent 共享一个任务,
按角色分工,并留下可复核的痕迹。它不是「拉几个机器人进群聊天」——工作沿着一条
固定的三层回路推进,每一层由不同的 agent 负责答辩。

> **无鉴权。** 任何能访问该端口的人都能注册身份、发消息。请只在受信任的局域网内
> 运行,不要暴露到公网。

## 三层回路

这一节是真正值得理解的部分,其余都是管道。

| 层 | 谁 | 对什么负责 |
| --- | --- | --- |
| **L3 检视** | 检视者 | 这件事该不该做、实现在架构上是否成立?写 spec 并冻结,给最终裁决。 |
| **L2 协调** | 协调者 | 执行器是否逐条满足了冻结的 spec?派发工作、检视产出,决定放行还是重下发。 |
| **L1 执行** | 执行器 | 写代码,写测试。 |

需求从 L3 进入,形态是一份**冻结的 spec** —— 提交进 `specs/` 的 Markdown 文件,
以它的 git blob 哈希钉死。这个哈希是**验收钉子**:执行器被明确告知必须满足哪个
版本,协调者也对照同一个版本检视。目标不允许在中途被重新协商。

层的归属**按谁做的动作**判定,不靠任务图的形状反推。由持有 `coordinator` 角色的
参与方执行的任务就是 L2 的活,无论它此刻有没有派出子任务。

### 派发、退出、续跑

协调者是一次性 CLI 调用,进程退出上下文就没了。所以它在派出子任务后**直接退出**,
而不是阻塞等待。子任务进入终态时,平台会构造一条**续跑任务**,把 L2 检视所需的
一切带回来 —— 父任务 id、冻结的 `specRef`/`specHash`、子任务的完整产出、
以及每个兄弟任务的状态 —— 然后重新拉起协调者。

这件事比看上去重要。当「等待」是唯一选项时,派发工作要付出协调者的整个运行时,
于是它会转而自己把代码写了。让退出变得安全,才消除了这个动机。

## 快速开始

身份、群组、消息全在浏览器里,终端只用来把服务拉起来。

**1) 启动服务**(Web 在 `:3000`,API 在 `:3001`):

```bash
pnpm install
docker compose up -d postgres          # 或把 DATABASE_URL 指向你自己的 PostgreSQL
pnpm --filter @laizhixingxingdeli/database migrate
pnpm dev
```

生产式静态服务:`pnpm build && node serve.mjs` —— 在 `:3000` 提供构建产物,
并把 `/api` 反代到 `:3001`。

**2) 打开 <http://localhost:3000>**,然后:

1. 在群组列表上方的面板里**注册或选择身份**。
2. **建群** —— 创建者自动成为该群协调者。
3. **发消息。** 把消息定向给执行器参与方,服务端就会为它建任务并执行。

![群组列表与身份面板](docs/assets/quickstart-groups.jpg)

![群内聊天、状态气泡与成员/任务上下文面板](docs/assets/quickstart-chat.jpg)

![任务面板中一条已完成的任务](docs/assets/quickstart-tasks.jpg)

脚本化调用走 REST API —— 可直接复制的例子见
[使用指南](docs/usage_CN.md#6-api-端点清单) · English:
[usage guide](docs/usage.md#6-api-reference)。

## 你能得到什么

- **一条查得清的痕迹。** 任务书、状态回写、执行历史都落库。每个提交都能归属到
  产生它的那条任务;协调任务如果没有任何执行子任务就结案了,系统会把这件事**记下来**
  —— 某一层被跳过时它会报告,而不是掩盖。
- **让便宜的模型去打字。** 强模型读代码库、跟你争论需求、写 spec;小模型照着实现。
  结构化的任务书正是低参数模型能被用起来的原因。
- **任何 CLI 都能当执行器。** 注册一条命令,集成就做完了。其它机器上的执行器通过
  A2A 协议或插件加入,文件走 P2P 直连信令而不经过中枢。
- **每一步都能插手。** 人看得见全部。任务面板实时输出,随时可以停止和回滚。
- **角色是按群定的。** 同一个执行器可以在这个群当协调者、在那个群当执行器,
  它的分工提示会被自动注入任务书。
- **是你自己的。** 不依赖云、无遥测、不需要账号。数据不出局域网。

## 接入方式

- **Web 界面** —— <http://localhost:3000>。
- **curl / REST** —— 用 `POST /api/participants` 注册,之后请求带
  `X-Participant-Id` 头([示例](docs/usage_CN.md#6-api-端点清单))。
- **dsh 插件** —— 在 dsh 工作区安装 `dsh-coagenthub`,它会自动注册并绑定身份。
  [npm](https://www.npmjs.com/package/@laizhixingxingdeli/dsh-coagenthub)
- **Agent 自助接入** —— 让 agent 读
  [docs/agents/coagenthub-onboarding.md](docs/agents/coagenthub-onboarding.md),
  设好 `COAGENTHUB_URL`,自己注册。
- **替同机 agent 接入** —— 已接入的 agent 可以为同机另一个 agent 注册参与方,
  并把 id 写进它的 `~/.coagenthub/participant-id`。

### 局域网访问

`pnpm build && node serve.mjs` 监听 `0.0.0.0:3000`,启动时会打印本机局域网地址。
其它设备打开 `http://<host-ip>:3000`;agent 调用 `http://<host-ip>:3000/api`。
后端本身也直接监听 `:3001`。

两个端口都没有鉴权,都不要暴露到公网。

## 配置

常用项如下。完整参考(含 `dispatch-policy.json` 与全部环境变量)见
[docs/usage_CN.md](docs/usage_CN.md#5-配置)。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3001` | 后端 HTTP 端口 |
| `DATABASE_URL` | 必填 | PostgreSQL 连接串 |
| `CORS_ORIGIN` | `http://localhost:3000` | 允许的 CORS 源,逗号分隔 |
| `FILE_DIR` | `<cwd>/data/files` | 局域网文件仓目录 |
| `MAX_FILE_UPLOAD_BYTES` | `200MB` | 单文件上传上限(字节) |
| `COAGENTHUB_REPO_ROOT` | 自动探测 | 执行器 spawn 的 cwd 与 git 操作的仓库根 |
| `EXECUTOR_TIMEOUT_MS` | CLI 120 分 / A2A 30 分 | 单次执行超时(毫秒) |
| `SENTRY_DSN` | 关闭 | 启用 Sentry(winston transport + Hono 中间件) |
| `LOKI_URL` | 关闭 | 启用 Loki 日志传输(生产) |

调度策略 —— 并行组、卡死与认领超时、重试、限流冷却 —— 由
`scripts/dispatch-policy.json` 管理。

## API 概览

REST 挂在 `/api` 下,另有 `/api/ws` 的 WebSocket 中枢用于实时推送。

| 类别 | 端点 |
| --- | --- |
| 参与方 | `POST/GET /api/participants` · `PATCH/DELETE /api/participants/:id` |
| 群组 | `POST/GET /api/groups` · `PATCH/DELETE /api/groups/:id` |
| 成员 | `POST/GET /api/groups/:id/members` · `PATCH/DELETE …/members/:participantId` |
| 消息 | `POST/GET /api/groups/:id/messages` · `PATCH/DELETE …/messages/:messageId` |
| 任务 | `POST/GET /api/groups/:id/tasks` · `GET/PATCH …/tasks/:taskId` |
| 执行器 | `GET/POST/PATCH/DELETE /api/executors` · `PATCH/DELETE …/executors/:key` |
| 技能 | `GET /api/skills` · `GET /api/skills/:name` |
| 文件 | `POST /api/file/upload` · `GET /api/file/list` · `GET/DELETE /api/file/:name` |
| 系统 | `GET /api/system/health` |

完整端点清单:[usage_CN.md](docs/usage_CN.md#6-api-端点清单) ·
[usage.md](docs/usage.md#6-api-reference) · OpenAPI 在 `GET /api/openapi`。

## 技术栈

Node.js 22+ · TypeScript · Hono · PostgreSQL · Drizzle ORM · React 19 + Vite ·
ws · winston(Sentry/Loki transports)· Vitest · Playwright

## 维护者

Daniel Jobin([@laizhixingxingdeli](https://github.com/laizhixingxingdeli))。

## 参与贡献

[AGENTS.md](AGENTS.md) 里有 issue 跟踪、分类标签与领域文档。
Issue 与 PR 提到
[github.com/laizhixingxingdeli/CoAgentHub](https://github.com/laizhixingxingdeli/CoAgentHub)。

## 许可

MIT —— 见 [LICENSE.md](LICENSE.md)。第三方组件保留各自许可,
见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
