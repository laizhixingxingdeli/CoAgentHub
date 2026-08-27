import { existsSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendTaskDetail,
  cleanupExpiredTaskDetails,
  clearAllTaskDetails,
  DETAIL_RETENTION_MS,
  findTaskDetail,
  readTaskDetail,
  taskDetailFilePath,
} from "@server/lib/executor-task/detail-store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * 任务明细存储(detail-store.ts,spec two-tier-output-summary-and-detail R4):
 * 结构化条目的完整原文按任务写磁盘 JSONL(/tmp/coagenthub-task-detail-<taskId>.jsonl),
 * 不驻留内存、不进 diffSummary;raw 透传条目无明细不落盘;保留期 14 天,
 * 过期文件被 cleanupExpiredTaskDetails 清理(清理节流不影响直接调用)。
 */

const TASK_ID = "00000000-0000-4000-8000-0000000000ab";
const OTHER_TASK_ID = "00000000-0000-4000-8000-0000000000cd";

beforeEach(() => {
  clearAllTaskDetails();
});

afterEach(() => {
  clearAllTaskDetails();
});

describe("R4:按任务写 /tmp JSONL,raw 不落盘", () => {
  it("文件名与路径:coagenthub-task-detail-<taskId>.jsonl 位于 /tmp", () => {
    expect(taskDetailFilePath(TASK_ID)).toBe(
      path.join(tmpdir(), `coagenthub-task-detail-${TASK_ID}.jsonl`),
    );
  });

  it("非 raw 条目落盘为 JSONL 单行 {id,kind,at,text},text = detail 优先", () => {
    appendTaskDetail(TASK_ID, {
      id: "t7",
      kind: "thinking",
      summary: "[思考 #t7] 先确认守卫在哪个文件",
      detail: "先确认守卫在哪个文件,再决定改哪一段(完整原文)",
    });
    appendTaskDetail(TASK_ID, {
      id: "t8",
      kind: "tool",
      summary: "[工具 #t8] read_file file_path",
      // 摘要即原文的条目(text = summary)也落盘,保证 #id 在保留期内可展开。
    });
    const rows = readTaskDetail(TASK_ID);
    expect(rows).not.toBeNull();
    expect(rows).toHaveLength(2);
    expect(rows?.[0]).toMatchObject({
      id: "t7",
      kind: "thinking",
      text: "先确认守卫在哪个文件,再决定改哪一段(完整原文)",
    });
    expect(typeof rows?.[0].at).toBe("string");
    expect(rows?.[1]).toMatchObject({
      id: "t8",
      kind: "tool",
      text: "[工具 #t8] read_file file_path",
    });
    // 行尾只有一个换行(JSONL 语义)。
    const raw = require("node:fs").readFileSync(
      taskDetailFilePath(TASK_ID),
      "utf8",
    );
    expect(raw.split("\n").filter((l: string) => l.length > 0)).toHaveLength(2);
  });

  it("raw 透传条目不落盘(R7:逐字行只有摘要,无明细可展开)", () => {
    appendTaskDetail(TASK_ID, {
      id: "t1",
      kind: "raw",
      summary: "解析失败的行,逐字保留",
    });
    expect(readTaskDetail(TASK_ID)).toBeNull();
    expect(existsSync(taskDetailFilePath(TASK_ID))).toBe(false);
  });

  it("明细按任务隔离:不同任务互不串文件", () => {
    appendTaskDetail(TASK_ID, {
      id: "t1",
      kind: "command",
      summary: "[命令 #t1] git status exit 0",
    });
    expect(readTaskDetail(OTHER_TASK_ID)).toBeNull();
    expect(readTaskDetail(TASK_ID)).toHaveLength(1);
  });
});

describe("R4:读取与单条查找", () => {
  it("findTaskDetail:命中返回条目;id 不存在返回 null;文件不存在返回 undefined", () => {
    appendTaskDetail(TASK_ID, {
      id: "t3",
      kind: "report",
      summary: "[汇报 #t3] done",
    });
    const hit = findTaskDetail(TASK_ID, "t3");
    expect(hit).not.toBeNull();
    expect(hit?.id).toBe("t3");
    expect(hit?.text).toBe("[汇报 #t3] done");
    // id 不存在:文件在,id 无 → null(路由据此报「条目不存在」)。
    expect(findTaskDetail(TASK_ID, "t999")).toBeNull();
    // 文件不存在 → undefined(路由据此报「明细文件不存在/已被清理」)。
    expect(findTaskDetail(OTHER_TASK_ID, "t3")).toBeUndefined();
  });
});

describe("R4:14 天保留期清理", () => {
  it("超过 14 天的明细文件被删除,未超期保留", () => {
    const now = Date.now();
    const filePath = taskDetailFilePath(TASK_ID);
    appendTaskDetail(TASK_ID, {
      id: "t1",
      kind: "tool",
      summary: "[工具 #t1] read_file",
    });
    // 把 mtime 拨到 15 天前:超过保留期。
    const old = now - (DETAIL_RETENTION_MS + 60_000);
    utimesSync(filePath, new Date(old), new Date(old));
    // 另一个任务:保留期内。
    appendTaskDetail(OTHER_TASK_ID, {
      id: "t1",
      kind: "tool",
      summary: "[工具 #t1] write_file",
    });
    const removed = cleanupExpiredTaskDetails(now);
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(existsSync(filePath)).toBe(false);
    expect(existsSync(taskDetailFilePath(OTHER_TASK_ID))).toBe(true);
  });

  it("保留期内(14 天以内)的文件不清理", () => {
    const now = Date.now();
    const filePath = taskDetailFilePath(TASK_ID);
    appendTaskDetail(TASK_ID, {
      id: "t1",
      kind: "tool",
      summary: "[工具 #t1] read_file",
    });
    // 13 天前(明确在保留期内):不清理。
    const within = now - (DETAIL_RETENTION_MS - 60_000);
    utimesSync(filePath, new Date(within), new Date(within));
    expect(cleanupExpiredTaskDetails(now)).toBe(0);
    expect(statSync(filePath)).toBeTruthy();
  });
});
