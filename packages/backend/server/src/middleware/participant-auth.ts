import { participant as participantTable } from "@laizhixingxingdeli/database/schema";
import BizError, { BizCodeEnum } from "@laizhixingxingdeli/error/biz";
import type { DataBase } from "@server/lib/database";
import { resolveLocalUser } from "@server/lib/local-participant";
import { hashParticipantToken } from "@server/lib/participant-token";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";

/**
 * Participant identity resolution (LAN trust model):
 * - `Authorization: Bearer <token>` with a valid token → that participant;
 * - no token → the default Local User (human role, sees everything), so the
 *   web UI works without binding a token;
 * - a present-but-invalid token → 401 (a supplied identity must be real).
 *
 * 中间件原名为 agent-auth(agent 为 participant 的旧名);Authorization header
 * 格式与 token 语义不变,旧 token 直接兼容。
 */
export const participantAuth: MiddlewareHandler<{
  Variables: {
    db: DataBase;
    participantId: string;
  };
}> = async (c, next) => {
  const db = c.get("db");
  const header = c.req.header("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;

  if (!token) {
    c.set("participantId", await resolveLocalUser(db));
    await next();
    return;
  }

  const matches = await db
    .select({ id: participantTable.id })
    .from(participantTable)
    .where(eq(participantTable.tokenHash, hashParticipantToken(token)))
    .limit(1);
  if (!matches[0]) {
    throw new BizError(BizCodeEnum.Unauthorized);
  }

  c.set("participantId", matches[0].id);
  await next();
};
