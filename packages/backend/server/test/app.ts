import { Hono } from "hono";
import { createOnError } from "../src/lib/on-error";
import executorRouter from "../src/routes/executor";
import fileRouter from "../src/routes/file";
import groupRouter from "../src/routes/group";
import participantRouter from "../src/routes/participant";
import runtimeHealthRouter from "../src/routes/runtime-health";
import skillsRouter from "../src/routes/skills";
import systemRouter from "../src/routes/system";

/**
 * Assembles the same route tree index.ts mounts — but WITHOUT starting a
 * server. Tests drive it through app.request() (Hono's in-memory request
 * runner), so nothing listens on a port and no real DB is contacted (the
 * database/auth modules are swapped in test/setup.ts).
 */
export function createTestApp() {
  const app = new Hono().basePath("/api");

  // 与 index.ts 共用同一 onError 实现(lib/on-error.ts),杜绝镜像漂移。
  // 测试夹具不打日志(生产经 winston)——日志级别契约由
  // json-body-parse-failure.test.ts 用 spy logger 对同一实现直接断言;
  // 测试未挂 hono/request-id 中间件,响应体不带 requestId(与既有形状一致)。
  const silentLogger = {
    warn: () => undefined,
    error: () => undefined,
  };
  app.onError(createOnError(silentLogger));

  return (
    app
      .route("/system", systemRouter)
      .route("/health", runtimeHealthRouter)
      .route("/file", fileRouter)
      // /participants 为主路径;/agents 是历史别名(agent 为 participant 的旧名),
      // 与 index.ts 挂载保持一致,过渡期兼容旧客户端。
      .route("/participants", participantRouter)
      .route("/agents", participantRouter)
      .route("/executors", executorRouter)
      .route("/groups", groupRouter)
      .route("/skills", skillsRouter)
  );
}
