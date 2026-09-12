import { rmSync } from "node:fs";
import nodePath from "node:path";
import {
  type DispatchPolicy,
  extractRateLimitRecoveryMs,
  type RetryPolicy,
  readDispatchPolicy,
} from "@server/lib/executors";
import { clearAllTaskDetails } from "./detail-store";
import { clearAllTaskOutputs } from "./output-buffer";
import type { QueuedRun, QuotaFailureKind } from "./types";

/**
 * 执行器触发链路的模块级状态(executor-task 拆分):组队列 / 并行槽位 /
 * 超时阈值 / 重试与额度配置 / 冷却登记。所有可变状态收敛在本文件,其余
 * 子模块(notify/output-buffer/queue/report)通过此处读写,保证跨模块
 * 状态一致;测试重置入口(__resetExecutorQueueForTests 等)也在此。
 */

/**
 * 按 project_path 分组的执行队列(模块级,票4):同一组键(project_path)的任务
 * 组内串行;不同组并行执行,并行组数上限 maxParallelGroups(dispatch-policy.json,
 * 默认 2;=1 时退化为全局串行)。组槽位空闲时 pumpQueue 取组内队首运行。
 */
export const groupQueues = new Map<string, import("./types").GroupQueue>();

/** All runs handed from a queue to runOne, including the pre-spawn window. */
export const activeRuns = new Set<import("./types").QueuedRun>();

/** 调度策略:启动时读取一次,所有阈值从同一快照取值,避免重复读盘与不一致。 */
const dispatchPolicy: DispatchPolicy = readDispatchPolicy();

/** 最大并行组数:server 启动时从 scripts/dispatch-policy.json 读取。 */
let maxParallelGroups = dispatchPolicy.maxParallelGroups;

/** 工作树并发上限:同一 projectPath 下同时 running 的任务数上限;启动时读取,
 *  缺省 1(同一工作树串行)。projectPath 为空的默认组不参与本闸(单槽不变)。 */
let maxConcurrentPerWorkspace = dispatchPolicy.maxConcurrentPerWorkspace;

/** 静默超时阈值(ms):running 连续无输出超过即失败;启动时读配置,缺省 30min。 */
let stallTimeoutMs = dispatchPolicy.stallTimeoutMinutes * 60_000;

/** 无进展提醒阈值(ms):running 连续无输出超过即提醒协调者(不失败);
 *  启动时读配置,缺省 15min。 */
let stallAlertMs = dispatchPolicy.stallAlertMinutes * 60_000;

/** 认领超时阈值(ms):queued 超过即失败;启动时读配置,缺省 30min。 */
let claimTimeoutMs = dispatchPolicy.claimTimeoutMinutes * 60_000;

/** A2A 无进展超时阈值(ms):running 的 A2A 任务连续无进展信号即失败;启动时
 *  读配置,缺省 30min。detached 任务不适用(等待执行器事后 PATCH)。 */
let a2aSilenceTimeoutMs = dispatchPolicy.a2aSilenceTimeoutMinutes * 60_000;

/** detached 超时阈值(ms):detached 任务发送后执行器超过该时长未 PATCH 回写
 *  终态 → 按「结果未确认」处理;启动时读配置,缺省 24h。 */
let detachedTimeoutMs = dispatchPolicy.detachedTimeoutMinutes * 60_000;

/** L3 应答超时阈值(ms):协调任务落 done 且带 review_request 后,检视者超过
 *  该时长未公布 review_result → 任务详情派生 l3.overdue=true;启动时读配置,
 *  缺省 120min。逾期只触发群提醒,不改变任务状态或替代检视者裁决。 */
let l3ResponseMinutes = dispatchPolicy.l3ResponseMinutes;

/** 失败重试策略:exit≠0/超时/静默失败后按此配置自动重试;启动时读配置。 */
let retryPolicy: RetryPolicy = dispatchPolicy.retry;

/** 额度/速率限制配置(票7):失败关键词 + 冷却时长;启动时读配置。 */
let rateLimitPatterns = dispatchPolicy.rateLimit.detectPatterns;
let rateLimitCooldownMs = dispatchPolicy.rateLimit.cooldownMinutes * 60_000;

/**
 * 瞬时限流的 per-run 退避时长(ms);null = 未配置 → 不启用瞬时处置
 * (spec transient-ratelimit-escalated-to-long-cooldown R5)。
 */
let transientBackoffMs = transientBackoffMsOf(
  dispatchPolicy.rateLimit.transientBackoffSeconds,
);

/** 同一 run 连续瞬时限流次数上限(达到即升级为 exhausted);null = 未配置。 */
let transientEscalationLimit = optionalPositiveInt(
  dispatchPolicy.rateLimit.transientEscalationLimit,
);

