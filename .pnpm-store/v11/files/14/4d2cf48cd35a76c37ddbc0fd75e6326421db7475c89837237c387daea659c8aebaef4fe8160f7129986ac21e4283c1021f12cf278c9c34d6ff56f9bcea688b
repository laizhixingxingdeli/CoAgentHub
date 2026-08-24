"use strict";
const extendZodSymbols = require("./extendZodSymbols.chunk.cjs");
const mergeOpenApi = (openapi, {
  ref: _ref,
  refType: _refType,
  param: _param,
  header: _header,
  ...rest
} = {}) => ({
  ...rest,
  ...openapi
});
function extendZodWithOpenApi(zod) {
  if (typeof zod.ZodType.prototype.openapi !== "undefined") {
    return;
  }
  zod.ZodType.prototype.openapi = function(openapi) {
    const { zodOpenApi, ...rest } = this._def;
    const result = new this.constructor({
      ...rest,
      zodOpenApi: {
        openapi: mergeOpenApi(
          openapi,
          zodOpenApi == null ? void 0 : zodOpenApi.openapi
        )
      }
    });
    result._def.zodOpenApi[extendZodSymbols.currentSymbol] = result;
    if (zodOpenApi) {
      result._def.zodOpenApi[extendZodSymbols.previousSymbol] = this;
    }
    return result;
  };
  const zodDescribe = zod.ZodType.prototype.describe;
  zod.ZodType.prototype.describe = function(...args) {
    const result = zodDescribe.apply(this, args);
    const def = result._def;
    if (def.zodOpenApi) {
      const cloned = { ...def.zodOpenApi };
      cloned.openapi = mergeOpenApi({ description: args[0] }, cloned.openapi);
      cloned[extendZodSymbols.previousSymbol] = this;
      cloned[extendZodSymbols.currentSymbol] = result;
      def.zodOpenApi = cloned;
    } else {
      def.zodOpenApi = {
        openapi: { description: args[0] },
        [extendZodSymbols.currentSymbol]: result
      };
    }
    return result;
  };
  const zodObjectExtend = zod.ZodObject.prototype.extend;
  zod.ZodObject.prototype.extend = function(...args) {
    const extendResult = zodObjectExtend.apply(this, args);
    const zodOpenApi = extendResult._def.zodOpenApi;
    if (zodOpenApi) {
      const cloned = { ...zodOpenApi };
      cloned.openapi = mergeOpenApi({}, cloned.openapi);
      cloned[extendZodSymbols.previousSymbol] = this;
      extendResult._def.zodOpenApi = cloned;
    } else {
      extendResult._def.zodOpenApi = {
        [extendZodSymbols.previousSymbol]: this
      };
    }
    return extendResult;
  };
  const zodObjectOmit = zod.ZodObject.prototype.omit;
  zod.ZodObject.prototype.omit = function(...args) {
    const omitResult = zodObjectOmit.apply(this, args);
    const zodOpenApi = omitResult._def.zodOpenApi;
    if (zodOpenApi) {
      const cloned = { ...zodOpenApi };
      cloned.openapi = mergeOpenApi({}, cloned.openapi);
      delete cloned[extendZodSymbols.previousSymbol];
      delete cloned[extendZodSymbols.currentSymbol];
      omitResult._def.zodOpenApi = cloned;
    }
    return omitResult;
  };
  const zodObjectPick = zod.ZodObject.prototype.pick;
  zod.ZodObject.prototype.pick = function(...args) {
    const pickResult = zodObjectPick.apply(this, args);
    const zodOpenApi = pickResult._def.zodOpenApi;
    if (zodOpenApi) {
      const cloned = { ...zodOpenApi };
      cloned.openapi = mergeOpenApi({}, cloned.openapi);
      delete cloned[extendZodSymbols.previousSymbol];
      delete cloned[extendZodSymbols.currentSymbol];
      pickResult._def.zodOpenApi = cloned;
    }
    return pickResult;
  };
}
exports.extendZodWithOpenApi = extendZodWithOpenApi;
