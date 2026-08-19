import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  executorConfig as executorConfigTable,
  participant as participantTable,
} from "@laizhixingxingdeli/database/schema";
import { asc, eq } from "drizzle-orm";
import type { DataBase } from "./database";
import { resolveLocalUser } from "./local-participant";

/**
 * 执行器配置(server 单一来源):每一条对应「一个 AI 工具 = 一个 participant
 * 身份」。server 在 POST /groups/:id/messages 检测 audience=participant 且
 * audienceRef 命中本配置(按 participant.name === agentName 匹配)时创建 task
 * 并 spawn 执行器;开机时由 ensureExecutorParticipants 幂等注册对应 participant。
 *
 * 完整集合 = 内置默认(DEFAULT_EXECUTORS)+ DB 持久化配置(executor_config 表,
 * 经「接入 Participant」界面写入),见 effectiveExecutors(db)。
 *
 * bin 可用环境变量覆盖(测试/本机路径差异):EXECUTOR_BIN_<KEY 大写> 优先,
 * 回退到配置默认值。
 */

export interface ExecutorConfig {
  /** 唯一 key,写入 task.executor_key,标记任务由哪个执行器跑。 */
  key: string;
  /**
   * participant 展示名;与 participant 表 name 匹配用(注册的 participant 名)。
   * 字段名 agentName 保留旧名(兼容既有 executors.json/DB 行,agent 为
   * participant 的旧名)。
   */
  agentName: string;
  type: string;
  bin: string;
  label: string;
  args: string[];
  /**
   * 执行器默认模型(args 模板可用 {model} 占位引用;无 model 时该参数项被移除,
   * 避免 CLI 收到空参数)。可选:不配置则 args 里不渲染 model。
   */
  model?: string;
  /**
   * 运行方式:cli=本地 spawn(默认,现有三条);a2a=经 A2A gateway 远程调用
   * 其他设备上的 participant(如 Windows 上的 hermes),server 不 spawn 本地进程。
   */
  kind?: "cli" | "a2a";
  /**
   * 记忆模式(可选):仅 "per-group" 启用跨任务上下文延续 —— a2a 调用前查
   * 该 (执行器, 群) 最近非 cancelled 任务的 a2a_context_id,调用后回写新
   * contextId;按群隔离,跨群不串。缺省 = 无记忆:任务书自包含,每次任务
   * 独立执行,从不携带/回写 contextId。记忆只是加速器,验收不依赖记忆。
   */
  memory?: "per-group";
  /** a2a 的 gateway 基地址(DB 配置存 url 列,与 a2a.url 并存;runner 读 a2a.url)。 */
  url?: string;
  /** kind="a2a" 时的 gateway 信息;token 从 env 读(COAGENTHUB_WIN_A2A_TOKEN),不硬编码。 */
  a2a?: {
    /** gateway 基地址;env COAGENTHUB_WIN_A2A_URL 可覆盖(测试指向 mock)。 */
    url: string;
    /** Authorization: Bearer 用的 token。 */
    token: string;
  };
  /**
   * 同一执行器最大并发 running 任务数(可选,声明式并发上限):缺省 = 不限制
   * (可并发执行器允许多个任务同时 running,不做无谓串行)。配置为 1 时该执行器
   * 任务严格串行——如 AtomCode(atomgit session 并发会触发
   * `403 atomgit_session_concurrency_conflict`)。pump 调度时,目标执行器当前
   * running 数 >= maxConcurrency → 新任务保持 queued,等既有任务终态后自动出队。
   * 无配置的执行器走反应式排队:先按 running 尝试下发,收到 403 再转 queued。
   * 注:DB 持久化配置(executor_config 表)暂无可持久化列,按缺省(不限制)处理。
   */
  maxConcurrency?: number;
}

