import "dotenv/config";
import { initSentry } from "./lib/plugins/sentry";

initSentry();

import "zod-openapi/extend";

import type { Server as HttpServer } from "node:http";
import { serve } from "@hono/node-server";
import { sentry } from "@hono/sentry";
import BizError from "@laizhixingxingdeli/error/biz";

import { Scalar } from "@scalar/hono-api-reference";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { showRoutes } from "hono/dev";
import { requestId } from "hono/request-id";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { openAPISpecs } from "hono-openapi";
import { v7 as uuidv7 } from "uuid";
import type { Logger } from "winston";
import { corsOrigins, serverPort } from "./lib/config";
import type { DataBase } from "./lib/database";
import db from "./lib/database";
import { recoverInterruptedTasks } from "./lib/executor-task";
import { ensureExecutorParticipants } from "./lib/executors";
import { getLogger } from "./lib/plugins/winston";
import { wsHub } from "./lib/ws-hub";
import { connInfoMiddleware } from "./middleware/conn-info";
import { loggerMiddleware } from "./middleware/logger";
import executorRouter from "./routes/executor";
import fileRouter from "./routes/file";
import groupRouter from "./routes/group";
import participantRouter from "./routes/participant";
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
// 统一错误出口:BizError → 业务码;其余 → 500。一律经 winston 记录(含
// requestId,便于关联请求日志),响应体带 requestId 便于客户端定位。
const errorLog = getLogger("server");
app.onError((err, c) => {
  const requestIdValue = c.get("requestId");
  if (err instanceof BizError) {
    errorLog.warn("request failed (biz error)", {
      requestId: requestIdValue,
      code: err.code,
      status: err.statusCode,
      message: err.message,
      method: c.req.method,
      path: c.req.path,
    });
    return c.json(
      { code: err.code, message: err.message, requestId: requestIdValue },
      err.statusCode as ContentfulStatusCode,
    );
  }
  errorLog.error("request failed (internal error)", {
    requestId: requestIdValue,
    method: c.req.method,
    path: c.req.path,
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  return c.json(
    { message: "Internal Server Error", requestId: requestIdValue },
    500,
  );
});

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
  .route("/groups", groupRouter);

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
  const port = serverPort();

  // On restart, mark queued/running executor tasks as failed (the queue is
  // in-memory; persistence only exists as a failure backstop).
  try {
    await recoverInterruptedTasks(db);
  } catch (err) {
    console.warn("[executor] task recovery failed, continuing startup:", err);
  }

  // 桥已退役:server 是唯一调度器——开机时把执行器配置(含 hermes)对应的
  // participant 幂等注册进 participant 表。
  try {
    await ensureExecutorParticipants(db);
  } catch (err) {
    console.warn(
      "[executor] participant auto-registration failed, continuing:",
      err,
    );
  }

  const server = serve({ fetch: app.fetch, port }, ({ address, port: p }) => {
    console.log(`server listening on ${address}:${p}`);
    showRoutes(app);
  });

  // Realtime push: attach the WS hub to the same HTTP server so /api/ws
  // upgrade requests (identity via ?participantId=) are handled alongside HTTP.
  wsHub.handleUpgrade(server as HttpServer);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
