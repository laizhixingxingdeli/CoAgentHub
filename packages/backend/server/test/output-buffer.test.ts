import {
  appendTaskOutput,
  clearAllTaskOutputs,
  taskOutputTail,
} from "@server/lib/executor-task/output-buffer";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * 实时输出缓冲(output-buffer.ts):appendTaskOutput 仅以真实换行边界构成行——
 * chunk 一律裸拼接(prev + chunk),不在 chunk 边界补 \n。流式 chunk 常在词中间
 * 切开(如 `[tool→ read_fi` + `le] ok\n`),边界补换行会把一条真实动作行切成
 * 「词中间碎片」与半截 [tool→ 行;裸拼接让未以换行结尾的 chunk 与后续 chunk
 * 自然接续,直到真实 \n 才成为完整行。行数/字节截断只作用于已构成的行。
 */

const TAIL_MAX_LINES = 1000;

beforeEach(() => {
  clearAllTaskOutputs();
});

describe("仅以真实换行边界构成行", () => {
  it("未以换行结尾的 chunk 与后续 chunk 裸拼接,直到真实换行才成完整行", () => {
    appendTaskOutput("t1", "line-1");
    appendTaskOutput("t1", "line-2");
    expect(taskOutputTail("t1")).toBe("line-1line-2");
    appendTaskOutput("t1", "\n");
    expect(taskOutputTail("t1")).toBe("line-1line-2\n");
  });

  it("跨 chunk 的半截动作行重组为完整行,不产生词中间碎片(回归)", () => {
    appendTaskOutput("t1", "[tool→ read_fi");
    appendTaskOutput("t1", "le] ok\n");
    expect(taskOutputTail("t1")).toBe("[tool→ read_file] ok\n");
  });

  it("prev 以换行结尾 → 新 chunk 直接开始新行", () => {
    appendTaskOutput("t1", "line-1\n");
    appendTaskOutput("t1", "line-2");
    expect(taskOutputTail("t1")).toBe("line-1\nline-2");
  });

  it("chunk 以换行开头 → 直接续行", () => {
    appendTaskOutput("t1", "line-1");
    appendTaskOutput("t1", "\nline-2");
    expect(taskOutputTail("t1")).toBe("line-1\nline-2");
  });

  it("首块(无 prev)→ 原样入缓冲", () => {
    appendTaskOutput("t1", "first");
    expect(taskOutputTail("t1")).toBe("first");
  });

  it("空 chunk → 不追加、不刷新时间戳", () => {
    appendTaskOutput("t1", "a");
    appendTaskOutput("t1", "");
    expect(taskOutputTail("t1")).toBe("a");
  });
});

describe("OUTPUT_TAIL_MAX_LINES 截断(隐含回归点)", () => {
  it("真实多行输入超过 1000 行 → 只留尾部 1000 行,首行被裁", () => {
    for (let i = 1; i <= 1200; i += 1) {
      // 模拟真实流式输入:行间带 \n,最后一行可无结尾换行。
      appendTaskOutput("t2", i === 1200 ? `line-${i}` : `line-${i}\n`);
    }
    const tail = taskOutputTail("t2") ?? "";
    const lines = tail.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(TAIL_MAX_LINES);
    expect(lines[0]).toBe("line-201");
    expect(lines.at(-1)).toBe("line-1200");
  });

  it("行数未超限 → 全量保留", () => {
    for (let i = 1; i <= 3; i += 1) appendTaskOutput("t3", `line-${i}\n`);
    expect(taskOutputTail("t3")).toBe("line-1\nline-2\nline-3\n");
  });
});
