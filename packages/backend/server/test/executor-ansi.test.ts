import { createAnsiStripper, stripAnsi } from "@server/lib/executor-task";
import { describe, expect, it } from "vitest";

/**
 * ANSI 剥离(票:执行器输出在后端剥离 ANSI):共享正则/单块剥离/流式跨 chunk
 * 扣尾处理。输出路径(queue.onOutput)与汇报解析(report.ts)共用同一份正则,
 * 本文件直接测 ansi 模块,不 spawn 执行器。
 */

describe("stripAnsi(单块文本)", () => {
  it("剥掉常规 SGR 颜色序列", () => {
    expect(stripAnsi("\u001b[32mgreen\u001b[0m")).toBe("green");
  });

  it("无转义序列的文本原样保留", () => {
    expect(stripAnsi("plain text\nsecond line")).toBe(
      "plain text\nsecond line",
    );
  });

  it("空字符串/空值不抛错", () => {
    expect(stripAnsi("")).toBe("");
    expect(stripAnsi(null as unknown as string)).toBe("");
  });

  it("多个相邻序列一次剥净", () => {
    expect(stripAnsi("\u001b[1;31mB\u001b[0m\u001b[32mG\u001b[0m")).toBe("BG");
  });
});

describe("createAnsiStripper(流式,跨 chunk)", () => {
  it("单 chunk 完整序列:直接剥净", () => {
    const strip = createAnsiStripper();
    expect(strip("\u001b[32mgreen\u001b[0m")).toBe("green");
  });

  it("跨 chunk:转义序列被切成两半(\x1b[3 | 2m)无残留", () => {
    const strip = createAnsiStripper();
    // 前半块以「疑似半截转义」结尾:扣住不发。
    expect(strip("\u001b[3")).toBe("");
    // 后半块补齐成完整序列:一起剥掉,无乱码漏出。
    expect(strip("2mgreen\u001b[0m")).toBe("green");
  });

  it("跨 chunk:前块只留 ESC,后块以 '[' 开头补齐", () => {
    const strip = createAnsiStripper();
    expect(strip("error \u001b")).toBe("error ");
    expect(strip("[31mboom\u001b[0m")).toBe("boom");
  });

  it("跨 chunk 连续两段:各自拼回并剥净", () => {
    const strip = createAnsiStripper();
    expect(strip("\u001b[1;3")).toBe("");
    expect(strip("2mstrike\u001b[0m next \u001b[4")).toBe("strike next ");
    expect(strip("4munder\u001b[0m")).toBe("under");
  });

  it("chunk 以普通文本结尾:不扣尾,立即输出", () => {
    const strip = createAnsiStripper();
    expect(strip("plain \u001b[31mred")).toBe("plain red");
  });
});
