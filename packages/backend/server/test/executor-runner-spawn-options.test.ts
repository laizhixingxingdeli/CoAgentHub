import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildExecutorSpawnOptions,
  runExecutor,
} from "@server/lib/executor-runner";
import { afterAll, describe, expect, it } from "vitest";

/**
 * specs/executor-spawn-shows-empty-console-on-windows.md
 * - R2: Windows 去 detached + windowsHide; POSIX 逐字保留 detached: true
 * - 验收 5: stdout/stderr 流式收集不受影响
 */

describe("buildExecutorSpawnOptions 平台分叉", () => {
  it("POSIX: detached: true, 无 windowsHide(与历史逐字一致)", () => {
    const opts = buildExecutorSpawnOptions({
      cwd: "/tmp/repo",
      useStdin: false,
      platform: "linux",
    });
    expect(opts).toEqual({
      cwd: "/tmp/repo",
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(opts).not.toHaveProperty("windowsHide");
  });

  it("POSIX + stdin + env: 仍 detached, stdio[0]=pipe, env 合并", () => {
    const opts = buildExecutorSpawnOptions({
      cwd: "/tmp/repo",
      useStdin: true,
      env: { SENTINEL: "x" },
      platform: "darwin",
    });
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(opts.windowsHide).toBeUndefined();
    expect(opts.env?.SENTINEL).toBe("x");
    expect(opts.env?.PATH ?? opts.env?.Path).toBeTruthy();
  });

  it("Windows: windowsHide: true, 不传 detached", () => {
    const opts = buildExecutorSpawnOptions({
      cwd: "C:\\repo",
      useStdin: false,
      platform: "win32",
    });
    expect(opts).toEqual({
      cwd: "C:\\repo",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(opts).not.toHaveProperty("detached");
  });

  it("Windows + stdin + env: windowsHide, 无 detached, stdio/env 仍完整", () => {
    const opts = buildExecutorSpawnOptions({
      cwd: "C:\\repo",
      useStdin: true,
      env: { SENTINEL: "win" },
      platform: "win32",
    });
    expect(opts.windowsHide).toBe(true);
    expect(opts.detached).toBeUndefined();
    expect(opts.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(opts.env?.SENTINEL).toBe("win");
  });
});

describe("runExecutor stdout/stderr 流式收集(不因 spawn 选项分叉而丢)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "coagenthub-spawn-stdio-"));
  const script = path.join(dir, "stdio-probe.mjs");

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("多块 stdout/stderr 经 onOutput 完整回传, 并落入 result", async () => {
    // 分多次 write,迫使出现多个 data 事件,验证 pipe 收集链路仍通。
    writeFileSync(
      script,
      [
        "import { setTimeout as sleep } from 'node:timers/promises';",
        "process.stdout.write('OUT_A\\n');",
        "process.stderr.write('ERR_A\\n');",
        "await sleep(30);",
        "process.stdout.write('OUT_B\\n');",
        "process.stderr.write('ERR_B\\n');",
        "await sleep(30);",
        "process.stdout.write('OUT_C\\n');",
        "process.stderr.write('ERR_C\\n');",
      ].join("\n"),
    );

    const chunks: Array<{ source: "stdout" | "stderr"; text: string }> = [];
    const handle = runExecutor({
      bin: process.execPath,
      args: [script],
      cwd: dir,
      timeoutMs: 15_000,
      onOutput: (text, source) => {
        chunks.push({ source, text });
      },
    });
    const result = await handle.promise;
    expect(result.code).toBe(0);
    expect(result.timedOut).toBe(false);

    // 落库/回传用的累积字段必须完整。
    expect(result.stdout).toContain("OUT_A");
    expect(result.stdout).toContain("OUT_B");
    expect(result.stdout).toContain("OUT_C");
    expect(result.stderr).toContain("ERR_A");
    expect(result.stderr).toContain("ERR_B");
    expect(result.stderr).toContain("ERR_C");

    // 流式回调也必须看到全部标记(顺序允许跨 stream 交错,同 stream 保序)。
    const outJoined = chunks
      .filter((c) => c.source === "stdout")
      .map((c) => c.text)
      .join("");
    const errJoined = chunks
      .filter((c) => c.source === "stderr")
      .map((c) => c.text)
      .join("");
    expect(outJoined).toContain("OUT_A");
    expect(outJoined).toContain("OUT_B");
    expect(outJoined).toContain("OUT_C");
    expect(errJoined).toContain("ERR_A");
    expect(errJoined).toContain("ERR_B");
    expect(errJoined).toContain("ERR_C");

    // 本机若是 Windows,当前进程的 spawn 选项必须是 hide-only 分支。
    if (process.platform === "win32") {
      const opts = buildExecutorSpawnOptions({
        cwd: dir,
        useStdin: false,
        platform: "win32",
      });
      expect(opts.windowsHide).toBe(true);
      expect(opts.detached).toBeUndefined();
    }
  });
});
