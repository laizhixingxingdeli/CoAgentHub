import { describe, expect, it } from "vitest";
import {
  OUTPUT_TAIL_MAX_BYTES,
  OUTPUT_TAIL_MAX_LINES,
  appendOutputTail,
  lastNonEmptyLine,
} from "./output-buffer";

describe("appendOutputTail 前端有界缓冲(与后端 output-buffer.ts 同款上限)", () => {
  it("常规追加:逐块拼接,内容完整保留", () => {
    expect(appendOutputTail("", "hello ")).toBe("hello ");
    expect(appendOutputTail("hello ", "world\n")).toBe("hello world\n");
  });

  it("超字节上限(256KB):只保留尾部 256KB", () => {
    const chunk = "a".repeat(1024);
    let buf = "";
    // 累加 300KB,必然超过 256KB 上限。
    for (let i = 0; i < 300; i++) {
      buf = appendOutputTail(buf, chunk);
    }
    expect(buf.length).toBe(OUTPUT_TAIL_MAX_BYTES);
    // 尾部特征仍在:最后追加的块内容完整出现在结尾。
    expect(buf.endsWith(chunk)).toBe(true);
  });

  it("超行数上限(1000 行):只保留尾部 1000 行", () => {
    let buf = "";
    for (let i = 1; i <= 1500; i++) {
      buf = appendOutputTail(buf, `line-${i}\n`);
    }
    // 输入 split 后共 1501 个元素(1500 行 + 末尾换行的空元素),slice(-1000)
    // 取 501..1500 → 首元素为 line-502;join 后再 split 恰为 1000 个元素。
    const lines = buf.split("\n");
    expect(lines.length).toBe(OUTPUT_TAIL_MAX_LINES);
    // 头部被丢弃,尾部完整(最后一个元素是末尾换行的空串)。
    expect(lines[0]).toBe("line-502");
    expect(lines[lines.length - 2]).toBe("line-1500");
    expect(lines[lines.length - 1]).toBe("");
  });

  it("跨块追加:单块未超限但累计超限时仍只留尾部", () => {
    const bigChunk = "b".repeat(200 * 1024); // 200KB,单块不超限
    let buf = appendOutputTail("", bigChunk);
    buf = appendOutputTail(buf, bigChunk); // 累计 400KB
    expect(buf.length).toBe(OUTPUT_TAIL_MAX_BYTES);
    expect(buf.endsWith("b".repeat(56 * 1024))).toBe(true);
  });
});

describe("lastNonEmptyLine 折叠态最后非空行", () => {
  it("普通多行:取最后一行", () => {
    expect(lastNonEmptyLine("a\nb\nc")).toBe("c");
  });

  it("末尾空行/纯空白行被跳过,取最后一个非空行", () => {
    expect(lastNonEmptyLine("a\nb\n\n")).toBe("b");
    expect(lastNonEmptyLine("a\nb\n  \n\t\n")).toBe("b");
  });

  it("全空/无内容返回 null(折叠态不显示该行)", () => {
    expect(lastNonEmptyLine("")).toBeNull();
    expect(lastNonEmptyLine("\n\n  \n")).toBeNull();
  });

  it("无换行的单行内容原样返回", () => {
    expect(lastNonEmptyLine("single line")).toBe("single line");
  });
});
