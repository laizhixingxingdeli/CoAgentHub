import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  agent as agentTable,
  executorConfig as executorConfigTable,
} from "@laizhixingxingdeli/database/schema";
import { asc, eq } from "drizzle-orm";
import { generateAgentToken, hashAgentToken } from "./agent-token";
import type { DataBase } from "./database";
import { resolveLocalUser } from "./local-agent";

/**
 * 执行器配置(server 单一来源):每一条对应「一个 AI 工具 = 一个 agent 身份」。
 * server 在 POST /groups/:id/messages 检测 audience=agent 且 audienceRef 命中
 * 本配置(按 agent.name === agentName 匹配)时创建 task 并 spawn 执行器;
 * 开机时由 ensureExecutorAgents 幂等注册对应 agent。
 *
 * 完整集合 = 内置默认(DEFAULT_EXECUTORS)+ DB 持久化配置(executor_config 表,
 * 经「接入 Agent」界面写入),见 effectiveExecutors(db)。
 *
 * bin 可用环境变量覆盖(测试/本机路径差异):EXECUTOR_BIN_<KEY 大写> 优先,
 * 回退到配置默认值。
 */

export interface ExecutorConfig {
  /** 唯一 key,写入 task.executor_key,标记任务由哪个执行器跑。 */
  key: string;
  /** agent 展示名;与 agent 表 name 匹配用(桥注册的 agent 名)。 */
  agentName: string;
  type: string;
  bin: string;
  label: string;
  args: string[];
  /**
   * 运行方式:cli=本地 spawn(默认,现有三条);a2a=经 A2A gateway 远程调用
   * 其他设备上的 agent(如 Windows 上的 hermes),server 不 spawn 本地进程。
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
    type: "agent",
    bin: "atomcode",
    label: "atomcode",
    args: ["-y", "-p", "{ticket}"],
  },
  {
    key: "reasonix",
    agentName: "Reasoning 执行器",
    type: "agent",
    bin: "reasonix",
    label: "reasonix",
    args: ["run", "-y", "{ticket}"],
  },
  {
    key: "codebuddy",
    agentName: "CodeBuddy 执行器",
    type: "agent",
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

/* ---------------- DB 持久化配置(接入 Agent 界面) ---------------- */

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

/** 新增一条 DB 执行器配置的入参(key/agent_name 唯一,冲突抛错由路由转 409)。 */
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

/** 按 agent 表 name 匹配执行器配置(audienceRef → agent.name → executor)。 */
export async function findExecutorByAgentName(
  db: DataBase,
  agentName: string,
): Promise<ExecutorConfig | undefined> {
  const all = await effectiveExecutors(db);
  return all.find((ex) => ex.agentName === agentName);
}

/** 按 key 取执行器配置。 */
export async function findExecutorByKey(
  db: DataBase,
  key: string,
): Promise<ExecutorConfig | undefined> {
  const all = await effectiveExecutors(db);
  return all.find((ex) => ex.key === key);
}

/** 状态文件路径:env EXECUTOR_STATE_FILE 可覆盖(测试写临时目录,避免污染
 *  仓库内 scripts/.executor-agents.json)。 */
function resolveStateFile(): string {
  return (
    process.env.EXECUTOR_STATE_FILE ??
    resolve(process.cwd(), "scripts/.executor-agents.json")
  );
}

/**
 * 注册单个执行器配置对应的 agent(幂等,按 name 判重,以 agent 表为唯一
 * 事实源):新建时生成 token 并写 state 文件(明文只落一次,DB 存 SHA-256)。
 * 返回是否真的新建了 agent。供 ensureExecutorAgents 与 POST /api/executors 复用。
 */
export async function registerExecutorAgent(
  db: DataBase,
  ex: ExecutorConfig,
  stateFile = resolveStateFile(),
  device?: string,
): Promise<boolean> {
  const [existing] = await db
    .select({ name: agentTable.name })
    .from(agentTable)
    .where(eq(agentTable.name, ex.agentName))
    .limit(1);
  if (existing) return false;

  const token = generateAgentToken();
  await db.insert(agentTable).values({
    name: ex.agentName,
    type: ex.type,
    device: device ?? (ex.kind === "a2a" ? "remote" : "mac"),
    tokenHash: hashAgentToken(token),
    capabilities: [],
  });
  let state: Record<string, string> = {};
  try {
    state = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    // first run — no state yet
  }
  state[ex.agentName] = token;
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state, null, 2));
  console.log(`[executors] 已注册 agent: ${ex.agentName}`);
  return true;
}

/**
 * 开机自注册:把执行器配置(内置 + DB 配置)对应的 agent 补进 agent 表(幂等,
 * 按 name 判重)。桥已退役,注册职责由 server 承担——token 明文只写一次到
 * scripts/.executor-agents.json(已 gitignore),DB 里只存 SHA-256。
 */
export async function ensureExecutorAgents(
  db: DataBase,
  stateFile = resolveStateFile(),
): Promise<void> {
  // Pre-create the default LAN observer so anonymous access has a stable id.
  await resolveLocalUser(db);

  for (const ex of await effectiveExecutors(db)) {
    await registerExecutorAgent(db, ex, stateFile);
  }
}
