/**
 * 泵送信号:把「可能有活了,去看看」从对 `pumpQueue` 的直接回边解耦成
 * fire-and-forget 信号。冷却族 / 额度族搬走后只依赖本模块,不反向 import queue。
 *
 * 默认不是静默 no-op:未注册时暂存并告警,注册时补发 —— 丢信号 = 任务静默
 * 不再派发,必须可观测(见 specs/queue-ts-decomposition-design.md §5)。
 */

let pump: (() => void) | null = null;
let missed = false;

/** 调度器在模块加载时注册真正的泵。 */
export function registerPump(fn: () => void): void {
  pump = fn;
  if (missed) {
    missed = false;
    fn(); // 补发注册前丢掉的信号
  }
}

/** 「可能有活了」——发信号,不等待。 */
export function requestPump(): void {
  if (pump) {
    pump();
    return;
  }
  missed = true;
  console.warn("[executor] pump 尚未注册,信号已暂存,将在注册时补发");
}

/** 可观测:是否已注册 / 是否有暂存信号。 */
export function pumpSignalStatus(): { registered: boolean; missed: boolean } {
  return { registered: pump !== null, missed };
}

/**
 * 测试用:临时回到未注册态,跑完后原样恢复(含既有 pump 与 missed)。
 * 生产路径不要调用。
 */
export function __withUnregisteredPumpForTests(run: () => void): void {
  const prevPump = pump;
  const prevMissed = missed;
  pump = null;
  missed = false;
  try {
    run();
  } finally {
    pump = prevPump;
    missed = prevMissed;
  }
}
