import { ServerObject } from './oas-common.js';
export { ServerVariableObject } from './oas-common.js';
import { ISpecificationExtension } from './specification-extension.js';

interface OpenAPIObject extends ISpecificationExtension {
    openapi: string;
    info: InfoObject;
    servers?: ServerObject[];
    paths: PathsObject;
    components?: ComponentsObject;
    security?: SecurityRequirementObject[];
    tags?: TagObject[];
    externalDocs?: ExternalDocumentationObject;
}
interface InfoObject extends ISpecificationExtension {
    title: string;
    description?: string;
    termsOfService?: string;
    contact?: ContactObject;
    license?: LicenseObject;
    version: string;
}
interface ContactObject extends ISpecificationExtension {
    name?: string;
    url?: string;
    email?: string;
}
interface LicenseObject extends ISpecificationExtension {
    name: string;
    url?: string;
}
interface ComponentsObject extends ISpecificationExtension {
    schemas?: {
        [schema: string]: SchemaObject | ReferenceObject;
    };
    responses?: {
        [response: string]: ResponseObject | ReferenceObject;
    };
    parameters?: {
        [parameter: string]: ParameterObject | ReferenceObject;
    };
    examples?: {
        [example: string]: ExampleObject | ReferenceObject;
    };
    requestBodies?: {
        [request: string]: RequestBodyObject | ReferenceObject;
    };
    headers?: {
        [header: string]: HeaderObject | ReferenceObject;
    };
    securitySchemes?: {
        [securityScheme: string]: SecuritySchemeObject | ReferenceObject;
    };
    links?: {
        [link: string]: LinkObject | ReferenceObject;
    };
    callbacks?: {
        [callback: string]: CallbackObject | ReferenceObject;
    };
}
interface PathsObject extends ISpecificationExtension {
    [path: string]: PathItemObject;
}
type PathObject = PathsObject;
interface PathItemObject extends ISpecificationExtension {
    $ref?: string;
    summary?: string;
    description?: string;
    get?: OperationObject;
    put?: OperationObject;
    post?: OperationObject;
    delete?: OperationObject;
    options?: OperationObject;
    head?: OperationObject;
    patch?: OperationObject;
    trace?: OperationObject;
    servers?: ServerObject[];
    parameters?: (ParameterObject | ReferenceObject)[];
}
interface OperationObject extends ISpecificationExtension {
    tags?: string[];
    summary?: string;
    description?: string;
    externalDocs?: ExternalDocumentationObject;
    operationId?: string;
    parameters?: (ParameterObject | ReferenceObject)[];
    requestBody?: RequestBodyObject | ReferenceObject;
    responses: ResponsesObject;
    callbacks?: CallbacksObject;
    deprecated?: boolean;
    security?: SecurityRequirementObject[];
    servers?: ServerObject[];
}
interface ExternalDocumentationObject extends ISpecificationExtension {
    description?: string;
    url: string;
}
type ParameterLocation = 'query' | 'header' | 'path' | 'cookie';
type ParameterStyle = 'matrix' | 'label' | 'form' | 'simple' | 'spaceDelimited' | 'pipeDelimited' | 'deepObject';
interface BaseParameterObject extends ISpecificationExtension {
    description?: string;
    required?: boolean;
    deprecated?: boolean;
    allowEmptyValue?: boolean;
    style?: ParameterStyle;
    explode?: boolean;
    allowReserved?: boolean;
    schema?: SchemaObject | ReferenceObject;
    examples?: {
        [param: string]: ExampleObject | ReferenceObject;
    };
    example?: any;
    content?: ContentObject;
}
interface ParameterObject extends BaseParameterObject {
    name: string;
    in: ParameterLocation;
}
interface RequestBodyObject extends ISpecificationExtension {
    description?: string;
    content: ContentObject;
    required?: boolean;
}
interface ContentObject {
    [mediatype: string]: MediaTypeObject;
}
interface MediaTypeObject extends ISpecificationExtension {
    schema?: SchemaObject | ReferenceObject;
    examples?: ExamplesObject;
    example?: any;
    encoding?: EncodingObject;
}
interface EncodingObject extends ISpecificationExtension {
    [property: string]: EncodingPropertyObject | any;
}
interface EncodingPropertyObject {
    contentType?: string;
    headers?: {
        [key: string]: HeaderObject | ReferenceObject;
    };
    style?: string;
    explode?: boolean;
    allowReserved?: boolean;
    [key: string]: any;
}
interface ResponsesObject extends ISpecificationExtension {
    default?: ResponseObject | ReferenceObject;
    [statuscode: string]: ResponseObject | ReferenceObject | any;
}
interface ResponseObject extends ISpecificationExtension {
    description: string;
    headers?: HeadersObject;
    content?: ContentObject;
    links?: LinksObject;
}
interface CallbacksObject extends ISpecificationExtension {
    [name: string]: CallbackObject | ReferenceObject | any;
}
interface CallbackObject extends ISpecificationExtension {
    [name: string]: PathItemObject | any;
}
interface HeadersObject {
    [name: string]: HeaderObject | ReferenceObject;
}
interface ExampleObject {
    summary?: string;
    description?: string;
    value?: any;
    externalValue?: string;
    [property: string]: any;
}
interface LinksObject {
    [name: string]: LinkObject | ReferenceObject;
}
interface LinkObject extends ISpecificationExtension {
    operationRef?: string;
    operationId?: string;
    parameters?: LinkParametersObject;
    requestBody?: any | string;
    description?: string;
    server?: ServerObject;
    [property: string]: any;
}
interface LinkParametersObject {
    [name: string]: any | string;
}
interface HeaderObject extends BaseParameterObject {
    $ref?: string;
}
interface TagObject extends ISpecificationExtension {
    name: string;
    description?: string;
    externalDocs?: ExternalDocumentationObject;
    [extension: string]: any;
}
interface ExamplesObject {
    [name: string]: ExampleObject | ReferenceObject;
}
interface ReferenceObject {
    $ref: string;
}
type SchemaObjectType = 'integer' | 'number' | 'string' | 'boolean' | 'object' | 'null' | 'array';
type SchemaObjectFormat = 'int32' | 'int64' | 'float' | 'double' | 'byte' | 'binary' | 'date' | 'date-time' | 'password' | string;
interface SchemaObject extends ISpecificationExtension {
    nullable?: boolean;
    discriminator?: DiscriminatorObject;
    readOnly?: boolean;
    writeOnly?: boolean;
    xml?: XmlObject;
    externalDocs?: ExternalDocumentationObject;
    example?: any;
    examples?: any[];
    deprecated?: boolean;
    type?: SchemaObjectType | SchemaObjectType[];
    format?: SchemaObjectFormat;
    allOf?: (SchemaObject | ReferenceObject)[];
    oneOf?: (SchemaObject | ReferenceObject)[];
    anyOf?: (SchemaObject | ReferenceObject)[];
    not?: SchemaObject | ReferenceObject;
    items?: SchemaObject | ReferenceObject;
    properties?: {
        [propertyName: string]: SchemaObject | ReferenceObject;
    };
    additionalProperties?: SchemaObject | ReferenceObject | boolean;
    description?: string;
    default?: any;
    title?: string;
    multipleOf?: number;
    maximum?: number;
    exclusiveMaximum?: boolean;
    minimum?: number;
    exclusiveMinimum?: boolean;
    maxLength?: number;
    minLength?: number;
    pattern?: string;
    maxItems?: number;
    minItems?: number;
    uniqueItems?: boolean;
    maxProperties?: number;
    minProperties?: number;
    required?: string[];
    enum?: any[];
}
interface SchemasObject {
    [schema: string]: SchemaObject;
}
interface DiscriminatorObject {
    propertyName: string;
    mapping?: {
        [key: string]: string;
    };
}
interface XmlObject extends ISpecificationExtension {
    name?: string;
    namespace?: string;
    prefix?: string;
    attribute?: boolean;
    wrapped?: boolean;
}
type SecuritySchemeType = 'apiKey' | 'http' | 'oauth2' | 'openIdConnect';
interface SecuritySchemeObject extends ISpecificationExtension {
    type: SecuritySchemeType;
    description?: string;
    name?: string;
    in?: string;
    scheme?: string;
    bearerFormat?: string;
    flows?: OAuthFlowsObject;
    openIdConnectUrl?: string;
}
interface OAuthFlowsObject extends ISpecificationExtension {
    implicit?: OAuthFlowObject;
    password?: OAuthFlowObject;
    clientCredentials?: OAuthFlowObject;
    authorizationCode?: OAuthFlowObject;
}
interface OAuthFlowObject extends ISpecificationExtension {
    authorizationUrl?: string;
    tokenUrl?: string;
    refreshUrl?: string;
    scopes: ScopesObject;
}
interface ScopesObject extends ISpecificationExtension {
    [scope: string]: any;
}
interface SecurityRequirementObject {
    [name: string]: string[];
}

export { type BaseParameterObject, type CallbackObject, type CallbacksObject, type ComponentsObject, type ContactObject, type ContentObject, type DiscriminatorObject, type EncodingObject, type EncodingPropertyObject, type ExampleObject, type ExamplesObject, type ExternalDocumentationObject, type HeaderObject, type HeadersObject, ISpecificationExtension, type InfoObject, type LicenseObject, type LinkObject, type LinkParametersObject, type LinksObject, type MediaTypeObject, type OAuthFlowObject, type OAuthFlowsObject, type OpenAPIObject, type OperationObject, type ParameterLocation, type ParameterObject, type ParameterStyle, type PathItemObject, type PathObject, type PathsObject, type ReferenceObject, type RequestBodyObject, type ResponseObject, type ResponsesObject, type SchemaObject, type SchemaObjectFormat, type SchemaObjectType, type SchemasObject, type ScopesObject, type SecurityRequirementObject, type SecuritySchemeObject, type SecuritySchemeType, ServerObject, type TagObject, type XmlObject };
