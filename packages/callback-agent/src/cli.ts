#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CallbackAgent } from "./callback-agent.js";
import { CallbackAgentConfigSchema } from "./config.js";
import { DedupeStore } from "./dedupe.js";
import type { Logger } from "./logger.js";

/**
 * CLI entry point for callback-agent.
 *
 * Usage:
 *   callback-agent run           # one-shot poll & process
 *   callback-agent daemon        # continuous polling (graceful exit)
 *   callback-agent validate      # validate config and exit
 *
 * Options:
 *   --config <path>   Path to JSON config file (default: ./callback-agent.json)
 *   --dedupe <path>   Path to dedupe store file (default: ./callback-agent-dedupe.jsonl)
 *   --log <level>     Log level: info | warn | error (default: info)
 */

const args = process.argv.slice(2);

function parseArgs(): {
  command: string;
  configPath: string;
  dedupePath: string;
  logLevel: "info" | "warn" | "error";
} {
  let configPath = "./callback-agent.json";
  let dedupePath = "./callback-agent-dedupe.jsonl";
  let logLevel: "info" | "warn" | "error" = "info";

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case "--config":
        configPath = args[++i] ?? configPath;
        break;
      case "--dedupe":
        dedupePath = args[++i] ?? dedupePath;
        break;
      case "--log":
        logLevel = (args[++i] as "info" | "warn" | "error") ?? "info";
        break;
      case "--help":
        printHelp();
        return { command: args[0], configPath, dedupePath, logLevel };
      default:
        console.warn(`Unknown option: ${args[i]}`);
        printHelp();
        process.exit(1);
    }
  }

  return { command: args[0], configPath, dedupePath, logLevel };
}

function printHelp(): void {
  console.log(`callback-agent — Generic CLI Agent callback driver

Usage:
  callback-agent <command> [options]

Commands:
  run         One-shot poll: claim and process pending events, then exit
  daemon      Continuous polling with graceful shutdown (SIGINT/SIGTERM)
  validate    Validate config file and exit

Options:
  --config <path>   Path to JSON config (default: ./callback-agent.json)
  --dedupe <path>   Path to dedupe store (default: ./callback-agent-dedupe.jsonl)
  --log <level>     Log level: info | warn | error (default: info)
  --help            Show this help
`);
}

function loadConfig(configPath: string) {
  const absPath = resolve(configPath);
  let raw: string;
  try {
    raw = readFileSync(absPath, "utf-8");
  } catch (err) {
    console.error(`Failed to read config from ${absPath}: ${err}`);
    process.exit(1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`Invalid JSON in ${absPath}: ${err}`);
    process.exit(1);
  }
  const result = CallbackAgentConfigSchema.safeParse(parsed);
  if (!result.success) {
    console.error(`Config validation failed:\n${result.error.message}`);
    process.exit(1);
  }
  return result.data;
}

function createLogger(level: "info" | "warn" | "error"): Logger {
  const levels = { info: 0, warn: 1, error: 2 };
  const minLevel = levels[level];
  return {
    info:
      minLevel <= 0
        ? (msg?: string) => console.log(`[callback-agent] ${msg}`)
        : undefined,
    warn:
      minLevel <= 1
        ? (msg?: string) => console.warn(`[callback-agent] ${msg}`)
        : undefined,
    error:
      minLevel <= 2
        ? (msg?: string) => console.error(`[callback-agent] ${msg}`)
        : undefined,
  };
}

async function main(): Promise<void> {
  const { command, configPath, dedupePath, logLevel } = parseArgs();
  const logger = createLogger(logLevel);

  if (command === "help") {
    printHelp();
    return;
  }

  if (command === "validate") {
    loadConfig(configPath);
    console.log("Config is valid.");
    return;
  }

  if (command !== "run" && command !== "daemon") {
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
  }

  const config = loadConfig(configPath);
  const dedupe = new DedupeStore(resolve(dedupePath));
  const agent = new CallbackAgent({ config, dedupeStore: dedupe, logger });

  if (command === "run") {
    const processed = await agent.runOnce();
    console.log(`Processed ${processed} event(s).`);
    return;
  }

  if (command === "daemon") {
    await agent.run();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
