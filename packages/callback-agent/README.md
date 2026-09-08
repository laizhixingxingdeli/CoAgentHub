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
  "leaseMs": 90000,                      // Lease duration (must be > timeouts)
  "defaultTimeoutMs": 60000,             // Default command timeout (< leaseMs)
  "endpoints": {
    "<endpointRef>": {
      "driver": {
        "driver": "command",
        "executable": "/absolute/path/to/bin",  // MUST be absolute
        "args": ["exec", "resume", "{sessionRef}", "{message}"], // static or {placeholder}
        // Child env is an EXPLICIT ALLOWLIST (see below). Unmentioned parent
        // vars are never inherited — including secrets and proxy settings.
        "inheritEnv": ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"],
        "env": {
          "MY_APP_MODE": "callback"
        },
        "timeoutMs": 60000                     // optional per-endpoint; must be < leaseMs
      }
    }
  }
}
```

#### Environment allowlist (breaking change)

Child processes **do not** inherit the callback-agent process environment.

Layers (later wins):

1. **Hardcoded minimal set** copied from the parent when present: `PATH`, `HOME`,
   `USERPROFILE` / `HOMEDRIVE` / `HOMEPATH`, `SYSTEMROOT` / `WINDIR`, `TEMP` /
   `TMP`, `LANG` / `LC_*`, `PATHEXT`, `COMSPEC`. Not configurable.
2. **`inheritEnv`**: named keys copied from the parent when present (allowlist).
3. **`env`**: explicit key/value pairs from this config.

**Upgrade note:** configs that previously relied on ambient inheritance (for
example picking up `HTTPS_PROXY`, `SSL_CERT_FILE`, `AWS_*`, `GH_TOKEN`, or a
tool's own API keys from the agent process) must now list those names under
`inheritEnv` or set literal values under `env`.

Copy-paste example when the host command needs a proxy and a custom flag:

```json
{
  "driver": "command",
  "executable": "/usr/local/bin/my-cli",
  "args": ["{message}"],
  "inheritEnv": ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"],
  "env": {
    "MY_CLI_CONFIG": "/etc/my-cli/callback.toml"
  },
  "timeoutMs": 60000
}
```

#### Lease vs timeout (startup guard)

`defaultTimeoutMs` and every per-driver `timeoutMs` **must be strictly less than
`leaseMs`**. The agent refuses to start otherwise. This prevents a still-running
command from outliving its lease so a second consumer can claim and start the
same command again.

Defaults are self-consistent: `leaseMs=90000`, `defaultTimeoutMs=60000`.

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
- **Explicit env allowlist** — child env is the hardcoded minimal set plus optional `inheritEnv` names and `env` key/values. `spawn` is never called with `env: undefined` (which would inherit every parent secret).
- **Timeout < lease** — startup validation rejects configs where a command could outlive its lease under dual consumers.
- **No arbitrary webhooks** — commands are configured locally; the agent never reads URLs, commands, or credentials from the event.
- **Dedupe-before-ack** — local write happens before core ack; crash between them only results in a redundant ack.

## Tests

```bash
pnpm --filter @laizhixingxingdeli/callback-agent test
```

Covers all Spec acceptance criteria: fake API integration, competing consumers, ack-failure recovery, non-zero exit / timeout / spawn-error handling, config validation, shell metacharacter safety, env allowlist (sentinel), lease/timeout guard, and Codex argv ordering.
