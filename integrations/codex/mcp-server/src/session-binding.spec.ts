import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  activateSessionBinding,
  bindingPath,
  listSessionBindings,
  readBinding,
  readBindingForRecipient,
  readLegacyBinding,
  readSessionBinding,
  sessionBindingPath,
} from "./l3-state.js";
import { bindSessionStart } from "./session-binding.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "coagenthub-session-"));
  dirs.push(dir);
  return dir;
}

function start(sessionId: string, cwd = "C:/repo") {
  return {
    hook_event_name: "SessionStart" as const,
    session_id: sessionId,
    cwd,
    source: "startup",
  };
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

  // Two chats opening in a row must not overwrite each other, and an explicit
  // takeover must still work for the operator.
  it("keeps two SessionStarts side by side, refreshes its own, and only takeover moves the active default", () => {
    const dataDir = tempDir();

    const first = bindSessionStart(start("session-A", "C:/repo-a"), dataDir);
    const second = bindSessionStart(start("session-B", "C:/repo-b"), dataDir);

    expect(first.activated).toBe(true);
    expect(second.bound).toBe(true);
    expect(second.activated).toBe(false);
    expect(second.context).toContain("COAGENTHUB_BINDING_TAKEOVER=1");

    // Both are registered; nothing was lost.
    expect(readSessionBinding(dataDir, "session-A")).toMatchObject({
      sessionId: "session-A",
      recipient: "session-A",
      cwd: "C:/repo-a",
    });
    expect(readSessionBinding(dataDir, "session-B")).toMatchObject({
      sessionId: "session-B",
      recipient: "session-B",
      cwd: "C:/repo-b",
    });
    // The first chat keeps receiving; the late chat does not steal it.
    expect(readBinding(dataDir)?.sessionId).toBe("session-A");
    expect(readBindingForRecipient(dataDir, "session-B")?.sessionId).toBe(
      "session-B",
    );

    // Same-session refresh is allowed and keeps the active default.
    const refreshed = bindSessionStart(start("session-A", "C:/repo-a2"), dataDir);
    expect(refreshed.activated).toBe(true);
    expect(refreshed.context).toContain("refreshed");
    expect(readBinding(dataDir)?.sessionId).toBe("session-A");
    expect(readBinding(dataDir)?.cwd).toBe("C:/repo-a2");

    // Explicit opt-in takeover.
    const taken = bindSessionStart(start("session-B"), dataDir, {
      takeover: true,
    });
    expect(taken.activated).toBe(true);
    expect(readBinding(dataDir)?.sessionId).toBe("session-B");
    expect(readSessionBinding(dataDir, "session-A")).toBeDefined();

    // Explicit activation entry point.
    activateSessionBinding(dataDir, readSessionBinding(dataDir, "session-A")!);
    expect(readBinding(dataDir)?.sessionId).toBe("session-A");
    expect(listSessionBindings(dataDir)).toHaveLength(2);
  });

  it("hashes session ids into the registry and still reads a legacy single-file binding", () => {
    const dataDir = tempDir();
    const hostile = "../../escape/../session";
    bindSessionStart(start(hostile), dataDir);

    const path = sessionBindingPath(dataDir, hostile);
    expect(path.startsWith(join(dataDir, "l3-bindings"))).toBe(true);
    expect(path).not.toContain("..");
    expect(readSessionBinding(dataDir, hostile)?.sessionId).toBe(hostile);

    // Old deployment: only the legacy file exists, no registry.
    const legacyDir = tempDir();
    writeFileSync(
      bindingPath(legacyDir),
      JSON.stringify({
        sessionId: "legacy-thread",
        cwd: "C:/legacy",
        inboxScope: "recipient",
        recipient: "legacy-thread",
        updatedAt: "2026-10-01T00:00:00.000Z",
      }),
      "utf8",
    );
    expect(readLegacyBinding(legacyDir)?.sessionId).toBe("legacy-thread");
    expect(readBinding(legacyDir)?.sessionId).toBe("legacy-thread");
    expect(readBindingForRecipient(legacyDir, "legacy-thread")?.sessionId).toBe(
      "legacy-thread",
    );

    // Legacy install upgrades on first SessionStart: the legacy session keeps
    // receiving, the new chat is registered but must not steal it.
    const upgraded = bindSessionStart(start("new-thread"), legacyDir);
    expect(upgraded.activated).toBe(false);
    expect(readBinding(legacyDir)?.sessionId).toBe("legacy-thread");
    expect(readSessionBinding(legacyDir, "new-thread")?.sessionId).toBe(
      "new-thread",
    );
    expect(
      JSON.parse(readFileSync(bindingPath(legacyDir), "utf8")).sessionId,
    ).toBe("legacy-thread");
  });
});
