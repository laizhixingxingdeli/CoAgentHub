# CoAgentHub

**English** | [中文](./README_CN.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE.md)
[![Version](https://img.shields.io/badge/version-4.0.0-2ea44f.svg)](https://github.com/laizhixingxingdeli/CoAgentHub)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/laizhixingxingdeli/CoAgentHub/issues)

CoAgentHub is an open-source, self-hosted, local-first AI platform for
enterprises and teams: a **LAN-scale multi-participant coordination hub**.
Participants (humans, CLIs, resident scripts, AI bots) register identities,
join task groups, exchange role-routed messages, and hand off files via P2P
signaling — CoAgentHub is the coordination backbone, not a file proxy.

## Installation

**Prerequisites:** Node.js 22+, PostgreSQL (or Docker), and pnpm.

```bash
pnpm install
docker compose up -d postgres          # or use your own PostgreSQL
pnpm --filter @laizhixingxingdeli/database migrate
```

## Quick start

```bash
# 1) Start the backend on :3001 — executor participants auto-register on startup
pnpm --filter @laizhixingxingdeli/server build
node packages/backend/server/dist/server.mjs

# In a second terminal: register → create a group → send a message
BASE=http://localhost:3001/api

# 2) Register a participant — keep the returned id
curl -s -X POST $BASE/participants -H 'Content-Type: application/json' \
  -d '{"name":"alice"}'

# 3) Create a group — the creator becomes the coordinator
curl -s -X POST $BASE/groups -H 'Content-Type: application/json' \
  -H 'X-Participant-Id: <participant-id>' -d '{"title":"demo"}'

# 4) Send a message (speak as a participant via X-Participant-Id)
curl -s -X POST $BASE/groups/<group-id>/messages \
  -H 'Content-Type: application/json' -H 'X-Participant-Id: <participant-id>' \
  -d '{"body":"hello","audience":"broadcast"}'
```

Then open **http://localhost:3000** in a browser, pick your identity in the
identity panel, and watch the collaboration live. A full walkthrough is in the
[Usage guide](docs/usage.md) · [使用指南](docs/usage_CN.md).

## Configuration

Only the most common knobs — the complete reference (including
`dispatch-policy.json` and every env var) is in
[docs/usage.md](docs/usage.md#5-configuration).

| Env var | Default | Description |
| --- | --- | --- |
| `PORT` | `3001` | Backend HTTP port |
| `DATABASE_URL` | required | PostgreSQL connection string |
| `CORS_ORIGIN` | `http://localhost:3000` | Allowed CORS origins, comma-separated |
| `FILE_DIR` | `<cwd>/data/files` | LAN file-store directory |
| `MAX_FILE_UPLOAD_BYTES` | `200MB` | Per-file upload cap (bytes) |
| `COAGENTHUB_REPO_ROOT` | auto-detected | Repo root used for executor spawn cwd and git ops |
| `EXECUTOR_TIMEOUT_MS` | CLI 120 min / A2A 30 min | Per-execution timeout (ms) |
| `SENTRY_DSN` | off | Enables Sentry (winston transport + Hono middleware) |
| `LOKI_URL` | off | Enables Loki log transport (production) |

Scheduling is governed by `scripts/dispatch-policy.json` (parallel groups,
stall/claim timeouts, retry, rate-limit cooldown) — see the
[usage guide](docs/usage.md#5-configuration).

## Features

- **Participant identity registration** — any actor (human, CLI, script, AI bot)
  registers once with a unique name; LAN full-trust model, no token auth.
- **One task, one group** — roles (`coordinator`, `reviewer`, `executor`,
  `specialist`, `observer`, `human`) + per-member division-of-labor prompts.
- **Role-routed messaging** — `audience=broadcast|role|participant`, reply trees
  via `parentId`, keyword search, and `?after=` incremental cursors.
- **Server-side visibility** — senders see their own messages, humans see
  everything, the rest is audience-filtered in SQL (cursor pagination, LIMIT 200).
- **Executor tasks** — addressing a message to an executor creates a task, run
  through a per-project parallel queue (same project serial, different projects
  parallel) with git checkpoints for stop/rollback and live output streaming.
- **Review workflow** — coordinator drafts (→ reviewer), reviewers comment, the
  coordinator publishes a final version that only the executor sees.
- **P2P file transfer** — messages carry a `fileRef` (name/size/sha256/fetchUrl);
  the receiver downloads directly and verifies — CoAgentHub never proxies bytes.
- **Realtime & pull** — a WebSocket hub (`/api/ws`) pushes `group_message` and
  `task_status_changed` events; `?after=` incremental pull is the fallback.

## Tech stack

Node.js 22+ · TypeScript · Hono · PostgreSQL · Drizzle ORM · React 19 + Vite ·
ws · winston (Sentry/Loki transports) · Vitest · Playwright

## API overview

| Category | Endpoints |
| --- | --- |
| Participants | `POST/GET /api/participants` · `PATCH/DELETE /api/participants/:id` |
| Groups | `POST/GET /api/groups` · `PATCH/DELETE /api/groups/:id` |
| Members | `POST/GET /api/groups/:id/members` · `PATCH/DELETE …/members/:participantId` |
| Messages | `POST/GET /api/groups/:id/messages` · `PATCH/DELETE …/messages/:messageId` |
| Tasks | `POST/GET /api/groups/:id/tasks` · `GET/PATCH …/tasks/:taskId` |
| Executors | `GET/POST/PATCH/DELETE /api/executors` |
| Files | `POST /api/file/upload` · `GET /api/file/list` · `GET/DELETE /api/file/:name` |
| System | `GET /api/system/health` |

Complete endpoint reference: [usage.md](docs/usage.md#6-api-reference) ·
[usage_CN.md](docs/usage_CN.md#6-api-端点清单) · OpenAPI at `GET /api/openapi`.

## Maintainers

Daniel Jobin ([@laizhixingxingdeli](https://github.com/laizhixingxingdeli)).

## Contributing

See [AGENTS.md](AGENTS.md) for issue tracker, triage labels, and domain docs,
then open an issue or PR at
[github.com/laizhixingxingdeli/CoAgentHub](https://github.com/laizhixingxingdeli/CoAgentHub).

## License

MIT — see [LICENSE.md](LICENSE.md). Third-party components retain their own
licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
