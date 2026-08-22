import { formatExecutorStartupFailure } from "@server/lib/executor-task";
import { describe, expect, it } from "vitest";

describe("执行器启动失败提示", () => {
  it("参数错误提示核对与 CLI 版本匹配的 args 配置", () => {
    const message = formatExecutorStartupFailure(
      "codex",
      "unexpected argument '--ask-for-approval' found",
    );

    expect(message).toContain("无法启动 codex");
    expect(message).toContain("参数配置可能与当前 CLI 版本不匹配");
    expect(message).toContain("executors.ts");
  });

  it("ENOENT 提示检查安装状态和 PATH", () => {
    const message = formatExecutorStartupFailure(
      "codex",
      "执行器进程错误(codex): spawn codex ENOENT",
    );

    expect(message).toContain("codex 可能未安装或不在 PATH");
    expect(message).toContain("which codex");
  });

  it("未知错误保持原错误文本", () => {
    const message = formatExecutorStartupFailure("codex", "some failure");

    expect(message).toBe("无法启动 codex (some failure)");
  });
});
