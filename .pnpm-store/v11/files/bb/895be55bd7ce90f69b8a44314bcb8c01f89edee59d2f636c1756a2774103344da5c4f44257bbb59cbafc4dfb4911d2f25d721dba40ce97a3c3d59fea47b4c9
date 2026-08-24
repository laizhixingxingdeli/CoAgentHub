import { ZodType, AnyZodObject } from 'zod';
import { ParameterObject, ReferenceObject } from '../openapi3-ts/dist/model/openapi31.js';
import { ComponentsObject } from './components.js';
import { ZodOpenApiParameters, CreateDocumentOptions, ZodObjectInputType } from './document.js';

declare const createParamOrRef: (zodSchema: ZodType, components: ComponentsObject, subpath: string[], type?: keyof ZodOpenApiParameters, name?: string, documentOptions?: CreateDocumentOptions) => ParameterObject | ReferenceObject;
declare const getZodObject: (schema: ZodObjectInputType, type: "input" | "output") => AnyZodObject;

export { createParamOrRef, getZodObject };
