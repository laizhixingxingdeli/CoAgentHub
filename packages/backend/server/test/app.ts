import BizError from "@laizhixingxingdeli/error/biz";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import executorRouter from "../src/routes/executor";
import fileRouter from "../src/routes/file";
import groupRouter from "../src/routes/group";
import participantRouter from "../src/routes/participant";
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

  return (
    app
      .route("/system", systemRouter)
      .route("/file", fileRouter)
      // /participants 为主路径;/agents 是历史别名(agent 为 participant 的旧名),
      // 与 index.ts 挂载保持一致,过渡期兼容旧客户端。
      .route("/participants", participantRouter)
      .route("/agents", participantRouter)
      .route("/executors", executorRouter)
      .route("/groups", groupRouter)
  );
}
