import { describe, expect, it } from "vitest";
import { parseOutputLine } from "./output-detail";

describe("parseOutputLine 摘要行解析(展开入口识别)", () => {
  it("带 #id 的 [标签] 前缀行 → 提取 entryId,原行保留", () => {
    expect(parseOutputLine("[思考 #t7] 先确认守卫在哪个文件")).toEqual({
      entryId: "t7",
      line: "[思考 #t7] 先确认守卫在哪个文件",
    });
  });

  it("多位数 id 也能提取(如 [工具 #t12])", () => {
    expect(parseOutputLine("[工具 #t12] read_file src/x.ts")).toEqual({
      entryId: "t12",
      line: "[工具 #t12] read_file src/x.ts",
    });
  });

  it("无 #id 的 [标签] 行 → entryId 为 null", () => {
    expect(parseOutputLine("[汇报] 提交: abc")).toEqual({
      entryId: null,
      line: "[汇报] 提交: abc",
    });
  });

  it("普通文本行(无 [标签] 前缀)→ entryId 为 null", () => {
    expect(parseOutputLine("已连接 WS")).toEqual({
      entryId: null,
      line: "已连接 WS",
    });
  });

  it("空行 → entryId 为 null", () => {
    expect(parseOutputLine("")).toEqual({ entryId: null, line: "" });
  });

  it("正文里的 #42 / #标题 / src/a.ts#L42 不误判为展开入口", () => {
    expect(parseOutputLine("见 issue #42 讨论")).toEqual({
      entryId: null,
      line: "见 issue #42 讨论",
    });
    expect(parseOutputLine("# 一级标题")).toEqual({
      entryId: null,
      line: "# 一级标题",
    });
    expect(parseOutputLine("修改 src/a.ts#L42")).toEqual({
      entryId: null,
      line: "修改 src/a.ts#L42",
    });
  });

  it("#id 出现在 [标签] 前缀内部(如 [思考 #t7 中间])也可提取", () => {
    expect(parseOutputLine("[思考 #t7 中间] 继续")).toEqual({
      entryId: "t7",
      line: "[思考 #t7 中间] 继续",
    });
  });
});