const DEFAULT_EXECUTORS: ExecutorConfig[] = [
  {
    key: "executor",
    agentName: "AtomCode 执行器",
    // type 旧值为 "agent"(participant 旧名);只影响新注册行的展示值,
    // 不与任何路由/权限逻辑耦合,改名后统一为 "participant"。
    type: "participant",
    bin: "atomcode",
    label: "atomcode",
    args: ["-y", "-p", "{ticket}"],
    // 声明式并发上限:AtomCode 的 atomgit session 同一时间只能执行一个任务,
    // 并发会触发 403 atomgit_session_concurrency_conflict → 服务端按 1 排队。
    maxConcurrency: 1,
  },
  {
    key: "reasonix",
    agentName: "Reasoning 执行器",
    type: "participant",
    bin: "reasonix",
    label: "reasonix",
    // 支持 --model:args 模板用 {model} 占位(有 model 替换,无 model 时该参数
    // 项连同前置 --model flag 一并移除,避免 CLI 收到空参数)。
    args: ["run", "-y", "--model", "{model}", "{ticket}"],
    model: "deepseek-v4-flash",
  },
  {
    key: "codebuddy",
    agentName: "CodeBuddy 执行器",
    type: "participant",
    bin: "codebuddy",
    label: "codebuddy",
    args: ["-y", "-p", "{ticket}"],
  },
  {
    key: "codex",
    agentName: "Codex 执行器",
    type: "participant",
    bin: "codex",
    label: "codex",
    // Headless Codex task:允许改工作区,不等待审批,每个 task 使用新上下文。
    args: [
      "exec",
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "never",
      "--ephemeral",
      "{ticket}",
    ],
    // 当前 runner 以共享工作区执行,避免同一 Codex participant 并发改文件。
    maxConcurrency: 1,
  },
  {
    key: "hermes",
    agentName: "Hermes 规划",
    type: "hermes",
    bin: "hermes",
    label: "hermes",
    args: ["-z", "{ticketContent}"],
  },
  {
    // 远端设备上的 hermes(Windows 192.168.31.180):A2A gateway 调用,
    // 不用本地 bin(spawn 路径按 kind=a2a 分流,bin 仅作占位标识)。
    key: "win-hermes",
    agentName: "Win Hermes",
    type: "hermes",
    bin: "win-hermes",
    label: "win-hermes",
    args: [],
    kind: "a2a",
    // 协调器:开启按群记忆(a2a 跨任务按群延续 contextId)。纯粹执行器保持
    // 无记忆(任务书自包含,每次任务独立执行)。
    memory: "per-group",
    a2a: {
      url: "http://192.168.31.180:9900/",
      token: "",
    },
  },
];

/** 内置默认 + env 覆盖(不改 DB,与 DB 行互不影响)。 */
function defaultExecutors(): ExecutorConfig[] {
  return DEFAULT_EXECUTORS.map(applyEnvOverrides);
}

/** 判断 key 是否为内置默认执行器(内置配置不可删除/跳过删除)。 */
export function isBuiltinExecutorKey(key: string): boolean {
  return DEFAULT_EXECUTORS.some((ex) => ex.key === key);
}

/**
 * 从失败输出解析执行器额度恢复时间(冷却动态化,票8):
 *  - "resets around 13:33"(大小写不敏感)→ 今天该时刻;若该时刻已过,视为
 *    now(立即恢复,保守不再延长)。
 *  - "try again in 5 seconds"(大小写不敏感)→ now + N 秒。
 * 解析成功返回冷却到期时刻(epoch ms);无匹配返回 null(调用方回退固定冷却)。
 * now 参数便于测试注入固定基准时间。
 */
export function parseRateLimitRecoveryMs(
  text: string,
  now: number = Date.now(),
): number | null {
  const clean = (text ?? "").replace(ANSI_RE, "");
  const around = clean.match(/resets?\s*around\s+(\d{1,2}):(\d{2})/i);
  if (around) {
    const target = new Date(now);
    target.setHours(Number(around[1]), Number(around[2]), 0, 0);
    return target.getTime() > now ? target.getTime() : now;
  }
  const retryIn = clean.match(/try again in\s+(\d+)\s*seconds?/i);
  if (retryIn) {
    return now + Number(retryIn[1]) * 1000;
  }
  return null;
}

/** 与 executor-task 相同的 ANSI 清理(解析前剥掉颜色码)。 */
const ANSI_RE =
  /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

/**
 * 渲染 spawn args 模板(票8):替换 {model} 占位。有 model → 替换;无 model →
 * 从 args 中移除该参数项,并连同其前一个独立 flag(如 "--model")一并移除,
 * 避免 CLI 收到悬空 flag(「--model {model}」整组消失)。
 * {ticket}/{ticketContent} 等其他占位由调用方先替换。
 */
