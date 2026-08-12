import { agent as agentTable } from "@laizhixingxingdeli/database/schema";
import BizError, { BizCodeEnum } from "@laizhixingxingdeli/error/biz";
import { hashAgentToken } from "@server/lib/agent-token";
import type { DataBase } from "@server/lib/database";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";

/**
 * Agent token auth: resolves `Authorization: Bearer <token>` against the
 * agents table by SHA-256 hash and exposes the matched agent id on the
 * request context (`c.get("agentId")`). Requests without a token, or with a
 * token that matches no registered agent, are rejected with 401.
 *
 * This is the identity foundation for later tickets (group membership,
 * message audience); it is intentionally not applied to any route yet.
 */
export const agentAuth: MiddlewareHandler<{
  Variables: {
    db: DataBase;
    agentId: string;
  };
}> = async (c, next) => {
  const header = c.req.header("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  if (!token) {
    throw new BizError(BizCodeEnum.Unauthorized);
  }

  const db = c.get("db");
  const matches = await db
    .select({ id: agentTable.id })
    .from(agentTable)
    .where(eq(agentTable.tokenHash, hashAgentToken(token)))
    .limit(1);
  if (!matches[0]) {
    throw new BizError(BizCodeEnum.Unauthorized);
  }

  c.set("agentId", matches[0].id);
  await next();
};
