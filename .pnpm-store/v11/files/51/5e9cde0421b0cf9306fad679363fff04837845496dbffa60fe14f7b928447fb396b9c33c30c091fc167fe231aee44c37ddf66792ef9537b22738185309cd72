// src/helper/testing/index.ts
import { hc } from "../../client/index.js";
var testClient = (app, Env, executionCtx) => {
  const customFetch = (input, init) => {
    return app.request(input, init, Env, executionCtx);
  };
  return hc("http://localhost", { fetch: customFetch });
};
export {
  testClient
};
