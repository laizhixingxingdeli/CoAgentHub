import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeCommand } from "../src/command-driver.js";
import type { CompletionEvent } from "../src/config.js";
import { CommandDriverSchema } from "../src/config.js";
import { createFakeExecutable } from "./fake-executable.js";

function makeEvent(overrides: Partial<CompletionEvent> = {}): CompletionEvent {
  return {
    schemaVersion: 1,
    type: "coagenthub.task.completed",
    eventId: "00000000-0000-7000-8000-000000000001",
    dispatcherParticipantId: null,
    dispatcherSessionId: null,
    callbackRef: {
      platform: "codex",
      endpointRef: "dev-mac",
      sessionRef: "sess-abc",
    },
    task: {
      groupId: "00000000-0000-7000-8000-000000000002",
      taskId: "00000000-0000-7000-8000-000000000003",
      status: "done",
      specRef: "specs/test.md",
      specHash: "deadbeef",
      diffSummary: { files: 3, lines: 42 },
      outputTail: "commit abc1234",
    },
    ...overrides,
  } as CompletionEvent;
}

describe("Command Driver", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "coagenthub-cmd-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("Codex example: resolves argv in correct order", async () => {
    const fakeBin = createFakeExecutable("fake-codex.sh");
    const driver = CommandDriverSchema.parse({
      driver: "command",
      executable: fakeBin.path,
      args: ["exec", "resume", "--json", "{sessionRef}", "{message}"],
    });

    const event = makeEvent();
    const eventFilePath = join(tmpDir, "event.json");
    const fs = await import("node:fs");
    fs.writeFileSync(eventFilePath, "message-content");

    const result = await executeCommand(driver, {
      event,
      eventFilePath,
      sessionRef: "sess-abc",
    });

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);

    const argv = fakeBin.getArgv();
    // argv should be: ["exec", "resume", "--json", "sess-abc", "<message json>"]
    expect(argv[0]).toBe("exec");
    expect(argv[1]).toBe("resume");
    expect(argv[2]).toBe("--json");
    expect(argv[3]).toBe("sess-abc");
    // argv[4] should be the JSON message
    expect(argv[4]).toContain("coagenthub-task-completion");

    fakeBin.cleanup();
  });

  it("always uses shell:false — event content with shell metacharacters is a single arg", async () => {
    const fakeBin = createFakeExecutable();
    const driver = CommandDriverSchema.parse({
      driver: "command",
      executable: fakeBin.path,
      args: ["{message}"],
    });

    // Event with shell metacharacters in specRef
    const event = makeEvent({
      callbackRef: { endpointRef: "dev-mac", sessionRef: "sess-123" },
      task: {
        groupId: "g1",
        taskId: "t1",
        status: "done",
        specRef: "$(rm -rf /); `whoami`; ;|&\n'",
        specHash: "abc",
        diffSummary: { files: 0, lines: 0 },
        outputTail: "x",
      },
    });

    const eventFilePath = join(tmpDir, "event.json");
    const fs = await import("node:fs");
    fs.writeFileSync(eventFilePath, "msg");

    const result = await executeCommand(driver, {
      event,
      eventFilePath,
      sessionRef: "sess-123",
    });

    expect(result.exitCode).toBe(0);
    const argv = fakeBin.getArgv();
    // The message should be a single argument (not split by shell metacharacters)
    expect(argv.length).toBe(1);
    expect(argv[0]).toContain("coagenthub-task-completion");

    fakeBin.cleanup();
  });

  it("rejects relative executable path at config level", () => {
    expect(() =>
      CommandDriverSchema.parse({
        driver: "command",
        executable: "./relative/path",
        args: [],
      }),
    ).toThrow(/absolute path/);
  });

  it("rejects mixed template argument at config level", () => {
    const result = CommandDriverSchema.safeParse({
      driver: "command",
      executable: "/usr/bin/true",
      args: ["prefix-{sessionRef}-suffix"],
    });
    expect(result.success).toBe(false);
  });

  it("non-zero exit code returns exitCode != 0", async () => {
    const fakeBin = (
      await import("./fake-executable.js")
    ).createFailingExecutable(42);
    const driver = CommandDriverSchema.parse({
      driver: "command",
      executable: fakeBin.path,
      args: [],
    });

    const event = makeEvent();
    const eventFilePath = join(tmpDir, "event.json");
    const fs = await import("node:fs");
    fs.writeFileSync(eventFilePath, "msg");

    const result = await executeCommand(driver, {
      event,
      eventFilePath,
    });

    expect(result.exitCode).toBe(42);
    expect(result.timedOut).toBe(false);

    fakeBin.cleanup();
  });

  it("timeout returns timedOut=true", async () => {
    const fs = await import("node:fs");
    const fakeBin = createFakeExecutable("fake-slow.sh");
    fs.writeFileSync(fakeBin.path, `#!/bin/sh\nsleep 10\n`);
    fs.chmodSync(fakeBin.path, 0o755);

    const driver = CommandDriverSchema.parse({
      driver: "command",
      executable: fakeBin.path,
      args: [],
      timeoutMs: 200,
    });

    const event = makeEvent();
    const eventFilePath = join(tmpDir, "event.json");
    fs.writeFileSync(eventFilePath, "msg");

    const result = await executeCommand(driver, {
      event,
      eventFilePath,
    });

    expect(result.timedOut).toBe(true);

    fakeBin.cleanup();
  });

  it("missing sessionRef resolves {sessionRef} to empty string", async () => {
    const fakeBin = createFakeExecutable();
    const driver = CommandDriverSchema.parse({
      driver: "command",
      executable: fakeBin.path,
      args: ["{sessionRef}"],
    });

    const event = makeEvent({ callbackRef: null });
    const eventFilePath = join(tmpDir, "event.json");
    const fs = await import("node:fs");
    fs.writeFileSync(eventFilePath, "msg");

    const result = await executeCommand(driver, {
      event,
      eventFilePath,
      sessionRef: undefined,
    });

    expect(result.exitCode).toBe(0);
    const argv = fakeBin.getArgv();
    expect(argv[0]).toBe("");

    fakeBin.cleanup();
  });
});
