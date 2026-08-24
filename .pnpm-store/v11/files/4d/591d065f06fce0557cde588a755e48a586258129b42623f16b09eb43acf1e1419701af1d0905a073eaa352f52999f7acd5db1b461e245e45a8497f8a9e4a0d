import { z } from 'zod';
declare const openApiExtensionSchema: z.ZodObject<{
    name: z.ZodString;
    component: z.ZodUnknown;
    renderer: z.ZodOptional<z.ZodUnknown>;
}, z.core.$strip>;
declare const viewComponentSchema: z.ZodObject<{
    component: z.ZodUnknown;
    renderer: z.ZodOptional<z.ZodUnknown>;
    props: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodAny>>;
}, z.core.$strip>;
export declare const apiReferencePluginSchema: z.ZodFunction<z.ZodTuple<readonly [], null>, z.ZodObject<{
    name: z.ZodString;
    extensions: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        component: z.ZodUnknown;
        renderer: z.ZodOptional<z.ZodUnknown>;
    }, z.core.$strip>>;
    views: z.ZodOptional<z.ZodObject<{
        'content.end': z.ZodOptional<z.ZodArray<z.ZodObject<{
            component: z.ZodUnknown;
            renderer: z.ZodOptional<z.ZodUnknown>;
            props: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodAny>>;
        }, z.core.$strip>>>;
    }, z.core.$strip>>;
}, z.core.$strip>>;
export type SpecificationExtension = z.infer<typeof openApiExtensionSchema>;
export type ViewComponent = z.infer<typeof viewComponentSchema>;
export type ApiReferencePlugin = z.infer<typeof apiReferencePluginSchema>;
export {};
//# sourceMappingURL=api-reference-plugin.d.ts.map