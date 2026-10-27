import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureBridge, type BridgeSpawn } from "./bridge-supervisor.js";
import { daemonPidPath, writeSessionBinding } from "./l3-state.js";

const dirs: string[] = [];

function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "coagenthub-bridge-supervisor-"));
  dirs.push(dir);
  return dir;
}

function bindSession(dataDir: string): void {
  writeSessionBinding(dataDir, {
    sessionId: "session-1",
    cwd: dataDir,
    inboxScope: "recipient",
    recipient: "session-1",
    updatedAt: "2026-10-27T00:00:00.000Z",
  });
}

function fakeSpawn() {
  const unref = vi.fn();
  const spawn = vi.fn<BridgeSpawn>(() => ({ unref }));
  return { spawn, unref };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ensureBridge", () => {
  it("launches the daemon once when a binding exists and no pid is alive", () => {
    const dataDir = tempDataDir();
    bindSession(dataDir);
    const { spawn, unref } = fakeSpawn();

    expect(ensureBridge(dataDir, { spawn, env: {} })).toBe(true);

    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawn.mock.calls[0];
    expect(args[0].endsWith("l3-daemon.js")).toBe(true);
    expect(options.detached).toBe(true);
    expect(options.env?.PLUGIN_DATA).toBe(dataDir);
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it("does not launch when the pid is alive, the registry is empty, or the switch is off", () => {
    const runningDir = tempDataDir();
    bindSession(runningDir);
    // The test process is its own live pid; process.kill(pid, 0) succeeds
    // without starting anything.
    writeFileSync(daemonPidPath(runningDir), String(process.pid), "utf8");
    const { spawn } = fakeSpawn();

    expect(ensureBridge(runningDir, { spawn, env: {} })).toBe(false);
    expect(spawn).not.toHaveBeenCalled();

    const emptyDir = tempDataDir();
    expect(ensureBridge(emptyDir, { spawn, env: {} })).toBe(false);
    expect(spawn).not.toHaveBeenCalled();

    // A bound dir with no pid would otherwise launch, so the switch itself is
    // what has to stop the spawn here.
    const switchedOffDir = tempDataDir();
    bindSession(switchedOffDir);
    expect(
      ensureBridge(switchedOffDir, {
        spawn,
        env: { COAGENTHUB_L3_BRIDGE: "0" },
      }),
    ).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });
});
