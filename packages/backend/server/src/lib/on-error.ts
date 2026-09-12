import BizError from "@laizhixingxingdeli/error/biz";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * 统一错误出口的日志注入面。生产传 winston logger(getLogger("server"));
 * 测试传 spy / no-op,便于断言日志级别而不污染控制台。
 */
export interface OnErrorLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * 全局 onError 工厂(specs/json-body-parse-failure-returns-500.md)。
 *
 * 生产 `src/index.ts` 与测试夹具 `test/app.ts` 共用这一个实现,杜绝两处
 * 复制漂移(漂移正是本缺陷的温床)。分流:
 *
 * | 错误 | status | 日志 |
 * |---|---|---|
 * | BizError | `err.statusCode` | warn(保持) |
 * | HTTPException 且 status < 500 | `err.status` | warn(R3,不静默) |
 * | HTTPException 且 status ≥ 500 | `err.status` | error |
 * | 其它(含业务层 SyntaxError) | 500 | error(保持) |
 *
 * 判据(R2,窄):`err instanceof HTTPException`(hono/http-exception),status
 * 用 `err.status`。body JSON 解析失败在 Hono/`@hono/zod-validator` 的 validator
 * 内已被 catch 并抛成 `HTTPException(400, "Malformed JSON in request body")`——
 * 错误在进入 onError 前已归因到「本次请求 body 解析」。业务/handler 内
 * `throw new SyntaxError(...)` 仍是裸 SyntaxError,不是 HTTPException → 落「其它」
 * 分支 → 500。**不做 `instanceof SyntaxError` → 400 的一刀切。**
 *
 * 响应体:仅当 requestId 存在(生产挂了 hono/request-id)才带,便于客户端
 * 关联请求日志;测试 app 未挂该中间件时自然省略,与既有响应形状逐字一致。
 */
export function createOnError(errorLog: OnErrorLogger) {
  return (err: Error, c: Context): Response => {
    const requestIdValue = c.get("requestId") as string | undefined;

    if (err instanceof BizError) {
      errorLog.warn("request failed (biz error)", {
        requestId: requestIdValue,
        code: err.code,
        status: err.statusCode,
        message: err.message,
        method: c.req.method,
        path: c.req.path,
      });
      const body: Record<string, unknown> = {
        code: err.code,
        message: err.message,
      };
      if (requestIdValue !== undefined) body.requestId = requestIdValue;
      return c.json(body, err.statusCode as ContentfulStatusCode);
    }

    if (err instanceof HTTPException) {
      const meta = {
        requestId: requestIdValue,
        status: err.status,
        message: err.message,
        method: c.req.method,
        path: c.req.path,
      };
      if (err.status < 500) {
        // 客户端错误(如 body 解析失败):warn 留痕,不再以 error 报(R3)。
        errorLog.warn("request failed (client error)", meta);
      } else {
        errorLog.error("request failed (internal error)", {
          ...meta,
          stack: err.stack,
        });
      }
      const body: Record<string, unknown> = { message: err.message };
      if (requestIdValue !== undefined) body.requestId = requestIdValue;
      return c.json(body, err.status as ContentfulStatusCode);
    }

    errorLog.error("request failed (internal error)", {
      requestId: requestIdValue,
      method: c.req.method,
      path: c.req.path,
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    const body: Record<string, unknown> = { message: "Internal Server Error" };
    if (requestIdValue !== undefined) body.requestId = requestIdValue;
    return c.json(body, 500);
  };
}
