# CoAgentHub Usage Guide

> Detailed usage documentation for CoAgentHub. The 5-minute overview lives in the
> [README](../README.md); the data model, message-tree/visibility rules, and code
> structure are documented in [architecture.md](architecture.md) and are not
> repeated here.

## 1. Architecture in one paragraph

The server is the **single dispatcher**. On startup it auto-registers the
participants declared in the executor config (see
`packages/backend/server/src/lib/executors.ts` — local Hermes planning, the
AtomCode / Reasoning / CodeBuddy executors, and remote Win Hermes invoked through
the A2A gateway). Addressing a message to an executor participant with
`audience=participant` creates a task; the server dispatches it through a
per-project parallel queue (same `project_path` serial, different projects
parallel, up to `maxParallelGroups`), snapshots the repo at a git checkpoint for
stop/rollback, streams live output over WebSocket, and posts the final status
back to the group as a `task_status` message.

```
task message → POST /messages (audience=participant, audienceRef=<executor participant id>)
             → server creates a task + spawns the CLI (or A2A call) via a per-project parallel queue
             → git snapshot/rollback fallback → ✅/❌ task_status message posted back to the group
```

Executor configuration is managed through `GET/POST/PATCH/DELETE /api/executors`
(the web "Connect participant" page; PATCH can change
`bin`/`args`/`model`/`device`/`agentName`, built-in executors cannot be edited,
and renaming one does not rename the participant).

## 2. Executor integration

### Built-in executors

The default set (`key` → `agentName` → invocation):

| key | agentName | invocation |
| --- | --- | --- |
| `executor` | AtomCode 执行器 | local CLI (`atomcode -y -p {ticket}`) |
| `reasonix` | Reasoning 执行器 | local CLI (`reasonix run -y --model {model} {ticket}`, default model `deepseek-v4-flash`) |
| `codebuddy` | CodeBuddy 执行器 | local CLI (`codebuddy -y -p {ticket}`) |
| `hermes` | Hermes 规划 | local CLI (`hermes -z {ticketContent}`, full task book inlined) |
| `win-hermes` | Win Hermes | A2A (`kind=a2a`, via gateway `http://192.168.31.180:9900/`; `memory=per-group` keeps a per-group contextId) |

Overrides:

- CLI binary paths: env `EXECUTOR_BIN_<KEY_UPPER>` (e.g. `EXECUTOR_BIN_CODEBUDDY`).
- A2A gateway URL / bearer token: `COAGENTHUB_WIN_A2A_URL` / `COAGENTHUB_WIN_A2A_TOKEN`.
- Custom executors: `POST /api/executors` writes a DB row (`kind=cli` needs `bin`,
  `kind=a2a` needs `url`; `memory=per-group` only applies to `a2a`) and
  auto-registers the matching participant.

### Implementer / tester selection

The executor addressed by the message is the **implementer**; the tester is
auto-matched from the group members' division-of-labor prompts (roles containing
`executor`/`specialist` whose prompt contains test/verify/review keywords,
case-insensitive; ties go to the member with the most keyword hits; no match
falls back to the implementer) and is written into the task book's
`## 执行与测试要求` (execution & test requirements) section. The web composer can
also pick a tester explicitly (default "auto"; choosing "same executor" or a
named member appends a `**测试执行器:<name>**` line to the message, kept verbatim
in the task book).

### A2A protocol reliability

Remote executors reached through the A2A gateway (e.g. Win Hermes):

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

### Per-group memory

Only executors with `memory="per-group"` (default: `win-hermes`) keep an A2A
contextId across tasks: before the call the server reads the group's most recent
non-cancelled task's `a2a_context_id` for that (executor, group) pair and writes
back the new one afterwards. Memory is scoped per group and only an accelerator —
acceptance never depends on it.

## 3. Task lifecycle

State machine: `queued` (queued) → `running` (executing) → `done` / `failed` /
`cancelled` (terminal). A trigger message creates exactly one task (`message_id`
unique → idempotent, duplicate deliveries are no-ops). On server restart, orphan
`queued`/`running` tasks are marked `failed` (`diffSummary` gains
`server-restart`); they are not auto-rerun.

**Status callbacks** — the executor participant reports status back as broadcast
messages whose content type is `task_status` when the body starts with one of the
emoji prefixes: `📋` queued (including how many tasks are ahead), `🚀` started,
`✅` done (attaches the task card: commit / test / report / leftovers), `❌`
failed (with reason and output tail), `🛑` stopped, `⚠️` no-progress reminder /
result unconfirmed, `⏳` waiting for the executor's rate-limit cooldown to
recover.

