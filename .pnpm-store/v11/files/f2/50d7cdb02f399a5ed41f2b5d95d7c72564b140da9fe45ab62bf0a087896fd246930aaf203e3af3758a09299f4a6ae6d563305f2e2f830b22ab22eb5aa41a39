// src/helper/websocket/index.ts
var WSContext = class {
  #init;
  constructor(init) {
    this.#init = init;
    this.raw = init.raw;
    this.url = init.url ? new URL(init.url) : null;
    this.protocol = init.protocol ?? null;
  }
  send(source, options) {
    this.#init.send(source, options ?? {});
  }
  raw;
  binaryType = "arraybuffer";
  get readyState() {
    return this.#init.readyState;
  }
  url;
  protocol;
  close(code, reason) {
    this.#init.close(code, reason);
  }
};
var createWSMessageEvent = (source) => {
  return new MessageEvent("message", {
    data: source
  });
};
var defineWebSocketHelper = (handler) => {
  return (createEvents, options) => {
    return async function UpgradeWebSocket(c, next) {
      const events = await createEvents(c);
      const result = await handler(c, events, options);
      if (result) {
        return result;
      }
      await next();
    };
  };
};
export {
  WSContext,
  createWSMessageEvent,
  defineWebSocketHelper
};
