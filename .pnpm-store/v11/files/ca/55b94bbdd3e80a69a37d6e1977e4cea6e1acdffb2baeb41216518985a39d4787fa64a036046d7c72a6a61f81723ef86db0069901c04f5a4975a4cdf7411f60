import { getDefaultComponents, createPaths, createComponents, createSchema as createSchema$1, createSchemaComponents } from "./components.chunk.mjs";
import { extendZodWithOpenApi } from "./extendZod.chunk.mjs";
const createDocument = (zodOpenApiObject, documentOptions) => {
  const { paths, webhooks, components = {}, ...rest } = zodOpenApiObject;
  const defaultComponents = getDefaultComponents(
    components,
    zodOpenApiObject.openapi
  );
  const createdPaths = createPaths(paths, defaultComponents, documentOptions);
  const createdWebhooks = createPaths(
    webhooks,
    defaultComponents,
    documentOptions
  );
  const createdComponents = createComponents(
    components,
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
  const components = getDefaultComponents(
    {
      schemas: opts == null ? void 0 : opts.components
    },
    opts == null ? void 0 : opts.openapi
  );
  const state = {
    components,
    type: (opts == null ? void 0 : opts.schemaType) ?? "output",
    path: [],
    visited: /* @__PURE__ */ new Set(),
    documentOptions: opts
  };
  const schema = createSchema$1(zodType, state, ["createSchema"]);
  const schemaComponents = createSchemaComponents({}, components);
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
export {
  createDocument,
  createSchema,
  extendZodWithOpenApi,
  oas30,
  oas31
};
