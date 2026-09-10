/**
 * 任务书工作流策略模板(S6):方法论文案入库为 JSON,运行时按盘读取。
 *
 * 查找顺序(R2):`dispatchKind` 专属文件 → default.json;找不到专属不报错,
 * 回落全局。仓库文件是唯一真相源;本模块只读、不提供写接口(R3)。
 *
 * 第一版不做模板引擎(R4):字符串字段 + 调用方既有拼接;变体选择
 * (角色 / 群内是否有 reviewer)仍是机制,留在代码。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type TicketRole = "coordinator" | "executor" | "fallback";

export type TicketTemplate = {
  executionMode: {
    coordinator: string;
    executor: string;
    fallbackNote: string;
  };
  report: {
    coordinatorWithReviewer: string;
    coordinatorNoReviewer: string;
    executor: string;
  };
  /** 关联规范段「指令」行正文(不含 `- **指令**: ` 前缀);空串 = 不输出该行。 */
  specInstruction: string;
};

const EMPTY_TEMPLATE: TicketTemplate = {
  executionMode: {
    coordinator: "",
    executor: "",
    fallbackNote: "",
  },
  report: {
    coordinatorWithReviewer: "",
    coordinatorNoReviewer: "",
    executor: "",
  },
  specInstruction: "",
};

/** 模板目录:env 可覆盖(测试写临时目录);默认上溯找 ticket-templates/。 */
export function resolveTicketTemplatesDir(): string {
  const override = process.env.COAGENTHUB_TICKET_TEMPLATES_DIR?.trim();
  if (override) return override;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = resolve(dir, "ticket-templates");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(dirname(fileURLToPath(import.meta.url)), "ticket-templates");
}

function readJsonFile(path: string): unknown | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    // 损坏/不可读 → 视作缺失,回落(R2:不要报错)。
    return null;
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 只收录 JSON 里真正出现的字符串键;缺席的键不进 partial,避免合并时被空串覆盖。 */
function pickStringFields<K extends string>(
  src: Record<string, unknown>,
  keys: readonly K[],
): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  for (const key of keys) {
    if (key in src) out[key] = asString(src[key]);
  }
  return out;
}

function parseTemplate(raw: unknown): Partial<TicketTemplate> {
  if (!raw || typeof raw !== "object") return {};
  const obj = raw as Record<string, unknown>;
  const out: Partial<TicketTemplate> = {};
  if (obj.executionMode && typeof obj.executionMode === "object") {
    out.executionMode = pickStringFields(
      obj.executionMode as Record<string, unknown>,
      ["coordinator", "executor", "fallbackNote"] as const,
    ) as TicketTemplate["executionMode"];
  }
  if (obj.report && typeof obj.report === "object") {
    out.report = pickStringFields(
      obj.report as Record<string, unknown>,
      ["coordinatorWithReviewer", "coordinatorNoReviewer", "executor"] as const,
    ) as TicketTemplate["report"];
  }
  if ("specInstruction" in obj) {
    out.specInstruction = asString(obj.specInstruction);
  }
  return out;
}

/** 浅合并:override 里出现的分组整组替换其内已给字段,未给的字段保留 base。 */
function mergeTemplate(
  base: TicketTemplate,
  override: Partial<TicketTemplate>,
): TicketTemplate {
  return {
    executionMode: {
      ...base.executionMode,
      ...(override.executionMode ?? {}),
    },
    report: {
      ...base.report,
      ...(override.report ?? {}),
    },
    specInstruction:
      override.specInstruction !== undefined
        ? override.specInstruction
        : base.specInstruction,
  };
}

/**
 * 按 dispatchKind 加载模板(每次调用读盘,改文件无需重建 server)。
 * dispatchKind 专属缺失/损坏 → 静默回落 default;default 也缺失 → 空模板
 * (平台段仍由 queue 侧 buildExecutionContextSection 注入,R5)。
 */
export function loadTicketTemplate(
  dispatchKind: "requirement" | "fix" | null,
): TicketTemplate {
  const dir = resolveTicketTemplatesDir();
  const globalRaw = readJsonFile(resolve(dir, "default.json"));
  const global = mergeTemplate(EMPTY_TEMPLATE, parseTemplate(globalRaw));
  if (!dispatchKind) return global;
  // requirement 与 null 共用全局(当前文案一致);专属文件存在则覆盖。
  const kindRaw = readJsonFile(resolve(dir, `${dispatchKind}.json`));
  if (kindRaw === null) return global;
  return mergeTemplate(global, parseTemplate(kindRaw));
}

/** 多行字符串 → 行数组;空串 → 不贡献任何行(避免 join 出多余空行)。 */
export function templateLines(text: string): string[] {
  if (!text) return [];
  return text.split("\n");
}

export function buildExecutionModeLines(
  template: TicketTemplate,
  role: TicketRole,
): string[] {
  if (role === "coordinator") {
    return templateLines(template.executionMode.coordinator);
  }
  const lines = templateLines(template.executionMode.executor);
  if (role === "fallback" && template.executionMode.fallbackNote) {
    lines.push(template.executionMode.fallbackNote);
  }
  return lines;
}

export function buildReportLines(
  template: TicketTemplate,
  role: TicketRole,
  groupHasReviewer: boolean,
): string[] {
  if (role === "coordinator") {
    // 是否可携带 review_request 是平台机制(与 tasks.ts R3 守卫同源判定);
    // 文案本身来自模板。dispatchKind 深度差异由 loadTicketTemplate 合并进
    // coordinatorWithReviewer 字段,这里不再按 kind 分支。
    if (groupHasReviewer) {
      return templateLines(template.report.coordinatorWithReviewer);
    }
    return templateLines(template.report.coordinatorNoReviewer);
  }
  return templateLines(template.report.executor);
}
