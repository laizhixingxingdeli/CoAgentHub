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

## 接入你的 Participant

server 是**唯一的调度器**(任务桥已退役):开机时自动注册执行器配置里的 participant
(见 `packages/backend/server/src/lib/executors.ts`,含本地 Hermes 规划、AtomCode /
Reasoning / CodeBuddy 执行器,以及经 A2A gateway 调用的远端 Win Hermes)。在群里
用 `audience=participant` 定向到某个执行器 participant 即触发任务。接入/编辑执行器
配置走 `GET/POST/PATCH/DELETE /api/executors`(网页「接入 Participant」页;PATCH 支持
改 bin/args/model/device/agentName,内置执行器不可编辑,改名不会自动改 participant 名):

```
任务消息 → POST /messages(audience=participant, audienceRef=<执行器 participant id>)
         → server 建 task + 按项目分组的并行队列 spawn CLI(或 A2A 调用)
         → git 快照/回滚兜底 → 完成后 ✅/❌ task_status 消息回传群里
```

**执行器分工选择**:定向消息指定的执行器 = 实现执行器;测试执行器按群成员分工提示词
自动匹配(roles 含 executor/specialist 且 prompt 含测试/验证/检验/test/verify/review
关键词,大小写不敏感;多个匹配取关键词出现最多者,稳定选一;无匹配则默认由实现执行器
完成测试),写入任务书「执行与测试要求」段。网页发送器可选「测试执行器」(默认
「自动」;选「同一执行器」或显式成员时,消息里追加 `**测试执行器:<名>**` 行,任务书
原样保留——「同一执行器」= 测试由实现执行器自己完成,显式成员按名字生效)。

**任务状态实时推送(`task_status_changed`)**:任务状态在 `queued / running /
done / failed / cancelled` 任一变化时,server 经 `/api/ws` 向**任务所属群的
订阅者**推送(与 `task_output` 同界,broadcast 可见性;fire-and-forget——推送
失败只告警不重试,依赖方仍应以 HTTP 拉取兜底)。事件帧:

```ts
{
  type: "task_status_changed",
  groupId: string,
  taskId: string,
  status: "queued" | "running" | "done" | "failed" | "cancelled",
  task?: {  // 可选:最新任务行快照(与任务面板行同形状,日期为 ISO 字符串)
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

**单任务查询**:`GET /api/groups/:id/tasks/:taskId` 返回任务详情(只暴露约定
字段,不泄露 attempts/a2aContextId 等内部列);`?includeOutput=1` 时附加实时
输出尾部 `outputTail`(running 任务 = 内存缓冲;已完成任务 = diffSummary 回填
或留空):

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
  outputTail?: string | null   // 仅 includeOutput=1 时出现
}
```

**A2A 协议可靠性**(经 A2A gateway 调用的远端执行器,如 Win Hermes):
- **进度/心跳**:A2A 任务 `running` 期间,执行器 participant 在群内发送的消息
  视为进展信号,刷新 `lastActivityAt` 并顺延无进展超时;连续无进展超过
  `a2aSilenceTimeoutMinutes`(默认 30,`scripts/dispatch-policy.json`)→ 无进展失败。
- **结果未确认**:gateway「agent did not reply in time」/ 请求超时但有进展 /
  网络错误 / HTTP 5xx 时不直接按失败处理——`diffSummary` 增加
  `{ error: "执行器未按协议回复，结果未确认", unconfirmed: true }`,群内回传
  `⚠️ 任务结果未确认`(不回传 ❌、不自动重试)。
- **可脱离执行(detached)**:任务书支持 `## ReplyMode: detached`(大小写不敏感);
  A2A 发送完成即视为「已派发」,任务保持 `running`,由执行器恢复后
  `PATCH /api/groups/:id/tasks/:taskId` 回写终态;超过
  `detachedTimeoutMinutes`(默认 1440)仍未回写 → 按「结果未确认」处理。

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
│                       #   routes/group/ → groups/members/messages/tasks 子路由 + helpers
│                       #   lib/executor-task/ → types/state/output-buffer/notify/report/queue
│                       #   lib/config.ts 统一配置读取
├── backend/database/   # Drizzle schema + migrations (PostgreSQL; 0015 = group_id 索引)
├── frontend/web/       # React 19 + Vite + wouter SPA
└── common/             # error codes + shared tsconfig presets
docs/                   # Nextra documentation site
serve.mjs               # LAN static server + /api reverse proxy + WS upgrade
```

## License

MIT — see [LICENSE.md](LICENSE.md). Third-party components retain their own
licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
