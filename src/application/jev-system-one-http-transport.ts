/**
 * Jev System One —— raw fetch HTTP transport.
 *
 * 可注入 fetch；单次 POST；无 retry / 无日志 / 无 Platform 耦合。
 * Error.message 不得包含 API key 或 response raw body。
 */

import type {
  JevSystemOneRequest,
  JevSystemOneResponse,
  JevSystemOneTransport,
} from './jev-decision-provider.ts';

const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

export interface JevSystemOneHttpTransportOptions {
  readonly fetch: typeof globalThis.fetch;
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly maxBodyBytes: number;
  readonly endpoint?: string;
}

type HttpErrorCategory =
  | 'unauthorized'
  | 'client_error'
  | 'rate_limited'
  | 'server_error'
  | 'overloaded'
  | 'http_error';

function categoryForStatus(status: number): HttpErrorCategory {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 429) return 'rate_limited';
  if (status === 529) return 'overloaded';
  if (status >= 500 && status <= 599) return 'server_error';
  if (status >= 400 && status <= 499) return 'client_error';
  return 'http_error';
}

function failHttp(status: number): never {
  const category = categoryForStatus(status);
  throw new Error(`JevSystemOneHttpTransport: HTTP ${status} (${category})`);
}

function fail(message: string): never {
  throw new Error(`JevSystemOneHttpTransport: ${message}`);
}

function parseContentLength(header: string | null): number | undefined {
  if (header === null || header === '') return undefined;
  // Only trust a plain non-negative integer (no multi-value / junk).
  if (!/^\d+$/.test(header.trim())) return undefined;
  const n = Number(header.trim());
  if (!Number.isSafeInteger(n) || n < 0) return undefined;
  return n;
}

function byteLengthUtf8(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export function createJevSystemOneHttpTransport(
  options: JevSystemOneHttpTransportOptions,
): JevSystemOneTransport {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const { fetch: fetchImpl, apiKey, timeoutMs, maxBodyBytes } = options;

  return {
    async systemOne(request: JevSystemOneRequest): Promise<JevSystemOneResponse> {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, timeoutMs);

      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            state: request.state,
            questions: request.questions,
            model: request.model,
          }),
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        if (controller.signal.aborted) {
          fail(`request timed out after ${timeoutMs}ms`);
        }
        const detail =
          err instanceof Error && err.message !== '' ? err.message : 'network error';
        // Network errors may carry fetch messages; never echo apiKey if present.
        const safe =
          typeof detail === 'string' && apiKey !== '' && detail.includes(apiKey)
            ? 'network error'
            : detail;
        fail(`network request failed: ${safe}`);
      }

      try {
        if (response.status < 200 || response.status > 299) {
          failHttp(response.status);
        }

        const declared = parseContentLength(response.headers.get('content-length'));
        if (declared !== undefined && declared > maxBodyBytes) {
          fail(`response Content-Length ${declared} exceeds maxBodyBytes ${maxBodyBytes}`);
        }

        const text = await response.text();
        const actualBytes = byteLengthUtf8(text);
        if (actualBytes > maxBodyBytes) {
          fail(`response body ${actualBytes} bytes exceeds maxBodyBytes ${maxBodyBytes}`);
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          fail('response is not valid JSON');
        }

        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          fail('response JSON must be a plain object');
        }

        return parsed as JevSystemOneResponse;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
