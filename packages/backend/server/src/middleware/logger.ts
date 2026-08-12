import { getLogger } from "@server/lib/plugins/winston";
import type { MiddlewareHandler } from "hono";

const log = getLogger("server");

/** Attach the shared logger and log one line per finished request. */
export const loggerMiddleware: MiddlewareHandler<{
  Variables: { logger: typeof log };
}> = async (c, next) => {
  c.set("logger", log);
  const startedAt = Date.now();
  await next();
  log.info("request finished", {
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    durationMs: Date.now() - startedAt,
  });
};
