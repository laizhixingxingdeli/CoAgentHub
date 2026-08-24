import { ZodType, AnyZodObject, ZodTypeDef } from 'zod';
import { OpenApiVersion } from '../openapi.js';
import { MediaTypeObject as MediaTypeObject$1, RequestBodyObject as RequestBodyObject$1, ResponseObject as ResponseObject$1, HeadersObject, ReferenceObject as ReferenceObject$1, ParameterLocation as ParameterLocation$1, OperationObject as OperationObject$1, ParameterObject as ParameterObject$1, PathItemObject as PathItemObject$1, ComponentsObject as ComponentsObject$1, SchemaObject as SchemaObject$1, HeaderObject as HeaderObject$1 } from '../openapi3-ts/dist/model/openapi30.js';
import { ISpecificationExtension } from '../openapi3-ts/dist/model/specification-extension.js';
import { MediaTypeObject, SchemaObject, ReferenceObject, RequestBodyObject, ResponseObject, HeadersObject as HeadersObject$1, ParameterLocation, OperationObject, ParameterObject, PathItemObject, ComponentsObject, HeaderObject, OpenAPIObject } from '../openapi3-ts/dist/model/openapi31.js';

interface ZodOpenApiMediaTypeObject extends Omit<MediaTypeObject & MediaTypeObject$1, 'schema'> {
    schema?: ZodType | SchemaObject | ReferenceObject;
}
interface ZodOpenApiContentObject {
    'application/json'?: ZodOpenApiMediaTypeObject;
    [mediatype: string]: ZodOpenApiMediaTypeObject | undefined;
}
interface ZodOpenApiRequestBodyObject extends Omit<RequestBodyObject & RequestBodyObject$1, 'content'> {
    content: ZodOpenApiContentObject;
    /** Use this field to auto register this request body as a component */
    ref?: string;
}
interface ZodOpenApiResponseObject extends Omit<ResponseObject & ResponseObject$1, 'content' | 'headers'> {
    content?: ZodOpenApiContentObject;
    headers?: AnyZodObject | HeadersObject | HeadersObject$1;
    /** Use this field to auto register this response object as a component */
    ref?: string;
}
interface ZodOpenApiResponsesObject extends ISpecificationExtension {
    default?: ZodOpenApiResponseObject | ReferenceObject | ReferenceObject$1;
    [statuscode: `${1 | 2 | 3 | 4 | 5}${string}`]: ZodOpenApiResponseObject | ReferenceObject;
}
type ZodOpenApiParameters = Partial<Record<ParameterLocation & ParameterLocation$1, ZodObjectInputType>>;
interface ZodOpenApiCallbacksObject extends ISpecificationExtension {
    [name: string]: ZodOpenApiCallbackObject;
}
interface ZodOpenApiCallbackObject extends ISpecificationExtension {
    /** Use this field to auto register this callback object as a component */
    ref?: string;
    [name: string]: ZodOpenApiPathItemObject | string | undefined;
}
interface ZodOpenApiOperationObject extends Omit<OperationObject & OperationObject$1, 'requestBody' | 'responses' | 'parameters' | 'callbacks'> {
    parameters?: Array<ZodType | ParameterObject | ParameterObject$1 | ReferenceObject | ReferenceObject$1>;
    requestBody?: ZodOpenApiRequestBodyObject;
    requestParams?: ZodOpenApiParameters;
    responses: ZodOpenApiResponsesObject;
    callbacks?: ZodOpenApiCallbacksObject;
}
interface ZodOpenApiPathItemObject extends Omit<PathItemObject & PathItemObject$1, 'get' | 'put' | 'post' | 'delete' | 'options' | 'head' | 'patch' | 'trace'> {
    get?: ZodOpenApiOperationObject;
    put?: ZodOpenApiOperationObject;
    post?: ZodOpenApiOperationObject;
    delete?: ZodOpenApiOperationObject;
    options?: ZodOpenApiOperationObject;
    head?: ZodOpenApiOperationObject;
    patch?: ZodOpenApiOperationObject;
    trace?: ZodOpenApiOperationObject;
}
interface ZodOpenApiPathsObject extends ISpecificationExtension {
    [path: string]: ZodOpenApiPathItemObject;
}
interface ZodOpenApiComponentsObject extends Omit<ComponentsObject & ComponentsObject$1, 'schemas' | 'responses' | 'requestBodies' | 'headers' | 'parameters'> {
    parameters?: Record<string, ZodType | ParameterObject | ParameterObject$1 | ReferenceObject | ReferenceObject$1>;
    schemas?: Record<string, ZodType | SchemaObject | ReferenceObject | SchemaObject$1 | ReferenceObject$1>;
    requestBodies?: Record<string, ZodOpenApiRequestBodyObject>;
    headers?: Record<string, ZodType | HeaderObject | HeaderObject$1 | ReferenceObject | ReferenceObject$1>;
    responses?: Record<string, ZodOpenApiResponseObject>;
    callbacks?: Record<string, ZodOpenApiCallbackObject>;
}
type ZodOpenApiVersion = OpenApiVersion;
interface ZodOpenApiObject extends Omit<OpenAPIObject, 'openapi' | 'paths' | 'webhooks' | 'components'> {
    openapi: ZodOpenApiVersion;
    paths?: ZodOpenApiPathsObject;
    webhooks?: ZodOpenApiPathsObject;
    components?: ZodOpenApiComponentsObject;
}
type ZodObjectInputType<Output = unknown, Def extends ZodTypeDef = ZodTypeDef, Input = Record<string, unknown>> = ZodType<Output, Def, Input>;
interface CreateDocumentOptions {
    /**
     * Used to throw an error if a Discriminated Union member is not registered as a component
     */
    enforceDiscriminatedUnionComponents?: boolean;
    /**
     * Used to change the default Zod Date schema
     */
    defaultDateSchema?: Pick<SchemaObject, 'type' | 'format'>;
    /**
     * Used to set the output of a ZodUnion to be `oneOf` instead of `anyOf`
     */
    unionOneOf?: boolean;
}
declare const createDocument: (zodOpenApiObject: ZodOpenApiObject, documentOptions?: CreateDocumentOptions) => OpenAPIObject;

export { type CreateDocumentOptions, type ZodObjectInputType, type ZodOpenApiCallbackObject, type ZodOpenApiCallbacksObject, type ZodOpenApiComponentsObject, type ZodOpenApiContentObject, type ZodOpenApiMediaTypeObject, type ZodOpenApiObject, type ZodOpenApiOperationObject, type ZodOpenApiParameters, type ZodOpenApiPathItemObject, type ZodOpenApiPathsObject, type ZodOpenApiRequestBodyObject, type ZodOpenApiResponseObject, type ZodOpenApiResponsesObject, type ZodOpenApiVersion, createDocument };
