import type { ExecutorOutputParser } from "../output-parser";
import type { TokenUsage, TokenUsageCollectionInput } from "../token-usage";

/**
 * 执行器适配器：把「按 executor key 分支」收敛成一次查表(spec:
 * executor-adapter-registry)。三个方法全部可选,缺省落到现有的通用实现——
 * 这是硬要求:`claude` 今天只有 token 专用实现,parser 与 finalText 走通用,
 * 接口若强制全实现就会逼出凑数的空实现,漂移换个地方继续(spec R1)。
 */
export interface ExecutorAdapter {
  /** 缺省 = 通用语义解析器(createGenericParser)。 */
  createParser?(): ExecutorOutputParser;
  /** 缺省 = 不提供专用采集(直接走通用扫描)。返回 undefined 同样降级到通用扫描。 */
  collectTokenUsage?(input: TokenUsageCollectionInput): TokenUsage | undefined;
  /** 缺省 = extractGenericJsonlText。 */
  extractFinalText?(stdout: string): string | undefined;
}
