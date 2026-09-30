/**
 * DecisionProvider composition factory（SHADOW only）。
 *
 * OFF：立即返回 undefined，且不得读取 API key / timeout / body / model。
 * SHADOW：显式 env + 可注入 fetch → Jev HTTP transport + JevDecisionProvider。
 */

import type { DecisionMode } from './decision-mode.ts';
import type { DecisionProvider, PostExecutionEvaluator } from './ports.ts';
import { JevPostExecutionEvaluator } from './jev-post-execution-evaluator.ts';
import { JevDecisionProvider } from './jev-decision-provider.ts';
import { createJevSystemOneHttpTransport } from './jev-system-one-http-transport.ts';

// E3 实测（2026-09-23）：热连接约 300ms，进程里第一次调用 733–1342ms、闲置 20 秒后 729ms。
// 生产里一条 Mission 一个进程、两次派发隔几分钟，调用几乎都是冷的——800ms 会把大部分 shadow
// 调用误杀成超时。1500 盖住实测最坏的 1342ms；代价是 shadow 在派发路径上最坏多等这么久。
const DEFAULT_TIMEOUT_MS = 1500;
const DEFAULT_MAX_BODY_BYTES = 65_536;
const DEFAULT_MODEL = 'jev-latest';
const MAX_TIMEOUT_MS = 60_000;
const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MiB

export interface DecisionProviderFactoryOptions {
  readonly mode: DecisionMode;
  readonly env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  readonly fetch?: typeof globalThis.fetch;
}

function parsePositiveIntEnv(
  raw: string | undefined,
  label: string,
  max: number,
): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = String(raw).trim();
  if (trimmed === '') {
    throw new Error(`${label} must be a positive integer`);
  }
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${label} must be a positive integer`);
  }
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  if (n > max) {
    throw new Error(`${label} exceeds maximum ${max}`);
  }
  return n;
}

/**
 * shadow 模式下 PRE 与 POST 共用的那一份配置与传输：同一把 key、同一个超时、同一个模型。
 * 只在 shadow 时被调用——off 模式不碰任何 decision 相关 env 的性质由两个入口各自先挡。
 */
function shadowTransport(options: DecisionProviderFactoryOptions): {
  transport: ReturnType<typeof createJevSystemOneHttpTransport>;
  model: string;
} {
  const env = options.env;
  const apiKeyRaw = env.TYPESAFE_API_KEY;
  const apiKey = apiKeyRaw == null ? '' : String(apiKeyRaw).trim();
  if (apiKey === '') {
    throw new Error('TYPESAFE_API_KEY is required for shadow DecisionProvider');
  }

  const timeoutMs =
    parsePositiveIntEnv(
      env.COAGENT_DECISION_TIMEOUT_MS,
      'COAGENT_DECISION_TIMEOUT_MS',
      MAX_TIMEOUT_MS,
    ) ?? DEFAULT_TIMEOUT_MS;

  const maxBodyBytes =
    parsePositiveIntEnv(
      env.COAGENT_DECISION_MAX_BODY_BYTES,
      'COAGENT_DECISION_MAX_BODY_BYTES',
      MAX_BODY_BYTES,
    ) ?? DEFAULT_MAX_BODY_BYTES;

  const modelRaw = env.COAGENT_DECISION_MODEL;
  const model =
    modelRaw != null && String(modelRaw).trim() !== ''
      ? String(modelRaw).trim()
      : DEFAULT_MODEL;

  const fetchImpl = options.fetch ?? globalThis.fetch;
  const transport = createJevSystemOneHttpTransport({
    fetch: fetchImpl,
    apiKey,
    timeoutMs,
    maxBodyBytes,
  });
  return { transport, model };
}

/**
 * 按 mode 构造可选 DecisionProvider（PRE_DISPATCH）。
 * mode !== shadow 时立即 undefined，不触碰任何 decision 相关 env。
 */
export function createDecisionProvider(
  options: DecisionProviderFactoryOptions,
): DecisionProvider | undefined {
  if (options.mode !== 'shadow') {
    return undefined;
  }
  const { transport, model } = shadowTransport(options);
  return new JevDecisionProvider({ transport, model });
}

/**
 * 按 mode 构造可选 POST_EXECUTION 评估器（J2）。
 * 与 createDecisionProvider 同一套 env 与传输；mode !== shadow 时立即 undefined，不触碰任何 env。
 */
export function createPostExecutionEvaluator(
  options: DecisionProviderFactoryOptions,
): PostExecutionEvaluator | undefined {
  if (options.mode !== 'shadow') {
    return undefined;
  }
  const { transport, model } = shadowTransport(options);
  return new JevPostExecutionEvaluator({ transport, model });
}
