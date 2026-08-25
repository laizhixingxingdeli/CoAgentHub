import {
  formatExecutorStartupFailure,
  spawnFailureHint,
} from "@server/lib/executor-task";
import { describe, expect, it } from "vitest";

const argumentHint =
  "；执行器参数配置可能与当前 CLI 版本不匹配，请核对 executors.ts 中的内置配置";
const pathHint =
  "；执行器可能未安装或不在 PATH，请使用 which <bin> 确认或配置绝对路径";
const permissionHint = "；执行器文件可能没有可执行权限，请检查可执行位";

describe("执行器启动失败提示", () => {
  it.each([
    "unexpected argument '--ask-for-approval' found",
    "UNRECOGNIZED option",
    "cannot be used with --json",
    "invalid value for --model",
  ])("参数错误给出 CLI 配置提示: %s", (msg) => {
    expect(spawnFailureHint(msg)).toBe(argumentHint);
  });

  it.each([
    "执行器进程错误(codex): spawn codex ENOENT",
    "spawn codex enoent",
    "COMMAND NOT FOUND",
  ])("ENOENT/command not found 给出安装与 PATH 提示: %s", (msg) => {
    expect(spawnFailureHint(msg)).toBe(pathHint);
  });

  it.each(["EACCES: permission denied", "PERMISSION DENIED", "eacces"])(
    "权限错误给出可执行位提示: %s",
    (msg) => {
      expect(spawnFailureHint(msg)).toBe(permissionHint);
    },
  );

  it("无法归类时不猜测", () => {
    expect(spawnFailureHint("some failure")).toBe("");
  });

  it("两个出口都保留完整原始错误并在末尾追加提示", () => {
    const raw = "unexpected argument '--ask-for-approval' found";
    const message = formatExecutorStartupFailure("codex", raw);

    expect(message).toBe(`无法启动 codex (${raw})${argumentHint}`);
    expect(message.indexOf(raw)).toBeLessThan(message.indexOf(argumentHint));
  });
});
