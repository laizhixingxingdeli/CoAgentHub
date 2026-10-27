import { spawn, type SpawnOptions } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  clearDeadDaemonPid,
  listSessionBindings,
  pidIsAlive,
  pluginDataDir,
  readDaemonPid,
} from "./l3-state.js";

export type BridgeSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => { unref(): void };

export function ensureBridge(
  dataDir: string,
  deps: { spawn?: BridgeSpawn; env?: NodeJS.ProcessEnv } = {},
): boolean {
  const env = deps.env ?? process.env;
  // A zero switch must stop both the hook and the MCP timer. Leaving the
  // daemon down is the point of the switch; spawning anyway would defeat tests
  // that inherit a real environment.
  if (env.COAGENTHUB_L3_BRIDGE === "0") return false;
  clearDeadDaemonPid(dataDir);
  const pid = readDaemonPid(dataDir);
  if (pid && pidIsAlive(pid)) return false;
  // No registered chat means there is nobody to deliver to. Starting the
  // daemon would only poll an empty registry.
  if (listSessionBindings(dataDir).length === 0) return false;
  const launch = deps.spawn ?? defaultSpawn;
  const here = dirname(fileURLToPath(import.meta.url));
  const child = launch(process.execPath, [join(here, "l3-daemon.js")], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...env, PLUGIN_DATA: dataDir },
  });
  child.unref();
  return true;
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): { unref(): void } {
  return spawn(command, args, options);
}

export function startBridgeSupervision(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.COAGENTHUB_L3_BRIDGE === "0") return;
  const tick = () => {
    try {
      ensureBridge(pluginDataDir(env), { env });
    } catch {
      // A failed spawn must not take down the MCP server; the next tick retries.
    }
  };
  tick();
  const timer = setInterval(tick, 60_000);
  timer.unref();
}
