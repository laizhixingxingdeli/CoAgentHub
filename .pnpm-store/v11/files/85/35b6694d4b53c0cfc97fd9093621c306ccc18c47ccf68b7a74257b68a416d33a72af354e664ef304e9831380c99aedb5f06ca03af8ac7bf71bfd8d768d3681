"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  getSentry: () => getSentry,
  sentry: () => sentry
});
module.exports = __toCommonJS(index_exports);
var import_toucan_js = require("toucan-js");
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
    const sentry2 = new import_toucan_js.Toucan({
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  getSentry,
  sentry
});
