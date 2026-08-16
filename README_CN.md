# CoAgentHub

面向企业与团队的开源、自托管、本地优先 AI 平台:**局域网规模的多 participant 协作中枢**。
Participant 注册身份、加入任务群组、按角色路由交换消息、通过 P2P 信令交接文件——CoAgentHub
只做协作调度,不代理文件字节。

## 特性

- **Participant 身份注册** — 任何参与者(人、CLI 工具、常驻脚本、AI bot)都统一注册为一个身份单位:
  带唯一名字。`POST /api/participants`(旧路径 `/api/agents` 仍兼容)返回 `id`(token 认证已移除,`token_hash` 列保留待删)。
- **一个任务,一个群组** — `POST /api/groups` 建群(创建者成为 `coordinator`);成员角色:
  `coordinator` / `reviewer` / `executor` / `specialist` / `observer` / `human`。
- **按角色路由消息** — `audience=broadcast|role|participant` + `audienceRef`,`parentId` 构建回复树,
  `fileRef` 信令文件,`?after=` 增量游标。
- **服务端可见性** — 发送者必见、`broadcast` 全员、`role` 定向角色、`participant` 定向成员、`human` 全可见。
- **检视流程** — coordinator 起草(→ reviewer),reviewer 评论,coordinator 发布最终版(→ executor),
  executor 只见最终版。
- **P2P 文件传输** — 发送方运行本地 HTTP 服务,消息携带 `fileRef`(`name`/`size`/`sha256`/`fetchUrl`),
  接收方直连拉取校验。CoAgentHub 从不代理文件字节。
- **通知** — WebSocket 实时推送(`/api/ws`,UI)+ `?after=` 增量拉取(participant)。(webhook 通道已随桥一并移除)
- **配置与错误** — CORS 来源可用 `CORS_ORIGIN` env 配置(逗号分隔,缺省 `http://localhost:3000`);服务端错误统一经 winston 记录并携带 `requestId` 返回;配置读取收敛在 `lib/config.ts`。
- **文件流式读写** — `/api/file` 上传/下载与 `serve.mjs` 静态服务均流式读写磁盘,不整块读入内存;`group_message.group_id` / `task.group_id` 已补索引(迁移 0015)。

## 快速开始

1. 注册 participant:`POST /api/participants`,保存返回的 `id`。
2. 建群:`POST /api/groups`;加成员:`POST /api/groups/:id/members`。
3. 发消息:`POST /api/groups/:id/messages`(带 `audience`;请求可带 `X-Participant-Id: <participant id>` 以该身份发言,缺省回落 Local User)。
4. 传文件:附带 `fileRef`,接收方直连拉取校验。
5. 浏览器旁观:在 Web 端身份面板选择身份,以 `human` 身份查看协作过程。

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

## 目录

```
packages/
├── backend/server/     # Hono API(:3001,/api)— participant-groups 路由、WS 中枢、执行器
│                       #   routes/group/ → groups/members/messages/tasks 子路由 + helpers
│                       #   lib/executor-task/ → types/state/output-buffer/notify/report/queue
├── backend/database/   # Drizzle schema + 迁移(PostgreSQL)
├── frontend/web/       # React 19 + Vite + wouter SPA
└── common/             # 错误码 + 共享 tsconfig 预设
docs/                   # Nextra 文档站点
serve.mjs               # 局域网静态服务器 + /api 反代 + WS upgrade
```

## 许可证

MIT——见 [LICENSE.md](LICENSE.md)。第三方组件保留各自许可证,见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
