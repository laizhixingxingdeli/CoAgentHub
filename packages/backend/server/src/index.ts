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
import type { DataBase } from "./lib/database";
import db from "./lib/database";
import { ensureExecutorAgents } from "./lib/executors";
import { recoverInterruptedTasks } from "./lib/executor-task";
import { wsHub } from "./lib/ws-hub";
import { connInfoMiddleware } from "./middleware/conn-info";
import { loggerMiddleware } from "./middleware/logger";
import agentRouter from "./routes/agent";
import fileRouter from "./routes/file";
import groupRouter from "./routes/group";
import systemRouter from "./routes/system";

declare module "hono" {
  interface ContextVariableMap {
    db: DataBase;
    logger: Logger;
    connInfo: import("hono/conninfo").ConnInfo & { ip: string };
    agentId: string;
  }
}

const app = new Hono().basePath("/api");

/* ---------- error handling ---------- */
app.onError((err, c) => {
  if (err instanceof BizError) {
    return c.json(
      { code: err.code, message: err.message },
      err.statusCode as ContentfulStatusCode,
    );
  }
  console.error(err);
  return c.json({ message: "Internal Server Error" }, 500);
});

/* ---------- global middleware ---------- */
app.use(
  "*",
  cors({
    origin: ["http://localhost:3000"],
    allowHeaders: [
      "Content-Type",
      "Authorization",
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
  .route("/agents", agentRouter)
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
  const port = process.env.PORT ? Number(process.env.PORT) : 3001;

  // On restart, mark queued/running executor tasks as failed (the queue is
  // in-memory; persistence only exists as a failure backstop).
  try {
    await recoverInterruptedTasks(db);
  } catch (err) {
    console.warn("[executor] task recovery failed, continuing startup:", err);
  }

  // 桥已退役:server 是唯一调度器——开机时把执行器配置(含 hermes)对应的
  // agent 幂等注册进 agent 表。
  try {
    await ensureExecutorAgents(db);
  } catch (err) {
    console.warn("[executor] agent auto-registration failed, continuing:", err);
  }

  const server = serve({ fetch: app.fetch, port }, ({ address, port: p }) => {
    console.log(`server listening on ${address}:${p}`);
    showRoutes(app);
  });

  // Realtime push: attach the WS hub to the same HTTP server so /api/ws
  // upgrade requests (auth via ?token=) are handled alongside HTTP.
  wsHub.handleUpgrade(server as HttpServer);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
