/**
 * 运行时双侧诊断（平台侧 / 上游侧）的平台侧收口。
 *
 * 为什么要它：`endedBy` 是**一个**值，平台不可达优先，于是「平台连不上」的同时
 * 「上游报了配额耗尽」这件事在结束码上就看不见了。适配层已经把它们分成两栏报
 * 回来（`runtimeDiagnostics.platform` / `.upstream`），平台要做的只是把两栏
 * **各自的固定词**落进 Activity。
 *
 * 为什么只落固定词：这条链路的上游是 agent 进程，agent 读得到本机一切东西。
 * 一旦允许把任意 `message` / `stack` / URL / 请求体写进状态文件，一次 `env`
 * 或者一段上游响应体就会永久留在平台状态里。所以这一层只做**白名单投影**：
 * `platform.code` 只认 `platform_unreachable`，`upstream.category` 只认下面这张
 * 表；其余键一律**逐字丢弃**，不 spread、不深拷贝。适配层本地仍可以保留已脱敏的
 * `message` 给人看，但它不进平台状态。
 *
 * 为什么复制而不是 import 适配层的枚举：平台不认识适配包（那是依赖倒置的反向）。
 * 这里复制的是**通用协议**里的有限词汇，不是实现细节。
 */

/**
 * 上游失败类别。与 `adapters/pi/src/failure-classify.ts` 的
 * `UpstreamFailureCategory` 取值一致——这是平台与适配层共同遵守的协议词表，
 * 两边各自声明、互不 import。**加词要两边一起加**，否则适配层新报的类别会被
 * 这一层静默丢掉（丢掉是安全侧默认，但会看不见）。
 */
export const RUNTIME_DIAGNOSTIC_UPSTREAM_CATEGORIES = [
  'model_not_found',
  'credentials',
  'rate_limited',
  'quota_exhausted',
  'network',
  'content_blocked',
  'unknown',
] as const;

export type RuntimeDiagnosticUpstreamCategory =
  (typeof RUNTIME_DIAGNOSTIC_UPSTREAM_CATEGORIES)[number];

/** 平台侧只承认「连不上平台自己」这一条可判定事实。 */
export const RUNTIME_DIAGNOSTIC_PLATFORM_CODES = ['platform_unreachable'] as const;

export type RuntimeDiagnosticPlatformCode =
  (typeof RUNTIME_DIAGNOSTIC_PLATFORM_CODES)[number];

/** 落盘形状（v1）。只有固定词，没有文案/堆栈/URL。 */
export interface RuntimeDiagnosticsV1 {
  readonly platform?: { readonly code: RuntimeDiagnosticPlatformCode };
  readonly upstream?: { readonly category: RuntimeDiagnosticUpstreamCategory };
}

const UPSTREAM_CATEGORY_SET: ReadonlySet<string> = new Set(RUNTIME_DIAGNOSTIC_UPSTREAM_CATEGORIES);
const PLATFORM_CODE_SET: ReadonlySet<string> = new Set(RUNTIME_DIAGNOSTIC_PLATFORM_CODES);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/** 只读 `code` 一个键：其余键（message/stack/url/请求体）连读都不读。 */
function projectPlatform(value: unknown): RuntimeDiagnosticsV1['platform'] | undefined {
  if (!isPlainObject(value)) return undefined;
  const code = value.code;
  if (typeof code !== 'string' || !PLATFORM_CODE_SET.has(code)) return undefined;
  return { code: code as RuntimeDiagnosticPlatformCode };
}

/** 只读 `category` 一个键：适配层带上来的 `message` 到此为止。 */
function projectUpstream(value: unknown): RuntimeDiagnosticsV1['upstream'] | undefined {
  if (!isPlainObject(value)) return undefined;
  const category = value.category;
  if (typeof category !== 'string' || !UPSTREAM_CATEGORY_SET.has(category)) return undefined;
  return { category: category as RuntimeDiagnosticUpstreamCategory };
}

/**
 * 把不可信诊断收成 v1 白名单。**失败返回 undefined，调用方照常收尾。**
 *
 * 两栏各自独立校验：平台栏畸形不影响上游栏落盘（两件事本来没有因果关系，
 * 一栏坏掉就整段丢掉等于让一次畸形输入吞掉另一侧的真实事实）。两栏都收不出
 * 东西时整个字段缺席——**不写空对象**，否则「有诊断」和「诊断全是空」分不开。
 *
 * 未知键一律投影掉，不当成整段作废：适配层本来就会带 `message`，为了一个多余
 * 的键把真实类别一起丢掉，等于让排障信息消失得没有理由。
 *
 * 错误路径不回显输入：输入里可能夹着路径/正文/凭据。
 */
export function sanitizeRuntimeDiagnostics(input: unknown): RuntimeDiagnosticsV1 | undefined {
  if (input === undefined) return undefined;
  if (!isPlainObject(input)) return undefined;
  const platform = projectPlatform(input.platform);
  const upstream = projectUpstream(input.upstream);
  if (platform === undefined && upstream === undefined) return undefined;
  return {
    ...(platform !== undefined ? { platform } : {}),
    ...(upstream !== undefined ? { upstream } : {}),
  };
}
