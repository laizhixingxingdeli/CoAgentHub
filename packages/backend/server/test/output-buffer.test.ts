import {
  appendTaskOutput,
  clearAllTaskOutputs,
  taskOutputTail,
} from "@server/lib/executor-task/output-buffer";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * 实时输出缓冲(output-buffer.ts,R4):appendTaskOutput 在 prev 与 chunk 边界
 * 均无换行时补一个 \n——治执行器多句粘成一段,顺带让 OUTPUT_TAIL_MAX_LINES
 * 在真实多行输入上确实生效(改动前几十句粘一行,行上限永远够不着,只有
 * 256KB 字节上限在起作用;本文件为隐含回归点)。
 */

const TAIL_MAX_LINES = 1000;

beforeEach(() => {
  clearAllTaskOutputs();
});

describe("R4:chunk 边界补换行", () => {
  it("prev 与 chunk 均不以换行结尾/开头 → 补一个 \\n", () => {
    appendTaskOutput("t1", "line-1");
    appendTaskOutput("t1", "line-2");
    expect(taskOutputTail("t1")).toBe("line-1\nline-2");
  });

  it("prev 以换行结尾 → 不补", () => {
    appendTaskOutput("t1", "line-1\n");
    appendTaskOutput("t1", "line-2");
    expect(taskOutputTail("t1")).toBe("line-1\nline-2");
  });

  it("chunk 以换行开头 → 不补", () => {
    appendTaskOutput("t1", "line-1");
    appendTaskOutput("t1", "\nline-2");
    expect(taskOutputTail("t1")).toBe("line-1\nline-2");
  });

  it("首块(无 prev)→ 不补", () => {
    appendTaskOutput("t1", "first");
    expect(taskOutputTail("t1")).toBe("first");
  });

  it("空 chunk → 不补、不刷新时间戳", () => {
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
