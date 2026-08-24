import z from 'zod';
/**
 * A source is any potential document input used for API Reference
 * and API Client integrations. Sources may be specified in the configuration
 * or used independently. Some configurations may have multiple sources.
 */
export declare const sourceConfigurationSchema: z.ZodObject<{
    default: z.ZodCatch<z.ZodOptional<z.ZodDefault<z.ZodBoolean>>>;
    url: z.ZodOptional<z.ZodString>;
    content: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNull, z.ZodRecord<z.ZodString, z.ZodAny>, z.ZodFunction<z.ZodTuple<readonly [], null>, z.ZodRecord<z.ZodString, z.ZodAny>>]>>;
    title: z.ZodOptional<z.ZodString>;
    slug: z.ZodOptional<z.ZodString>;
    spec: z.ZodOptional<z.ZodObject<{
        url: z.ZodOptional<z.ZodString>;
        content: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNull, z.ZodRecord<z.ZodString, z.ZodAny>, z.ZodFunction<z.ZodTuple<readonly [], null>, z.ZodRecord<z.ZodString, z.ZodAny>>]>>;
    }, z.core.$strip>>;
    agent: z.ZodOptional<z.ZodObject<{
        key: z.ZodOptional<z.ZodString>;
        disabled: z.ZodOptional<z.ZodBoolean>;
        hideAddApi: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type SourceConfiguration = z.infer<typeof sourceConfigurationSchema>;
//# sourceMappingURL=source-configuration.d.ts.map