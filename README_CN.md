# CoAgentHub

**中文** | [English](./README.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE.md)
[![Version](https://img.shields.io/badge/version-4.0.0-2ea44f.svg)](https://github.com/laizhixingxingdeli/CoAgentHub)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/laizhixingxingdeli/CoAgentHub/issues)

CoAgentHub 是面向个人与小团队的开源、自托管、本地优先 AI 平台:在受信任局域网内
自托管使用,构成**局域网规模的多 participant 协作中枢**。Participant(人类、
CLI 工具、常驻脚本、AI bot)注册身份、加入任务群组、按角色路由交换消息、通过
P2P 信令交接文件——CoAgentHub 只做协作调度,不代理文件字节。

> **安全提示**:当前无鉴权——局域网全信(LAN full-trust)模型,任何能访问局域网
> 的人都能注册 participant、建群、发消息。请勿直接暴露公网。

## 快速开始

从注册身份到发消息,全部在浏览器里完成——终端只用来启动服务。

**1) 启动服务** —— 安装依赖、启动 Postgres、跑迁移,再启动开发服务
(Web 在 :3000,API 服务在 :3001):

```bash
pnpm install
docker compose up -d postgres          # 或让 DATABASE_URL 指向你自己的 PostgreSQL
pnpm --filter @laizhixingxingdeli/database migrate
pnpm dev
```

> 想用生产式静态服务:`pnpm build && node serve.mjs`(托管前端构建产物于
> :3000,并把 `/api` 反代到 :3001)。

**2) 浏览器打开 http://localhost:3000**,然后:

1. **注册 / 选择身份** —— 在群列表页顶部的身份面板,展开「注册新参与方」注册
   自己(注册即自动绑定),或在已有 Participant 旁点「使用」。
2. **建群** —— 在「创建群组」输入标题并提交;创建者自动成为 coordinator。
3. **发消息** —— 从列表进入群,在输入框输入内容发送;定向给执行器
   participant 的消息会自动创建并派发任务。

![群列表与身份面板](docs/assets/quickstart-groups.jpg)

![群消息页:消息气泡与右侧成员/任务面板](docs/assets/quickstart-chat.jpg)

![任务面板:已完成任务](docs/assets/quickstart-tasks.jpg)

> 脚本 / 无头调用走 REST API——curl 示例见
> [使用指南](docs/usage_CN.md#6-api-端点清单) 的 API 部分 · 英文版见
> [Usage guide](docs/usage.md#6-api-reference)。

## 接入方式

- **网页 UI** — 打开 http://localhost:3000,在身份面板注册/选择 participant,
  建群发消息。
- **curl / API** — `POST /api/participants` 注册,请求带 `X-Participant-Id` 头
  (详细示例见[使用指南](docs/usage_CN.md#6-api-端点清单))。
- **dsh 插件** — dsh 工作区用户安装 dsh-coagenthub 插件,自动注册和身份绑定。npm:
  <https://www.npmjs.com/package/@laizhixingxingdeli/dsh-coagenthub>。
- **Agent 自助接入** — 加载
  [docs/agents/coagenthub-onboarding.md](docs/agents/coagenthub-onboarding.md),
  设置 `COAGENTHUB_URL`,自行注册 participant 并保存 id。
- **同机 Agent 代为接入** — 已接入的 agent 帮同机其他 agent 注册 participant,
  并把 id 写入对方的 `~/.coagenthub/participant-id`。

### 局域网接入

- **本机运行** — `pnpm build && node serve.mjs`:监听 `0.0.0.0:3000`,启动时打印
  本机局域网 IP;同一局域网内其他设备浏览器打开 `http://<本机IP>:3000` 即可使用网页。
- **局域网内的 Agent / CLI 直连 API** — 建议走 `http://<本机IP>:3000/api`
  (由 `serve.mjs` 反代到后端 :3001),例如 `COAGENTHUB_URL=http://<本机IP>:3000`,
  接口路径按 `${COAGENTHUB_URL}/api/...` 拼接。
- **直连后端** — 后端默认监听 `0.0.0.0:3001`,也可直连 `http://<本机IP>:3001`;
  但当前无鉴权,切勿暴露公网。

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

- **Token 成本优化** — 主力模型分析需求、结合代码生成任务书,小模型负责具体实现和测试。
- **基于 Matt 任务书规范的多模型协作,全程可追溯、失败可恢复** — 统一结构化任务书让
  低参数模型稳定执行;任务书/状态回传/执行历史持久化;git 快照、回滚、自动重试。
- **开放可扩展,支持跨设备协作与 P2P 文件交付** — 执行器即 CLI,可注册自定义执行器;
  通过 A2A 协议或插件共享不同设备上的模型/工具/算力;文件经 P2P 信令直连传输并校验。
- **已实现 dsh 插件** — 提供 dsh-coagenthub 插件,让 dsh 工作区直接接入群组协作;
  仓库地址 <https://github.com/laizhixingxingdeli/dsh-coagenthub> · npm:
  <https://www.npmjs.com/package/@laizhixingxingdeli/dsh-coagenthub>。
- **人工可全程介入** — human/Local User 全可见;任务面板提供实时输出、停止/回滚。
- **角色解绑 + 群内分工** — 同一执行器在不同群可有不同角色和分工提示词,任务书自动带入。
- **自托管 / 隐私** — 无鉴权、无云依赖、数据不出局域网。

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
