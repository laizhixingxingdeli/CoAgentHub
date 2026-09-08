import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    // Drive via node so Windows does not hit EFTYPE on shebang scripts.
    const driver = CommandDriverSchema.parse({
      driver: "command",
      executable: process.execPath,
      args: [fakeBin.path, "exec", "resume", "--json", "{sessionRef}", "{message}"],
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
      executable: process.execPath,
      args: [fakeBin.path, "{message}"],
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
      executable: process.execPath,
      args: [fakeBin.path],
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
    const slow = join(tmpDir, "slow.mjs");
    writeFileSync(slow, "await new Promise((r) => setTimeout(r, 10_000));\n");

    const driver = CommandDriverSchema.parse({
      driver: "command",
      executable: process.execPath,
      args: [slow],
      timeoutMs: 200,
    });

    const event = makeEvent();
    const eventFilePath = join(tmpDir, "event.json");
    writeFileSync(eventFilePath, "msg");

    const result = await executeCommand(driver, {
      event,
      eventFilePath,
    });

    expect(result.timedOut).toBe(true);
  });

  it("missing sessionRef resolves {sessionRef} to empty string", async () => {
    const fakeBin = createFakeExecutable();
    const driver = CommandDriverSchema.parse({
      driver: "command",
      executable: process.execPath,
      args: [fakeBin.path, "{sessionRef}"],
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

  /**
   * Env allowlist probes use `node <helper.mjs>` (process.execPath) so they
   * run on Windows where bare shebang scripts fail with EFTYPE.
   * Only the test sentinel is inspected — never real secrets / full env dumps.
   */
  it("does not inherit COAGENTHUB_TEST_SENTINEL when env is unset", async () => {
    const sentinel = "COAGENTHUB_TEST_SENTINEL";
    const sentinelVal = "r9-should-not-leak";
    const prev = process.env[sentinel];
    process.env[sentinel] = sentinelVal;

    const helper = join(tmpDir, "env-sentinel.mjs");
    const outPath = join(tmpDir, "env-sentinel.out");
    const eventFilePath = join(tmpDir, "event.json");
    writeFileSync(
      helper,
      [
        "import { writeFileSync } from 'node:fs';",
        "const out = process.argv[2];",
        "writeFileSync(out, process.env.COAGENTHUB_TEST_SENTINEL === undefined ? 'absent' : 'present');",
        "",
      ].join("\n"),
    );
    writeFileSync(eventFilePath, "{}");

    const driver = CommandDriverSchema.parse({
      driver: "command",
      executable: process.execPath,
      args: [helper, outPath],
      timeoutMs: 10_000,
    });

    try {
      const result = await executeCommand(driver, {
        event: makeEvent(),
        eventFilePath,
      });
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
      const status = (await import("node:fs")).readFileSync(outPath, "utf-8");
      expect(status).toBe("absent");
    } finally {
      if (prev === undefined) delete process.env[sentinel];
      else process.env[sentinel] = prev;
    }
  });

  it("passes only allowlisted env: inheritEnv + explicit env, not the sentinel", async () => {
    const sentinel = "COAGENTHUB_TEST_SENTINEL";
    const sentinelVal = "r9-should-not-leak";
    const proxyKey = "HTTPS_PROXY";
    const prevSentinel = process.env[sentinel];
    const prevProxy = process.env[proxyKey];
    process.env[sentinel] = sentinelVal;
    process.env[proxyKey] = "http://allowlist-proxy.test:8080";

    const helper = join(tmpDir, "env-allow.mjs");
    const outPath = join(tmpDir, "env-allow.out");
    writeFileSync(
      helper,
      [
        "import { writeFileSync } from 'node:fs';",
        "const out = process.argv[2];",
        "writeFileSync(out, JSON.stringify({",
        "  sentinel: process.env.COAGENTHUB_TEST_SENTINEL ?? null,",
        "  proxy: process.env.HTTPS_PROXY ?? null,",
        "  custom: process.env.MY_CUSTOM_FLAG ?? null,",
        "}));",
        "",
      ].join("\n"),
    );
    const eventFilePath = join(tmpDir, "event.json");
    writeFileSync(eventFilePath, "{}");

    const driver = CommandDriverSchema.parse({
      driver: "command",
      executable: process.execPath,
      args: [helper, outPath],
      inheritEnv: [proxyKey],
      env: { MY_CUSTOM_FLAG: "from-config" },
      timeoutMs: 10_000,
    });

    try {
      const result = await executeCommand(driver, {
        event: makeEvent(),
        eventFilePath,
      });
      expect(result.exitCode).toBe(0);
      const dump = JSON.parse(
        (await import("node:fs")).readFileSync(outPath, "utf-8"),
      ) as {
        sentinel: string | null;
        proxy: string | null;
        custom: string | null;
      };
      expect(dump.sentinel).toBeNull();
      expect(dump.proxy).toBe("http://allowlist-proxy.test:8080");
      expect(dump.custom).toBe("from-config");
    } finally {
      if (prevSentinel === undefined) delete process.env[sentinel];
      else process.env[sentinel] = prevSentinel;
      if (prevProxy === undefined) delete process.env[proxyKey];
      else process.env[proxyKey] = prevProxy;
    }
  });
});
