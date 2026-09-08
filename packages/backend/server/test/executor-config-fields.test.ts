import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  EXECUTOR_CONFIG_FIELD_CAPABILITIES,
  inputModeWriteError,
  resolveExecutorCliSpawn,
  supportedInputModes,
} from "../src/lib/executor-config-fields";
import { runExecutor } from "../src/lib/executor-runner";
import { renderExecutorArgs } from "../src/lib/executors";

/**
 * R1/R3 单元 + 真 runner 探针(specs/executor-config-fields-saved-but-never-honored.md)。
 * 端到端 API→queue→runner 用例在 executor-api.test.ts。
 */

describe("EXECUTOR_CONFIG_FIELD_CAPABILITIES(R1 单一出处)", () => {
  it("三类字段状态齐全且 outputProfile 仍为 reserved", () => {
    expect(EXECUTOR_CONFIG_FIELD_CAPABILITIES.outputProfile).toBe("reserved");
    expect(EXECUTOR_CONFIG_FIELD_CAPABILITIES.env).toBe("supported");
    expect(EXECUTOR_CONFIG_FIELD_CAPABILITIES.inputMode.path).toBe("supported");
    expect(EXECUTOR_CONFIG_FIELD_CAPABILITIES.inputMode.inline).toBe(
      "supported",
    );
    expect(EXECUTOR_CONFIG_FIELD_CAPABILITIES.inputMode["at-file"]).toBe(
      "supported",
    );
    expect(EXECUTOR_CONFIG_FIELD_CAPABILITIES.inputMode.stdin).toBe(
      "unimplemented",
    );
  });

  it("supportedInputModes 从能力表派生,不含 stdin", () => {
    expect(supportedInputModes()).toEqual(["path", "inline", "at-file"]);
  });

  it("inputModeWriteError:stdin 拒绝,supported/null 放行", () => {
    expect(inputModeWriteError("stdin")).toMatch(/尚未实现/);
    expect(inputModeWriteError("stdin")).toMatch(/path, inline, at-file/);
    expect(inputModeWriteError("path")).toBeNull();
    expect(inputModeWriteError("inline")).toBeNull();
    expect(inputModeWriteError("at-file")).toBeNull();
    expect(inputModeWriteError(null)).toBeNull();
    expect(inputModeWriteError(undefined)).toBeNull();
  });
});

describe("resolveExecutorCliSpawn(R3 单一消费入口)", () => {
  const ticketPath = "/tmp/coagenthub-ticket-t1.md";
  const ticketContent = "hello-ticket-body";

  function resolve(
    partial: Partial<Parameters<typeof resolveExecutorCliSpawn>[0]> & {
      argsTemplate: string[];
    },
  ) {
    return resolveExecutorCliSpawn({
      ticketPath,
      ticketContent,
      renderArgs: renderExecutorArgs,
      ...partial,
    });
  }

  it("缺省/path:{ticket}=路径,{ticketContent}=正文(既有占位符行为)", () => {
    const a = resolve({
      argsTemplate: ["-p", "{ticket}", "--body", "{ticketContent}"],
    });
    expect(a.args).toEqual(["-p", ticketPath, "--body", ticketContent]);
    expect(a.stdin).toBeNull();
    expect(a.envOverlay).toBeUndefined();

    const b = resolve({
      argsTemplate: ["{ticket}"],
      inputMode: "path",
    });
    expect(b.args).toEqual([ticketPath]);
  });

  it("inline:{ticket} 变为正文", () => {
    const r = resolve({
      argsTemplate: ["-z", "{ticket}"],
      inputMode: "inline",
    });
    expect(r.args).toEqual(["-z", ticketContent]);
  });

  it("at-file:{ticket} 前缀 @", () => {
    const r = resolve({
      argsTemplate: ["{ticket}"],
      inputMode: "at-file",
    });
    expect(r.args).toEqual([`@${ticketPath}`]);
  });

  it("{ticketContent} 不随 inputMode 改变(显式要正文)", () => {
    const r = resolve({
      argsTemplate: ["{ticketContent}"],
      inputMode: "at-file",
    });
    expect(r.args).toEqual([ticketContent]);
  });

  it("存量 stdin 降级 path,stdin 载荷仍为 null(不追溯不炸)", () => {
    const r = resolve({
      argsTemplate: ["{ticket}"],
      inputMode: "stdin",
    });
    expect(r.args).toEqual([ticketPath]);
    expect(r.stdin).toBeNull();
  });

  it("env 原样 overlay;空对象视作无", () => {
    expect(
      resolve({ argsTemplate: [], env: { FOO: "bar" } }).envOverlay,
    ).toEqual({ FOO: "bar" });
    expect(resolve({ argsTemplate: [], env: {} }).envOverlay).toBeUndefined();
    expect(resolve({ argsTemplate: [], env: null }).envOverlay).toBeUndefined();
  });

  it("{model} 仍由 renderArgs 处理(无 model 时移除 flag 组)", () => {
    const r = resolve({
      argsTemplate: ["--model", "{model}", "{ticket}"],
    });
    expect(r.args).toEqual([ticketPath]);
  });
});

describe("runExecutor 真消费 env(经单一入口 → runner)", () => {
  const probeDir = mkdtempSync(path.join(tmpdir(), "coagenthub-r8-probe-"));
  const outFile = path.join(probeDir, "probe-out.json");
  // node 假执行器:Git Bash sh 会把 @path 展开成文件内容,真实 CLI 不会;
  // node 保留字面 argv,才能验 at-file。
  const script = path.join(probeDir, "probe.mjs");

  afterAll(() => {
    rmSync(probeDir, { recursive: true, force: true });
  });

  it("假执行器实际读到 env overlay 与 at-file 参数", async () => {
    writeFileSync(
      script,
      [
        "import { writeFileSync, readFileSync } from 'node:fs';",
        `const out = ${JSON.stringify(outFile)};`,
        "let stdin = '';",
        "try { stdin = readFileSync(0, 'utf8'); } catch { stdin = ''; }",
        "writeFileSync(out, JSON.stringify({",
        "  argv: process.argv.slice(2),",
        "  env: process.env.R8_ENV_SENTINEL ?? null,",
        "  stdin,",
        "}));",
      ].join("\n"),
    );
    const ticketPath = path.join(probeDir, "ticket.md");
    writeFileSync(ticketPath, "ticket-body-r8");

    const plan = resolveExecutorCliSpawn({
      argsTemplate: ["{ticket}"],
      inputMode: "at-file",
      env: { R8_ENV_SENTINEL: "honored-from-config" },
      ticketPath,
      ticketContent: "ticket-body-r8",
      renderArgs: renderExecutorArgs,
    });
    expect(plan.args).toEqual([`@${ticketPath}`]);
    expect(plan.envOverlay).toEqual({
      R8_ENV_SENTINEL: "honored-from-config",
    });

    const handle = runExecutor({
      bin: process.execPath,
      args: [script, ...plan.args],
      cwd: probeDir,
      timeoutMs: 10_000,
      ...(plan.envOverlay ? { env: plan.envOverlay } : {}),
      ...(plan.stdin != null ? { stdin: plan.stdin } : {}),
    });
    const result = await handle.promise;
    expect(result.code).toBe(0);

    const probe = JSON.parse(readFileSync(outFile, "utf8")) as {
      argv: string[];
      env: string | null;
      stdin: string;
    };
    expect(probe.env).toBe("honored-from-config");
    expect(probe.argv).toContain(`@${ticketPath}`);
    expect(probe.stdin).toBe("");
  });
});
