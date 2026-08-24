import { ZodType } from 'zod';
import { SchemaObject, ReferenceObject } from '../openapi3-ts/dist/model/openapi31.js';
import { ComponentsObject, CreationType } from './components.js';
import { CreateDocumentOptions } from './document.js';

declare const createMediaTypeSchema: (schemaObject: ZodType | SchemaObject | ReferenceObject | undefined, components: ComponentsObject, type: CreationType, subpath: string[], documentOptions?: CreateDocumentOptions) => SchemaObject | ReferenceObject | undefined;

export { createMediaTypeSchema };
