/**
 * 本机回环控制面客户端。
 *
 * 给 L3 CLI 把写命令交给**已经持锁的**同状态服务。不用 fetch：动态端口可能
 * 落在 Fetch 屏蔽表里，而原生 http 能连。失败必须明确——尤其 merge 可能已经
 * 在对端成功，自动重试会变成第二次终审。
 *
 * 每次应答都核 API 版本和实例/state 身份。对不上就当实例漂移，不把响应当
 * 成功，也不退回本地再写一份。
 */

import { request as httpRequest } from 'node:http';

/** 控制写（含 git 合并）可能超过健康探测的 800ms；太短会把慢合并误判成断线。 */
export const LOOPBACK_CONTROL_TIMEOUT_MS = 120_000;

export class LoopbackHttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'LoopbackHttpError';
    this.status = status;
    this.code = code;
  }
}

export class LoopbackIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoopbackIdentityError';
  }
}

export interface LoopbackWriterTarget {
  readonly port: number;
  readonly instanceId: string;
  readonly stateId: string;
  readonly apiVersion: string;
}

export interface LoopbackControlRequest {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: unknown;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * 状态文件身份是否同一真实文件。口径必须和 lock.ts 的探测一致：
 * 否则 Windows 上 probe 判 live，回环写却因盘符大小写把合法应答当成漂移。
 * 非 Windows 上大小写不同就是两个路径，合并会把两个状态文件当成同一个。
 *
 * `windows` 可注入，便于在非 Windows 上锁住这条规则；生产调用走 `process.platform`。
 */
function sameStateIdentity(left: string, right: string, windows: boolean): boolean {
  if (left === right) return true;
  if (!windows) return false;
  return left.toLowerCase() === right.toLowerCase();
}

function assertWriterIdentity(
  target: LoopbackWriterTarget,
  headers: { readonly [key: string]: string | string[] | undefined },
  windowsStateId: boolean,
): void {
  const api = headerValue(headers['x-coagent-api']);
  const instanceId = headerValue(headers['x-coagent-instance']);
  const stateId = headerValue(headers['x-coagent-state-id']);
  if (api !== target.apiVersion) {
    throw new LoopbackIdentityError(
      `错误版本：应答 API ${api ?? '（无）'}，期望 ${target.apiVersion}。主状态未改（若对端已写入，不要重试 merge）。`,
    );
  }
  if (instanceId !== target.instanceId) {
    throw new LoopbackIdentityError(
      `实例漂移：应答 instance ${instanceId ?? '（无）'}，期望 ${target.instanceId}。主状态未改（若对端已写入，不要重试 merge）。`,
    );
  }
  if (typeof stateId !== 'string' || !sameStateIdentity(stateId, target.stateId, windowsStateId)) {
    throw new LoopbackIdentityError(
      `状态身份不符：应答 state ${stateId ?? '（无）'}，期望 ${target.stateId}。主状态未改（若对端已写入，不要重试 merge）。`,
    );
  }
}

/**
 * 对 127.0.0.1 发一次控制请求。不重试。
 *
 * 断线、超时、身份/版本不符都抛错，调用方不得改走无锁本地写。
 */
export function loopbackControlRequest(
  target: LoopbackWriterTarget,
  input: LoopbackControlRequest,
  options?: { readonly timeoutMs?: number; readonly treatStateIdAsWindows?: boolean },
): Promise<unknown> {
  const timeoutMs = options?.timeoutMs ?? LOOPBACK_CONTROL_TIMEOUT_MS;
  const windowsStateId = options?.treatStateIdAsWindows ?? process.platform === 'win32';
  const payload =
    input.method === 'GET'
      ? undefined
      : JSON.stringify(input.body === undefined ? {} : input.body);
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (error: Error | undefined, value?: unknown) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    const headers: Record<string, string | number> = {
      accept: 'application/json',
    };
    if (payload !== undefined) {
      headers['content-type'] = 'application/json; charset=utf-8';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    const req = httpRequest(
      {
        host: '127.0.0.1',
        family: 4,
        port: target.port,
        path: input.path,
        method: input.method,
        timeout: timeoutMs,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => {
          chunks.push(chunk as Buffer);
        });
        res.on('end', () => {
          try {
            assertWriterIdentity(target, res.headers, windowsStateId);
          } catch (error) {
            done(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          const raw = Buffer.concat(chunks).toString('utf8');
          let body: unknown = undefined;
          if (raw.length > 0) {
            try {
              body = JSON.parse(raw) as unknown;
            } catch {
              done(new Error('写者应答不是 JSON。主状态未改（若对端已写入，不要重试 merge）。'));
              return;
            }
          }
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            done(undefined, body);
            return;
          }
          const rec = body && typeof body === 'object' ? (body as { error?: unknown; message?: unknown }) : {};
          const code = typeof rec.error === 'string' ? rec.error : 'HTTP_ERROR';
          const message = typeof rec.message === 'string' && rec.message.length > 0 ? rec.message : `HTTP ${String(status)}`;
          done(new LoopbackHttpError(status, code, message));
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      done(new Error('写者断线：回环请求超时。不确定对端是否已写入，不要重试 merge。'));
    });
    req.on('error', (error) => {
      done(
        new Error(
          `写者断线：${error.message}。不确定对端是否已写入，不要重试 merge。`,
        ),
      );
    });
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
