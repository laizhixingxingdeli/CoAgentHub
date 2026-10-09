# CoAgentHub

[中文](README.md) | [English](README_EN.md)

**Run several AI coding agents on one requirement in three layers — and leave an evidence trail for every step.**

CoAgentHub is a local, agent-first software-engineering harness. You hand a requirement to a *reviewer* (any agent session you already have open). The platform turns it into a bounded change (a **Mission**); a *coordinator* model plans it and writes frozen work orders; cheap, fast *executor* models carry them out. The platform runs the verification itself, stores the evidence, enforces the gates, recovers from failures — and the reviewer signs the result into an integration branch. Merging into `main` is always yours.

It is not tied to any one agent or model:

- **L3 reviewer** — any agent that can run commands or speak MCP: Claude Code, Codex, Cursor, Gemini CLI, opencode… ([docs/l3-agents.md](docs/l3-agents.md))
- **L2 coordinator / L1 executor** — any model supported by [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent): Anthropic, OpenAI, Google, DeepSeek, xAI, OpenRouter, Ollama, local llama.cpp… ([docs/models.md](docs/models.md))
- Want a different agent runtime for L2/L1? The platform talks to it over a plain stdin/stdout protocol: [docs/adapter-protocol.md](docs/adapter-protocol.md).

> **Status: preview.** Developed and tested on Windows 11. The code is written to be cross-platform but Linux/macOS are not verified yet — reports welcome. The HTTP API has **no authentication** and listens on `127.0.0.1` only; there is no sandbox. Read [docs/security.md](docs/security.md) before pointing it at code you care about.
> Most documentation is currently in Chinese; English translations of the guides are welcome.

## The three layers

| Layer | Who | Owns | Does not touch |
|---|---|---|---|
| **L3 reviewer** | an agent session you have open | understands the requirement, freezes it into a contract ("ticket"), starts the Mission, watches it, signs the final merge into the integration branch | writes no feature code, does no code-level acceptance |
| **L2 coordinator** | a model session the platform launches | plans inside one Mission, splits work items, writes frozen work orders, accepts each delivery against the evidence | cannot change the contract |
| **L1 executor** | a (usually cheap) model session | executes one frozen work order, submits changes and evidence | no self-acceptance, does not redefine the goal |

Core model: **Project → Mission → WorkItem → Attempt**. Principles: *evidence over wording* (the platform runs the verification commands itself), *enforce in tools, not in prompts*, *expensive models only for expensive judgements*, and *nothing is `completed` without the reviewer*.

## Quick start

Requires **Node 24+**, **git**, **npm** (only for `setup`), a model account or API key that pi supports, and an agent to act as reviewer.

```bash
git clone https://github.com/laizhixingxingdeli/CoAgentHub.git
cd CoAgentHub
node scripts/coagent.mjs setup     # installs adapter + MCP server deps (the platform itself has zero dependencies)
node scripts/coagent.mjs doctor    # read-only self-check: tells you what is still missing
node scripts/coagent.mjs start     # open http://127.0.0.1:3101
```

Then: log a model account in with `npx pi` (`/login`) and add candidates on the pool page; give your reviewer agent the MCP server and the operating manual; run your first Mission on the bundled playground project. Step by step: [docs/getting-started.md](docs/getting-started.md) (Chinese).

The platform has no build step and no third-party dependency (Postgres storage is optional and the only thing that needs `pg`):

```bash
node --test          # full test suite, nothing to install first
```

On a machine without Postgres, about 90 database tests show up as skipped (skipped is neither pass nor fail).

## Layout

```
src/            the platform: kernel (pure domain) / application / runtime / api / web (plain ES modules)
adapters/pi/    the L2/L1 adapter built on pi; the platform talks to it over stdin/stdout, imports no agent SDK
integrations/   L3 hookups: MCP server (any agent), Codex plugin hooks, Claude Code skill + config
scripts/        the launcher (coagent.mjs) and read-only MCP / watch helpers
examples/       a playground project, contract / pool / pi-models examples
.coagent/       the project's own long-term memory (specs, ADRs, module map) — this repo is developed with itself
docs/           guides
```

## License

See [LICENSE](LICENSE). Contributing: [CONTRIBUTING.md](CONTRIBUTING.md).
