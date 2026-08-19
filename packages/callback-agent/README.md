# @laizhixingxingdeli/callback-agent

Generic Callback Agent and Command Driver for CoAgentHub.

Consumes [Durable Task Completion Events](../docs/adr/0006-durable-task-completion-events.md) from a participant's inbox and restores the original CLI agent session via a **local static command configuration** — never by executing arbitrary webhooks or reading URLs/secrets from the event.

## Why

CoAgentHub core persists a completion event the first time a task enters a terminal state (`done`/`failed`/`cancelled`). The callback agent is a standalone process that:

1. Polls the participant's completion-event inbox.
2. Claims an event (atomic lease via core API).
3. Selects a local endpoint configuration by `callbackRef.endpointRef`.
4. Spawns the configured command (`shell:false`) with the standard `<coagenthub-task-completion>` message.
5. On success, atomically records the `eventId` in a local dedupe store **then** acks — crash between write and ack only re-acks on restart, never re-executes.

## Install

```bash
pnpm --filter @laizhixingxingdeli/callback-agent build
```

## Usage

### Configuration

Create a JSON config (see [`examples/codex.json`](examples/codex.json) for a Codex example):

```jsonc
{
  "apiBase": "http://localhost:3001",     // CoAgentHub server base URL
  "participantId": "<uuid>",             // The participant whose inbox to poll
  "consumerId": "my-callback-consumer",  // Lease owner identifier
  "pollIntervalMs": 5000,                // Polling interval in daemon mode
  "leaseMs": 30000,                      // Lease duration
  "defaultTimeoutMs": 60000,             // Default command timeout
  "endpoints": {
    "<endpointRef>": {
      "driver": {
        "driver": "command",
        "executable": "/absolute/path/to/bin",  // MUST be absolute
        "args": ["exec", "resume", "{sessionRef}", "{message}"], // static or {placeholder}
        "env": { "HOME": "/Users/me" },         // optional fixed allowlist
        "timeoutMs": 120000                     // optional per-endpoint override
      }
    }
  }
}
```

#### Argument placeholders

Each argument must be either a **static string** or a **single complete placeholder**:

| Placeholder   | Resolves to                                    |
| ------------- | ---------------------------------------------- |
| `{sessionRef}`| `callbackRef.sessionRef` (or `""` if absent)  |
| `{message}`   | The full JSON `<coagenthub-task-completion>` message |
| `{eventFile}` | Absolute path to a temp file containing the message |

Mixed placeholders like `prefix-{sessionRef}` are rejected at validation time.

### CLI

```bash
# Validate config
callback-agent validate --config ./callback-agent.json

# One-shot poll (process all claimable events, then exit)
callback-agent run --config ./callback-agent.json

# Daemon mode (continuous polling, graceful shutdown on SIGINT/SIGTERM)
callback-agent daemon --config ./callback-agent.json

# Custom dedupe store location
callback-agent daemon --config ./callback-agent.json --dedupe ./dedupe.jsonl
```

### Library

```ts
import { CallbackAgent, DedupeStore } from "@laizhixingxingdeli/callback-agent";

const agent = new CallbackAgent({
  config,
  dedupeStore: new DedupeStore("./dedupe.jsonl"),
});

// One-shot
await agent.runOnce();

// Continuous (until SIGINT/SIGTERM)
await agent.run();
```

## Safety

- **`shell:false` always** — executable and args come from local static config, never from the event.
- **No secret inheritance** — only explicitly allowlisted env vars are passed to the child.
- **No arbitrary webhooks** — commands are configured locally; the agent never reads URLs, commands, or credentials from the event.
- **Dedupe-before-ack** — local write happens before core ack; crash between them only results in a redundant ack.

## Tests

```bash
pnpm --filter @laizhixingxingdeli/callback-agent test
```

Covers all Spec acceptance criteria: fake API integration, competing consumers, ack-failure recovery, non-zero exit / timeout / spawn-error handling, config validation, shell metacharacter safety, and Codex argv ordering.
