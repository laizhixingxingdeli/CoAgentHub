import { resolveWindowsLauncher } from "@server/lib/executor-runner";
import { describe, expect, it } from "vitest";

/**
 * specs/windows-cmd-executor-spawn.md 的验收用例。
 *
 * 判定的是「垫片 → 可直接 spawn 的真实目标」这一步:args 只允许前缀追加,
 * 不允许任何转义/重排 —— 这正是本方案相对 `shell: true` 的全部价值。
 */

const NODE_SHIM = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  "",
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ") ELSE (",
  '  SET "_prog=node"',
  "  SET PATHEXT=%PATHEXT:;.JS;=;%",
  ")",
  "",
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@scope\\pkg\\bin\\cli.js" %*',
].join("\r\n");

const EXE_SHIM = [
  "@ECHO off",
  "SETLOCAL",
  "CALL :find_dp0",
  '"%dp0%\\node_modules\\@scope\\pkg\\bin\\cli.exe"   %*',
].join("\r\n");

const EXTENSIONLESS_SHIM = NODE_SHIM.replace(
  "\\bin\\cli.js",
  "\\bin\\clitool",
);

const BIN = "C:\\Users\\dev\\AppData\\Roaming\\npm\\cli.cmd";
const NPM_DIR = "C:\\Users\\dev\\AppData\\Roaming\\npm";

function deps(shim: string | undefined, overrides = {}) {
  return {
    platform: "win32" as NodeJS.Platform,
    readShim: () => shim,
    exists: () => true,
    nodeBin: "C:\\Program Files\\nodejs\\node.exe",
    ...overrides,
  };
}

describe("resolveWindowsLauncher", () => {
  it("node 型垫片 → node + 脚本绝对路径,原 args 逐字保留", () => {
    const out = resolveWindowsLauncher(BIN, ["-p", "{ticket}"], deps(NODE_SHIM));
    expect(out.bin).toBe("C:\\Program Files\\nodejs\\node.exe");
    expect(out.args).toEqual([
      `${NPM_DIR}\\node_modules\\@scope\\pkg\\bin\\cli.js`,
      "-p",
      "{ticket}",
    ]);
  });

  it("exe 型垫片 → 直接用该 exe,args 逐字不变", () => {
    const out = resolveWindowsLauncher(BIN, ["-p", "x"], deps(EXE_SHIM));
    expect(out.bin).toBe(`${NPM_DIR}\\node_modules\\@scope\\pkg\\bin\\cli.exe`);
    expect(out.args).toEqual(["-p", "x"]);
  });

  it("无扩展名的 node 脚本(shebang)也走 node 分支", () => {
    const out = resolveWindowsLauncher(BIN, [], deps(EXTENSIONLESS_SHIM));
    expect(out.bin).toBe("C:\\Program Files\\nodejs\\node.exe");
    expect(out.args).toEqual([
      `${NPM_DIR}\\node_modules\\@scope\\pkg\\bin\\clitool`,
    ]);
  });

  it("含空格 / & / 换行的参数逐字不变(证明没有引入转义或拼接)", () => {
    const ticket = "# 任务书\r\n\r\n跑 `a && b`，路径 C:\\Program Files\\x";
    const out = resolveWindowsLauncher(
      BIN,
      ["--output-format", "stream-json", ticket],
      deps(NODE_SHIM),
    );
    expect(out.args.slice(1)).toEqual([
      "--output-format",
      "stream-json",
      ticket,
    ]);
  });

  it("非 win32 平台原样返回(同一份垫片输入)", () => {
    const out = resolveWindowsLauncher(
      BIN,
      ["-p"],
      deps(NODE_SHIM, { platform: "darwin" as NodeJS.Platform }),
    );
    expect(out).toEqual({ bin: BIN, args: ["-p"] });
  });

  it("非 .cmd/.bat 的 bin 原样返回", () => {
    const out = resolveWindowsLauncher(
      "C:\\tools\\cli.exe",
      ["-p"],
      deps(NODE_SHIM),
    );
    expect(out).toEqual({ bin: "C:\\tools\\cli.exe", args: ["-p"] });
  });

  it("垫片读不到时原样返回,不做兜底猜测", () => {
    const out = resolveWindowsLauncher(BIN, ["-p"], deps(undefined));
    expect(out).toEqual({ bin: BIN, args: ["-p"] });
  });

  it("解析出的目标文件不存在时原样返回", () => {
    const out = resolveWindowsLauncher(
      BIN,
      ["-p"],
      deps(NODE_SHIM, { exists: () => false }),
    );
    expect(out).toEqual({ bin: BIN, args: ["-p"] });
  });

  it("垫片里没有 %* 启动行时原样返回", () => {
    const out = resolveWindowsLauncher(BIN, ["-p"], deps("@ECHO off\r\nEXIT /b"));
    expect(out).toEqual({ bin: BIN, args: ["-p"] });
  });
});
