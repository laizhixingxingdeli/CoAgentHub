import { agent as agentTable } from "@laizhixingxingdeli/database/schema";
import { eq } from "drizzle-orm";
import { generateAgentToken, hashAgentToken } from "./agent-token";
import type { DataBase } from "./database";

/**
 * 局域网信任模型下的默认观察者身份:请求不带 token 时,以这个
 * 「本地用户」(human 角色,全可见)访问,免绑定即可浏览群组。
 * 懒创建 + 进程内缓存;开机时 ensureExecutorAgents 也会预建。
 */
export const DEFAULT_LOCAL_USER_NAME = "Local User";

let cachedLocalUserId: string | null = null;

export async function resolveLocalUser(db: DataBase): Promise<string> {
  if (cachedLocalUserId) {
    return cachedLocalUserId;
  }
  const existing = await db
    .select({ id: agentTable.id })
    .from(agentTable)
    .where(eq(agentTable.name, DEFAULT_LOCAL_USER_NAME))
    .limit(1);
  if (existing[0]) {
    cachedLocalUserId = existing[0].id;
    return cachedLocalUserId;
  }
  // Note: agent.name 目前没有唯一约束,onConflictDoNothing 实际是空操作 —
  // 创建串行化靠开机预建(ensureExecutorAgents)+ 进程内缓存保证。保留该
  // 子句,以便将来 name 加了 UNIQUE 后此处自动具备幂等性。
  await db
    .insert(agentTable)
    .values({
      name: DEFAULT_LOCAL_USER_NAME,
      type: "human",
      tokenHash: hashAgentToken(generateAgentToken()),
    })
    .onConflictDoNothing();
  const created = await db
    .select({ id: agentTable.id })
    .from(agentTable)
    .where(eq(agentTable.name, DEFAULT_LOCAL_USER_NAME))
    .limit(1);
  cachedLocalUserId = created[0]?.id ?? null;
  if (!cachedLocalUserId) {
    throw new Error("Local User agent could not be resolved");
  }
  return cachedLocalUserId;
}

/** Forget the cache (tests register/reset agents). */
export function clearLocalUserCache(): void {
  cachedLocalUserId = null;
}
