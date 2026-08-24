import { ZodType } from 'zod';
import { SchemaObject as SchemaObject$1, ReferenceObject as ReferenceObject$1, ParameterObject as ParameterObject$1, HeaderObject as HeaderObject$1, ResponseObject as ResponseObject$1, RequestBodyObject as RequestBodyObject$1, CallbackObject as CallbackObject$1 } from '../openapi3-ts/dist/model/openapi30.js';
import { ComponentsObject as ComponentsObject$1, SchemaObject, ReferenceObject, ParameterObject, ParameterLocation, HeaderObject, ResponseObject, RequestBodyObject, CallbackObject } from '../openapi3-ts/dist/model/openapi31.js';
import { ZodOpenApiVersion, ZodOpenApiComponentsObject, CreateDocumentOptions, ZodOpenApiResponseObject, ZodOpenApiRequestBodyObject, ZodOpenApiCallbackObject } from './document.js';

type CreationType = 'input' | 'output';
type BaseEffect = {
    zodType: ZodType;
    path: string[];
};
type ComponentEffect = BaseEffect & {
    type: 'component';
};
type SchemaEffect = BaseEffect & {
    type: 'schema';
    creationType: CreationType;
};
type Effect = ComponentEffect | SchemaEffect;
type ResolvedEffect = {
    creationType: CreationType;
    path: string[];
    zodType: ZodType;
    component?: {
        ref: string;
        zodType: ZodType;
        path: string[];
    };
};
interface CompleteSchemaComponent extends BaseSchemaComponent {
    type: 'complete';
    schemaObject: SchemaObject | ReferenceObject | SchemaObject$1 | ReferenceObject$1;
    /** Set when the created schemaObject is specific to a particular effect */
    effects?: Effect[];
    resolvedEffect?: ResolvedEffect;
}
/**
 *
 */
interface ManualSchemaComponent extends BaseSchemaComponent {
    type: 'manual';
}
interface InProgressSchemaComponent extends BaseSchemaComponent {
    type: 'in-progress';
}
interface BaseSchemaComponent {
    ref: string;
}
type SchemaComponent = CompleteSchemaComponent | ManualSchemaComponent | InProgressSchemaComponent;
type SchemaComponentMap = Map<ZodType, SchemaComponent>;
interface CompleteParameterComponent extends BaseParameterComponent {
    type: 'complete';
    paramObject: ParameterObject | ReferenceObject | ParameterObject$1 | ReferenceObject$1;
}
interface PartialParameterComponent extends BaseParameterComponent {
    type: 'manual';
}
interface BaseParameterComponent {
    ref: string;
    in: ParameterLocation;
    name: string;
}
type ParameterComponent = CompleteParameterComponent | PartialParameterComponent;
type ParameterComponentMap = Map<ZodType, ParameterComponent>;
interface CompleteHeaderComponent extends BaseHeaderComponent {
    type: 'complete';
    headerObject: HeaderObject | ReferenceObject | HeaderObject$1 | ReferenceObject$1;
}
interface PartialHeaderComponent extends BaseHeaderComponent {
    type: 'manual';
}
interface BaseHeaderComponent {
    ref: string;
}
type HeaderComponent = CompleteHeaderComponent | PartialHeaderComponent;
type HeaderComponentMap = Map<ZodType, HeaderComponent>;
interface BaseResponseComponent {
    ref: string;
}
interface CompleteResponseComponent extends BaseResponseComponent {
    type: 'complete';
    responseObject: ResponseObject | ReferenceObject | ResponseObject$1 | ReferenceObject$1;
}
interface PartialResponseComponent extends BaseResponseComponent {
    type: 'manual';
}
type ResponseComponent = CompleteResponseComponent | PartialResponseComponent;
type ResponseComponentMap = Map<ZodOpenApiResponseObject, ResponseComponent>;
interface BaseRequestBodyComponent {
    ref: string;
}
interface CompleteRequestBodyComponent extends BaseRequestBodyComponent {
    type: 'complete';
    requestBodyObject: RequestBodyObject | ReferenceObject | RequestBodyObject$1 | ReferenceObject$1;
}
interface PartialRequestBodyComponent extends BaseRequestBodyComponent {
    type: 'manual';
}
type RequestBodyComponent = CompleteRequestBodyComponent | PartialRequestBodyComponent;
type RequestBodyComponentMap = Map<ZodOpenApiRequestBodyObject, RequestBodyComponent>;
interface BaseCallbackComponent {
    ref: string;
}
interface CompleteCallbackComponent extends BaseCallbackComponent {
    type: 'complete';
    callbackObject: ZodOpenApiCallbackObject | CallbackObject | CallbackObject$1;
}
interface PartialCallbackComponent extends BaseCallbackComponent {
    type: 'manual';
}
type CallbackComponent = CompleteCallbackComponent | PartialCallbackComponent;
type CallbackComponentMap = Map<ZodOpenApiCallbackObject, CallbackComponent>;
interface ComponentsObject {
    schemas: SchemaComponentMap;
    parameters: ParameterComponentMap;
    headers: HeaderComponentMap;
    requestBodies: RequestBodyComponentMap;
    responses: ResponseComponentMap;
    callbacks: CallbackComponentMap;
    openapi: ZodOpenApiVersion;
}
declare const getDefaultComponents: (componentsObject?: ZodOpenApiComponentsObject, openapi?: ZodOpenApiVersion) => ComponentsObject;
declare const createComponents: (componentsObject: ZodOpenApiComponentsObject, components: ComponentsObject, documentOptions?: CreateDocumentOptions) => ComponentsObject$1 | undefined;

export { type BaseCallbackComponent, type CallbackComponent, type CallbackComponentMap, type CompleteCallbackComponent, type CompleteHeaderComponent, type CompleteParameterComponent, type CompleteRequestBodyComponent, type CompleteResponseComponent, type CompleteSchemaComponent, type ComponentEffect, type ComponentsObject, type CreationType, type Effect, type HeaderComponent, type HeaderComponentMap, type InProgressSchemaComponent, type ManualSchemaComponent, type ParameterComponent, type ParameterComponentMap, type PartialCallbackComponent, type PartialHeaderComponent, type PartialParameterComponent, type PartialRequestBodyComponent, type PartialResponseComponent, type RequestBodyComponent, type RequestBodyComponentMap, type ResolvedEffect, type ResponseComponent, type ResponseComponentMap, type SchemaComponent, type SchemaComponentMap, type SchemaEffect, createComponents, getDefaultComponents };
