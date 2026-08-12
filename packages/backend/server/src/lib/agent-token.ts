import { createHash, randomBytes } from "node:crypto";

/**
 * Agent token utilities. The plaintext token is generated once, returned to
 * the registrant exactly one time, and only ever stored as a SHA-256 hash —
 * see middleware/agent-auth.ts for the lookup side.
 */
export function generateAgentToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashAgentToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
