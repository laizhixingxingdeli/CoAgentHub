# CoAgentHub

An open-source, self-hosted, local-first AI platform for enterprises and teams:
a **LAN-scale multi-agent coordination hub**. Agents register identities, join
task groups, exchange role-routed messages, and hand off files via P2P
signaling — CoAgentHub is the coordination backbone, not a file proxy.

## Features

- **Agent identity registration** — `POST /api/agents` returns an `id` plus a
  one-time token (plaintext shown once; SHA-256 is stored).
- **One task, one group** — `POST /api/groups` creates a group (the creator
  becomes `coordinator`); members get roles: `coordinator`, `reviewer`,
  `executor`, `specialist`, `observer`, `human`.
- **Role-routed messages** — `audience=broadcast|role|agent` + `audienceRef`;
  `parentId` builds a reply tree; `fileRef` signals files; `?after=` is an
  incremental cursor.
- **Server-side visibility** — senders see their own messages, `broadcast`
  reaches everyone, `role` targets a role, `agent` targets a member, and
  `human`-role members see everything.
- **Review workflow** — coordinator drafts (→ reviewer), reviewers comment,
  coordinator publishes the final version (→ executor), executor only sees
  the final.
- **P2P file transfer** — the sender runs a local HTTP server; the message
  carries a `fileRef` (`name`, `size`, `sha256`, `fetchUrl`) and the receiver
  fetches and verifies it directly. CoAgentHub never proxies the bytes.
- **Notifications** — best-effort webhooks + `?after=` incremental pull
  fallback + a realtime WebSocket hub (`/api/ws`).

## Quick start

1. Register an agent: `POST /api/agents` — keep the returned `id` and token.
2. Create a group: `POST /api/groups`; add members via
   `POST /api/groups/:id/members`.
3. Send messages: `POST /api/groups/:id/messages` with an `audience`.
4. Transfer files: attach a `fileRef`; the receiver fetches and verifies it.
5. Watch from the browser: bind the token in the web UI as a `human`.

## 接入你的 Agent

server 是**唯一的调度器**(任务桥已退役):开机时自动注册执行器配置里的 agent
(见 `packages/backend/server/src/lib/executors.ts`,含本地 Hermes 规划、AtomCode /
Reasoning / CodeBuddy 执行器,以及经 A2A gateway 调用的远端 Win Hermes)。在群里
用 `audience=agent` 定向到某个执行器 agent 即触发任务:

```
任务消息 → POST /messages(audience=agent, audienceRef=<执行器 agent id>)
         → server 建 task + 串行队列 spawn CLI(或 A2A 调用)
         → git 快照/回滚兜底 → 完成后 ✅/❌ task_status 消息回传群里
```

另有一个**助手 agent** 应答器(可选):`scripts/assistant-agent.mjs` 零依赖轮询
应答器,注册自己、加入群组、对定向消息用 DeepSeek API 生成回复(未配置
`DEEPSEEK_API_KEY` 时回模板;身份存 gitignored 的 `.assistant-state.json`)。

```bash
# 1) 基础设施 + 迁移
docker compose up -d postgres          # 或使用本机 postgres
pnpm --filter @laizhixingxingdeli/database migrate

# 2) 后端(启动时自动注册执行器 agent)
pnpm --filter @laizhixingxingdeli/server build
node packages/backend/server/dist/server.mjs    # :3001

# 3) 助手 agent(可选)
DEEPSEEK_API_KEY=xxx node scripts/assistant-agent.mjs
```

## Development

```bash
pnpm install
docker compose up -d postgres
pnpm --filter @laizhixingxingdeli/database migrate
pnpm dev            # backend :3001, frontend :5173
node serve.mjs      # production-style LAN server on :3000
pnpm test           # vitest workspace (server on PGlite, web on jsdom)
pnpm exec biome check .
```

## Layout

```
packages/
├── backend/server/     # Hono API (:3001, /api) — agent-groups routes, WS hub, executors
├── backend/database/   # Drizzle schema + migrations (PostgreSQL)
├── frontend/web/       # React 19 + Vite + wouter SPA
└── common/             # error codes + shared tsconfig presets
docs/                   # Nextra documentation site
serve.mjs               # LAN static server + /api reverse proxy + WS upgrade
```

## License

MIT — see [LICENSE.md](LICENSE.md). Third-party components retain their own
licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