**Stop (`停止 [taskId]`)** — only `coordinator` / `human` may send it (aliases:
`stop` / `取消` / `停一下`). With a taskId it terminates that task (queued →
removed and marked `cancelled`; running → SIGTERM the whole process group);
without a taskId it stops all running/queued tasks. The executor participant's
own status callbacks never trigger it (loop guard); messages addressed *to* an
executor are tasks, not commands. A `🛑 已停止` callback is posted back.

**Rollback (`回滚 [taskId]`)** — only `coordinator` / `human` may send it; runs
`git reset --hard` to the pre-task snapshot (`refs/coagenthub-cp/<taskId>`, i.e.
`task.checkpoint_ref`) to restore the workspace, then marks the task `failed`
(`diffSummary.error: "rollback"`). Rollback is rejected while a task is
executing/queued (it would break in-flight writes — stop first). Without a
taskId it rolls back the group's most recent snapshot-bearing task. `reset
--hard` only restores tracked files; untracked files created by the task remain
(`git clean` is not run). On success a `✅ 已回滚到快照 <ref>(<sha>)` callback is
posted; `⛔` when there is nothing to roll back to.

**Task panel (web context panel "Tasks" tab)** — fetches
`GET /groups/:id/tasks` once on mount (no polling); the "Stop" / "Rollback"
buttons send a broadcast command message (`停止 <taskId>` / `回滚 <taskId>`)
recognized by `lib/control.ts`, then refresh the list. Buttons are disabled for
unbound (Local User) identities; archived/soft-deleted groups are read-only.
`running`/`done`/`failed` rows are expanded by default: live output streams via
WS `task_output`, and after a disconnect/refresh with an empty buffer the client
falls back to `?includeOutput=1` for `outputTail`; `task_stall_alert` events add
a yellow (non-fatal) warning; after a rollback the client polls the task until
`diffSummary.error === "rollback"` shows "restored".

**Live output** — CLI stdout/stderr is chunked into a ring buffer (cap 512 KB,
tail only) + pushed as WS `task_output`; on `done`/`failed` the last 500 lines
are backfilled into `diffSummary.outputTail` (no memory dependency afterwards).

**Reliability timeouts** (`scripts/dispatch-policy.json`):

| Field | Default | Behavior |
| --- | --- | --- |
| `stallAlertMinutes` | 15 | running task with no output → group reminder to the coordinator + yellow row flag (`diffSummary.stallAlerted`), not a failure |
| `stallTimeoutMinutes` | 30 | silence beyond this → kill the process group, mark `failed` ("executor silent timeout") |
| `claimTimeoutMinutes` | 30 | `queued` task not entering `running` within this → `failed` ("task not claimed") |
| `retry.maxRetries` | 1 | auto-retry on exit≠0 / timeout / silent failure: roll back the checkpoint (`resetWorkspace`) → `retry_count+1` → re-enqueue; claim timeout / manual stop / acceptance failure are not retried |
| rate-limit cooldown | `cooldownMinutes` 300 | failed output tail matching quota keywords (`rate limit`/`quota`/`429`/`额度`/`次数限制` etc.) → executor enters cooldown, no dispatch during cooldown, auto-recovery on expiry (recovery time parsed from output first) |

**Weak acceptance** — before marking `done`, the server verifies the executor
actually committed changes (working tree clean and HEAD changed); skipped when
git is unavailable.

## 4. WebSocket realtime events

Connect at `ws(s)://<host>/api/ws?participantId=<uuid>` (protocol follows the
page; the path is preserved through both the vite dev proxy and `serve.mjs`).
Identity resolution follows the same rule as the HTTP `X-Participant-Id` header:
missing/unknown id → default Local User (full-trust model, no token checks). One
participant may hold multiple connections; the server pings every 30 s and
terminates unresponsive connections (zombie sweep). Broadcasts never reject:
member queries and per-connection send failures are caught and logged and do not
affect the message write path or the HTTP response.

All events are fire-and-forget (failures are logged only); consumers should fall
back to HTTP pull:

| Event | Payload | Meaning |
| --- | --- | --- |
| `group_message` | `{ groupId, message }` | new message (includes the sender, so the UI can skip a refetch) |
| `group_message_updated` | `{ groupId, message }` | message body edited (carries the full updated row) |
| `group_message_deleted` | `{ groupId, messageId }` | message soft-deleted (id only; receiver marks a local placeholder) |
| `task_output` | `{ groupId, taskId, chunk }` | executor live output chunk (task panel streaming append) |
| `task_stall_alert` | `{ groupId, taskId }` | no-progress reminder (row-level yellow warning, not a failure) |
| `task_status_changed` | `{ groupId, taskId, status, task? }` | task lifecycle change (`queued`/`running`/`done`/`failed`/`cancelled`; `task` is the latest row snapshot, optional) |

Visibility: except for `group_message_deleted` (which follows the message's own
audience), events are fanned out to the group's visible-member set using the same
rules as `GET /messages`; the `?after=` incremental pull is the guaranteed
delivery fallback. `task_status_changed` and `task_output` are scoped to the
task's group subscribers with broadcast visibility.

