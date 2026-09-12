import type { ExecutorConfig } from "@server/lib/executors";

/**
 * 执行器是否返回并发冲突(`403 atomgit_session_concurrency_conflict`):AtomCode
 * 等执行器同一时间只能跑一个会话,并发时 CLI 以该错误退出。命中 → 不判任务
 * 失败,转为 queued,等既有 running 任务终态后自动重试(反应式排队)。
 * 大小写不敏感;匹配带 403 前缀或独立 token 两种写法。
 */
export function isConcurrencyConflict(text: string): boolean {
  return /403\s*atomgit_session_concurrency_conflict|atomgit_session_concurrency_conflict/i.test(
    text ?? "",
  );
}

/** 根据 spawn 失败的实际错误串给出可操作的排查方向。 */
export function spawnFailureHint(msg: string): string {
  if (
    /unexpected argument|unrecognized|cannot be used with|invalid value/i.test(
      msg,
    )
  ) {
    return "；执行器参数配置可能与当前 CLI 版本不匹配，请核对 executors.ts 中的内置配置";
  }
  if (/ENOENT|command not found/i.test(msg)) {
    return "；执行器可能未安装或不在 PATH，请使用 which <bin> 确认或配置绝对路径";
  }
  if (/EACCES|permission denied/i.test(msg)) {
    return "；执行器文件可能没有可执行权限，请检查可执行位";
  }
  return "";
}

export function spawnFailureStatus(ex: ExecutorConfig, msg: string): string {
  return `❌ [${ex.label}] 任务失败: 无法启动 ${ex.bin} (${msg})${spawnFailureHint(msg)}`;
}

export function spawnFailureReason(msg: string): string {
  return `${msg}${spawnFailureHint(msg)}`;
}

export function formatExecutorStartupFailure(bin: string, msg: string): string {
  return `无法启动 ${bin} (${msg})${spawnFailureHint(msg)}`;
}
