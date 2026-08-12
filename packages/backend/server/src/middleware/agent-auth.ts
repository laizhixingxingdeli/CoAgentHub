import { agent as agentTable } from "@laizhixingxingdeli/database/schema";
import BizError, { BizCodeEnum } from "@laizhixingxingdeli/error/biz";
import { hashAgentToken } from "@server/lib/agent-token";
import { resolveLocalUser } from "@server/lib/local-agent";
import type { DataBase } from "@server/lib/database";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";

/**
 * Agent identity resolution (LAN trust model):
 * - `Authorization: Bearer <token>` with a valid token → that agent;
 * - no token → the default Local User (human role, sees everything), so the
 *   web UI works without binding a token;
 * - a present-but-invalid token → 401 (a supplied identity must be real).
 */
export const agentAuth: MiddlewareHandler<{
  Variables: {
    db: DataBase;
    agentId: string;
  };
}> = async (c, next) => {
  const db = c.get("db");
  const header = c.req.header("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;

  if (!token) {
    c.set("agentId", await resolveLocalUser(db));
    await next();
    return;
  }

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
