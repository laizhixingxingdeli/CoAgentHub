"use strict";
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const components = require("./components.chunk.cjs");
const extendZod = require("./extendZod.chunk.cjs");
const createDocument = (zodOpenApiObject, documentOptions) => {
  const { paths, webhooks, components: components$1 = {}, ...rest } = zodOpenApiObject;
  const defaultComponents = components.getDefaultComponents(
    components$1,
    zodOpenApiObject.openapi
  );
  const createdPaths = components.createPaths(paths, defaultComponents, documentOptions);
  const createdWebhooks = components.createPaths(
    webhooks,
    defaultComponents,
    documentOptions
  );
  const createdComponents = components.createComponents(
    components$1,
    defaultComponents,
    documentOptions
  );
  return {
    ...rest,
    ...createdPaths && { paths: createdPaths },
    ...createdWebhooks && { webhooks: createdWebhooks },
    ...createdComponents && { components: createdComponents }
  };
};
const createSchema = (zodType, opts) => {
  const components$1 = components.getDefaultComponents(
    {
      schemas: opts == null ? void 0 : opts.components
    },
    opts == null ? void 0 : opts.openapi
  );
  const state = {
    components: components$1,
    type: (opts == null ? void 0 : opts.schemaType) ?? "output",
    path: [],
    visited: /* @__PURE__ */ new Set(),
    documentOptions: opts
  };
  const schema = components.createSchema(zodType, state, ["createSchema"]);
  const schemaComponents = components.createSchemaComponents({}, components$1);
  return {
    schema,
    components: schemaComponents
  };
};
const oas30 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null
}, Symbol.toStringTag, { value: "Module" }));
const oas31 = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.defineProperty({
  __proto__: null
}, Symbol.toStringTag, { value: "Module" }));
exports.extendZodWithOpenApi = extendZod.extendZodWithOpenApi;
exports.createDocument = createDocument;
exports.createSchema = createSchema;
exports.oas30 = oas30;
exports.oas31 = oas31;
