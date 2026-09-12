/**
 * 后台工作登记处(报告 T3):表达「已接收的工作都做完了」,而不是
 * 「当前 Map 看起来为空」。
 *
 * trackBackgroundWork 在调用 fn() **之前**同步登记,finally 解除。
 * 父子交接:子工作必须在父的 track finally 解除之前登记 —— 典型做法是
 * 父 fn 的 finally 里同步 requestPump()/启动子 run,因为 fn 的 finally 早于
 * track 的 finally。
 */

export type BackgroundWorkItem = { label: string; sinceMs: number };

export type DrainResult = {
  ok: boolean;
  pending: BackgroundWorkItem[];
};

type InternalEntry = {
  label: string;
  startedAt: number;
  promise: Promise<unknown>;
};

const pending = new Set<InternalEntry>();

function snapshotOf(now = Date.now()): BackgroundWorkItem[] {
  return [...pending].map((e) => ({
    label: e.label,
    sinceMs: now - e.startedAt,
  }));
}

/**
 * 同步登记 label,再跑 fn;无论成功失败 finally 解除。
 * label 须可定位(含 taskId / messageId 与操作类别)。
 */
export function trackBackgroundWork<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const entry: InternalEntry = {
    label,
    startedAt: Date.now(),
    promise: Promise.resolve(),
  };
  pending.add(entry);
  let work: Promise<T>;
  try {
    work = fn();
  } catch (err) {
    pending.delete(entry);
    throw err;
  }
  const tracked = work.finally(() => {
    pending.delete(entry);
  });
  entry.promise = tracked;
  return tracked;
}

/** 当前未完成的后台工作快照(label + 已持续 ms)。 */
export function backgroundWorkSnapshot(): BackgroundWorkItem[] {
  return snapshotOf();
}

/**
 * 等到全部已登记工作完成,或超时。
 * 无后台工作时立即返回 { ok: true } —— 不固定空闲等待。
 */
export async function drainBackgroundWork(opts: {
  timeoutMs: number;
}): Promise<DrainResult> {
  const deadline = Date.now() + Math.max(0, opts.timeoutMs);

  for (;;) {
    if (pending.size === 0) {
      return { ok: true, pending: [] };
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { ok: false, pending: snapshotOf() };
    }
    const inflight = [...pending].map((e) => e.promise);
    await Promise.race([
      Promise.allSettled(inflight),
      new Promise<void>((resolve) => setTimeout(resolve, remaining)),
    ]);
  }
}

/** 测试用:清空登记(不取消底层工作)。生产路径不要调用。 */
export function __resetBackgroundWorkForTests(): void {
  pending.clear();
}