/** 瞬时限流配置:秒 → ms;未配置(null)保持 null(不启用瞬时处置)。 */
function transientBackoffMsOf(seconds: number | null): number | null {
  return seconds === null ? null : Math.max(1, Math.floor(seconds * 1_000));
}

/** 正整数才算配置(0 / 负数 / 非整数 = 未配置)。 */
function optionalPositiveInt(value: number | null): number | null {
  return value !== null && Number.isInteger(value) && value >= 1 ? value : null;
}

/**
 * 重派熔断阈值(票 quota-exhaustion R4):同一父任务名下**连续失败**子任务数达到
 * 该值后停止重派(兜底防线,与原因识别无关 —— 即使原因识别失败也必须熔断)。
 * 默认 5(建议值),启动时读配置;测试可覆盖。
 */
let redispatchFailureLimit = 5;

/**
 * 执行器额度冷却(票7):executorKey → 冷却结束时间(epoch ms)。运行时判定仍读
 * 此 Map;额度失败时同步写入 task.diffSummary,启动时由 queue 恢复未到期记录。
 */
export const executorCooldowns = new Map<string, number>();
export type ExecutorCooldownSource = "parsed" | "fallback";
export interface ExecutorCooldownRecord {
  endMs: number;
  source: ExecutorCooldownSource;
  taskId?: string;
}
export const executorCooldownRecords = new Map<
  string,
  ExecutorCooldownRecord
>();

/** 冷却结束定时器(executorKey → timer):到期清冷却并泵一次,让排队任务自动派发。 */
export const cooldownTimers = new Map<string, NodeJS.Timeout>();

/**
 * 计划中的泵送定时器(403 退避 / 瞬时额度退避等,非冷却 Map 内的那些)。
 * 仅用于测试 teardown 取消——不能把几小时后的 timer 当成必须自然跑完。
 */
export const scheduledPumpTimers = new Set<NodeJS.Timeout>();

/** 登记一个到期会 requestPump 的 setTimeout,便于测试统一取消。 */
export function trackScheduledPumpTimer(timer: NodeJS.Timeout): void {
  scheduledPumpTimers.add(timer);
}

/** 定时器回调开头调用:正常到期后从集合移除。 */
export function untrackScheduledPumpTimer(timer: NodeJS.Timeout): void {
  scheduledPumpTimers.delete(timer);
}

/**
 * 测试专用:取消所有计划中的泵送/冷却定时器,不改变生产调度判定。
 * fixture drain 前调用,避免长冷却 timer 在关库后触发。
 */
export function __cancelScheduledPumpsForTests(): void {
  for (const t of cooldownTimers.values()) clearTimeout(t);
  cooldownTimers.clear();
  for (const t of scheduledPumpTimers) clearTimeout(t);
  scheduledPumpTimers.clear();
}

/**
 * 额度判定的调用上下文(伪额度回显修复 + 协调者转述误判修复
 * specs/quota-misclassified-from-coordinator-narration.md):只靠关键词命中不足
 * 以判额度 —— 必须至少有一条**正面**结构证据:命中行呈提供方错误行形状,或
 * 可解析出真实恢复时刻(spec R1:退出码一律不构成证据)。
 */
export interface QuotaFailureContext {
  /**
   * 进程退出码;null/undefined = 未知(如孤儿收敛无退出码可取)。
   *
   * ⚠️ R1(2026-09-06 事故):退出码**不再参与证据判定**(非零与零都不算)。
   * 协调进程被重启杀掉 → 非零退出;重试次数用尽 → exit 0 —— 两种「普通失败」
   * 都曾因正文提到 429/quota 被升格成额度冷却。保留本字段仅为调用点留痕与
   * 接口兼容,判定一律以正面证据为准。
   */
  exitCode?: number | null;
  /** 任务书全文(回显排除):命中行若逐字出现在任务书里 → 视为回显,不计证据。 */
  taskBook?: string | null;
  /**
   * R2 转述排除用:除本执行器外其它执行器的标识(key/label/agentName,
   * 调用方经 listPeerExecutorNames 取得)。命中行含其一 → 判为「转述他人状态」,
   * 不算本执行器限流。
   */
  peerExecutorNames?: string[];
}

/** 额度判定结果:isQuota 为真时 matchedLine 为命中的原始行(安全截断)。 */
export interface QuotaFailureVerdict {
  isQuota: boolean;
  /** 命中的原始行(截断到 QUOTA_MATCHED_LINE_MAX 字符);非配额为 null。 */
  matchedLine: string | null;
  /** 分级(transient / exhausted);非配额为 null。 */
  kind: QuotaFailureKind | null;
}

