import { participant as participantTable } from "@laizhixingxingdeli/database/schema";
import type { DataBase } from "@server/lib/database";
import { resolveLocalUser } from "@server/lib/local-participant";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";

/**
 * Participant identity resolution (LAN full-trust model):
 * - `X-Participant-Id: <uuid>` header claiming an existing participant → that
 *   participant (冒名无害:全信模型不再校验 token,任何存在的 id 都被接受);
 * - missing header / non-existent id → the default Local User (human role,
 *   sees everything), so the web UI works without binding an identity.
 *
 * 中间件原名为 participant-auth(再早为 agent-auth);token 认证已移除,只保留
 * 「身份声明」。历史 token 校验逻辑见 git 历史。
 */
export const participantIdentity: MiddlewareHandler<{
  Variables: {
    db: DataBase;
    participantId: string;
  };
}> = async (c, next) => {
  const db = c.get("db");
  const claimedId = c.req.header("X-Participant-Id")?.trim();

  // 缺失或格式不合法(非 uuid)→ 回落 Local User,不报错(宽容,避免误伤)。
  // 格式校验必须在查库之前:非 uuid 文本直接进 PG uuid 列会抛类型错误 → 500。
  if (!claimedId || !UUID_RE.test(claimedId)) {
    c.set("participantId", await resolveLocalUser(db));
    await next();
    return;
  }

  // 全信模型:声称的身份存在则采用;不存在 → 回落 Local User。
  const matches = await db
    .select({ id: participantTable.id })
    .from(participantTable)
    .where(eq(participantTable.id, claimedId))
    .limit(1);

  c.set("participantId", matches[0]?.id ?? (await resolveLocalUser(db)));
  await next();
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
