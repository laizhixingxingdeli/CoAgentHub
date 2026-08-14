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
   * 运行方式:cli=本地 spawn(默认,现有三条);a2a=经 A2A gateway 远程调用
   * 其他设备上的 participant(如 Windows 上的 hermes),server 不 spawn 本地进程。
   */
  kind?: "cli" | "a2a";
  /** a2a 的 gateway 基地址(DB 配置存 url 列,与 a2a.url 并存;runner 读 a2a.url)。 */
  url?: string;
  /** kind="a2a" 时的 gateway 信息;token 从 env 读(COAGENTHUB_WIN_A2A_TOKEN),不硬编码。 */
  a2a?: {
    /** gateway 基地址;env COAGENTHUB_WIN_A2A_URL 可覆盖(测试指向 mock)。 */
    url: string;
    /** Authorization: Bearer 用的 token。 */
    token: string;
  };
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
  },
  {
    key: "reasonix",
    agentName: "Reasoning 执行器",
    type: "participant",
    bin: "reasonix",
    label: "reasonix",
    args: ["run", "-y", "{ticket}"],
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
    })
    .returning();
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
  if (base.kind === "a2a") {
    base.a2a = { url: row.url ?? "", token: "" };
  }
  return applyEnvOverrides(base);
}

/** 完整执行器集合 = 内置默认 + DB 配置(合并,DB 行追加在默认之后)。 */
export async function effectiveExecutors(
  db: DataBase,
): Promise<ExecutorConfig[]> {
  const rows = await listExecutorConfigs(db);
  return [...defaultExecutors(), ...rows.map(rowToConfig)];
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
  /** 静默超时(分钟):running 任务连续无输出超过该值 → 视为失联,标 failed。 */
  stallTimeoutMinutes: number;
  /** 认领超时(分钟):queued 任务超过该值仍未进入 running → 标 failed。 */
  claimTimeoutMinutes: number;
  /** 失败自动重试策略。 */
  retry: RetryPolicy;
  /** 额度/速率限制失败后的冷却调度策略。 */
  rateLimit: RateLimitPolicy;
}

/** 默认最大并行组数(dispatch-policy.json 缺失时兜底)。 */
const DEFAULT_MAX_PARALLEL_GROUPS = 2;

/** 默认静默超时(分钟);缺失/非法时兜底。 */
export const DEFAULT_STALL_TIMEOUT_MINUTES = 30;

/** 默认认领超时(分钟);缺失/非法时兜底。 */
export const DEFAULT_CLAIM_TIMEOUT_MINUTES = 30;

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
      stallTimeoutMinutes?: unknown;
      claimTimeoutMinutes?: unknown;
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
      stallTimeoutMinutes: positiveInt(
        raw.stallTimeoutMinutes,
        DEFAULT_STALL_TIMEOUT_MINUTES,
      ),
      claimTimeoutMinutes: positiveInt(
        raw.claimTimeoutMinutes,
        DEFAULT_CLAIM_TIMEOUT_MINUTES,
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
    stallTimeoutMinutes: DEFAULT_STALL_TIMEOUT_MINUTES,
    claimTimeoutMinutes: DEFAULT_CLAIM_TIMEOUT_MINUTES,
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
