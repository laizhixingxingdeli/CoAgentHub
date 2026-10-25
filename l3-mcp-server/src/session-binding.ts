import {
  activateSessionBinding,
  bindingRecipient,
  readBindingForRecipient,
  readSessionBinding,
  registerSessionBinding,
  type L3SessionBinding,
} from "./l3-state.js";

export type SessionStartInput = {
  session_id?: unknown;
  cwd?: unknown;
  hook_event_name?: unknown;
  source?: unknown;
};

export type BindSessionStartOptions = {
  recipient?: string;
  inboxScope?: "recipient" | "all";
  /**
   * Explicit activation: make this session the active default and take the
   * inbox over from any other registered session. The hook only sets this when
   * `COAGENTHUB_BINDING_TAKEOVER=1`; the default is never to steal a binding.
   */
  takeover?: boolean;
};

export function bindSessionStart(
  input: SessionStartInput,
  dataDir: string,
  options: BindSessionStartOptions = {},
): { bound: boolean; context: string; activated?: boolean } {
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

  const binding: L3SessionBinding = {
    sessionId,
    cwd: typeof input.cwd === "string" ? input.cwd : process.cwd(),
    inboxScope,
    ...(recipient ? { recipient } : {}),
    ...(typeof input.source === "string" ? { source: input.source } : {}),
    updatedAt: new Date().toISOString(),
  };

  if (options.takeover) {
    activateSessionBinding(dataDir, binding);
    return {
      bound: true,
      activated: true,
      context: [
        "CoAgentHub v5 L3 is bound to this Codex root session and took over the Delivery bridge.",
        describeScope(inboxScope, recipient),
        "Use the coagenthub-v5 Mission/L3 MCP tools; legacy group/task/participant tools do not apply.",
      ].join(" "),
    };
  }

  const { registration, activeSessionId } = registerSessionBinding(
    dataDir,
    binding,
  );

  if (registration === "inactive") {
    return {
      bound: true,
      activated: false,
      context: [
        "CoAgentHub v5 L3 registered this Codex root session, but the Delivery bridge stays bound to another active session.",
        activeSessionId
          ? `Active Delivery recipient: ${activeRecipientLabel(dataDir, activeSessionId)}.`
          : undefined,
        "Set COAGENTHUB_BINDING_TAKEOVER=1 for this session to take the bridge over explicitly.",
        "Use the coagenthub-v5 Mission/L3 MCP tools; legacy group/task/participant tools do not apply.",
      ]
        .filter(Boolean)
        .join(" "),
    };
  }

  const refreshed = registration === "refreshed";
  return {
    bound: true,
    activated: true,
    context: [
      refreshed
        ? "CoAgentHub v5 L3 is bound to this Codex root session (binding refreshed)."
        : "CoAgentHub v5 L3 is bound to this Codex root session.",
      describeScope(inboxScope, recipient),
      "Use the coagenthub-v5 Mission/L3 MCP tools; legacy group/task/participant tools do not apply.",
    ].join(" "),
  };
}

/**
 * Explicit activation/takeover entry point for callers that know the session.
 * Registers the session (if needed) and points the active default at it.
 */
export function activateSessionForBridge(
  dataDir: string,
  binding: L3SessionBinding,
): void {
  activateSessionBinding(dataDir, binding);
}

/**
 * Resolve which registered session should receive a Delivery. Returns undefined
 * when nothing registered for that recipient, so the bridge never queues into
 * "whatever chat opened last".
 */
export function resolveSessionForRecipient(
  dataDir: string,
  recipient: string,
): L3SessionBinding | undefined {
  return readBindingForRecipient(dataDir, recipient);
}

function describeScope(
  inboxScope: "recipient" | "all",
  recipient: string | undefined,
): string {
  return inboxScope === "all"
    ? "The bridge is explicitly configured to consume the full durable Delivery Inbox."
    : `The bridge only consumes Delivery recipient ${recipient}.`;
}

function activeRecipientLabel(dataDir: string, sessionId: string): string {
  const active = readSessionBinding(dataDir, sessionId);
  return (active && bindingRecipient(active)) || sessionId;
}
