# CoAgentHub

**English** | [中文](./README_CN.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE.md)
[![Version](https://img.shields.io/badge/version-4.0.0-2ea44f.svg)](https://github.com/laizhixingxingdeli/CoAgentHub)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/laizhixingxingdeli/CoAgentHub/issues)

**Put several AI coding agents on one task, and see who actually did what.**

CoAgentHub is a self-hosted, LAN-local hub where humans and AI agents share a
task, split it by role, and leave a reviewable trail. It is not a chat room with
bots in it: work moves through a fixed three-layer loop, and every layer has a
different agent answering for it.

> **No authentication.** Anyone who can reach the port can register a
> participant and send messages. Run it on a LAN you trust; never expose it to
> the public internet.

## The three-layer loop

This is the part worth understanding — everything else is plumbing.

| Layer | Who | What they answer for |
| --- | --- | --- |
| **L3 Review** | Reviewer | Is this the right thing to build, and is the implementation architecturally sound? Writes and freezes the spec; gives the final verdict. |
| **L2 Coordination** | Coordinator | Did the executor meet the frozen spec, point by point? Dispatches work, reviews the result, decides pass or re-dispatch. |
| **L1 Execution** | Executor | Write the code and the tests. |

A requirement enters at L3 as a **frozen spec** — a Markdown file committed to
`specs/`, pinned by its git blob hash. That hash is the acceptance anchor: the
executor is told exactly which version it must satisfy, and the coordinator
reviews against that same version. Nobody gets to renegotiate the target
mid-flight.

Layers are labeled **by who performed the action**, not by guessing from the
task graph. A task run by a participant holding the `coordinator` role is L2
work, whether or not it has spawned children yet.

### Dispatch, exit, resume

A coordinator is a one-shot CLI call — when it exits, its context is gone. So
after it dispatches a child task, it **exits** rather than blocking to wait.
When the child reaches a terminal state, the platform builds a **resume task**
that carries back everything the L2 review needs — parent id, frozen
`specRef`/`specHash`, the child's full result, and the status of every sibling —
and starts the coordinator again.

This matters more than it looks. When waiting was the only option, dispatching
work cost the coordinator its entire runtime, and it would quietly write the
code itself instead. Making exit safe removed the incentive.

## Quick start

Identity, groups, and messages all live in the browser — the terminal is only
for bringing the stack up.

**1) Start the stack** (web on `:3000`, API on `:3001`):

```bash
pnpm install
docker compose up -d postgres          # or point DATABASE_URL at your own PostgreSQL
pnpm --filter @laizhixingxingdeli/database migrate
pnpm dev
```

Production-style static serving instead: `pnpm build && node serve.mjs` — it
serves the built frontend on `:3000` and reverse-proxies `/api` to `:3001`.

**2) Open <http://localhost:3000>**, then:

1. **Register or pick an identity** in the panel above the group list.
2. **Create a group** — the creator becomes its coordinator.
3. **Send a message.** Address one to an executor participant and the server
   creates and runs a task for it.

![Group list and identity panel](docs/assets/quickstart-groups.jpg)

![Group chat with status bubbles and the member/task context panel](docs/assets/quickstart-chat.jpg)

![Task panel with a finished task](docs/assets/quickstart-tasks.jpg)

