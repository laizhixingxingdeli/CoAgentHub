/**
 * DecisionProvider composition factory（SHADOW only）。
 *
 * OFF：立即返回 undefined，且不得读取 API key / timeout / body / model。
 * SHADOW：显式 env + 可注入 fetch → Jev HTTP transport + JevDecisionProvider。
 */

import type { DecisionMode } from './decision-mode.ts';
import type { DecisionProvider } from './ports.ts';
import { JevDecisionProvider } from './jev-decision-provider.ts';
import { createJevSystemOneHttpTransport } from './jev-system-one-http-transport.ts';

const DEFAULT_TIMEOUT_MS = 800;
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
 * 按 mode 构造可选 DecisionProvider。
 * mode !== shadow 时立即 undefined，不触碰任何 decision 相关 env。
 */
export function createDecisionProvider(
  options: DecisionProviderFactoryOptions,
): DecisionProvider | undefined {
  if (options.mode !== 'shadow') {
    return undefined;
  }

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

  return new JevDecisionProvider({ transport, model });
}
