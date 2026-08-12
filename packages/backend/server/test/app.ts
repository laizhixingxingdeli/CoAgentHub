import BizError from "@laizhixingxingdeli/error/biz";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import agentRouter from "../src/routes/agent";
import executorRouter from "../src/routes/executor";
import fileRouter from "../src/routes/file";
import groupRouter from "../src/routes/group";
import systemRouter from "../src/routes/system";

/**
 * Assembles the same route tree index.ts mounts — but WITHOUT starting a
 * server. Tests drive it through app.request() (Hono's in-memory request
 * runner), so nothing listens on a port and no real DB is contacted (the
 * database/auth modules are swapped in test/setup.ts).
 */
export function createTestApp() {
  const app = new Hono().basePath("/api");

  // Mirror index.ts error handling: BizError maps to its status code + code.
  app.onError((err, c) => {
    if (err instanceof BizError) {
      return c.json(
        { code: err.code, message: err.message },
        err.statusCode as ContentfulStatusCode,
      );
    }
    return c.json({ message: "Internal Server Error" }, 500);
  });

  return app
    .route("/system", systemRouter)
    .route("/file", fileRouter)
    .route("/agents", agentRouter)
    .route("/executors", executorRouter)
    .route("/groups", groupRouter);
}
