import { getConnInfo } from "@hono/node-server/conninfo";
import type { MiddlewareHandler } from "hono";
import type { ConnInfo } from "hono/conninfo";

type ConnectionInfo = ConnInfo & { ip: string };

/** Resolve the best-effort client IP (proxy headers first, loopback fallback). */
export const connInfoMiddleware: MiddlewareHandler<{
  Variables: { connInfo: ConnectionInfo };
}> = async (c, next) => {
  const raw = getConnInfo(c);
  const forwarded = c.req.header("x-forwarded-for");
  const ip =
    c.req.header("cf-connecting-ip") ??
    forwarded?.split(",")[0]?.trim() ??
    "127.0.0.1";
  c.set("connInfo", { ip, remote: raw.remote });
  await next();
};
