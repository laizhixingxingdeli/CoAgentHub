import { ZodType } from 'zod';
import { OpenApiVersion } from '../../openapi.js';
import { SchemaObject } from '../../openapi3-ts/dist/model/openapi30.js';
import { SchemaObject as SchemaObject$1, ReferenceObject } from '../../openapi3-ts/dist/model/openapi31.js';
import { CreationType } from '../components.js';
import { CreateDocumentOptions } from '../document.js';

interface SchemaResult {
    schema: SchemaObject | SchemaObject$1 | ReferenceObject;
    components?: Record<string, SchemaObject | SchemaObject$1 | ReferenceObject> | undefined;
}
interface CreateSchemaOptions extends CreateDocumentOptions {
    /**
     * This controls whether this should be rendered as a request (`input`) or response (`output`). Defaults to `output`
     */
    schemaType?: CreationType;
    /**
     * OpenAPI version to use, defaults to `'3.1.0'`
     */
    openapi?: OpenApiVersion;
    /**
     * Additional components to use and create while rendering the schema
     */
    components?: Record<string, ZodType>;
    /**
     * The $ref path to use for the component. Defaults to `#/components/schemas/`
     */
    componentRefPath?: string;
}
declare const createSchema: (zodType: ZodType, opts?: CreateSchemaOptions) => SchemaResult;

export { type CreateSchemaOptions, type SchemaResult, createSchema };