/**
 * 瞬时限流的相对恢复时长上限(ms):解析出的恢复时长 ≤ 该值 → 供应方只是要求
 * 短暂退避(准确但很短),按 transient 处理;超过 → 按 exhausted 处理(保守)。
 *
 * 与 queue.ts 的 MIN_EFFECTIVE_COOLDOWN_MS 同值:二者是同一条边界的两面 ——
 * R7 把「解析值 ≤ 该窗口」当作形同虚设的冷却而回退固定冷却,本 spec 把同一个
 * 窗口识别为瞬时退避。二者必须同值,否则会出现「既不算瞬时、又被 R7 回退成
 * 5 小时冷却」的空档(spec transient-ratelimit-escalated-to-long-cooldown R1)。
 */
export const TRANSIENT_RECOVERY_MAX_MS = 60_000;

/**
 * 额度耗尽关键词(兜底表,非分级主轴 —— R7-b:无恢复信息时才回落;中英双语)。
 * 命中任一即 exhausted,且**先于**时长判定(R7-c:同时命中按 exhausted,保守)。
 * spec R7-b:usage limit / quota exceeded / 额度 / 用尽 / 次数限制 等。
 */
const EXHAUSTED_QUOTA_SHAPES: ReadonlyArray<RegExp> = [
  /\busage limit(?:ed)?\b/i,
  /\bwindow exhausted\b/i,
  /\bquota exceeded\b/i,
  /\blimit reached\b/i,
  /额度/,
  /次数限制/,
  /用尽/,
];

/**
 * R7-b 兜底:瞬时动词(无恢复信息时回落;标注:兜底,非分级主轴)。中英双语:
 * retry/backoff、重试/稍后/请求过于频繁。
 */
const TRANSIENT_RETRY_VERB_RE =
  /\b(?:retry|retrying|retried|backoff|back(?:ing)? off)\b|重试|稍后|过于频繁/i;

/**
 * R7-a 恢复时长提取(分级主轴,与语言无关):从命中行提取恢复信息,只分三种
 * 结构 —— 相对时长(数字+时间单位)/ 绝对时刻(时钟或日期时间)/ 无恢复信息。
 * 返回「距 now 的毫秒数」,>0 为未来;无恢复信息返回 null。绝对时刻优先复用
 * parseRateLimitRecoveryMs 的时钟解析(不改其解析规则,R6),中文日期时间在此
 * 独立解析;恢复时刻已过去 → 负值,由调用方按 exhausted 处理(R3:垃圾解析 →
 * 回退固定冷却)。
 */
function recoveryDistanceMs(line: string, nowMs: number): number | null {
  const recoveryTs = extractRateLimitRecoveryMs(line, nowMs);
  return recoveryTs === null ? null : recoveryTs - nowMs;
}

/**
 * 额度失败分级(单点判定,调用方只读 kind)。
 *
 * 主轴(R7-a):恢复时长 —— 相对时长/绝对时刻距 now ≤ TRANSIENT_RECOVERY_MAX_MS
 * → transient,超过 → exhausted(与语言无关)。
 * 兜底(R7-b,非主轴):无恢复信息时才回落关键词 —— 耗尽关键词 → exhausted;
 * 瞬时动词且无耗尽关键词 → transient;都不命中 → exhausted(fail-safe)。
 * 优先级(R7-c):耗尽关键词先于时长判定(同时命中按 exhausted,保守,v1.0 口径)。
 */
function classifyQuotaKind(
  line: string,
  nowMs: number = Date.now(),
): QuotaFailureKind {
  const normalized = line.toLowerCase().replace(/-/g, " ");
  if (EXHAUSTED_QUOTA_SHAPES.some((re) => re.test(normalized))) {
    return "exhausted";
  }
  const recoveryMs = recoveryDistanceMs(line, nowMs);
  if (recoveryMs !== null) {
    return recoveryMs > 0 && recoveryMs <= TRANSIENT_RECOVERY_MAX_MS
      ? "transient"
      : "exhausted";
  }
  if (TRANSIENT_RETRY_VERB_RE.test(normalized)) {
    return "transient";
  }
  return "exhausted";
}

/** quotaMatchedLine 落库的最大长度(安全截断,避免超长 JSONL 行原样入 diffSummary)。 */
const QUOTA_MATCHED_LINE_MAX = 300;

/**
 * 提供方错误行语义形状(逐行):命中行需呈现「报错/限流诊断」外观,而不是源码
 *  回显或协调者转述。与 CLI 无关,不写死任何执行器名。
 *
 * R1(specs/quota-misclassified-from-coordinator-narration.md)收窄:只保留
 * 「锚定/显式」形状 —— 行首 error/fatal、行首方括号限流标签、JSON error 事件、
 * 显式限流动词短语、**行首** HTTP 状态码。删掉的两类弱形状正是两次事故的
 * 判定出处:裸 `429|5\d{2}`(行中数字,「HTTP 429 限流」式转述与参与者 id
 * 都会命中)与裸 `limit reached`/`exhausted`(平台自身「retry limit reached」
 * 熔断文案 01a074c6-e033 命中)。真限流在语料里的呈现(行首 429、[rate-limited]
 * 标签、error 前缀、resets around 时刻)全部仍被保留形状覆盖。
 *
 * ADR-0009:本判据拿「错误行形态」代替「输出提到限流词」;不成立的情形是
 * 提供方只用普通叙述报限流(无错误行形状、无恢复时刻)→ 漏判为普通失败,
 * 走普通重试路径 —— 代价从「误冷却停派 5 小时」降为「多试一次」,可接受。
 */