export function renderExecutorArgs(
  args: string[],
  model: string | undefined,
): string[] {
  const rendered = args.map((a) =>
    model === undefined ? a : a.replaceAll("{model}", model),
  );
  if (model !== undefined) return rendered;
  const out: string[] = [];
  for (let i = 0; i < rendered.length; i++) {
    const arg = rendered[i];
    if (arg.includes("{model}")) {
      // 无 model:该参数项移除;若前一项是独立 flag(以 - 开头且非 --flag=value
      // 形式),一并移除(如 "--model {model}" 整组消失)。
      if (
        out.length > 0 &&
        /^-\S+$/.test(out[out.length - 1]) &&
        !out[out.length - 1].includes("=")
      ) {
        out.pop();
      }
      continue;
    }
    out.push(arg);
  }
  return out;
}

/** env 覆盖:cli 的 bin 用 EXECUTOR_BIN_<KEY 大写>(如 EXECUTOR_BIN_CODEBUDDY);
 *  a2a 的 url 用 COAGENTHUB_WIN_A2A_URL 覆盖(测试指向本地 mock),token 一律从
 *  COAGENTHUB_WIN_A2A_TOKEN 读,不硬编码进源码。 */
function applyEnvOverrides(ex: ExecutorConfig): ExecutorConfig {
  if (ex.kind === "a2a" && ex.a2a) {
    return {
      ...ex,
      url: process.env.COAGENTHUB_WIN_A2A_URL ?? ex.url,
      a2a: {
        url: process.env.COAGENTHUB_WIN_A2A_URL ?? ex.a2a.url,
        token: process.env.COAGENTHUB_WIN_A2A_TOKEN ?? ex.a2a.token,
      },
    };
  }
  const override = process.env[`EXECUTOR_BIN_${ex.key.toUpperCase()}`];
  return override ? { ...ex, bin: override } : ex;
}

/* ---------------- DB 持久化配置(接入 Participant 界面) ---------------- */

/** DB 执行器配置行的运行时类型(select 结果元素)。 */
type ExecutorConfigRow = Awaited<
  ReturnType<typeof listExecutorConfigs>
>[number];
/** effectiveExecutors 短缓存:消息调度热路径避免每次现查 executor_config。
 *  TTL 到期自动失效;增删改函数主动失效,保证 CRUD 后立刻生效。 */
let cachedEffectiveExecutors: ExecutorConfig[] | null = null;
let cachedEffectiveExecutorsAt = 0;
const EXECUTORS_CACHE_TTL_MS = 5_000;

function invalidateExecutorsCache(): void {
  cachedEffectiveExecutors = null;
  cachedEffectiveExecutorsAt = 0;
}

/** 读取全部 DB 执行器配置(created_at 升序,顺序稳定)。 */
export async function listExecutorConfigs(db: DataBase) {
  return db
    .select()
    .from(executorConfigTable)
    .orderBy(asc(executorConfigTable.createdAt));
}

/** 新增一条 DB 执行器配置的入参(key/agent_name 唯一——列名保留旧名,agent 为
 *  participant 的旧名,冲突抛错由路由转 409)。 */
export interface AddExecutorConfigInput {
  key: string;
  agentName: string;
  type: string;
  kind: "cli" | "a2a";
  bin: string;
  url?: string;
  args?: string[];
  label?: string;
  /** 执行器默认模型(args 模板 {model} 占位);可选,null 表示清空。 */
  model?: string | null;
  /** 记忆模式:仅 "per-group" 启用按群 contextId 延续;null 表示无记忆。 */
  memory?: "per-group" | null;
}

/** 插入一条 DB 执行器配置并返回整行。 */
export async function addExecutorConfig(
  db: DataBase,
  input: AddExecutorConfigInput,
): Promise<ExecutorConfigRow> {
  const [row] = await db
    .insert(executorConfigTable)
    .values({
      key: input.key,
      agentName: input.agentName,
      type: input.type,
      kind: input.kind,
      bin: input.bin,
      url: input.url ?? null,
      args: input.args ?? [],
      label: input.label ?? input.agentName,
      model: input.model ?? null,
      memory: input.memory ?? null,
    })
    .returning();
  invalidateExecutorsCache();
  return row;
}

/** 按 key 删除 DB 执行器配置;返回是否真的删除了某行。 */
export async function removeExecutorConfig(
  db: DataBase,
  key: string,
): Promise<boolean> {
  const deleted = await db
    .delete(executorConfigTable)
    .where(eq(executorConfigTable.key, key))
    .returning({ id: executorConfigTable.id });
  invalidateExecutorsCache();
  return deleted.length > 0;
}

