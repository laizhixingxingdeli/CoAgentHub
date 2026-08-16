# CoAgentHub

**中文** | [English](./README.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE.md)
[![Version](https://img.shields.io/badge/version-4.0.0-2ea44f.svg)](https://github.com/laizhixingxingdeli/CoAgentHub)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/laizhixingxingdeli/CoAgentHub/issues)

CoAgentHub 是面向企业与团队的开源、自托管、本地优先 AI 平台:**局域网规模的多
participant 协作中枢**。Participant(人类、CLI 工具、常驻脚本、AI bot)注册身份、
加入任务群组、按角色路由交换消息、通过 P2P 信令交接文件——CoAgentHub 只做协作调度,
不代理文件字节。

## 安装

**前置依赖:** Node.js 22+、PostgreSQL(或 Docker)、pnpm。

```bash
pnpm install
docker compose up -d postgres          # 或使用本机 PostgreSQL
pnpm --filter @laizhixingxingdeli/database migrate
```

## 快速开始

```bash
# 1) 启动后端(:3001)——开机时自动注册执行器 participant
pnpm --filter @laizhixingxingdeli/server build
node packages/backend/server/dist/server.mjs
```

另开一个终端,依次完成注册 participant → 建群 → 发消息:

```bash
BASE=http://localhost:3001/api

# 2) 注册 participant —— 保存返回的 id
curl -s -X POST $BASE/participants -H 'Content-Type: application/json' \
  -d '{"name":"alice"}'

# 3) 建群 —— 创建者自动成为 coordinator
curl -s -X POST $BASE/groups -H 'Content-Type: application/json' \
  -H 'X-Participant-Id: <participant-id>' -d '{"title":"demo"}'

# 4) 给群里发消息(经 X-Participant-Id 以该身份发言)
curl -s -X POST $BASE/groups/<group-id>/messages \
  -H 'Content-Type: application/json' -H 'X-Participant-Id: <participant-id>' \
  -d '{"body":"hello","audience":"broadcast"}'
```

然后在浏览器打开 **http://localhost:3000**,在身份面板选择你的身份,实时观看协作过程。
完整走查见 [使用指南](docs/usage_CN.md) · [Usage guide](docs/usage.md)。

## 配置

仅列最常用配置项——完整参考(含 `dispatch-policy.json` 与全部环境变量)见
[使用指南](docs/usage_CN.md#5-配置项)。

| 环境变量 | 缺省 | 说明 |
| --- | --- | --- |
| `PORT` | `3001` | 后端 HTTP 端口 |
| `DATABASE_URL` | 必填 | PostgreSQL 连接串 |
| `CORS_ORIGIN` | `http://localhost:3000` | 允许的跨域来源,逗号分隔多个 |
| `FILE_DIR` | `<cwd>/data/files` | 局域网文件仓目录 |
| `MAX_FILE_UPLOAD_BYTES` | `200MB` | 单文件上传上限(字节) |
| `COAGENTHUB_REPO_ROOT` | 自动推导 | 执行器 spawn cwd 与 git 操作基于的仓库根目录 |
| `EXECUTOR_TIMEOUT_MS` | CLI 120 分钟 / A2A 30 分钟 | 单次执行超时(毫秒) |
| `SENTRY_DSN` | 未启用 | 设置后启用 Sentry(winston transport + Hono 中间件) |
| `LOKI_URL` | 未启用 | 设置后启用 Loki 日志传输(生产) |

调度行为由 `scripts/dispatch-policy.json` 控制——并行组数、静默/认领超时、失败重试、
额度冷却。每个字段的说明见[使用指南](docs/usage_CN.md#5-配置项)。

## 主要特性

- **Participant 身份注册** — 任何主体(人类、CLI 工具、常驻脚本、AI bot)以唯一名字
  注册一次,可加入任意群组;局域网全信模型,无 token 鉴权。
- **一个任务,一个群组** — 群组承载角色(`coordinator` / `reviewer` / `executor` /
  `specialist` / `observer` / `human`)与每个成员的分工提示词,注入下发的任务书。
- **按角色路由消息** — `audience=broadcast|role|participant`,`parentId` 挂回复树,
  关键词搜索,`?after=` 增量游标。
- **服务端可见性** — 发送者必见、human 全可见,其余按 audience 在 SQL 中过滤,
  游标分页(LIMIT 200)。
- **执行器任务** — 定向到执行器的消息创建 task,经按项目分组的并行队列派发
  (同项目串行、不同项目并行),git 快照支撑停止/回滚,实时输出流式推送。
- **检视流程** — coordinator 起草(→ reviewer),reviewer 评论,coordinator 发布
  最终版,executor 只见最终版。
- **P2P 文件传输** — 消息携带 `fileRef`(name/size/sha256/fetchUrl),接收方直连
  拉取并校验——CoAgentHub 从不代理文件字节。
- **实时推送 + 增量拉取** — WebSocket 中枢(`/api/ws`)推送 `group_message` 与
  `task_status_changed` 事件;`?after=` 增量拉取兜底。

## 技术栈

Node.js 22+ · TypeScript · Hono · PostgreSQL · Drizzle ORM · React 19 + Vite ·
ws · winston(Sentry/Loki transport) · Vitest · Playwright

## API 概览

服务端在 `/api` 下提供 REST API,并附带 `/api/ws` WebSocket 中枢:

| 分类 | 端点 |
| --- | --- |
| Participants | `POST/GET /api/participants` · `PATCH/DELETE /api/participants/:id` |
| Groups | `POST/GET /api/groups` · `PATCH/DELETE /api/groups/:id` |
| Members | `POST/GET /api/groups/:id/members` · `PATCH/DELETE …/members/:participantId` |
| Messages | `POST/GET /api/groups/:id/messages` · `PATCH/DELETE …/messages/:messageId` |
| Tasks | `POST/GET /api/groups/:id/tasks` · `GET/PATCH …/tasks/:taskId` |
| Executors | `GET/POST/PATCH/DELETE /api/executors` |
| Files | `POST /api/file/upload` · `GET /api/file/list` · `GET/DELETE /api/file/:name` |
| System | `GET /api/system/health` |

完整端点参考(参数与返回示例):[usage_CN.md](docs/usage_CN.md#6-api-端点清单) ·
[usage.md](docs/usage.md#6-api-reference) · OpenAPI 规范见 `GET /api/openapi`。

## 维护者

Daniel Jobin([@laizhixingxingdeli](https://github.com/laizhixingxingdeli))。

## 贡献

见 [AGENTS.md](AGENTS.md)(issue tracker、triage 标签与领域文档),然后在
[github.com/laizhixingxingdeli/CoAgentHub](https://github.com/laizhixingxingdeli/CoAgentHub)
提 issue 或 PR。

## 许可证

MIT——见 [LICENSE.md](LICENSE.md)。第三方组件保留各自许可证,见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
