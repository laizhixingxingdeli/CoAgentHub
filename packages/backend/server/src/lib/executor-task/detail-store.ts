/**
 * 任务明细存储(executor-task 拆分,two-tier-output-summary-and-detail R4):
 * 结构化条目的完整原文按任务写磁盘 JSONL(/tmp/coagenthub-task-detail-<taskId>.jsonl),
 * 不驻留内存(内存只保留摘要流环形缓冲)、不进 diffSummary(不撑大数据库行)。
 *
 * 保留期与清理沿用仓库既有 prod 日志惯例(/tmp 按天 + 14 天清理):超过
 * DETAIL_RETENTION_MS(14 天)未修改的明细文件在清理节流窗口到时被删除。
 * 任务进入终态后内存缓冲照常释放,但明细文件保留,供事后排障展开。
 */

import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { OutputEntry, OutputEntryKind } from "./output-parser";

/** 明细文件命名:与任务书 /tmp/coagenthub-ticket-<taskId>.md 同款前缀风格。 */
const DETAIL_FILE_PREFIX = "coagenthub-task-detail-";
const DETAIL_FILE_SUFFIX = ".jsonl";
/** 明细保留期:沿用 prod 日志的 14 天清理口径(R4)。 */
export const DETAIL_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
/** 清理节流:至少间隔 1 小时才扫一次 /tmp,避免逐 chunk readdir 拖慢输出路径。 */
const CLEANUP_MIN_INTERVAL_MS = 60 * 60 * 1000;

/** 明细 JSONL 单行:{"id":"t7","kind":"thinking","at":"…","text":"完整原文"}。 */
export interface StoredTaskDetail {
  id: string;
  kind: OutputEntryKind;
  at: string;
  text: string;
}

/** 明细文件绝对路径(/tmp/coagenthub-task-detail-<taskId>.jsonl)。 */
export function taskDetailFilePath(taskId: string): string {
  return path.join(
    tmpdir(),
    `${DETAIL_FILE_PREFIX}${taskId}${DETAIL_FILE_SUFFIX}`,
  );
}

let lastCleanupAt = 0;

/**
 * 追加一条明细:raw 透传条目无明细不落盘;其余条目 text = detail ?? summary
 * (摘要即原文的条目也落盘,保证摘要流里的 #id 在保留期内都可展开)。
 * 落盘失败只告警,不影响主流程(fire-and-forget,与 wsHub 广播同界)。
 */
export function appendTaskDetail(taskId: string, entry: OutputEntry): void {
  if (entry.kind === "raw") return;
  const row: StoredTaskDetail = {
    id: entry.id,
    kind: entry.kind,
    at: new Date().toISOString(),
    text: entry.detail ?? entry.summary,
  };
  try {
    appendFileSync(
      taskDetailFilePath(taskId),
      `${JSON.stringify(row)}\n`,
      "utf8",
    );
    maybeCleanupExpiredTaskDetails();
  } catch (e) {
    console.warn(`[executor-task] 明细落盘失败(${taskId}, ${entry.id}): ${e}`);
  }
}

/** 清理节流闸门:距上次清理不足 1 小时不扫目录。 */
function maybeCleanupExpiredTaskDetails(): void {
  const now = Date.now();
  if (now - lastCleanupAt < CLEANUP_MIN_INTERVAL_MS) return;
  lastCleanupAt = now;
  cleanupExpiredTaskDetails(now);
}

/**
 * 删除 /tmp 下超过 14 天未修改的明细文件(保留期口径与 prod 日志一致)。
 * 返回删除的文件数;目录扫描失败只告警,不影响明细读写。
 */
export function cleanupExpiredTaskDetails(now = Date.now()): number {
  let removed = 0;
  try {
    for (const name of readdirSync(tmpdir())) {
      if (!name.startsWith(DETAIL_FILE_PREFIX)) continue;
      if (!name.endsWith(DETAIL_FILE_SUFFIX)) continue;
      try {
        const filePath = path.join(tmpdir(), name);
        if (now - statSync(filePath).mtimeMs > DETAIL_RETENTION_MS) {
          unlinkSync(filePath);
          removed += 1;
        }
      } catch {
        // 文件已被并发清理/不存在,跳过即可。
      }
    }
  } catch (e) {
    console.warn(`[executor-task] 明细清理失败: ${e}`);
  }
  return removed;
}

/**
 * 读整份明细:任务无明细文件(从未落盘或已被 14 天清理)返回 null;
 * 文件存在则返回全部条目(坏行跳过)。
 */
export function readTaskDetail(taskId: string): StoredTaskDetail[] | null {
  const filePath = taskDetailFilePath(taskId);
  if (!existsSync(filePath)) return null;
  try {
    const rows: StoredTaskDetail[] = [];
    for (const line of readFileSync(filePath, "utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        rows.push(JSON.parse(line) as StoredTaskDetail);
      } catch {
        // 坏行(外部写入/并发截断)跳过,不使整份明细不可读。
      }
    }
    return rows;
  } catch (e) {
    console.warn(`[executor-task] 明细读取失败(${taskId}): ${e}`);
    return null;
  }
}

/**
 * 查单条明细:返回 undefined = 明细文件不存在(条目已被清理 / 任务无明细);
 * null = 文件存在但该 id 不存在;命中则返回条目。调用方据此区分 404 原因。
 */
export function findTaskDetail(
  taskId: string,
  entryId: string,
): StoredTaskDetail | null | undefined {
  const rows = readTaskDetail(taskId);
  if (rows === null) return undefined;
  return rows.find((r) => r.id === entryId) ?? null;
}

/** 清空全部明细文件(测试重置用,与 clearAllTaskOutputs 配套)。 */
export function clearAllTaskDetails(): void {
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith(DETAIL_FILE_PREFIX)) continue;
    if (!name.endsWith(DETAIL_FILE_SUFFIX)) continue;
    try {
      unlinkSync(path.join(tmpdir(), name));
    } catch {
      // 不存在/被并发清理,忽略。
    }
  }
}
