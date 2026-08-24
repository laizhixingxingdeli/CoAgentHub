import { z } from 'zod';
import type { ApiReferenceConfigurationWithMultipleSources } from './api-reference-configuration.js';
/**
 * Zod schema for HTML rendering configuration
 */
export declare const htmlRenderingConfigurationSchema: z.ZodObject<{
    cdn: z.ZodDefault<z.ZodOptional<z.ZodString>>;
    pageTitle: z.ZodDefault<z.ZodOptional<z.ZodString>>;
}, z.core.$strip>;
/**
 * The configuration for the static HTML rendering using the CDN.
 *
 * It's the ApiReferenceConfiguration, but extended with the `pageTitle` and `cdn` options.
 */
export type HtmlRenderingConfiguration = Partial<ApiReferenceConfigurationWithMultipleSources> & z.infer<typeof htmlRenderingConfigurationSchema>;
//# sourceMappingURL=html-rendering-configuration.d.ts.map