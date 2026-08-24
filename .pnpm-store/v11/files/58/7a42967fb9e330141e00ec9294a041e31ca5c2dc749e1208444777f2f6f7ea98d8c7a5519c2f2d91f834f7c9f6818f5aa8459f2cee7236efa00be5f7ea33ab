import z from 'zod';
export declare const OLD_PROXY_URL = "https://api.scalar.com/request-proxy";
export declare const NEW_PROXY_URL = "https://proxy.scalar.com";
/** Shared configuration for the Api Reference and Api Client */
export declare const baseConfigurationSchema: z.ZodObject<{
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
    plugins: z.ZodOptional<z.ZodArray<z.ZodFunction<z.ZodTuple<readonly [], null>, z.ZodObject<{
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
    }, z.core.$strip>>>>;
    telemetry: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
}, z.core.$strip>;
//# sourceMappingURL=base-configuration.d.ts.map