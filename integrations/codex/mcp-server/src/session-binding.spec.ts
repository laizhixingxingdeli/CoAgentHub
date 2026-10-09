import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readBinding } from "./l3-state.js";
import { bindSessionStart } from "./session-binding.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "coagenthub-session-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("SessionStart binding", () => {
  it("persists the exact Codex session id and cwd", () => {
    const dataDir = tempDir();
    const result = bindSessionStart(
      {
        hook_event_name: "SessionStart",
        session_id: "0199-test-thread",
        cwd: "C:/program1/project",
        source: "resume",
      },
      dataDir,
    );

    expect(result.bound).toBe(true);
    expect(readBinding(dataDir)).toMatchObject({
      sessionId: "0199-test-thread",
      cwd: "C:/program1/project",
      inboxScope: "recipient",
      recipient: "0199-test-thread",
      source: "resume",
    });
    expect(result.context).toContain("CoAgentHub v5 L3 is bound");
  });

  it("does not create a binding without session_id", () => {
    const dataDir = tempDir();
    const result = bindSessionStart(
      { hook_event_name: "SessionStart", cwd: "C:/repo" },
      dataDir,
    );
    expect(result.bound).toBe(false);
    expect(readBinding(dataDir)).toBeUndefined();
  });
});