const PROVIDER_ERROR_LINE_SHAPES: ReadonlyArray<RegExp> = [
  /^\s*(?:error|fatal)\b/i,
  /^\s*\[(?:rate[- ]?limit(?:ed)?|quota|limit|429)\]/i,
  // 行首 HTTP 状态码(429/5xx,可带 "HTTP/1.1 " / "HTTP " 前缀);行中出现
  // 的状态码不构成证据 —— 「因 HTTP 429 限流」式转述即靠行中匹配误判。
  /^\s*(?:HTTP\/?[\d.]*\s+)?(?:429|5\d{2})\b/,
  /"type"\s*:\s*"error"/i,
  /\b(?:rate[- ]?limit(?:ed)?\s*(?:exceeded|exhausted)|too many requests|window exhausted|quota\s*(?:exceeded|exhausted)|usage limit(?:ed)?|you'?ve hit your (?:usage|rate) limit)\b/i,
];

/**
 * R2 转述排除的结构判据(不用语义猜测):命中行里出现以下任一「指向另一个
 * 任务/执行器」的结构特征 → 判为转述他人状态,不算本执行器限流。
 *
 * ADR-0009:本判据拿「行内是否点名他人/引用平台字段」代替「这句话像不像在
 * 转述」;不成立的情形是转述时不带任何指代(如「上一轮因额度失败」)——
 * 该情形由 R1 兜底:没有正面证据(错误行形状/恢复时刻)一律不判额度。
 */

/** 平台 ULID 形 id(任务/参与者/群共享同一生成器:8 位、01 开头的十六进制
 *  时间戳前缀,短形 01a06663 与长形 01a074c4-7117-… 的首段都命中)。 */
const PLATFORM_ID_SHAPE = /\b01[0-9a-f]{6}\b/i;

/** 平台自有字段名(带赋值/JSON 键形态,如 `quotaKind=exhausted`、
 *  `"dispatchKind":"fix"`)。取领域词汇表里的平台专有名,不含 "status"
 *  这类提供方 JSON 也用的通用键 —— codebuddy 真限流行里的
 *  `"status":429` 不得被误伤(01a0721c 实证)。 */
const PLATFORM_FIELD_SHAPE =
  /\b(?:quotaKind|dispatchKind|checkpointRef|callbackRef|supersedesTaskId|specHash|executorKey|queuedBlocked|resumeOf)\s*[=:]/i;

/** ASCII 执行器标识按整词匹配(避免 "pi" 命中 "api"/"pipeline");非 ASCII
 *  标签(中文别名)退化为普通包含。 */
function mentionsExecutorName(line: string, name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (/[\u0080-\uffff]/.test(trimmed)) return line.includes(trimmed);
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(line);
}

/** R2:命中行是否在转述另一个任务/执行器的状态(结构特征判定)。 */
function isOtherPartyNarrationLine(
  line: string,
  peerExecutorNames?: string[],
): boolean {
  if (PLATFORM_ID_SHAPE.test(line)) return true;
  if (PLATFORM_FIELD_SHAPE.test(line)) return true;
  if (peerExecutorNames?.some((n) => mentionsExecutorName(line, n))) {
    return true;
  }
  return false;
}

/** 是否「detectPatterns 定义」自指行:输出里出现配置定义本身(含 detectPatterns
 *  键名,或 ≥2 个引号包裹的关键词列表,形如 "usage limit", "rate limit", "quota")。
 *  这类行只是回显了模式表,不是执行器真遇到的额度报错。 */
function isDetectPatternsDefinitionLine(line: string): boolean {
  if (/\bdetectPatterns\b/i.test(line)) return true;
  const quoted = line.match(/"[^"]*"/g) ?? [];
  if (quoted.length === 0) return false;
  const patternHits = quoted.filter((q) =>
    rateLimitPatterns.some((p) => q.toLowerCase().includes(p.toLowerCase())),
  );
  // 判据是**密度**而不是绝对条数:配置定义行整行就是关键词列表(命中/引号串 = 1.0),
  // 而提供方自己的 JSON 结果行有大量业务字段,关键词只占极小比例
  // (codebuddy 真实 JSONL 实测 2/数十)。只看「≥2 条」会把真限流的结果行
  // 误判成配置回显 —— 2026-09-06 实测漏判。
  return patternHits.length >= 2 && patternHits.length / quoted.length >= 0.5;
}

/** 是否任务书逐字回显(自指):命中行整行出现在任务书正文里 → 不算证据。
 *  只做「整行包含」判定(逐字回显),不抓长行里夹带的任务书片段。 */
function isTaskBookEcho(
  line: string,
  taskBook: string | null | undefined,
): boolean {
  if (!taskBook) return false;
  const trimmed = line.trim();
  return trimmed.length > 0 && taskBook.includes(trimmed);
}

/**
 * 额度失败判定(伪额度回显修复 + 转述误判修复):对每行做「关键词命中 →
 * 排除自指/转述 → 正面结构证据」三段判定。正面结构证据(spec R1,二选一):
 * 命中行呈提供方错误行形状,或可解析出真实恢复时刻。退出码(无论零非零)
 * 一律不构成证据;仅关键词命中(输出回显了含 quota 字样的源码/测试名/任务书)
 * → 不算额度,避免误冷却停派。
 *
 * 返回命中的原始行(截断),供 diffSummary.quotaMatchedLine 留痕;并给出分级
 * kind(瞬时限流 / 额度耗尽),供调用方分流(R1:分级收敛在本函数单点)。
 */
export function classifyQuotaFailure(
  texts: string[],
  ctx: QuotaFailureContext = {},
): QuotaFailureVerdict {
  const { taskBook, peerExecutorNames } = ctx;
  for (const raw of texts) {
    for (const rawLine of raw.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      const lower = line.toLowerCase();
      const normalized = lower.replace(/-/g, " ");
      if (
        !rateLimitPatterns.some(
          (p) =>
            lower.includes(p.toLowerCase()) ||
            normalized.includes(p.toLowerCase()),
        )
      ) {
        continue;
      }
      // 自指排除:detectPatterns 定义 / 任务书回显。
      if (isDetectPatternsDefinitionLine(line)) continue;
      if (isTaskBookEcho(line, taskBook)) continue;
      // 转述排除(R2):点名其它执行器/引用平台任务 id 或字段 → 转述他人状态。
      if (isOtherPartyNarrationLine(line, peerExecutorNames)) continue;
      // 正面结构证据(R1):提供方错误行形状 / 真实恢复时刻,二者其一。
      const hasEvidence =
        extractRateLimitRecoveryMs(line) !== null ||
        PROVIDER_ERROR_LINE_SHAPES.some((re) => re.test(line));
      if (hasEvidence) {
        return {
          isQuota: true,
          matchedLine: line.slice(0, QUOTA_MATCHED_LINE_MAX),
          kind: classifyQuotaKind(line),
        };
      }
    }
  }
  return { isQuota: false, matchedLine: null, kind: null };
}

/** 额度失败文本是否命中关键词(rate limit/quota/429/额度 等,大小写不敏感)。
 *  保持原签名(孤儿收敛等既有调用点不变);底层复用 classifyQuotaFailure 的
 *  结构证据判定(无退出码、无任务书时可退化为恢复时刻 / 错误行形状证据)。 */
export function isQuotaFailure(texts: string[]): boolean {
  return classifyQuotaFailure(texts).isQuota;
}

/** 格式化冷却结束时间(zh-CN 本地时间,与认领超时回传一致)。 */
export function formatEta(endMs: number): string {
  return new Date(endMs).toLocaleString("zh-CN");
}

/** 冷却结束时间(epoch ms);无冷却记录返回 0。 */
export function cooldownEndMs(ex: { key: string }): number {
  return executorCooldowns.get(ex.key) ?? 0;
}

/** 执行器是否处于额度冷却期。 */
export function isInCooldown(ex: { key: string }): boolean {
  return cooldownEndMs(ex) > Date.now();
}

/** 当前运行中的组数(组槽位占用数)。 */
export function runningGroupCount(): number {
  let n = 0;
  for (const g of groupQueues.values()) if (g.running.length > 0) n += 1;
  return n;
}

/** process.kill(pid, 0) 只探测进程是否存在,不发送信号。 */
export function isExecutorProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but this process cannot signal it. Only
    // ESRCH proves that the PID has disappeared; preserve everything else.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * 存活协调进程登记(spec multiple-coordinators-with-global-serialization R1):
 * pid → 该协调任务所在群绑定的 projectPath。
 *
 * 为什么需要它:协调任务是 detached 的 —— spawn 后队列槽位立即由 runOne 的
 * finally 释放(group.running 移除本 run),而工作树闸只数 group.running,
 * 因此**看不见仍在跑的协调进程**——既有闸的结构性盲区:协调者的 L2 测试代跑
 * 会与执行器写树重叠(serial-dispatch-guard 只修了执行器那一半)。
 *
 * 为什么占用判据是「进程存活」而不是「status=running」:父协调任务在等待
 * 执行器 PATCH 回写期间恒为 running,而续跑任务只有被 spawn 才能做 L2 并关掉
 * 父任务 —— 按 status 计数会让 wake-the-coordinator 整体死锁(spec v1.0 的
 * 缺陷,v1.1 修正点)。
 */
const liveCoordinatorProcesses = new Map<number, string>();

/**
 * 登记一个已 spawn 的协调任务进程。projectPath 为空(群未绑定项目)或 pid 缺失
 * (a2a 无本地进程)→ 不登记:前者不参与工作树闸(默认组由组内单槽维持原行为),
 * 后者没有可做存活判定的对象。
 */
export function registerCoordinatorProcess(
  projectPath: string | null,
  pid: number | undefined,
): void {
  if (!projectPath || pid === undefined) return;
  liveCoordinatorProcesses.set(pid, projectPath);
}

/** 撤销登记(协调进程退出的已知出口调用;存活判定本身仍是唯一判据)。 */
export function releaseCoordinatorProcess(pid: number | undefined): void {
  if (pid === undefined) return;
  liveCoordinatorProcesses.delete(pid);
}

/**
 * 指定工作树上的存活协调进程数:**读取时**判定存活(与孤儿收敛器同源的
 * process.kill(pid, 0)),因此进程一退出占用即消失,不依赖任何退出回调;已退出
 * 的条目在此顺手清掉,登记表不会无限增长。
 */
export function coordinatorOccupancyCount(projectPath: string): number {
  let n = 0;
  for (const [pid, path] of liveCoordinatorProcesses) {
    if (!isExecutorProcessAlive(pid)) {
      liveCoordinatorProcesses.delete(pid);
      continue;
    }
    if (path === projectPath) n += 1;
  }
  return n;
}

/**
 * 指定执行器当前 running 的任务数(跨所有组):执行器级并发上限(声明式
 * maxConcurrency)与反应式排队(403 后等待既有任务终态)的调度判定用。
 * 组内串行不变,但同一执行器在不同组可能各有 running —— 本函数按
 * executor key 聚合,供 pumpQueue 决定是否还能向该执行器派发。
 */
export function runningExecutorCount(exKey: string): number {
  let n = 0;
  for (const g of groupQueues.values()) {
    for (const r of g.running) {
      if (r.ex.key === exKey) n += 1;
    }
  }
  return n;
}

/**
 * 工作树维度的占用数(统一占用源,spec multiple-coordinators R1):同一
 * projectPath(群绑定项目路径)下跨所有组(不同群绑同一路径也计入同一闸)的
 *  1. 队列内 running 的任务(既有口径),+
 *  2. 存活的协调进程(detached,队列槽位已释放,只在此登记)。
 * pumpQueue 按 maxConcurrentPerWorkspace 上限判定是否还能向该工作树派发;
 * 认领超时豁免复用同一计数的「闸已满」判定(ADR-0009:同一事实只有一个判定
 * 出处)。projectPath 为空 → 不参与本闸,恒返回 0(默认组由组内单槽维持原行为)。
 */
export function runningWorkspaceCount(projectPath: string | null): number {
  if (!projectPath) return 0;
  let n = coordinatorOccupancyCount(projectPath);
  for (const g of groupQueues.values()) {
    for (const r of g.running) {
      if (r.projectPath === projectPath) n += 1;
    }
  }
  return n;
}

/** Test teardown visibility for the fire-and-forget runOne lifecycle. */
export function activeExecutorTaskCount(): number {
  return activeRuns.size;
}

/** pumpQueue 重入保护:并行启动多个组时,同一时刻只允许一个泵循环。 */
export let pumping = false;

/** pumpQueue 进入临界区(仅 queue.ts 内部调用)。 */
export function setPumping(value: boolean): void {
  pumping = value;
}

/** 读静默超时阈值(ms)。 */
export function getStallTimeoutMs(): number {
  return stallTimeoutMs;
}

/** 读无进展提醒阈值(ms)。 */
export function getStallAlertMs(): number {
  return stallAlertMs;
}

/** 读认领超时阈值(ms)。 */
export function getClaimTimeoutMs(): number {
  return claimTimeoutMs;
}

/** 读 A2A 无进展超时阈值(ms)。 */
export function getA2ASilenceTimeoutMs(): number {
  return a2aSilenceTimeoutMs;
}

/** 读 detached 超时阈值(ms)。 */
export function getDetachedTimeoutMs(): number {
  return detachedTimeoutMs;
}

/** 读 L3 应答超时阈值(ms)。 */
export function getL3ResponseMinutesMs(): number {
  return l3ResponseMinutes * 60_000;
}

/** 读最大并行组数。 */
export function getMaxParallelGroups(): number {
  return maxParallelGroups;
}

/** 读工作树并发上限。 */
export function getMaxConcurrentPerWorkspace(): number {
  return maxConcurrentPerWorkspace;
}

/** 读失败重试策略。 */
export function getRetryPolicy(): RetryPolicy {
  return retryPolicy;
}

/** 读额度冷却时长(ms)。 */
export function getRateLimitCooldownMs(): number {
  return rateLimitCooldownMs;
}

/**
 * 读瞬时限流处置配置(per-run 退避时长 + 连续升级上限);未配置 → null。
 *
 * null 时调用方必须回落 exhausted 语义(fail-safe:宁可长冷却也不要无限退避,
 * spec transient-ratelimit-escalated-to-long-cooldown R5/§7)。两个键缺一即
 * 视为未配置 —— 没有退避时长的退避、没有上限的退避都是半个机制。
 */
export function getTransientQuotaPolicy(): {
  backoffMs: number;
  escalationLimit: number;
} | null {
  if (transientBackoffMs === null || transientEscalationLimit === null) {
    return null;
  }
  return {
    backoffMs: transientBackoffMs,
    escalationLimit: transientEscalationLimit,
  };
}

/** 读重派熔断阈值(同一父任务连续失败子任务数上限)。 */
export function getRedispatchFailureLimit(): number {
  return redispatchFailureLimit;
}

/**
 * 取消单个 run 的认领/静默定时器(幂等;停止/完成/重置时调用)。
 *  detachedTimer 不在清理范围:detached 任务发送完成后 run 已离开队列,超时
 *  定时器需跨队列存活(等待执行器 PATCH,超时按结果未确认处理)。
 */
export function clearRunTimers(run: QueuedRun): void {
  if (run.claimTimer) {
    clearTimeout(run.claimTimer);
    run.claimTimer = null;
  }
  if (run.stallTimer) {
    clearTimeout(run.stallTimer);
    run.stallTimer = null;
  }
  if (run.stallAlertTimer) {
    clearTimeout(run.stallAlertTimer);
    run.stallAlertTimer = null;
  }
  if (run.a2aSilenceTimer) {
    clearTimeout(run.a2aSilenceTimer);
    run.a2aSilenceTimer = null;
  }
}

/**
 * 测试专用:终止全部运行中任务并清空所有组队列(模块级状态跨测试文件/用例
 * 共享,避免前一个用例残留的 running/queued 影响后续断言)。仅测试调用。
 */
/**
 * 清掉共享临时仓库里的陈旧 `.git/index.lock`(2026-09-07 定位)。
 *
 * 下面的 `r.kill?.()` 是**不等待**的:被杀的执行器可能正卡在 `git add -A` /
 * `git write-tree` 中间,留下 `index.lock`。下一个用例的「执行前快照」于是失败
 * (`fatal: Unable to create '…/.git/index.lock': File exists`),任务直接判失败、
 * 永远到不了 running —— 表现就是 coordinator-resume 端到端超时、
 * workspace-gate 的 occupancy 读到 0。实测两文件合跑 6 轮复现 1 次(~17%)。
 *
 * 只在 `COAGENTHUB_REPO_ROOT` 指向测试临时仓库时清理;本函数本身就是
 * test-only 导出,不会在生产路径被调用。
 */
export function clearStaleTestRepoIndexLock(): void {
  // 仅在 vitest 进程内生效:VITEST 由测试运行器注入,生产进程没有它。
  // 生产环境里删共享仓库的 index.lock 可能打断并发 git 操作,绝不能做。
  if (!process.env.VITEST) return;
  const repoRoot = process.env.COAGENTHUB_REPO_ROOT;
  if (!repoRoot) return;
  try {
    rmSync(nodePath.join(repoRoot, ".git", "index.lock"), { force: true });
  } catch {
    // 清理是尽力而为:锁不存在或无权限都不该让测试重置抛错。
  }
}

export function __resetExecutorQueueForTests(): void {
  for (const g of groupQueues.values()) {
    for (const r of g.running) {
      r.stopped = true;
      r.kill?.();
      clearRunTimers(r);
    }
    for (const q of g.queue) clearRunTimers(q);
    g.queue.length = 0;
  }
  groupQueues.clear();
  liveCoordinatorProcesses.clear();
  clearStaleTestRepoIndexLock();
  clearAllTaskOutputs();
  clearAllTaskDetails();
  for (const t of cooldownTimers.values()) clearTimeout(t);
  cooldownTimers.clear();
  for (const t of scheduledPumpTimers) clearTimeout(t);
  scheduledPumpTimers.clear();
  executorCooldowns.clear();
  executorCooldownRecords.clear();
  const policy = readDispatchPolicy();
  maxParallelGroups = policy.maxParallelGroups;
  maxConcurrentPerWorkspace = policy.maxConcurrentPerWorkspace;
  stallTimeoutMs = policy.stallTimeoutMinutes * 60_000;
  stallAlertMs = policy.stallAlertMinutes * 60_000;
  claimTimeoutMs = policy.claimTimeoutMinutes * 60_000;
  a2aSilenceTimeoutMs = policy.a2aSilenceTimeoutMinutes * 60_000;
  detachedTimeoutMs = policy.detachedTimeoutMinutes * 60_000;
  l3ResponseMinutes = policy.l3ResponseMinutes;
  retryPolicy = policy.retry;
  rateLimitPatterns = policy.rateLimit.detectPatterns;
  rateLimitCooldownMs = policy.rateLimit.cooldownMinutes * 60_000;
  transientBackoffMs = transientBackoffMsOf(
    policy.rateLimit.transientBackoffSeconds,
  );
  transientEscalationLimit = optionalPositiveInt(
    policy.rateLimit.transientEscalationLimit,
  );
  redispatchFailureLimit = 5;
}

/** 测试专用:覆盖最大并行组数(默认读 scripts/dispatch-policy.json)。 */
export function __setMaxParallelGroupsForTests(n: number): void {
  maxParallelGroups = Math.max(1, Math.floor(n));
}

/** 测试专用:覆盖工作树并发上限(默认读 scripts/dispatch-policy.json)。
 *  =2 时同一 projectPath 允许两个并行;=1 恢复串行(改动前行为)。 */
export function __setMaxConcurrentPerWorkspaceForTests(n: number): void {
  maxConcurrentPerWorkspace = Math.max(1, Math.floor(n));
}

/**
 * 测试专用:覆盖静默/认领/A2A 无进展/detached 超时阈值(默认读
 * scripts/dispatch-policy.json,单位 ms)。测试用 100ms 级小阈值避免拖慢测试,
 * 与配置单位(分钟)无关。a2aSilence/detached 未显式传值时给 60s 兜底,避免
 * 既有测试(未关注新阈值)被意外触发。
 */
export function __setReliabilityTimeoutsForTests(
  stallMs: number,
  claimMs: number,
  stallAlertMsOverride?: number,
  a2aSilenceMsOverride?: number,
  detachedMsOverride?: number,
): void {
  stallTimeoutMs = Math.max(1, Math.floor(stallMs));
  claimTimeoutMs = Math.max(1, Math.floor(claimMs));
  // 默认提醒阈值取 stall 的 2 倍:不改变既有测试行为(静默在 stall 即失败,
  // 提醒不会先触发);需要验证提醒的测试显式传小阈值。
  stallAlertMs =
    stallAlertMsOverride !== undefined
      ? Math.max(1, Math.floor(stallAlertMsOverride))
      : Math.max(1, Math.floor(stallMs)) * 2;
  a2aSilenceTimeoutMs =
    a2aSilenceMsOverride !== undefined
      ? Math.max(1, Math.floor(a2aSilenceMsOverride))
      : Math.max(60_000, Math.floor(stallMs));
  detachedTimeoutMs =
    detachedMsOverride !== undefined
      ? Math.max(1, Math.floor(detachedMsOverride))
      : Math.max(60_000, Math.floor(stallMs));
}

/** 测试专用:覆盖 L3 应答超时阈值(默认读 scripts/dispatch-policy.json,单位
 * 分钟;=1 时退化为 1 分钟,测试用 1 分钟级小阈值验证 overdue 派生)。 */
export function __setL3ResponseMinutesForTests(minutes: number): void {
  l3ResponseMinutes = Math.max(1, Math.floor(minutes));
}

/**
 * 测试专用:覆盖自动重试次数上限(默认读 scripts/dispatch-policy.json)。
 *
 * 静默/认领等「断言第一次终态」的用例必须 pin 为 0 或 1:policy 把
 * maxRetries 提到 3 后,可重试的失败(含 stall)会连跑多次,15s 级 wait
 * 会在中间一次 running 上超时,看起来像「信号永远不来」。
 */
export function __setMaxRetriesForTests(n: number): void {
  retryPolicy = {
    ...retryPolicy,
    maxRetries: Math.max(0, Math.floor(n)),
  };
}

/**
 * 测试专用:覆盖额度配置(关键词 + 冷却时长,单位 ms——与配置的分钟单位解耦,
 * 测试用 100ms~1s 级小阈值验证冷却拦截与自动恢复,避免拖慢测试)。
 */
export function __setRateLimitForTests(
  cooldownMs: number,
  patterns: string[],
): void {
  rateLimitCooldownMs = Math.max(1, Math.floor(cooldownMs));
  rateLimitPatterns = [...patterns];
}

/**
 * 测试专用:覆盖瞬时限流处置配置(per-run 退避时长 ms + 连续升级上限)。
 * 传 null(或非法值)即「未配置」→ getTransientQuotaPolicy() 返回 null,
 * 调用方回落 exhausted 语义(fail-safe,验收 9)。
 */
export function __setTransientQuotaForTests(
  backoffMs: number | null,
  escalationLimit: number | null,
): void {
  transientBackoffMs =
    backoffMs !== null && Number.isFinite(backoffMs) && backoffMs > 0
      ? Math.floor(backoffMs)
      : null;
  transientEscalationLimit = optionalPositiveInt(escalationLimit);
}
