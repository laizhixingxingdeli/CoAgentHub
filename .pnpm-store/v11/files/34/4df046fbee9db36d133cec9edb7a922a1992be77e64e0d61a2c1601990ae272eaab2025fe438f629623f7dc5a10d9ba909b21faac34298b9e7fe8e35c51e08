import { type ZodType, z } from 'zod';
import type { AuthenticationConfiguration } from './authentication-configuration.js';
import { type SourceConfiguration } from './source-configuration.js';
/**
 * Standard configuration for the Api Reference.
 *
 * This is used internally to the configure the applications and does not include the sources.
 *
 * Sources should only be specified in the user facing configurations.
 *
 * In the the future it is likely sources will be removed completely from the configuration and instead
 * specified through a separate addDocument interface.
 */
export declare const apiReferenceConfigurationSchema: z.ZodObject<{
    title: z.ZodOptional<z.ZodString>;
    slug: z.ZodOptional<z.ZodString>;
    authentication: z.ZodOptional<z.ZodAny>;
    baseServerURL: z.ZodOptional<z.ZodString>;
    hideClientButton: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodBoolean>>>;
    proxyUrl: z.ZodOptional<z.ZodString>;
    searchHotKey: z.ZodOptional<z.ZodEnum<{
        a: "a";
        b: "b";
        c: "c";
        d: "d";
        e: "e";
        f: "f";
        g: "g";
        h: "h";
        i: "i";
        j: "j";
        k: "k";
        l: "l";
        m: "m";
        n: "n";
        o: "o";
        p: "p";
        q: "q";
        r: "r";
        s: "s";
        t: "t";
        u: "u";
        v: "v";
        w: "w";
        x: "x";
        y: "y";
        z: "z";
    }>>;
    servers: z.ZodOptional<z.ZodArray<z.ZodAny>>;
    showSidebar: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodBoolean>>>;
    showDeveloperTools: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        never: "never";
        always: "always";
        localhost: "localhost";
    }>>>>;
    showToolbar: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        never: "never";
        always: "always";
        localhost: "localhost";
    }>>>>;
    operationTitleSource: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        summary: "summary";
        path: "path";
    }>>>>;
    theme: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        default: "default";
        alternate: "alternate";
        moon: "moon";
        purple: "purple";
        solarized: "solarized";
        bluePlanet: "bluePlanet";
        deepSpace: "deepSpace";
        saturn: "saturn";
        kepler: "kepler";
        elysiajs: "elysiajs";
        fastify: "fastify";
        mars: "mars";
        laserwave: "laserwave";
        none: "none";
    }>>>>;
    _integration: z.ZodOptional<z.ZodNullable<z.ZodEnum<{
        elysiajs: "elysiajs";
        fastify: "fastify";
        adonisjs: "adonisjs";
        astro: "astro";
        docusaurus: "docusaurus";
        dotnet: "dotnet";
        express: "express";
        fastapi: "fastapi";
        go: "go";
        hono: "hono";
        html: "html";
        laravel: "laravel";
        litestar: "litestar";
        nestjs: "nestjs";
        nextjs: "nextjs";
        nitro: "nitro";
        nuxt: "nuxt";
        platformatic: "platformatic";
        react: "react";
        rust: "rust";
        svelte: "svelte";
        vue: "vue";
    }>>>;
    onRequestSent: z.ZodOptional<z.ZodFunction<z.ZodTuple<readonly [z.ZodString], null>, z.ZodVoid>>;
    persistAuth: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodBoolean>>>;
    telemetry: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
    layout: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        modern: "modern";
        classic: "classic";
    }>>>>;
    proxy: z.ZodOptional<z.ZodString>;
    fetch: z.ZodOptional<z.ZodCustom<(input: string | URL | Request, init?: RequestInit) => Promise<Response>, (input: string | URL | Request, init?: RequestInit) => Promise<Response>>>;
    plugins: z.ZodOptional<z.ZodArray<z.ZodFunction<z.ZodTuple<readonly [], null>, z.ZodObject<{
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
    }, z.core.$strip>>>>;
    isEditable: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodBoolean>>>;
    isLoading: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodBoolean>>>;
    hideModels: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodBoolean>>>;
    documentDownloadType: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodEnum<{
        none: "none";
        yaml: "yaml";
        json: "json";
        both: "both";
        direct: "direct";
    }>>>>;
    hideDownloadButton: z.ZodOptional<z.ZodBoolean>;
    hideTestRequestButton: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodBoolean>>>;
    hideSearch: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodBoolean>>>;
    showOperationId: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodBoolean>>>;
    darkMode: z.ZodOptional<z.ZodBoolean>;
    forceDarkModeState: z.ZodOptional<z.ZodEnum<{
        dark: "dark";
        light: "light";
    }>>;
    hideDarkModeToggle: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodBoolean>>>;
    metaData: z.ZodOptional<z.ZodAny>;
    favicon: z.ZodOptional<z.ZodString>;
    hiddenClients: z.ZodOptional<z.ZodUnion<readonly [z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodBoolean, z.ZodArray<z.ZodString>]>>, z.ZodArray<z.ZodString>, z.ZodLiteral<true>]>>;
    defaultHttpClient: z.ZodOptional<z.ZodObject<{
        targetKey: z.ZodCustom<"c" | "r" | "go" | "rust" | "http" | "clojure" | "csharp" | "dart" | "fsharp" | "java" | "js" | "kotlin" | "node" | "objc" | "ocaml" | "php" | "powershell" | "python" | "ruby" | "shell" | "swift", "c" | "r" | "go" | "rust" | "http" | "clojure" | "csharp" | "dart" | "fsharp" | "java" | "js" | "kotlin" | "node" | "objc" | "ocaml" | "php" | "powershell" | "python" | "ruby" | "shell" | "swift">;
        clientKey: z.ZodString;
    }, z.core.$strip>>;
    customCss: z.ZodOptional<z.ZodString>;
    onSpecUpdate: z.ZodOptional<z.ZodFunction<z.ZodTuple<readonly [z.ZodString], null>, z.ZodVoid>>;
    onServerChange: z.ZodOptional<z.ZodFunction<z.ZodTuple<readonly [z.ZodString], null>, z.ZodVoid>>;
    onDocumentSelect: z.ZodType<(() => Promise<void> | void) | undefined>;
    onLoaded: z.ZodType<((slug: string) => Promise<void> | void) | undefined>;
    onBeforeRequest: z.ZodType<((a: {
        request: Request;
    }) => Promise<void> | void) | undefined>;
    onShowMore: z.ZodType<((a: string) => Promise<void> | void) | undefined>;
    onSidebarClick: z.ZodType<((a: string) => Promise<void> | void) | undefined>;
    pathRouting: z.ZodOptional<z.ZodObject<{
        basePath: z.ZodString;
    }, z.core.$strip>>;
    generateHeadingSlug: z.ZodOptional<z.ZodFunction<z.ZodTuple<readonly [z.ZodObject<{
        slug: z.ZodDefault<z.ZodString>;
    }, z.core.$strip>], null>, z.ZodString>>;
    generateModelSlug: z.ZodOptional<z.ZodFunction<z.ZodTuple<readonly [z.ZodObject<{
        name: z.ZodDefault<z.ZodString>;
    }, z.core.$strip>], null>, z.ZodString>>;
    generateTagSlug: z.ZodOptional<z.ZodFunction<z.ZodTuple<readonly [z.ZodObject<{
        name: z.ZodDefault<z.ZodString>;
    }, z.core.$strip>], null>, z.ZodString>>;
    generateOperationSlug: z.ZodOptional<z.ZodFunction<z.ZodTuple<readonly [z.ZodObject<{
        path: z.ZodString;
        operationId: z.ZodOptional<z.ZodString>;
        method: z.ZodString;
        summary: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>], null>, z.ZodString>>;
    generateWebhookSlug: z.ZodOptional<z.ZodFunction<z.ZodTuple<readonly [z.ZodObject<{
        name: z.ZodString;
        method: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>], null>, z.ZodString>>;
    redirect: z.ZodOptional<z.ZodFunction<z.ZodTuple<readonly [z.ZodString], null>, z.ZodOptional<z.ZodNullable<z.ZodString>>>>;
    withDefaultFonts: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodBoolean>>>;
    defaultOpenFirstTag: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodBoolean>>>;
    defaultOpenAllTags: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodBoolean>>>;
    expandAllModelSections: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodBoolean>>>;
    expandAllResponses: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodBoolean>>>;
    tagsSorter: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"alpha">, z.ZodFunction<z.ZodTuple<readonly [z.ZodAny, z.ZodAny], null>, z.ZodNumber>]>>;
    operationsSorter: z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"alpha">, z.ZodLiteral<"method">, z.ZodFunction<z.ZodTuple<readonly [z.ZodAny, z.ZodAny], null>, z.ZodNumber>]>>;
    orderSchemaPropertiesBy: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodUnion<readonly [z.ZodLiteral<"alpha">, z.ZodLiteral<"preserve">]>>>>;
    orderRequiredPropertiesFirst: z.ZodCatch<z.ZodDefault<z.ZodOptional<z.ZodBoolean>>>;
}, z.core.$strip>;
/**
 * Pure configuration without the sources
 *
 * @deprecated Remove this once the types have been fully migrated
 */
