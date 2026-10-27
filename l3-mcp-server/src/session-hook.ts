import {
  pluginDataDir,
  writePluginDataPointer,
} from "./l3-state.js";
import {
  bindSessionStart,
  type SessionStartInput,
} from "./session-binding.js";
import { ensureBridge } from "./bridge-supervisor.js";

const input = await readStdin();
const dataDir = pluginDataDir();

// Overwrite on every SessionStart so an MCP process that only sees the pointer
// cannot keep pointing at a data dir that PLUGIN_DATA has since moved away from.
if (process.env.PLUGIN_DATA?.trim()) writePluginDataPointer(dataDir);

try {
  const scope =
    process.env.COAGENTHUB_INBOX_SCOPE?.trim().toLowerCase() === "all"
      ? "all"
      : "recipient";
  const recipient =
    process.env.COAGENTHUB_INBOX_RECIPIENT?.trim() || undefined;
  // Binding takeover is opt-in: by default a new chat must not steal the
  // Delivery bridge from the session that is already receiving.
  const takeover =
    process.env.COAGENTHUB_BINDING_TAKEOVER?.trim() === "1";
  const result = bindSessionStart(input, dataDir, {
    inboxScope: scope,
    ...(recipient ? { recipient } : {}),
    ...(takeover ? { takeover: true } : {}),
  });
  // The BRIDGE=0 switch lives inside the shared ensureBridge, so the hook and
  // the MCP supervision timer cannot drift apart on which switch applies.
  // An unbound SessionStart still skips the call: there is no chat to deliver to.
  if (result.bound) ensureBridge(dataDir);
  emitContext(result.context);
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      systemMessage: `CoAgentHub v5 L3 binding failed: ${safeError(error)}`,
    }),
  );
}

async function readStdin(): Promise<SessionStartInput> {
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  const normalized = raw.replace(/^\uFEFF/u, "").trim();
  if (!normalized) return {};
  const value = JSON.parse(normalized) as unknown;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as SessionStartInput)
    : {};
}

function emitContext(additionalContext: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext,
      },
    }),
  );
}

function safeError(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 1000)
    : String(error).slice(0, 1000);
}
