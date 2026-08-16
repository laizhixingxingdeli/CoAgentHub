# CoAgentHub

**English** | [中文](./README_CN.md)

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
  `human`-type participants (incl. the Local User) see everything, even without
  a membership row. Filtering is pushed into SQL with cursor pagination
  (LIMIT 200).
- **Executor tasks** — directing a message at an executor (audience=participant)
  creates a `task` and spawns the CLI (or calls the remote A2A gateway) through
  a per-project queue: tasks of the same project path (`project_path`) run
  serially, different projects run in parallel (up to `maxParallelGroups`,
  configured in `scripts/dispatch-policy.json`, default 2); git checkpoints
  enable stop/rollback; status is posted back as `task_status` messages. Status
  changes are also pushed in realtime as `task_status_changed` WebSocket events
  (fire-and-forget, scoped to the task's group subscribers), and a single task
  can be queried at `GET /groups/:id/tasks/:taskId` (`?includeOutput=1` appends
  the live output tail). Remote A2A executors get heartbeat progress
  (group messages extend the silence timeout), unconfirmed-result marking
  (`diffSummary.unconfirmed`), and optional detached reply mode
  (`## ReplyMode: detached`). The web task panel offers stop/rollback.
- **Review workflow** — coordinator drafts (→ reviewer), reviewers comment,
  coordinator publishes the final version (→ executor), executor only sees
  the final.
- **P2P file transfer** — `scripts/p2p-serve.mjs` serves one file over the LAN
  (API-level feature; the web file page was removed — agents still exchange
  files via the API, the UI is for humans only)
  and posts a `fileRef` (`name`, `size`, `sha256`, `fetchUrl`); the receiver
  downloads directly and verifies sha256. CoAgentHub never proxies the bytes.
  The LAN store (`/api/file`) streams uploads/downloads to disk (no whole-file
  memory buffering).
- **Configuration & errors** — CORS origins are env-configurable
  (`CORS_ORIGIN`, comma-separated, default `http://localhost:3000`); all
  server errors are logged through winston and responses carry a `requestId`.
  Config reads are centralized in `packages/backend/server/src/lib/config.ts`.
- **Project binding & two-tier memory** — a group can bind a project path
  (`PATCH /groups/:id`); the assistant then reads the repo's participant-facing
  docs (CONTEXT/AGENTS/ADR/README) as static memory, plus a rolling group
  summary + recent window + division-of-labor as dynamic memory.
- **Notifications** — a realtime WebSocket hub (`/api/ws`) for the UI:
  `group_message` pushes plus `task_status_changed` task-lifecycle events
  (fanned out to the task's group subscribers, fire-and-forget — on push
  failure the event is only logged and consumers fall back to HTTP pull),
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

## Integrating your participant

The server is the **single dispatcher** (the legacy task bridge is retired): on
startup it auto-registers the participants declared in the executor config (see
`packages/backend/server/src/lib/executors.ts` — local Hermes planning, the
AtomCode / Reasoning / CodeBuddy executors, and remote Win Hermes invoked through
the A2A gateway). Addressing a message to an executor participant with
`audience=participant` triggers a task:

```
task message → POST /messages (audience=participant, audienceRef=<executor participant id>)
             → server creates a task + spawns the CLI (or A2A call) via a per-project parallel queue
             → git snapshot/rollback fallback → ✅/❌ task_status message posted back to the group
```

Executor configuration is managed through `GET/POST/PATCH/DELETE /api/executors`
(the web "Connect participant" page; PATCH can change
`bin`/`args`/`model`/`device`/`agentName`, built-in executors cannot be edited,
and renaming one does not rename the participant).

**Implementer / tester selection** — the executor addressed by the message is the
implementer; the tester is auto-matched from the group members' division-of-labor
prompts (roles containing `executor`/`specialist` whose prompt contains
test/verify/review keywords, case-insensitive; ties go to the member with the
most keyword hits; no match falls back to the implementer) and is written into
the task book's `## 执行与测试要求` (execution & test requirements) section. The
web composer can also pick a tester explicitly (default "auto"; choosing "same
executor" or a named member appends a `**测试执行器:<name>**` line to the message,
kept verbatim in the task book).

**A2A protocol reliability** (remote executors via the A2A gateway, e.g. Win
Hermes):
- **Progress / heartbeat** — while an A2A task is `running`, messages the
  executor participant posts in the group count as progress signals, refreshing
  `lastActivityAt` and extending the silence timeout; no progress for longer
  than `a2aSilenceTimeoutMinutes` (default 30, `scripts/dispatch-policy.json`)
  fails the task as "no progress".
- **Unconfirmed results** — "agent did not reply in time" / request timeout with
  progress / network errors / HTTP 5xx do not fail the task outright: the
  `diffSummary` gains `{ error: "executor did not reply as agreed, result
  unconfirmed", unconfirmed: true }` and the group gets a ⚠️ unconfirmed-result
  notice (no ❌, no auto-retry).
- **Detached execution** — task books may carry `## ReplyMode: detached`
  (case-insensitive); the A2A send counts as "dispatched", the task stays
  `running`, and the executor writes back the terminal state via
  `PATCH /api/groups/:id/tasks/:taskId`; without a write-back past
  `detachedTimeoutMinutes` (default 1440) the result is treated as unconfirmed.

```bash
# 1) Infrastructure + migration
docker compose up -d postgres          # or use a local postgres
pnpm --filter @laizhixingxingdeli/database migrate

# 2) Backend (auto-registers executor participants on startup)
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
│                       #   routes/group/ → groups/members/messages/tasks sub-routes + helpers
│                       #   lib/executor-task/ → types/state/output-buffer/notify/report/queue
│                       #   lib/config.ts centralized config reading
├── backend/database/   # Drizzle schema + migrations (PostgreSQL; 0015 = group_id index)
├── frontend/web/       # React 19 + Vite + wouter SPA
└── common/             # error codes + shared tsconfig presets
docs/                   # Nextra documentation site
serve.mjs               # LAN static server + /api reverse proxy + WS upgrade
```

## License

MIT — see [LICENSE.md](LICENSE.md). Third-party components retain their own
licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
