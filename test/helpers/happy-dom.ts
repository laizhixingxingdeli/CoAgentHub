/**
 * 静态 import 'happy-dom' 会在装载阶段就抛，零依赖检出的 node --test 整文件变红。
 * 动态 import 才能在缺包时导出跳过原因。缺的不是 happy-dom（装了但自身依赖缺失）必须照抛，
 * 否则 CI 的 platform-dom 也会静默跳过。
 */

const SKIP_REASON =
  '没装 happy-dom，零依赖全量里跳过 DOM 测试，CI 的 platform-dom 任务装了依赖会跑';

export let Window: (new (...args: never[]) => unknown) | undefined;
export let noHappyDom: string | false = SKIP_REASON;

function missingHappyDom(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  // 只认「缺的包就是 happy-dom」。已安装的 happy-dom 缺别的包时，message 是
  // Cannot find package '别的包' imported from .../happy-dom/...，不能当成没装。
  return code === 'ERR_MODULE_NOT_FOUND'
    && error.message.includes("Cannot find package 'happy-dom'");
}

try {
  const loaded = await import('happy-dom');
  Window = loaded.Window;
  noHappyDom = false;
} catch (error) {
  if (!missingHappyDom(error)) throw error;
}