export type ApiReferenceConfigurationRaw = Omit<z.infer<typeof apiReferenceConfigurationSchema>, // Remove deprecated attributes
// Remove deprecated attributes
'proxy' | 'spec' | 'authentication' | 'showToolbar'> & {
    authentication?: AuthenticationConfiguration;
};
/**
 * Configuration for the Scalar Api Reference integrations
 *
 * See the type `ApiReferenceConfigurationWithSource` or `AnyApiReferenceConfiguration`\
 * for the configuration that includes the sources for you OpenAPI documents
 */
export type ApiReferenceConfiguration = ApiReferenceConfigurationRaw & {
    /** @deprecated
     * This type now refers to the base configuration that does not include the sources.
     * Use the type `ApiReferenceConfigurationWithSource` instead.
     */
    url?: SourceConfiguration['url'];
    /** @deprecated
     * This type now refers to the base configuration that does not include the sources.
     * Use the type `ApiReferenceConfigurationWithSource` instead.
     */
    content?: SourceConfiguration['content'];
};
/** Migrate the configuration through a transform */
/** Configuration for the Api Reference */
export declare const apiReferenceConfigurationWithSourceSchema: ZodType<Omit<ApiReferenceConfiguration, 'url' | 'content'> & SourceConfiguration>;
/**
 * User facing configuration that includes the document source configuration
 */
export type ApiReferenceConfigurationWithSource = Omit<z.infer<typeof apiReferenceConfigurationWithSourceSchema>, 'proxy' | 'spec' | 'authentication' | 'showToolbar'> & {
    authentication?: AuthenticationConfiguration;
};
/**
 * Configuration for a single config with multiple sources
 * The configuration will be shared between the documents
 */
export type ApiReferenceConfigurationWithMultipleSources = ApiReferenceConfigurationWithSource & {
    sources: SourceConfiguration[];
};
/** Configuration for multiple Api References */
export type AnyApiReferenceConfiguration = Partial<ApiReferenceConfigurationWithSource> | Partial<ApiReferenceConfigurationWithMultipleSources> | Partial<ApiReferenceConfigurationWithSource>[] | Partial<ApiReferenceConfigurationWithMultipleSources>[];
/** Typeguard to check to narrow the configs to the one with sources */
export declare const isConfigurationWithSources: (config: AnyApiReferenceConfiguration) => config is Partial<ApiReferenceConfigurationWithMultipleSources>;
//# sourceMappingURL=api-reference-configuration.d.ts.map