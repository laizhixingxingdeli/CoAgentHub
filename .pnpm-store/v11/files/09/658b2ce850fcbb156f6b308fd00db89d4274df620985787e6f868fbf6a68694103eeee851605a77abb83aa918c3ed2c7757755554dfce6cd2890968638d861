import { z } from 'zod';
export declare const securityApiKeySchema: z.ZodObject<{
    description: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"apiKey">;
    name: z.ZodDefault<z.ZodOptional<z.ZodString>>;
    in: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        cookie: "cookie";
        query: "query";
        header: "header";
    }>>>>;
    uid: z.core.$ZodBranded<z.ZodDefault<z.ZodString>, "securityScheme", "out">;
    nameKey: z.ZodDefault<z.ZodOptional<z.ZodString>>;
    value: z.ZodDefault<z.ZodString>;
}, z.core.$strip>;
export type SecuritySchemeApiKey = z.infer<typeof securityApiKeySchema>;
export declare const securityHttpSchema: z.ZodObject<{
    description: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"http">;
    scheme: z.ZodDefault<z.ZodOptional<z.ZodPipe<z.ZodString, z.ZodEnum<{
        basic: "basic";
        bearer: "bearer";
    }>>>>;
    bearerFormat: z.ZodDefault<z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"JWT">, z.ZodString]>>>;
    uid: z.core.$ZodBranded<z.ZodDefault<z.ZodString>, "securityScheme", "out">;
    nameKey: z.ZodDefault<z.ZodOptional<z.ZodString>>;
    username: z.ZodDefault<z.ZodString>;
    password: z.ZodDefault<z.ZodString>;
    token: z.ZodDefault<z.ZodString>;
}, z.core.$strip>;
export type SecuritySchemaHttp = z.infer<typeof securityHttpSchema>;
export declare const securityOpenIdSchema: z.ZodObject<{
    description: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"openIdConnect">;
    openIdConnectUrl: z.ZodDefault<z.ZodOptional<z.ZodString>>;
    uid: z.core.$ZodBranded<z.ZodDefault<z.ZodString>, "securityScheme", "out">;
    nameKey: z.ZodDefault<z.ZodOptional<z.ZodString>>;
}, z.core.$strip>;
export type SecuritySchemaOpenId = z.infer<typeof securityOpenIdSchema>;
/** Options for the x-usePkce extension */
export declare const pkceOptions: readonly ["SHA-256", "plain", "no"];
export declare const securityOauthSchema: z.ZodObject<{
    description: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"oauth2">;
    'x-default-scopes': z.ZodOptional<z.ZodArray<z.ZodString>>;
    flows: z.ZodDefault<z.ZodObject<{
        implicit: z.ZodOptional<z.ZodObject<{
            refreshUrl: z.ZodDefault<z.ZodOptional<z.ZodString>>;
            scopes: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodDefault<z.ZodOptional<z.ZodString>>>>>>;
            selectedScopes: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodString>>>;
            'x-scalar-client-id': z.ZodDefault<z.ZodOptional<z.ZodString>>;
            token: z.ZodDefault<z.ZodString>;
            'x-scalar-security-query': z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
            'x-scalar-security-body': z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
            'x-tokenName': z.ZodOptional<z.ZodString>;
            type: z.ZodDefault<z.ZodLiteral<"implicit">>;
            authorizationUrl: z.ZodDefault<z.ZodString>;
            'x-scalar-redirect-uri': z.ZodDefault<z.ZodOptional<z.ZodString>>;
        }, z.core.$strip>>;
        password: z.ZodOptional<z.ZodObject<{
            refreshUrl: z.ZodDefault<z.ZodOptional<z.ZodString>>;
            scopes: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodDefault<z.ZodOptional<z.ZodString>>>>>>;
            selectedScopes: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodString>>>;
            'x-scalar-client-id': z.ZodDefault<z.ZodOptional<z.ZodString>>;
            token: z.ZodDefault<z.ZodString>;
            'x-scalar-security-query': z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
            'x-scalar-security-body': z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
            'x-tokenName': z.ZodOptional<z.ZodString>;
            type: z.ZodDefault<z.ZodLiteral<"password">>;
            tokenUrl: z.ZodDefault<z.ZodString>;
            clientSecret: z.ZodDefault<z.ZodString>;
            username: z.ZodDefault<z.ZodString>;
            password: z.ZodDefault<z.ZodString>;
            'x-scalar-credentials-location': z.ZodOptional<z.ZodEnum<{
                header: "header";
                body: "body";
            }>>;
        }, z.core.$strip>>;
        clientCredentials: z.ZodOptional<z.ZodObject<{
            refreshUrl: z.ZodDefault<z.ZodOptional<z.ZodString>>;
            scopes: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodDefault<z.ZodOptional<z.ZodString>>>>>>;
            selectedScopes: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodString>>>;
            'x-scalar-client-id': z.ZodDefault<z.ZodOptional<z.ZodString>>;
            token: z.ZodDefault<z.ZodString>;
            'x-scalar-security-query': z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
            'x-scalar-security-body': z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
            'x-tokenName': z.ZodOptional<z.ZodString>;
            type: z.ZodDefault<z.ZodLiteral<"clientCredentials">>;
            tokenUrl: z.ZodDefault<z.ZodString>;
            clientSecret: z.ZodDefault<z.ZodString>;
            'x-scalar-credentials-location': z.ZodOptional<z.ZodEnum<{
                header: "header";
                body: "body";
            }>>;
        }, z.core.$strip>>;
        authorizationCode: z.ZodOptional<z.ZodObject<{
            refreshUrl: z.ZodDefault<z.ZodOptional<z.ZodString>>;
            scopes: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodDefault<z.ZodOptional<z.ZodString>>>>>>;
            selectedScopes: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodString>>>;
            'x-scalar-client-id': z.ZodDefault<z.ZodOptional<z.ZodString>>;
            token: z.ZodDefault<z.ZodString>;
            'x-scalar-security-query': z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
            'x-scalar-security-body': z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
            'x-tokenName': z.ZodOptional<z.ZodString>;
            type: z.ZodDefault<z.ZodLiteral<"authorizationCode">>;
            authorizationUrl: z.ZodDefault<z.ZodString>;
            'x-usePkce': z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                "SHA-256": "SHA-256";
                plain: "plain";
                no: "no";
            }>>>;
            'x-scalar-redirect-uri': z.ZodDefault<z.ZodOptional<z.ZodString>>;
            tokenUrl: z.ZodDefault<z.ZodString>;
            clientSecret: z.ZodDefault<z.ZodString>;
            'x-scalar-credentials-location': z.ZodOptional<z.ZodEnum<{
                header: "header";
                body: "body";
            }>>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    uid: z.core.$ZodBranded<z.ZodDefault<z.ZodString>, "securityScheme", "out">;
    nameKey: z.ZodDefault<z.ZodOptional<z.ZodString>>;
}, z.core.$strip>;
export type SecuritySchemeOauth2 = z.infer<typeof securityOauthSchema>;
export type SecuritySchemeOauth2Payload = z.input<typeof securityOauthSchema>;
export type Oauth2Flow = NonNullable<SecuritySchemeOauth2['flows']['authorizationCode' | 'clientCredentials' | 'implicit' | 'password']>;
/** Payload for the oauth 2 flows + extensions */
export type Oauth2FlowPayload = NonNullable<SecuritySchemeOauth2Payload['flows']>['authorizationCode' | 'clientCredentials' | 'implicit' | 'password'] & Record<`x-${string}`, string>;
/**
 * Security Requirement
 * Lists the required security schemes to execute this operation OR the whole collection/spec.
 * The name used for each property MUST correspond to a security scheme declared in the Security
 * Schemes under the Components Object.
 *
 * The key (name) here will be matched to the key of the securityScheme for linking
 *
 * @see https://spec.openapis.org/oas/latest.html#security-requirement-object
 */
export declare const oasSecurityRequirementSchema: z.ZodRecord<z.ZodString, z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodString>>>>;
/** OAS Compliant security schemes */
export declare const oasSecuritySchemeSchema: z.ZodUnion<readonly [z.ZodObject<{
    description: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"apiKey">;
    name: z.ZodDefault<z.ZodOptional<z.ZodString>>;
    in: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        cookie: "cookie";
        query: "query";
        header: "header";
    }>>>>;
}, z.core.$strip>, z.ZodObject<{
    description: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"http">;
    scheme: z.ZodDefault<z.ZodOptional<z.ZodPipe<z.ZodString, z.ZodEnum<{
        basic: "basic";
        bearer: "bearer";
    }>>>>;
    bearerFormat: z.ZodDefault<z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"JWT">, z.ZodString]>>>;
}, z.core.$strip>, z.ZodObject<{
    description: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"oauth2">;
    'x-default-scopes': z.ZodOptional<z.ZodArray<z.ZodString>>;
    flows: z.ZodDefault<z.ZodObject<{
        implicit: z.ZodOptional<z.ZodObject<{
            refreshUrl: z.ZodDefault<z.ZodOptional<z.ZodString>>;
            scopes: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodDefault<z.ZodOptional<z.ZodString>>>>>>;
            selectedScopes: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodString>>>;
            'x-scalar-client-id': z.ZodDefault<z.ZodOptional<z.ZodString>>;
            token: z.ZodDefault<z.ZodString>;
            'x-scalar-security-query': z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
            'x-scalar-security-body': z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
            'x-tokenName': z.ZodOptional<z.ZodString>;
            type: z.ZodDefault<z.ZodLiteral<"implicit">>;
            authorizationUrl: z.ZodDefault<z.ZodString>;
            'x-scalar-redirect-uri': z.ZodDefault<z.ZodOptional<z.ZodString>>;
        }, z.core.$strip>>;
        password: z.ZodOptional<z.ZodObject<{
            refreshUrl: z.ZodDefault<z.ZodOptional<z.ZodString>>;
            scopes: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodDefault<z.ZodOptional<z.ZodString>>>>>>;
            selectedScopes: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodString>>>;
            'x-scalar-client-id': z.ZodDefault<z.ZodOptional<z.ZodString>>;
            token: z.ZodDefault<z.ZodString>;
            'x-scalar-security-query': z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
            'x-scalar-security-body': z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
            'x-tokenName': z.ZodOptional<z.ZodString>;
            type: z.ZodDefault<z.ZodLiteral<"password">>;
            tokenUrl: z.ZodDefault<z.ZodString>;
            clientSecret: z.ZodDefault<z.ZodString>;
            username: z.ZodDefault<z.ZodString>;
            password: z.ZodDefault<z.ZodString>;
            'x-scalar-credentials-location': z.ZodOptional<z.ZodEnum<{
                header: "header";
                body: "body";
            }>>;
        }, z.core.$strip>>;
        clientCredentials: z.ZodOptional<z.ZodObject<{
            refreshUrl: z.ZodDefault<z.ZodOptional<z.ZodString>>;
            scopes: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodDefault<z.ZodOptional<z.ZodString>>>>>>;
            selectedScopes: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodString>>>;
            'x-scalar-client-id': z.ZodDefault<z.ZodOptional<z.ZodString>>;
            token: z.ZodDefault<z.ZodString>;
            'x-scalar-security-query': z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
            'x-scalar-security-body': z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
            'x-tokenName': z.ZodOptional<z.ZodString>;
            type: z.ZodDefault<z.ZodLiteral<"clientCredentials">>;
            tokenUrl: z.ZodDefault<z.ZodString>;
            clientSecret: z.ZodDefault<z.ZodString>;
            'x-scalar-credentials-location': z.ZodOptional<z.ZodEnum<{
                header: "header";
                body: "body";
            }>>;
        }, z.core.$strip>>;
        authorizationCode: z.ZodOptional<z.ZodObject<{
            refreshUrl: z.ZodDefault<z.ZodOptional<z.ZodString>>;
            scopes: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodDefault<z.ZodOptional<z.ZodString>>>>>>;
            selectedScopes: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodString>>>;
            'x-scalar-client-id': z.ZodDefault<z.ZodOptional<z.ZodString>>;
            token: z.ZodDefault<z.ZodString>;
            'x-scalar-security-query': z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
            'x-scalar-security-body': z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
            'x-tokenName': z.ZodOptional<z.ZodString>;
            type: z.ZodDefault<z.ZodLiteral<"authorizationCode">>;
            authorizationUrl: z.ZodDefault<z.ZodString>;
            'x-usePkce': z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                "SHA-256": "SHA-256";
                plain: "plain";
                no: "no";
            }>>>;
            'x-scalar-redirect-uri': z.ZodDefault<z.ZodOptional<z.ZodString>>;
            tokenUrl: z.ZodDefault<z.ZodString>;
            clientSecret: z.ZodDefault<z.ZodString>;
            'x-scalar-credentials-location': z.ZodOptional<z.ZodEnum<{
                header: "header";
                body: "body";
            }>>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
    description: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"openIdConnect">;
    openIdConnectUrl: z.ZodDefault<z.ZodOptional<z.ZodString>>;
}, z.core.$strip>]>;
/** Extended security schemes for workspace usage */
export declare const securitySchemeSchema: z.ZodPipe<z.ZodDiscriminatedUnion<[z.ZodObject<{
    description: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"apiKey">;
    name: z.ZodDefault<z.ZodOptional<z.ZodString>>;
    in: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        cookie: "cookie";
        query: "query";
        header: "header";
    }>>>>;
    uid: z.core.$ZodBranded<z.ZodDefault<z.ZodString>, "securityScheme", "out">;
    nameKey: z.ZodDefault<z.ZodOptional<z.ZodString>>;
    value: z.ZodDefault<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    description: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"http">;
    scheme: z.ZodDefault<z.ZodOptional<z.ZodPipe<z.ZodString, z.ZodEnum<{
        basic: "basic";
        bearer: "bearer";
    }>>>>;
    bearerFormat: z.ZodDefault<z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"JWT">, z.ZodString]>>>;
    uid: z.core.$ZodBranded<z.ZodDefault<z.ZodString>, "securityScheme", "out">;
    nameKey: z.ZodDefault<z.ZodOptional<z.ZodString>>;
    username: z.ZodDefault<z.ZodString>;
    password: z.ZodDefault<z.ZodString>;
    token: z.ZodDefault<z.ZodString>;
}, z.core.$strip>, z.ZodObject<{
    description: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"openIdConnect">;
    openIdConnectUrl: z.ZodDefault<z.ZodOptional<z.ZodString>>;
    uid: z.core.$ZodBranded<z.ZodDefault<z.ZodString>, "securityScheme", "out">;
    nameKey: z.ZodDefault<z.ZodOptional<z.ZodString>>;
}, z.core.$strip>, z.ZodObject<{
    description: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"oauth2">;
    'x-default-scopes': z.ZodOptional<z.ZodArray<z.ZodString>>;
    flows: z.ZodDefault<z.ZodObject<{
        implicit: z.ZodOptional<z.ZodObject<{
            refreshUrl: z.ZodDefault<z.ZodOptional<z.ZodString>>;
            scopes: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodDefault<z.ZodOptional<z.ZodString>>>>>>;
            selectedScopes: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodString>>>;
            'x-scalar-client-id': z.ZodDefault<z.ZodOptional<z.ZodString>>;
            token: z.ZodDefault<z.ZodString>;
            'x-scalar-security-query': z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
            'x-scalar-security-body': z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
            'x-tokenName': z.ZodOptional<z.ZodString>;
            type: z.ZodDefault<z.ZodLiteral<"implicit">>;
            authorizationUrl: z.ZodDefault<z.ZodString>;
            'x-scalar-redirect-uri': z.ZodDefault<z.ZodOptional<z.ZodString>>;
        }, z.core.$strip>>;
        password: z.ZodOptional<z.ZodObject<{
            refreshUrl: z.ZodDefault<z.ZodOptional<z.ZodString>>;
            scopes: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodDefault<z.ZodOptional<z.ZodString>>>>>>;
            selectedScopes: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodString>>>;
            'x-scalar-client-id': z.ZodDefault<z.ZodOptional<z.ZodString>>;
            token: z.ZodDefault<z.ZodString>;
            'x-scalar-security-query': z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
            'x-scalar-security-body': z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
            'x-tokenName': z.ZodOptional<z.ZodString>;
            type: z.ZodDefault<z.ZodLiteral<"password">>;
            tokenUrl: z.ZodDefault<z.ZodString>;
            clientSecret: z.ZodDefault<z.ZodString>;
            username: z.ZodDefault<z.ZodString>;
            password: z.ZodDefault<z.ZodString>;
            'x-scalar-credentials-location': z.ZodOptional<z.ZodEnum<{
                header: "header";
                body: "body";
            }>>;
        }, z.core.$strip>>;
        clientCredentials: z.ZodOptional<z.ZodObject<{
            refreshUrl: z.ZodDefault<z.ZodOptional<z.ZodString>>;
            scopes: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodDefault<z.ZodOptional<z.ZodString>>>>>>;
            selectedScopes: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodString>>>;
            'x-scalar-client-id': z.ZodDefault<z.ZodOptional<z.ZodString>>;
            token: z.ZodDefault<z.ZodString>;
            'x-scalar-security-query': z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
            'x-scalar-security-body': z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
            'x-tokenName': z.ZodOptional<z.ZodString>;
            type: z.ZodDefault<z.ZodLiteral<"clientCredentials">>;
            tokenUrl: z.ZodDefault<z.ZodString>;
            clientSecret: z.ZodDefault<z.ZodString>;
            'x-scalar-credentials-location': z.ZodOptional<z.ZodEnum<{
                header: "header";
                body: "body";
            }>>;
        }, z.core.$strip>>;
        authorizationCode: z.ZodOptional<z.ZodObject<{
            refreshUrl: z.ZodDefault<z.ZodOptional<z.ZodString>>;
            scopes: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodDefault<z.ZodOptional<z.ZodString>>>>>>;
            selectedScopes: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodString>>>;
            'x-scalar-client-id': z.ZodDefault<z.ZodOptional<z.ZodString>>;
            token: z.ZodDefault<z.ZodString>;
            'x-scalar-security-query': z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
            'x-scalar-security-body': z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
            'x-tokenName': z.ZodOptional<z.ZodString>;
            type: z.ZodDefault<z.ZodLiteral<"authorizationCode">>;
            authorizationUrl: z.ZodDefault<z.ZodString>;
            'x-usePkce': z.ZodDefault<z.ZodOptional<z.ZodEnum<{
                "SHA-256": "SHA-256";
                plain: "plain";
                no: "no";
            }>>>;
            'x-scalar-redirect-uri': z.ZodDefault<z.ZodOptional<z.ZodString>>;
            tokenUrl: z.ZodDefault<z.ZodString>;
            clientSecret: z.ZodDefault<z.ZodString>;
            'x-scalar-credentials-location': z.ZodOptional<z.ZodEnum<{
                header: "header";
                body: "body";
            }>>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
    uid: z.core.$ZodBranded<z.ZodDefault<z.ZodString>, "securityScheme", "out">;
    nameKey: z.ZodDefault<z.ZodOptional<z.ZodString>>;
}, z.core.$strip>], "type">, z.ZodTransform<{
    type: "apiKey";
    name: string;
    in: "cookie" | "query" | "header";
    uid: string & z.core.$brand<"securityScheme">;
    nameKey: string;
    value: string;
    description?: string | undefined;
} | {
    type: "http";
    scheme: "basic" | "bearer";
    bearerFormat: string;
    uid: string & z.core.$brand<"securityScheme">;
    nameKey: string;
    username: string;
    password: string;
    token: string;
    description?: string | undefined;
} | {
    type: "openIdConnect";
    openIdConnectUrl: string;
    uid: string & z.core.$brand<"securityScheme">;
    nameKey: string;
    description?: string | undefined;
} | {
    type: "oauth2";
    flows: {
        implicit?: {
            refreshUrl: string;
            scopes: Record<string, string>;
            selectedScopes: string[];
            'x-scalar-client-id': string;
            token: string;
            type: "implicit";
            authorizationUrl: string;
            'x-scalar-redirect-uri': string;
            'x-scalar-security-query'?: Record<string, string> | undefined;
            'x-scalar-security-body'?: Record<string, string> | undefined;
            'x-tokenName'?: string | undefined;
        } | undefined;
        password?: {
            refreshUrl: string;
            scopes: Record<string, string>;
            selectedScopes: string[];
            'x-scalar-client-id': string;
            token: string;
            type: "password";
            tokenUrl: string;
            clientSecret: string;
            username: string;
            password: string;
            'x-scalar-security-query'?: Record<string, string> | undefined;
            'x-scalar-security-body'?: Record<string, string> | undefined;
            'x-tokenName'?: string | undefined;
            'x-scalar-credentials-location'?: "header" | "body" | undefined;
        } | undefined;
        clientCredentials?: {
            refreshUrl: string;
            scopes: Record<string, string>;
            selectedScopes: string[];
            'x-scalar-client-id': string;
            token: string;
            type: "clientCredentials";
            tokenUrl: string;
            clientSecret: string;
            'x-scalar-security-query'?: Record<string, string> | undefined;
            'x-scalar-security-body'?: Record<string, string> | undefined;
            'x-tokenName'?: string | undefined;
            'x-scalar-credentials-location'?: "header" | "body" | undefined;
        } | undefined;
        authorizationCode?: {
            refreshUrl: string;
            scopes: Record<string, string>;
            selectedScopes: string[];
            'x-scalar-client-id': string;
            token: string;
            type: "authorizationCode";
            authorizationUrl: string;
            'x-usePkce': "SHA-256" | "plain" | "no";
            'x-scalar-redirect-uri': string;
            tokenUrl: string;
            clientSecret: string;
            'x-scalar-security-query'?: Record<string, string> | undefined;
            'x-scalar-security-body'?: Record<string, string> | undefined;
            'x-tokenName'?: string | undefined;
            'x-scalar-credentials-location'?: "header" | "body" | undefined;
        } | undefined;
    };
    uid: string & z.core.$brand<"securityScheme">;
    nameKey: string;
    description?: string | undefined;
    'x-default-scopes'?: string[] | undefined;
}, {
    type: "apiKey";
    name: string;
    in: "cookie" | "query" | "header";
    uid: string & z.core.$brand<"securityScheme">;
    nameKey: string;
    value: string;
    description?: string | undefined;
} | {
    type: "http";
    scheme: "basic" | "bearer";
    bearerFormat: string;
    uid: string & z.core.$brand<"securityScheme">;
    nameKey: string;
    username: string;
    password: string;
    token: string;
    description?: string | undefined;
} | {
    type: "openIdConnect";
    openIdConnectUrl: string;
    uid: string & z.core.$brand<"securityScheme">;
    nameKey: string;
    description?: string | undefined;
} | {
    type: "oauth2";
    flows: {
        implicit?: {
            refreshUrl: string;
            scopes: Record<string, string>;
            selectedScopes: string[];
            'x-scalar-client-id': string;
            token: string;
            type: "implicit";
            authorizationUrl: string;
            'x-scalar-redirect-uri': string;
            'x-scalar-security-query'?: Record<string, string> | undefined;
            'x-scalar-security-body'?: Record<string, string> | undefined;
            'x-tokenName'?: string | undefined;
        } | undefined;
        password?: {
            refreshUrl: string;
            scopes: Record<string, string>;
            selectedScopes: string[];
            'x-scalar-client-id': string;
            token: string;
            type: "password";
            tokenUrl: string;
            clientSecret: string;
            username: string;
            password: string;
            'x-scalar-security-query'?: Record<string, string> | undefined;
            'x-scalar-security-body'?: Record<string, string> | undefined;
            'x-tokenName'?: string | undefined;
            'x-scalar-credentials-location'?: "header" | "body" | undefined;
        } | undefined;
        clientCredentials?: {
            refreshUrl: string;
            scopes: Record<string, string>;
            selectedScopes: string[];
            'x-scalar-client-id': string;
            token: string;
            type: "clientCredentials";
            tokenUrl: string;
            clientSecret: string;
            'x-scalar-security-query'?: Record<string, string> | undefined;
            'x-scalar-security-body'?: Record<string, string> | undefined;
            'x-tokenName'?: string | undefined;
            'x-scalar-credentials-location'?: "header" | "body" | undefined;
        } | undefined;
        authorizationCode?: {
            refreshUrl: string;
            scopes: Record<string, string>;
            selectedScopes: string[];
            'x-scalar-client-id': string;
            token: string;
            type: "authorizationCode";
            authorizationUrl: string;
            'x-usePkce': "SHA-256" | "plain" | "no";
            'x-scalar-redirect-uri': string;
            tokenUrl: string;
            clientSecret: string;
            'x-scalar-security-query'?: Record<string, string> | undefined;
            'x-scalar-security-body'?: Record<string, string> | undefined;
            'x-tokenName'?: string | undefined;
            'x-scalar-credentials-location'?: "header" | "body" | undefined;
        } | undefined;
    };
    uid: string & z.core.$brand<"securityScheme">;
    nameKey: string;
    description?: string | undefined;
    'x-default-scopes'?: string[] | undefined;
}>>;
/**
 * Security Scheme Object
 *
 * @see https://spec.openapis.org/oas/latest.html#security-scheme-object
 */
export type SecurityScheme = z.infer<typeof securitySchemeSchema>;
export type SecuritySchemePayload = z.input<typeof securitySchemeSchema>;
//# sourceMappingURL=security-scheme.d.ts.map