/** DB 行 → 运行时 ExecutorConfig(同样过 env 覆盖,与内置配置行为一致)。 */
function rowToConfig(row: ExecutorConfigRow): ExecutorConfig {
  const base: ExecutorConfig = {
    key: row.key,
    agentName: row.agentName,
    type: row.type,
    bin: row.bin,
    label: row.label,
    args: row.args,
    kind: row.kind === "a2a" ? "a2a" : "cli",
    url: row.url ?? undefined,
  };
  if (row.model != null) base.model = row.model;
  if (row.memory === "per-group") base.memory = row.memory;
  if (base.kind === "a2a") {
    base.a2a = { url: row.url ?? "", token: "" };
  }
  return applyEnvOverrides(base);
}

/**
 * 部分更新一条 DB 执行器配置(PATCH /api/executors/:key):只更新传入的字段。
 * key 不可改(由路由层校验);返回更新后的整行,key 不存在返回 undefined。
 */
export async function updateExecutorConfig(
  db: DataBase,
  key: string,
  patch: Partial<
    Pick<
      AddExecutorConfigInput,
      "agentName" | "bin" | "args" | "label" | "model" | "memory"
    >
  >,
): Promise<ExecutorConfigRow | undefined> {
  const values: Record<string, unknown> = {};
  if (patch.agentName !== undefined) values.agentName = patch.agentName;
  if (patch.bin !== undefined) values.bin = patch.bin;
  if (patch.args !== undefined) values.args = patch.args;
  if (patch.label !== undefined) values.label = patch.label;
  if (patch.model !== undefined) values.model = patch.model ?? null;
  if (patch.memory !== undefined) values.memory = patch.memory ?? null;

  const [row] = await db
    .update(executorConfigTable)
    .set(values)
    .where(eq(executorConfigTable.key, key))
    .returning();
  invalidateExecutorsCache();
  return row;
}

/** 完整执行器集合 = 内置默认 + DB 配置(合并,DB 行追加在默认之后)。 */
export async function effectiveExecutors(
  db: DataBase,
): Promise<ExecutorConfig[]> {
  if (
    cachedEffectiveExecutors &&
    Date.now() - cachedEffectiveExecutorsAt < EXECUTORS_CACHE_TTL_MS
  ) {
    return cachedEffectiveExecutors;
  }
  const rows = await listExecutorConfigs(db);
  cachedEffectiveExecutors = [...defaultExecutors(), ...rows.map(rowToConfig)];
  cachedEffectiveExecutorsAt = Date.now();
  return cachedEffectiveExecutors;
}

/** 按 participant 表 name 匹配执行器配置(audienceRef → participant.name → executor)。 */
export async function findExecutorByParticipantName(
  db: DataBase,
  participantName: string,
): Promise<ExecutorConfig | undefined> {
  const all = await effectiveExecutors(db);
  return all.find((ex) => ex.agentName === participantName);
}

/** 按 key 取执行器配置。 */
export async function findExecutorByKey(
  db: DataBase,
  key: string,
): Promise<ExecutorConfig | undefined> {
  const all = await effectiveExecutors(db);
  return all.find((ex) => ex.key === key);
}

/* ---------------- 调度策略(dispatch-policy.json) ---------------- */

/** 失败自动重试策略(触发条件:exit≠0 / 超时 / 静默)。 */
export interface RetryPolicy {
  /** 最大重试次数(0 = 不重试);认领超时 / 手动停止 / 验收失败不重试。 */
  maxRetries: number;
  /** 重试前是否回滚 checkpoint 恢复工作树到任务前快照。 */
  resetWorkspace: boolean;
  /** 重试时是否换执行器;当前仅实现同一执行器重跑(false)。 */
  switchExecutor: boolean;
}

/** 额度/速率限制策略(票7):失败关键词命中 → 执行器进入冷却,冷却期不派任务。 */
export interface RateLimitPolicy {
  /** 失败原因文本命中任一关键词即归类「额度失败」(大小写不敏感)。 */
  detectPatterns: string[];
  /** 额度失败后执行器冷却时长(分钟);冷却期内不向该执行器派发新任务。 */
  cooldownMinutes: number;
  /** 冷却期备用执行器 key;当前只读配置,不实现换执行器(留接口,后续可做)。 */
  fallbackExecutor: string | null;
}

