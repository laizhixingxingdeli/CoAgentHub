import "dotenv/config";
import { initSentry } from "./lib/plugins/sentry";

initSentry();

import "zod-openapi/extend";

import type { Server as HttpServer } from "node:http";
import { sentry } from "@hono/sentry";
import { Scalar } from "@scalar/hono-api-reference";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { showRoutes } from "hono/dev";
import { requestId } from "hono/request-id";
import { openAPISpecs } from "hono-openapi";
import { v7 as uuidv7 } from "uuid";
import type { Logger } from "winston";
import { corsOrigins, serverPort } from "./lib/config";
import type { DataBase } from "./lib/database";
import db from "./lib/database";
import {
  recoverInterruptedTasks,
  restoreExecutorCooldowns,
  startCoordinatorResumeConsumer,
  startQueuedTaskReclaim,
} from "./lib/executor-task";
import { startL3OverdueReminder } from "./lib/l3-overdue-reminder";
import { assertNoPendingMigrations } from "./lib/migration-health";
import { startOrphanReconciler } from "./lib/orphan-task-reconciler";
import { getLogger } from "./lib/plugins/winston";
import { createOnError } from "./lib/on-error";
import { configureRuntimeEntry, logRuntimeStartup } from "./lib/runtime-status";
import { startServer } from "./lib/server-startup";
import { acquireSingleServerLock } from "./lib/single-server-lock";
import { wsHub } from "./lib/ws-hub";
import { connInfoMiddleware } from "./middleware/conn-info";
import { loggerMiddleware } from "./middleware/logger";
import executorRouter from "./routes/executor";
import fileRouter from "./routes/file";
import groupRouter from "./routes/group";
import participantRouter from "./routes/participant";
import runtimeHealthRouter from "./routes/runtime-health";
import skillsRouter from "./routes/skills";
import systemRouter from "./routes/system";

declare module "hono" {
  interface ContextVariableMap {
    db: DataBase;
    logger: Logger;
    connInfo: import("hono/conninfo").ConnInfo & { ip: string };
    participantId: string;
  }
}

const app = new Hono().basePath("/api");

/* ---------- error handling ---------- */
// 统一错误出口,实现见 lib/on-error.ts(specs/json-body-parse-failure-returns-500.md):
// BizError → 业务码;HTTPException < 500(如 body 解析失败)→ err.status 且 warn;
// 其余 → 500。一律经 winston 记录(含 requestId),响应体带 requestId 便于定位。
const errorLog = getLogger("server");
app.onError(createOnError(errorLog));

/* ---------- global middleware ---------- */
app.use(
  "*",
  cors({
    // env CORS_ORIGIN 可配(逗号分隔多个),缺省 http://localhost:3000。
    origin: corsOrigins(),
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "X-Participant-Id",
      "Upgrade-Insecure-Requests",
    ],
    allowMethods: ["GET", "HEAD", "PUT", "POST", "DELETE", "PATCH", "OPTIONS"],
    exposeHeaders: ["Content-Length", "X-Kuma-Revision"],
    maxAge: 600,
    credentials: true,
  }),
);

app.use(requestId({ generator: () => uuidv7() }));

if (process.env.SENTRY_DSN) {
  app.use(sentry({ dsn: process.env.SENTRY_DSN }));
}

app.use(connInfoMiddleware);
app.use(loggerMiddleware);

/* ---------- routes ---------- */
export const routes = new Hono()
  .route("/system", systemRouter)
  .route("/file", fileRouter)
  // /participants 为主路径;/agents 是历史别名(同一 handler,过渡期兼容
  // 旧客户端/旧执行器,agent 为 participant 的旧名),不 404。
  .route("/participants", participantRouter)
  .route("/agents", participantRouter)
  .route("/executors", executorRouter)
  .route("/groups", groupRouter)
  .route("/health", runtimeHealthRouter)
  .route("/skills", skillsRouter);

app.route("/", routes);

/* ---------- API docs ---------- */
app.get("/docs", Scalar({ theme: "purple", url: "/api/openapi" }));

app.get(
  "/openapi",
  openAPISpecs(routes, {
    documentation: {
      info: { title: "CoAgentHub API", version: "4.0.0" },
      servers: [{ url: "/api", description: "Local Server" }],
      // x-tagGroups is a vendor extension for the Scalar docs sidebar; it is
      // not part of OpenAPIV3.Document, so spread it via a typed record.
      ...({
        "x-tagGroups": [
          { name: "System", tags: ["Health"] },
          { name: "File", tags: ["File"] },
        ],
      } as Record<string, unknown>),
    },
  }),
);

/* ---------- bootstrap ---------- */
async function run() {
  configureRuntimeEntry(import.meta.url);
  logRuntimeStartup();

  // Single-server enforcement (ADR-0003 memory-scheduler reality): session
  // advisory lock on a dedicated non-pooled connection. Fail fast before any
  // recovery/mutation if another instance already owns this DATABASE_URL.
  // See lib/single-server-lock.ts (R2: must not use the Drizzle pool).
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set");
  }
  await acquireSingleServerLock({ connectionString: databaseUrl });

  const port = serverPort();

  // Do not let a new build serve requests against an older schema. This is a
  // read-only check; applying migrations remains an explicit operator action.
  await assertNoPendingMigrations(db);

  // Bind first. Recovery writes to the database, so it must only run after
  // this process owns the port.
  //
  // Built-in executors are intentionally NOT auto-registered as participants
  // here (removed per user request). Onboarding is always an explicit step
  // via POST /api/participants, which already resolves executorKey by
  // matching the registered name against known executor configs
  // (findExecutorKeyByInitialName in lib/executors.ts) — so routing works
  // correctly for a manually-onboarded participant without this callback.
  const server = await startServer({
    fetch: app.fetch,
    port,
    recoverInterruptedTasks: () => recoverInterruptedTasks(db),
    restoreExecutorCooldowns: () => restoreExecutorCooldowns(db),
    onListening: (listeningServer, listeningPort) => {
      const address = listeningServer.address();
      console.log(
        `server listening on ${typeof address === "string" ? address : address?.address}:${listeningPort}`,
      );
      showRoutes(app);
    },
  });

  // Realtime push: attach the WS hub to the same HTTP server so /api/ws
  // upgrade requests (identity via ?participantId=) are handled alongside HTTP.
  wsHub.handleUpgrade(server as HttpServer);
  startCoordinatorResumeConsumer(db);
  startOrphanReconciler(db);
  // 队列兜底:链条失败/重启后遗留的 queued 任务补回队列、不可拾起原因可见、
  // 超阈值按 stall 告警(specs/queued-task-never-picked-up-after-chain-failure)。
  startQueuedTaskReclaim(db);
  await startL3OverdueReminder(db);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
