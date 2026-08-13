import { createHash, randomBytes } from "node:crypto";

/**
 * Participant token utilities. The plaintext token is generated once, returned
 * to the registrant exactly one time, and only ever stored as a SHA-256 hash —
 * see middleware/participant-auth.ts for the lookup side.
 *
 * 函数名原为 generateAgentToken/hashAgentToken(agent 为 participant 的旧名,
 * 术语改名后统一 participant;token 本身兼容 —— 哈希算法与库中已存哈希不变)。
 */
export function generateParticipantToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashParticipantToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
