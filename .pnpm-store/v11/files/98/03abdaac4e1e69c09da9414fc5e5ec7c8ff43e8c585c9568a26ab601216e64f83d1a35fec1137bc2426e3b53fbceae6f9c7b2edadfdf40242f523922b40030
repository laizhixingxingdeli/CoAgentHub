// src/index.ts
import { Toucan } from "toucan-js";
var MockContext = class {
  passThroughOnException() {
    throw new Error("Method not implemented.");
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async waitUntil(promise) {
    await promise;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  props;
};
var sentry = (options, callback) => {
  return async (c, next) => {
    let hasExecutionContext = true;
    try {
      c.executionCtx;
    } catch {
      hasExecutionContext = false;
    }
    const sentry2 = new Toucan({
      dsn: c.env?.SENTRY_DSN ?? c.env?.NEXT_PUBLIC_SENTRY_DSN,
      requestDataOptions: {
        allowedHeaders: ["user-agent"],
        allowedSearchParams: /(.*)/
      },
      request: c.req.raw,
      context: hasExecutionContext ? c.executionCtx : new MockContext(),
      ...options
    });
    c.set("sentry", sentry2);
    if (callback) {
      callback(sentry2);
    }
    await next();
    if (c.error) {
      sentry2.captureException(c.error);
    }
  };
};
var getSentry = (c) => {
  return c.get("sentry");
};
export {
  getSentry,
  sentry
};
