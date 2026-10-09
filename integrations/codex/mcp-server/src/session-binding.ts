import { writeBinding } from "./l3-state.js";

export type SessionStartInput = {
  session_id?: unknown;
  cwd?: unknown;
  hook_event_name?: unknown;
  source?: unknown;
};

export function bindSessionStart(
  input: SessionStartInput,
  dataDir: string,
  options: { recipient?: string; inboxScope?: "recipient" | "all" } = {},
): { bound: boolean; context: string } {
  if (input.hook_event_name !== "SessionStart") {
    return {
      bound: false,
      context: "CoAgentHub v5 hook ignored: not a SessionStart event.",
    };
  }
  if (typeof input.session_id !== "string" || input.session_id.trim() === "") {
    return {
      bound: false,
      context:
        "CoAgentHub v5 L3 auto-bind skipped: Codex did not provide session_id.",
    };
  }

  const sessionId = input.session_id.trim();
  const inboxScope = options.inboxScope ?? "recipient";
  const recipient =
    inboxScope === "all" ? undefined : options.recipient?.trim() || sessionId;

  writeBinding(dataDir, {
    sessionId,
    cwd: typeof input.cwd === "string" ? input.cwd : process.cwd(),
    inboxScope,
    ...(recipient ? { recipient } : {}),
    ...(typeof input.source === "string" ? { source: input.source } : {}),
    updatedAt: new Date().toISOString(),
  });

  return {
    bound: true,
    context: [
      "CoAgentHub v5 L3 is bound to this Codex root session.",
      inboxScope === "all"
        ? "The bridge is explicitly configured to consume the full durable Delivery Inbox."
        : `The bridge only consumes Delivery recipient ${recipient}.`,
      "Use the coagenthub-v5 Mission/L3 MCP tools; legacy group/task/participant tools do not apply.",
    ].join(" "),
  };
}
