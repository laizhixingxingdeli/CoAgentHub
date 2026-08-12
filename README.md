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