/** 调度策略:并行组上限 + 任务可靠性超时(静默/认领)+ 失败重试 + 额度冷却。 */
export interface DispatchPolicy {
  /** 最大并行组数:同一 project_path 的组内串行,不同组并行,并行组数不超过此值。 */
  maxParallelGroups: number;
  /** 无进展提醒(分钟):running 任务连续无输出超过该值 → 提醒协调者(发群消息
   *  + 任务行警示标记,不失败);静默继续到 stallTimeoutMinutes 才标 failed。 */
  stallAlertMinutes: number;
  /** 静默超时(分钟):running 任务连续无输出超过该值 → 视为失联,标 failed。 */
  stallTimeoutMinutes: number;
  /** 认领超时(分钟):queued 任务超过该值仍未进入 running → 标 failed。 */
  claimTimeoutMinutes: number;
  /** A2A 无进展超时(分钟):running 的 A2A 任务连续无任何进展信号(执行器 participant
   *  在群里的消息)超过该值 → 判「无进展失败」;有进展信号则顺延。 */
  a2aSilenceTimeoutMinutes: number;
  /** detached 超时(分钟):ReplyMode: detached 任务发送后执行器超过该时长仍未
   *  PATCH 回写终态 → 按「结果未确认」处理。 */
  detachedTimeoutMinutes: number;
  /** 失败自动重试策略。 */
  retry: RetryPolicy;
  /** 额度/速率限制失败后的冷却调度策略。 */
  rateLimit: RateLimitPolicy;
}

/** 默认最大并行组数(dispatch-policy.json 缺失时兜底)。 */
const DEFAULT_MAX_PARALLEL_GROUPS = 2;

/** 默认无进展提醒(分钟);缺失/非法时兜底。 */
export const DEFAULT_STALL_ALERT_MINUTES = 15;

/** 默认静默超时(分钟);缺失/非法时兜底。 */
export const DEFAULT_STALL_TIMEOUT_MINUTES = 30;

/** 默认认领超时(分钟);缺失/非法时兜底。 */
export const DEFAULT_CLAIM_TIMEOUT_MINUTES = 30;

/** 默认 A2A 无进展超时(分钟);缺失/非法时兜底。 */
export const DEFAULT_A2A_SILENCE_TIMEOUT_MINUTES = 30;

/** 默认 detached 超时(分钟,24 小时);缺失/非法时兜底。 */
export const DEFAULT_DETACHED_TIMEOUT_MINUTES = 1440;

/** 默认重试策略:重试 1 次、重试前回滚工作区、同一执行器重跑。 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 1,
  resetWorkspace: true,
  switchExecutor: false,
};

/** 默认额度策略:关键词覆盖中英文常见额度/限流文案,冷却 5 小时。 */
export const DEFAULT_RATE_LIMIT_POLICY: RateLimitPolicy = {
  detectPatterns: [
    "rate limit",
    "quota",
    "429",
    "额度",
    "次数限制",
    "limit reached",
    "too many requests",
  ],
  cooldownMinutes: 300,
  fallbackExecutor: null,
};

/** 策略文件路径:env COAGENTHUB_DISPATCH_POLICY_FILE 可覆盖(测试写临时文件)。 */
function resolveDispatchPolicyFile(): string {
  return (
    process.env.COAGENTHUB_DISPATCH_POLICY_FILE ??
    resolve(process.cwd(), "scripts/dispatch-policy.json")
  );
}

/** 数值字段解析:正整数才生效,否则用给定默认值。 */
function positiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : fallback;
}

/** 非负整数解析(重试次数可配 0 = 不重试)。 */
function nonNegativeInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/**
 * 读取调度策略(server 启动时调用):scripts/dispatch-policy.json 随代码
 * 版本化,缺失/损坏/数值非法时回退默认值(不因配置问题阻塞启动)。
 */