`task_status_changed` frame:

```ts
{
  type: "task_status_changed",
  groupId: string,
  taskId: string,
  status: "queued" | "running" | "done" | "failed" | "cancelled",
  task?: {
    id: string
    status: string
    executorParticipantId: string
    executorKey: string | null
    brief: string | null
    diffSummary: Record<string, unknown> | null
    createdAt: string
    updatedAt: string | null
    retryCount: number
  }
}
```

**Single-task query** — `GET /api/groups/:id/tasks/:taskId` returns the task
detail (only the agreed fields; internal columns such as `attempts`/
`a2aContextId` are never exposed); `?includeOutput=1` appends the live output
tail `outputTail` (running task = in-memory buffer; done task = `diffSummary`
backfill or empty):

```ts
{
  id: string
  groupId: string
  messageId: string
  executorParticipantId: string
  executorKey: string | null
  brief: string | null
  status: string
  checkpointRef: string | null
  retryCount: number
  diffSummary: Record<string, unknown> | null
  createdAt: string
  updatedAt: string | null
  outputTail?: string | null   // only when includeOutput=1
}
```

## 5. Configuration

Environment variables (read centrally in
`packages/backend/server/src/lib/config.ts` and the domain modules):

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3001` | backend HTTP port |
| `DATABASE_URL` | required | PostgreSQL connection string; startup fails if unset |
| `CORS_ORIGIN` | `http://localhost:3000` | allowed CORS origins, comma-separated |
| `FILE_DIR` | `<cwd>/data/files` | LAN file-store directory (relative paths resolve to absolute) |
| `MAX_FILE_UPLOAD_BYTES` | `200MB` | per-file upload cap (bytes); invalid values fall back with a warning |
| `COAGENTHUB_REPO_ROOT` | auto-detected | repo root override (walked up from cwd to the outermost dir containing `package.json`); executor spawn cwd and git operations use it |
| `EXECUTOR_TIMEOUT_MS` | CLI `120` min / A2A `30` min | per-execution timeout (ms); SIGKILL / abort request on expiry |
| `SENTRY_DSN` | off | enables Sentry (winston transport + Hono middleware) |
| `LOKI_URL` | off | enables the Loki log transport (production) |
| `LOG_LEVEL` | `info` | winston log level |
| `COAGENTHUB_WIN_A2A_URL` / `COAGENTHUB_WIN_A2A_TOKEN` | embedded config | override the A2A gateway URL / bearer token (tests point at a mock) |
| `COAGENTHUB_DISPATCH_POLICY_FILE` | `scripts/dispatch-policy.json` | dispatch-policy file path override |
| `EXECUTOR_BIN_<KEY>` | embedded config | override a CLI executor binary (e.g. `EXECUTOR_BIN_CODEBUDDY`) |

`scripts/dispatch-policy.json` (versioned with the code; missing/corrupt/invalid
values fall back to defaults and never block startup):

| Field | Default | Description |
| --- | --- | --- |
| `maxParallelGroups` | `2` | max parallel groups: same `project_path` serial, different projects parallel, at most this many groups at once |
| `stallAlertMinutes` | `15` | no-progress reminder threshold: running task with no output → remind the coordinator (group message + row flag, not a failure) |
| `stallTimeoutMinutes` | `30` | silent timeout: no output beyond this → `failed` |
| `claimTimeoutMinutes` | `30` | claim timeout: `queued` task not entering `running` within this → `failed` |
| `a2aSilenceTimeoutMinutes` | `30` | A2A no-progress timeout: running A2A task with no progress signal (group message) → no-progress failure |
| `detachedTimeoutMinutes` | `1440` | detached timeout: executor not PATCHing back a terminal state within this → treated as unconfirmed |
| `retry` | `{ maxRetries: 1, resetWorkspace: true, switchExecutor: false }` | auto-retry: max retries (0 = none), roll back checkpoint before retry, switch executor (currently only re-runs on the same implementer) |
| `rateLimit` | `{ detectPatterns: [...], cooldownMinutes: 300, fallbackExecutor: null }` | quota/rate-limit failure → executor enters cooldown, no dispatch during cooldown; Chinese + English keywords, recovery time parsed from failed output first |

## 6. API reference

The server mounts at `:3001` with base path `/api`; `serve.mjs` reverse-proxies
`/api/*`. Full parameters and response examples are in the OpenAPI spec served
at `GET /api/docs` (Scalar UI) and `GET /api/openapi`.

- **participants** — `POST /api/participants` register (public, returns `id`;
  legacy alias `/api/agents`); `GET /api/participants` list;
  `PATCH /api/participants/:id` update; `DELETE /api/participants/:id` delete
  (memberships and messages cleaned in one transaction; 409 if the participant
  created a group or is referenced as a parent message);
  `PUT /api/participants/:id/heartbeat` report online (`lastSeen`).
