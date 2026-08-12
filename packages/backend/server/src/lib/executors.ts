import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { agent as agentTable } from "@laizhixingxingdeli/database/schema";
import { generateAgentToken, hashAgentToken } from "./agent-token";
import type { DataBase } from "./database";

/**
 * 执行器配置(server 单一来源):每一条对应「一个 AI 工具 = 一个 agent 身份」。
 * server 在 POST /groups/:id/messages 检测 audience=agent 且 audienceRef 命中
 * 本配置(按 agent.name === agentName 匹配)时创建 task 并 spawn 执行器;
 * 开机时由 ensureExecutorAgents 幂等注册对应 agent。
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

/** env 覆盖:cli 的 bin 用 EXECUTOR_BIN_<KEY 大写>(如 EXECUTOR_BIN_CODEBUDDY);
 *  a2a 的 url 用 COAGENTHUB_WIN_A2A_URL 覆盖(测试指向本地 mock),token 一律从
 *  COAGENTHUB_WIN_A2A_TOKEN 读,不硬编码进源码。 */
function effectiveExecutors(): ExecutorConfig[] {
  return DEFAULT_EXECUTORS.map((ex) => {
    if (ex.kind === "a2a" && ex.a2a) {
      return {
        ...ex,
        a2a: {
          url: process.env.COAGENTHUB_WIN_A2A_URL ?? ex.a2a.url,
          token: process.env.COAGENTHUB_WIN_A2A_TOKEN ?? ex.a2a.token,
        },
      };
    }
    const override = process.env[`EXECUTOR_BIN_${ex.key.toUpperCase()}`];
    return override ? { ...ex, bin: override } : ex;
  });
}

export const EXECUTORS: ExecutorConfig[] = effectiveExecutors();

/** 按 agent 表 name 匹配执行器配置(audienceRef → agent.name → executor)。 */
export function findExecutorByAgentName(
  agentName: string,
): ExecutorConfig | undefined {
  return EXECUTORS.find((ex) => ex.agentName === agentName);
}

/** 按 key 取执行器配置。 */
export function findExecutorByKey(key: string): ExecutorConfig | undefined {
  return EXECUTORS.find((ex) => ex.key === key);
}

/**
 * 开机自注册:把执行器配置(含 hermes)对应的 agent 补进 agent 表(幂等,
 * 按 name 判重)。桥已退役,注册职责由 server 承担——token 明文只写一次到
 * scripts/.executor-agents.json(已 gitignore),DB 里只存 SHA-256。
 */
export async function ensureExecutorAgents(
  db: DataBase,
  stateFile = resolve(process.cwd(), "scripts/.executor-agents.json"),
): Promise<void> {
  const rows = await db.select({ name: agentTable.name }).from(agentTable);
  const existing = new Set(rows.map((r) => r.name));

  let state: Record<string, string> = {};
  try {
    state = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    // first run — no state yet
  }
  let dirty = false;

  for (const ex of effectiveExecutors()) {
    if (existing.has(ex.agentName) || state[ex.agentName]) {
      continue;
    }
    const token = generateAgentToken();
    await db.insert(agentTable).values({
      name: ex.agentName,
      type: ex.type,
      device: ex.kind === "a2a" ? "remote" : "mac",
      tokenHash: hashAgentToken(token),
      capabilities: [],
    });
    state[ex.agentName] = token;
    dirty = true;
    console.log(`[executors] 已注册 agent: ${ex.agentName}`);
  }

  if (dirty) {
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, JSON.stringify(state, null, 2));
  }
}