export function readDispatchPolicy(): DispatchPolicy {
  try {
    const raw = JSON.parse(
      readFileSync(resolveDispatchPolicyFile(), "utf8"),
    ) as {
      maxParallelGroups?: unknown;
      stallAlertMinutes?: unknown;
      stallTimeoutMinutes?: unknown;
      claimTimeoutMinutes?: unknown;
      a2aSilenceTimeoutMinutes?: unknown;
      detachedTimeoutMinutes?: unknown;
      retry?: {
        maxRetries?: unknown;
        resetWorkspace?: unknown;
        switchExecutor?: unknown;
      };
      rateLimit?: {
        detectPatterns?: unknown;
        cooldownMinutes?: unknown;
        fallbackExecutor?: unknown;
      };
    };
    // 额度关键词:只取非空字符串;显式空数组 = 关闭额度检测(不兜底默认值)。
    const rawPatterns = Array.isArray(raw.rateLimit?.detectPatterns)
      ? raw.rateLimit.detectPatterns.filter(
          (p): p is string => typeof p === "string" && p.trim().length > 0,
        )
      : DEFAULT_RATE_LIMIT_POLICY.detectPatterns;
    const rawFallback = raw.rateLimit?.fallbackExecutor;
    return {
      maxParallelGroups: positiveInt(
        raw.maxParallelGroups,
        DEFAULT_MAX_PARALLEL_GROUPS,
      ),
      stallAlertMinutes: positiveInt(
        raw.stallAlertMinutes,
        DEFAULT_STALL_ALERT_MINUTES,
      ),
      stallTimeoutMinutes: positiveInt(
        raw.stallTimeoutMinutes,
        DEFAULT_STALL_TIMEOUT_MINUTES,
      ),
      claimTimeoutMinutes: positiveInt(
        raw.claimTimeoutMinutes,
        DEFAULT_CLAIM_TIMEOUT_MINUTES,
      ),
      a2aSilenceTimeoutMinutes: positiveInt(
        raw.a2aSilenceTimeoutMinutes,
        DEFAULT_A2A_SILENCE_TIMEOUT_MINUTES,
      ),
      detachedTimeoutMinutes: positiveInt(
        raw.detachedTimeoutMinutes,
        DEFAULT_DETACHED_TIMEOUT_MINUTES,
      ),
      retry: {
        maxRetries: nonNegativeInt(
          raw.retry?.maxRetries,
          DEFAULT_RETRY_POLICY.maxRetries,
        ),
        resetWorkspace:
          typeof raw.retry?.resetWorkspace === "boolean"
            ? raw.retry.resetWorkspace
            : DEFAULT_RETRY_POLICY.resetWorkspace,
        switchExecutor:
          typeof raw.retry?.switchExecutor === "boolean"
            ? raw.retry.switchExecutor
            : DEFAULT_RETRY_POLICY.switchExecutor,
      },
      rateLimit: {
        detectPatterns: rawPatterns,
        cooldownMinutes: positiveInt(
          raw.rateLimit?.cooldownMinutes,
          DEFAULT_RATE_LIMIT_POLICY.cooldownMinutes,
        ),
        fallbackExecutor:
          typeof rawFallback === "string" && rawFallback.trim().length > 0
            ? rawFallback
            : null,
      },
    };
  } catch {
    // 文件缺失/不可读/非 JSON → 默认。
  }
  return {
    maxParallelGroups: DEFAULT_MAX_PARALLEL_GROUPS,
    stallAlertMinutes: DEFAULT_STALL_ALERT_MINUTES,
    stallTimeoutMinutes: DEFAULT_STALL_TIMEOUT_MINUTES,
    claimTimeoutMinutes: DEFAULT_CLAIM_TIMEOUT_MINUTES,
    a2aSilenceTimeoutMinutes: DEFAULT_A2A_SILENCE_TIMEOUT_MINUTES,
    detachedTimeoutMinutes: DEFAULT_DETACHED_TIMEOUT_MINUTES,
    retry: DEFAULT_RETRY_POLICY,
    rateLimit: DEFAULT_RATE_LIMIT_POLICY,
  };
}

/**
 * 注册单个执行器配置对应的 participant(幂等,按 name 判重,以 participant
 * 表为唯一事实源)。token 认证已移除:不再生成/持久化 token。返回是否真的
 * 新建了 participant。供 ensureExecutorParticipants 与 POST /api/executors 复用。
 */
export async function registerExecutorParticipant(
  db: DataBase,
  ex: ExecutorConfig,
  device?: string,
): Promise<boolean> {
  const [existing] = await db
    .select({ name: participantTable.name })
    .from(participantTable)
    .where(eq(participantTable.name, ex.agentName))
    .limit(1);
  if (existing) return false;

  await db.insert(participantTable).values({
    name: ex.agentName,
    device: device ?? (ex.kind === "a2a" ? "remote" : "mac"),
    tokenHash: "",
    capabilities: [],
  });
  console.log(`[executors] 已注册 participant: ${ex.agentName}`);
  return true;
}

/**
 * 开机自注册:把执行器配置(内置 + DB 配置)对应的 participant 补进
 * participant 表(幂等,按 name 判重)。桥已退役,注册职责由 server 承担。
 */
export async function ensureExecutorParticipants(db: DataBase): Promise<void> {
  // Pre-create the default LAN observer so anonymous access has a stable id.
  await resolveLocalUser(db);

  for (const ex of await effectiveExecutors(db)) {
    await registerExecutorParticipant(db, ex);
  }
}