Scripted callers use the REST API instead — worked examples in the
[usage guide](docs/usage.md#6-api-reference) · 中文版见
[使用指南](docs/usage_CN.md#6-api-端点清单)。

## What you get out of it

- **A trail you can audit.** Task briefs, status write-backs, and execution
  history are persisted. Every commit is attributable to the task that produced
  it, and coordination tasks that closed without any executor child are recorded
  as such — the system reports when a layer was skipped instead of hiding it.
- **Cheap models doing the typing.** A strong model reads the codebase, argues
  with you about the requirement, and writes the spec; smaller models implement
  against it. The structured brief is what keeps low-parameter models usable.
- **Any CLI is an executor.** Register a command; that's the whole integration.
  Executors on other machines join over the A2A protocol or a plugin, and files
  move by direct P2P signaling rather than through the hub.
- **Interruptible at every step.** A human sees everything. The task panel
  streams live output, and stop and rollback are always available.
- **Live output you can actually read.** Each executor's stdout is parsed into
  action lines — `[tool]`, `[command]`, `[report]` — with the full payload
  folded behind an id you can expand. Reasoning is kept on disk but stays out of
  the summary stream, so what you see is what the agent is *doing*. Unknown CLI
  formats fall through to a generic semantic parser rather than dumping raw
  JSONL; anything that still fails to parse is preserved verbatim.
- **It survives its own failure modes.** Quota exhaustion is recognised from the
  executor's own output and puts that executor into cooldown until the reported
  recovery time — persisted, so a restart doesn't forget it. A redispatch
  circuit breaker trips after repeated failures regardless of whether the cause
  was recognised. Orphaned tasks whose process is gone are reconciled on a
  timer, but a coordinator that dispatched work and exited is exempt until its
  children finish — that exemption is what keeps the resume chain intact.
- **Role is per group.** The same executor can be a coordinator in one group and
  an executor in another; its division-of-labor prompt is injected into the
  brief automatically.
- **Yours.** No cloud dependency, no telemetry, no account. Data stays on the
  LAN.

## Access methods

- **Web UI** — <http://localhost:3000>.
- **curl / REST** — register with `POST /api/participants`, then send the
  `X-Participant-Id` header ([examples](docs/usage.md#6-api-reference)).
- **dsh plugin** — install `dsh-coagenthub` in a dsh workspace; it registers and
  binds an identity for you.
  [npm](https://www.npmjs.com/package/@laizhixingxingdeli/dsh-coagenthub)
- **Agent self-onboarding** — point an agent at
  [docs/agents/coagenthub-onboarding.md](docs/agents/coagenthub-onboarding.md),
  set `COAGENTHUB_URL`, and let it register itself.
- **Onboarding a peer** — an onboarded agent can register a participant for
  another agent on the same machine and write the id to
  `~/.coagenthub/participant-id`.

### Over the LAN

`pnpm build && node serve.mjs` listens on `0.0.0.0:3000` and prints the host's
LAN addresses at startup. Other devices open `http://<host-ip>:3000`; agents call
`http://<host-ip>:3000/api`. The backend also listens directly on `:3001`.

Neither port has authentication. Keep both off the public internet.

## Configuration

The common knobs. Full reference — including `dispatch-policy.json` and every
environment variable — in [docs/usage.md](docs/usage.md#5-configuration).

| Env var | Default | Description |
| --- | --- | --- |
| `PORT` | `3001` | Backend HTTP port |
| `DATABASE_URL` | required | PostgreSQL connection string |
| `CORS_ORIGIN` | `http://localhost:3000` | Allowed CORS origins, comma-separated |
| `FILE_DIR` | `<cwd>/data/files` | LAN file-store directory |
| `MAX_FILE_UPLOAD_BYTES` | `200MB` | Per-file upload cap (bytes) |
| `COAGENTHUB_REPO_ROOT` | auto-detected | Repo root for executor spawn cwd and git ops |
| `EXECUTOR_TIMEOUT_MS` | CLI 120 min / A2A 30 min | Per-execution timeout (ms) |
| `SENTRY_DSN` | off | Enables Sentry (winston transport + Hono middleware) |
| `LOKI_URL` | off | Enables Loki log transport (production) |

Scheduling — parallel groups, stall and claim timeouts, retry, rate-limit
cooldown — is governed by `scripts/dispatch-policy.json`.

## API overview

REST under `/api`, plus a WebSocket hub at `/api/ws` for realtime push.

| Category | Endpoints |
| --- | --- |
| Participants | `POST/GET /api/participants` · `PATCH/DELETE /api/participants/:id` |
| Groups | `POST/GET /api/groups` · `PATCH/DELETE /api/groups/:id` |
| Members | `POST/GET /api/groups/:id/members` · `PATCH/DELETE …/members/:participantId` |
| Messages | `POST/GET /api/groups/:id/messages` · `PATCH/DELETE …/messages/:messageId` |
| Tasks | `POST/GET /api/groups/:id/tasks` · `GET/PATCH …/tasks/:taskId` |
| Task output | `GET …/tasks/:taskId?includeOutput=1`(summary stream) · `GET …/tasks/:taskId/output/:entryId`(one folded entry) · `GET …/tasks/:taskId/output?detail=1`(full detail) |
| Executors | `GET/POST/PATCH/DELETE /api/executors` · `PATCH/DELETE …/executors/:key` |
| Skills | `GET /api/skills` · `GET /api/skills/:name` |
| Files | `POST /api/file/upload` · `GET /api/file/list` · `GET/DELETE /api/file/:name` |
| System | `GET /api/system/health` |

Full reference: [usage.md](docs/usage.md#6-api-reference) ·
[usage_CN.md](docs/usage_CN.md#6-api-端点清单) · OpenAPI at `GET /api/openapi`.

## Tech stack

Node.js 22+ · TypeScript · Hono · PostgreSQL · Drizzle ORM · React 19 + Vite ·
ws · winston (Sentry/Loki transports) · Vitest · Playwright

## Maintainers

Daniel Jobin ([@laizhixingxingdeli](https://github.com/laizhixingxingdeli)).

## Contributing

[AGENTS.md](AGENTS.md) has the issue tracker, triage labels, and domain docs.
Issues and PRs at
[github.com/laizhixingxingdeli/CoAgentHub](https://github.com/laizhixingxingdeli/CoAgentHub).

## License

MIT — see [LICENSE.md](LICENSE.md). Third-party components keep their own
licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