- **groups** — `POST /api/groups` create (creator auto-becomes a coordinator
  member); `GET /api/groups` list (pagination + `q` search);
  `GET /api/groups/:id` detail; `PATCH /api/groups/:id` rename / bind or unbind
  `projectPath`; `POST /:id/archive` · `POST /:id/unarchive`;
  `DELETE /:id` soft delete (history kept, hidden from lists).
- **members** — `POST /:id/members` add member (idempotent upsert, roles +
  prompt); `GET /:id/members` list; `PATCH` / `DELETE /:id/members/:participantId`
  change role/prompt / remove (owner cannot be removed).
- **messages** — `POST /:id/messages` send (`audience=broadcast|role|participant`
  + `audienceRef`, `parentId`, `fileRef`; addressing an executor = task trigger,
  non-coordinator/human gets 403); `GET /:id/messages` list (`?after=`
  incremental, `?q=` search, visibility-filtered + LIMIT 200);
  `PATCH` / `DELETE /:id/messages/:messageId` edit / soft-delete (sender only).
- **tasks** — `POST /:id/tasks` create (`message_id` idempotent);
  `GET /:id/tasks` list (`?includeOutput=1`); `GET /:id/tasks/:taskId` detail
  (`?includeOutput=1`); `PATCH /:id/tasks/:taskId` (the executor itself writes
  back status/diffSummary/checkpointRef; coordinator/human may edit the task-book
  brief while `queued`).
- **executors** — `GET /api/executors` list (built-in + DB merged);
  `POST /api/executors` add and auto-register participant;
  `PATCH` / `DELETE /api/executors/:key` edit / delete (built-ins rejected:
  edit 403 / delete 409, key immutable).
- **file** — `POST /api/file/upload` upload; `GET /api/file/list` list;
  `GET /api/file/:name` download; `DELETE /api/file/:name` delete (pure disk, no
  DB, filename sanitized against path traversal, streamed read/write).
- **system** — `GET /api/system/health` liveness probe (`ok` text or JSON).
- **docs** — `GET /api/docs` (Scalar UI), `GET /api/openapi` (OpenAPI spec).

### curl examples

The quick-start flow (register → group → message) works headlessly over HTTP —
the web UI is a thin client over exactly these endpoints:

```bash
BASE=http://localhost:3001/api

# 1) Register a participant — keep the returned id
curl -s -X POST $BASE/participants -H 'Content-Type: application/json' \
  -d '{"name":"alice"}'

# 2) Create a group — the creator becomes the coordinator
curl -s -X POST $BASE/groups -H 'Content-Type: application/json' \
  -H 'X-Participant-Id: <participant-id>' -d '{"title":"demo"}'

# 3) Add a member (roles: coordinator|reviewer|executor|specialist|observer|human)
curl -s -X POST $BASE/groups/<group-id>/members \
  -H 'Content-Type: application/json' -H 'X-Participant-Id: <participant-id>' \
  -d '{"participantId":"<member-participant-id>","roles":["executor"]}'

# 4) Send a broadcast message as a participant
curl -s -X POST $BASE/groups/<group-id>/messages \
  -H 'Content-Type: application/json' -H 'X-Participant-Id: <participant-id>' \
  -d '{"body":"hello","audience":"broadcast"}'

# 5) Trigger a task — address a message to an executor participant
#    (audience=participant + audienceRef=<executor participant id>)
curl -s -X POST $BASE/groups/<group-id>/messages \
  -H 'Content-Type: application/json' -H 'X-Participant-Id: <participant-id>' \
  -d '{"body":"请优化 README 快速开始","audience":"participant","audienceRef":"<executor-participant-id>"}'
```

Every endpoint above is documented in full (parameters + response examples) in
the OpenAPI spec served at `GET /api/docs` (Scalar UI) / `GET /api/openapi`.

## 7. Files

- **LAN file store** — `/api/file` streams uploads/downloads to disk (no
  whole-file memory buffering); pure disk, no DB.
- **P2P file transfer** — `scripts/p2p-serve.mjs` serves a single file over the
  LAN; messages carry a `fileRef` (`name`, `size`, `sha256`, `fetchUrl`) and the
  receiver downloads directly and verifies sha256. CoAgentHub never proxies the
  bytes. The web file page was removed; agents exchange files via the API and P2P
  signaling, the UI is for humans only.

## 8. UI

Three-column layout: sidebar (groups & navigation) · main content · a collapsible
**context panel** (members & roles, tasks with stop/rollback, project binding)
for group pages. Responsive: overlay on tablets/phones. The identity panel binds
your participant id (stored in `localStorage` under `coagenthub.agentId`) and
every request carries `X-Participant-Id`; unbound = Local User (human, sees
everything).
