import { describe, expect, it, vi } from "vitest";
// 经 barrel 拉起 queue → 模块顶层 registerPump。本 import 必须在断言「已注册」
// 之前发生;只 import pump-signal 不会触发注册。
import { pumpSignalStatus as barrelPumpSignalStatus } from "../src/lib/executor-task";
import {
  __withUnregisteredPumpForTests,
  pumpSignalStatus,
  registerPump,
  requestPump,
} from "../src/lib/executor-task/pump-signal";
import { createTestApp } from "./app";

describe("pump-signal", () => {
  it("barrel / queue 模块加载后 pump 已注册", () => {
    // setup.ts 与本文件的 barrel import 都会加载 queue.ts,顶层 registerPump 已跑。
    expect(barrelPumpSignalStatus().registered).toBe(true);
    expect(pumpSignalStatus().registered).toBe(true);
    expect(pumpSignalStatus().missed).toBe(false);
  });

  it("未注册时 requestPump 暂存,registerPump 时补发一次", () => {
    __withUnregisteredPumpForTests(() => {
      expect(pumpSignalStatus()).toEqual({
        registered: false,
        missed: false,
      });

      const warn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      requestPump();
      expect(pumpSignalStatus()).toEqual({
        registered: false,
        missed: true,
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("pump 尚未注册"),
      );
      warn.mockRestore();

      const fn = vi.fn();
      registerPump(fn);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(pumpSignalStatus()).toEqual({
        registered: true,
        missed: false,
      });
    });
    // 恢复后仍是 queue 顶层挂上的泵。
    expect(pumpSignalStatus().registered).toBe(true);
  });

  it("已注册时 requestPump 立即调用泵,不置 missed", () => {
    __withUnregisteredPumpForTests(() => {
      const fn = vi.fn();
      registerPump(fn);
      requestPump();
      requestPump();
      expect(fn).toHaveBeenCalledTimes(2);
      expect(pumpSignalStatus().missed).toBe(false);
    });
  });
});

describe("GET /api/health pumpSignal", () => {
  const app = createTestApp();

  it("透出泵送信号注册状态(与 dispatchPolicy 同级)", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      stale: boolean;
      dispatchPolicy: unknown;
      pumpSignal: { registered: boolean; missed: boolean };
    };
    // 既有字段仍在。
    expect(typeof body.stale).toBe("boolean");
    expect(body.dispatchPolicy).toBeTypeOf("object");
    // createTestApp 挂了会 import queue 的路由 → 注册已发生。
    expect(body.pumpSignal).toEqual({ registered: true, missed: false });
  });
});
