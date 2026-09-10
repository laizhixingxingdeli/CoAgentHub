/**
 * 执行器配置字段能力表 —— **唯一出处**(specs/executor-config-fields-saved-but-never-honored.md R1)。
 *
 * 文档与 API 文案只引用本模块,禁止在注释/README/architecture 再抄一份取值表
 * (ADR-0008 要治的就是多处定义漂移)。
 *
 * 状态词:
 *  - supported     — 写入后执行路径会消费
 *  - reserved      — 有记录的分期保留,只存不读(不得因本票删除或提前实现)
 *  - unimplemented — schema 仍接受枚举形,但执行路径不消费;新写入必须拒绝
 */

export type ExecutorConfigFieldStatus =
  | "supported"
  | "reserved"
  | "unimplemented";

export type ExecutorInputMode = "path" | "inline" | "at-file" | "stdin";

/**
 * 三类字段能力表(R1 单一出处)。
 *
 * inputMode 按**取值**细分:path/inline/at-file 由 resolveExecutorCliSpawn 消费;
 * stdin 未实现(runner 亦未接 stdin 管道),新写入拒绝。
 */
export const EXECUTOR_CONFIG_FIELD_CAPABILITIES = {
  inputMode: {
    path: "supported",
    inline: "supported",
    "at-file": "supported",
    stdin: "unimplemented",
  },
  /** spawn 时叠加到 process.env 的用户配置 env(单一入口:resolveExecutorCliSpawn)。 */
  env: "supported",
  /** ADR-0008 批 1 分期:只存不读,批 2 画像消费。 */
  outputProfile: "reserved",
} as const satisfies {
  inputMode: Record<ExecutorInputMode, ExecutorConfigFieldStatus>;
  env: ExecutorConfigFieldStatus;
  outputProfile: ExecutorConfigFieldStatus;
};

/** inputMode 当前可写入且会生效的取值(从能力表派生,不另维护清单)。 */
export function supportedInputModes(): ExecutorInputMode[] {
  return (
    Object.entries(EXECUTOR_CONFIG_FIELD_CAPABILITIES.inputMode) as Array<
      [ExecutorInputMode, ExecutorConfigFieldStatus]
    >
  )
    .filter(([, status]) => status === "supported")
    .map(([mode]) => mode);
}

/**
 * 新写入校验:未实现取值返回错误文案;通过返回 null。
 * 存量配置不追溯 —— 只在 POST/PATCH 路径调用本函数。
 */
export function inputModeWriteError(
  mode: string | null | undefined,
): string | null {
  if (mode == null) return null;
  const status =
    EXECUTOR_CONFIG_FIELD_CAPABILITIES.inputMode[mode as ExecutorInputMode] ??
    null;
  if (status === "unimplemented") {
    return (
      `inputMode "${mode}" 尚未实现,保存不会让执行路径生效。` +
      `当前支持: ${supportedInputModes().join(", ")}。` +
      `存量已保存的配置不追溯;请改用已支持取值或 args 占位符。`
    );
  }
  // 未知取值交给 zod 拦;这里不重复。
  return null;
}

/** resolveExecutorCliSpawn 的入参:CLI 执行器 spawn 前的配置解析。 */
export interface ResolveExecutorCliSpawnInput {
  /** args 模板(可含 {ticket}/{ticketContent}/{model})。 */
  argsTemplate: string[];
  model?: string;
  inputMode?: ExecutorInputMode | null;
  env?: Record<string, string> | null;
  ticketPath: string;
  ticketContent: string;
  /**
   * 渲染 {model} 的函数(注入以免本模块反向依赖 executors.ts 的循环;
   * 生产路径传 renderExecutorArgs)。
   */
  renderArgs: (args: string[], model: string | undefined) => string[];
}

/**
 * CLI spawn 解析结果 —— queue/runner 只消费这里,不再各自解读 inputMode/env。
 */
export interface ResolvedExecutorCliSpawn {
  args: string[];
  /**
   * 叠加到 process.env 的用户 env;undefined = 不传 env 选项(Node 默认继承父进程,
   * 与改前行为一致)。
   */
  envOverlay: Record<string, string> | undefined;
  /**
   * 若非 null,runner 应写入子进程 stdin。
   * 当前 stdin inputMode 未实现,恒为 null;入口先留好,实现时只改本函数。
   */
  stdin: string | null;
}

/**
 * **inputMode + env 的单一消费入口**(R3)。
 *
 * - `{ticket}` 按 inputMode 解析:path → 路径 / inline → 正文 / at-file → @路径;
 *   null/缺省与 path 相同(既有占位符路径行为不变)。
 * - `{ticketContent}` **始终**是正文(显式要内容,不随 inputMode 变)。
 * - `{model}` 交给 renderArgs。
 * - env:原样作为 overlay 返回;runner 负责与 process.env 合并。
 * - stdin 取值:未实现。存量若仍是 stdin,降级为 path 并 stdin=null
 *   (不炸运行中任务;新写入已在 API 层拒绝)。
 *
 * ⚠️ 不得在 queue.ts / executor-runner.ts / 适配器里再散落一份 inputMode/env 解读。
 */
export function resolveExecutorCliSpawn(
  input: ResolveExecutorCliSpawnInput,
): ResolvedExecutorCliSpawn {
  const requested = input.inputMode ?? null;
  // 存量 stdin:降级 path,不写 stdin(R2 不追溯)。
  const mode: ExecutorInputMode =
    requested == null ||
    EXECUTOR_CONFIG_FIELD_CAPABILITIES.inputMode[requested] === "unimplemented"
      ? "path"
      : requested;

  const ticketArg =
    mode === "inline"
      ? input.ticketContent
      : mode === "at-file"
        ? `@${input.ticketPath}`
        : input.ticketPath;

  const withTickets = input.argsTemplate.map((a) =>
    a
      .replaceAll("{ticket}", ticketArg)
      .replaceAll("{ticketContent}", input.ticketContent),
  );
  const args = input.renderArgs(withTickets, input.model);

  const envOverlay =
    input.env && Object.keys(input.env).length > 0
      ? { ...input.env }
      : undefined;

  return {
    args,
    envOverlay,
    // stdin 模式未实现:入口返回 null,runner 保持 stdio stdin=ignore。
    stdin: null,
  };
}
