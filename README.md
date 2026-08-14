# CoAgentHub

An open-source, self-hosted, local-first AI platform for enterprises and teams:
a **LAN-scale multi-participant coordination hub**. Participants register identities, join
task groups, exchange role-routed messages, and hand off files via P2P
signaling — CoAgentHub is the coordination backbone, not a file proxy.

## Features

- **Participant identity registration** — every participant (human, CLI tool,
  resident script, AI bot) registers as an identity with a unique name.
  `POST /api/participants` (legacy alias `/api/agents` still works) returns an `id`.
  The `token_hash` column is kept for now but token authentication has been
  removed (Plan B will drop the column).
- **LAN full-trust model, no auth** — a request may declare its identity via
  `X-Participant-Id: <uuid>`; the claimed id is used as-is, and a missing or
  unknown id falls back to the default `Local User` (human, sees everything).
  No token validation, no 401/403 from identity. Writes still require group
  membership.
- **One task, one group** — `POST /api/groups` creates a group (the creator
  becomes `coordinator`); members get roles: `coordinator`, `reviewer`,
  `executor`, `specialist`, `observer`, `human`. Roles are decoupled from participant
  identity — each (group, participant) pair can carry a custom **prompt** describing
  its division of labor, which is injected into dispatched task books.
- **Role-routed messages** — `audience=broadcast|role|participant` + `audienceRef`;
  `parentId` builds a reply tree; `fileRef` signals P2P files; `?after=` is an
  incremental cursor; `?q=` does keyword search (visibility-filtered).
- **Server-side visibility** — senders see their own messages, `broadcast`
  reaches everyone, `role` targets a role, `participant` targets a member, and
  `human`-role members see everything. Filtering is pushed into SQL with
  cursor pagination (LIMIT 200).
- **Executor tasks** — directing a message at an executor (audience=participant)
  creates a `task` and spawns the CLI (or calls the remote A2A gateway) through
  a per-project queue: tasks of the same project path (`project_path`) run
  serially, different projects run in parallel (up to `maxParallelGroups`,
  configured in `scripts/dispatch-policy.json`, default 2); git checkpoints
  enable stop/rollback; status is posted back as `task_status` messages. The
  web task panel offers stop/rollback.
- **Review workflow** — coordinator drafts (→ reviewer), reviewers comment,
  coordinator publishes the final version (→ executor), executor only sees
  the final.
- **P2P file transfer** — `scripts/p2p-serve.mjs` serves one file over the LAN
  and posts a `fileRef` (`name`, `size`, `sha256`, `fetchUrl`); the receiver
  downloads directly and verifies sha256. CoAgentHub never proxies the bytes.
- **Project binding & two-tier memory** — a group can bind a project path
  (`PATCH /groups/:id`); the assistant then reads the repo's participant-facing
  docs (CONTEXT/AGENTS/ADR/README) as static memory, plus a rolling group
  summary + recent window + division-of-labor as dynamic memory.
- **Notifications** — a realtime WebSocket hub (`/api/ws`) for the UI,
  and `?after=` incremental pull for participants. (The old webhook channel was
  removed with the bridge; nothing consumed it.)

## UI

Three-column layout: sidebar (groups & navigation) · main content · a
collapsible **context panel** (members & roles, tasks with stop/rollback,
project binding) for group pages. Responsive: overlay on tablets/phones.

## Quick start

1. Register a participant: `POST /api/participants` — keep the returned `id`.
2. Create a group: `POST /api/groups`; add members via
   `POST /api/groups/:id/members`.
3. Send messages: `POST /api/groups/:id/messages` with an `audience` — the
   request may carry `X-Participant-Id: <participant id>` to speak as that
   identity (omitted → `Local User`).
4. Transfer files: attach a `fileRef`; the receiver fetches and verifies it.
5. Watch from the browser: pick your identity in the web UI identity panel.

## 接入你的 Participant

server 是**唯一的调度器**(任务桥已退役):开机时自动注册执行器配置里的 participant
(见 `packages/backend/server/src/lib/executors.ts`,含本地 Hermes 规划、AtomCode /
Reasoning / CodeBuddy 执行器,以及经 A2A gateway 调用的远端 Win Hermes)。在群里
用 `audience=participant` 定向到某个执行器 participant 即触发任务:

```
任务消息 → POST /messages(audience=participant, audienceRef=<执行器 participant id>)
         → server 建 task + 按项目分组的并行队列 spawn CLI(或 A2A 调用)
         → git 快照/回滚兜底 → 完成后 ✅/❌ task_status 消息回传群里
```

```bash
# 1) 基础设施 + 迁移
docker compose up -d postgres          # 或使用本机 postgres
pnpm --filter @laizhixingxingdeli/database migrate

# 2) 后端(启动时自动注册执行器 participant)
pnpm --filter @laizhixingxingdeli/server build
node packages/backend/server/dist/server.mjs    # :3001

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

## E2E tests (Playwright)

Browser end-to-end tests against the real stack — real PostgreSQL, real server
(`dist`), real web SPA — covering the core user paths (register participant,
create group, send message, reply tree, archive read-only, task panel).

```bash
pnpm build          # webServer uses existing dist artifacts — build first if stale
pnpm test:e2e       # playwright test
```

- Runs isolated on its own ports (web `:3010`, server `:3011`), never touching
  the resident `:3000`/`:3001` dev servers.
- Uses a dedicated `coagenthub_e2e` database (created + migrated in
  `globalSetup`, dropped in `globalTeardown`) — the real `coagenthub` database
  is never touched.
- CI runs it in the `e2e` job of `.github/workflows/test-suite.yml` (postgres
  service + build + `playwright install --with-deps chromium`).
- Task cases inject `queued` tasks via the API instead of spawning real
  executors, so the suite needs no external agent runtime.

## Layout

```
packages/
├── backend/server/     # Hono API (:3001, /api) — participant-groups routes, WS hub, executors
├── backend/database/   # Drizzle schema + migrations (PostgreSQL)
├── frontend/web/       # React 19 + Vite + wouter SPA
└── common/             # error codes + shared tsconfig presets
docs/                   # Nextra documentation site
serve.mjs               # LAN static server + /api reverse proxy + WS upgrade
```

## License

MIT — see [LICENSE.md](LICENSE.md). Third-party components retain their own
licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
