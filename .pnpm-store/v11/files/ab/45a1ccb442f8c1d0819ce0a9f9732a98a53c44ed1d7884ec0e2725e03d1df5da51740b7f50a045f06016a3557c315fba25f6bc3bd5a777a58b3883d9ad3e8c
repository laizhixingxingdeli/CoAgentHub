import { z } from 'zod';
export declare const hooksSchema: z.ZodObject<{
    onBeforeRequest: z.ZodOptional<z.ZodFunction<z.ZodTuple<readonly [z.ZodObject<{
        request: z.ZodCustom<Request, Request>;
    }, z.core.$strip>], null>, z.core.$ZodFunctionOut>>;
    onResponseReceived: z.ZodOptional<z.ZodFunction<z.ZodTuple<readonly [z.ZodObject<{
        response: z.ZodCustom<Response, Response>;
        operation: z.ZodRecord<z.ZodString, z.ZodAny>;
    }, z.core.$strip>], null>, z.core.$ZodFunctionOut>>;
}, z.core.$strip>;
/**
 * An API client plugin that can connect into request and response hooks
 */
export declare const apiClientPluginSchema: z.ZodFunction<z.ZodTuple<readonly [], null>, z.ZodObject<{
    name: z.ZodString;
    views: z.ZodOptional<z.ZodObject<{
        'request.section': z.ZodOptional<z.ZodArray<z.ZodObject<{
            title: z.ZodOptional<z.ZodString>;
            component: z.ZodUnknown;
            props: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodAny>>;
        }, z.core.$strip>>>;
        'response.section': z.ZodOptional<z.ZodArray<z.ZodObject<{
            title: z.ZodOptional<z.ZodString>;
            component: z.ZodUnknown;
            props: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodAny>>;
        }, z.core.$strip>>>;
    }, z.core.$strip>>;
    hooks: z.ZodOptional<z.ZodObject<{
        onBeforeRequest: z.ZodOptional<z.ZodFunction<z.ZodTuple<readonly [z.ZodObject<{
            request: z.ZodCustom<Request, Request>;
        }, z.core.$strip>], null>, z.core.$ZodFunctionOut>>;
        onResponseReceived: z.ZodOptional<z.ZodFunction<z.ZodTuple<readonly [z.ZodObject<{
            response: z.ZodCustom<Response, Response>;
            operation: z.ZodRecord<z.ZodString, z.ZodAny>;
        }, z.core.$strip>], null>, z.core.$ZodFunctionOut>>;
    }, z.core.$strip>>;
}, z.core.$strip>>;
export type ApiClientPlugin = z.infer<typeof apiClientPluginSchema>;
//# sourceMappingURL=api-client-plugin.d.ts.map