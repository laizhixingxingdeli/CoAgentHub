/**
 * 执行器配置(阶段2-票1):由 scripts/executors.json 搬入 server 的硬编码常量,
 * scripts/ 下的 json 不再作为运行时源(票3 会删除)。每一条对应「一个 AI 工具
 * = 一个 agent 身份」:bridge 时代桥按 agentName 注册 agent 并 @ 到哪个 agent
 * 就调对应 CLI;现在 server 直接在 POST /groups/:id/messages 检测 audience=agent
 * 且 audienceRef 命中本配置(按 agent.name === agentName 匹配)时创建 task 并
 * spawn 执行器。
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
