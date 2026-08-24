import { p as isWindowDefined, e as isFunction, q as SWRConfigContext, m as mergeObjects, d as defaultConfig, s as serialize, a as SWRGlobalState, o as cache, i as isUndefined, I as IS_SERVER, t as mergeConfigs } from '../config-context-ext53wcz.mjs';
export { j as IS_REACT_LEGACY, O as OBJECT, S as SWRConfig, U as UNDEFINED, v as compare, c as createCacheHelper, w as defaultConfigOptions, g as getTimestamp, x as hasRequestAnimationFrame, y as initCache, f as internalMutate, z as isDocumentDefined, A as isLegacyDeno, b as isPromiseLike, k as mutate, n as noop, B as preset, r as rAF, C as revalidateEvents, D as slowConnection, G as stableHash, l as unload, u as useIsomorphicLayoutEffect } from '../config-context-ext53wcz.mjs';
import { INFINITE_PREFIX } from './constants.mjs';
import React, { useContext, useMemo } from 'react';

// @ts-expect-error
const enableDevtools = isWindowDefined && window.__SWR_DEVTOOLS_USE__;
const use = enableDevtools ? window.__SWR_DEVTOOLS_USE__ : [];
const setupDevTools = ()=>{
    if (enableDevtools) {
        // @ts-expect-error
        window.__SWR_DEVTOOLS_REACT__ = React;
    }
};

const normalize = (args)=>{
    return isFunction(args[1]) ? [
        args[0],
        args[1],
        args[2] || {}
    ] : [
        args[0],
        null,
        (args[1] === null ? args[2] : args[1]) || {}
    ];
};

const useSWRConfig = ()=>{
    const parentConfig = useContext(SWRConfigContext);
    const mergedConfig = useMemo(()=>mergeObjects(defaultConfig, parentConfig), [
        parentConfig
    ]);
    return mergedConfig;
};

const preload = (key_, fetcher)=>{
    // preload should be a no-op on the server
    if (IS_SERVER) {
        return undefined;
    }
    const [key, fnArg] = serialize(key_);
    const [, , , PRELOAD] = SWRGlobalState.get(cache);
    // Prevent preload to be called multiple times before used.
    if (PRELOAD[key]) {
        return PRELOAD[key];
    }
    const req = fetcher(fnArg);
    PRELOAD[key] = req;
    return req;
};
const middleware = (useSWRNext)=>(key_, fetcher_, config)=>{
        // fetcher might be a sync function, so this should not be an async function
        const fetcher = fetcher_ && ((...args)=>{
            const [key] = serialize(key_);
            const [, , , PRELOAD] = SWRGlobalState.get(cache);
            if (key.startsWith(INFINITE_PREFIX)) {
                // we want the infinite fetcher to be called.
                // handling of the PRELOAD cache happens there.
                return fetcher_(...args);
            }
            const req = PRELOAD[key];
            if (isUndefined(req)) return fetcher_(...args);
            delete PRELOAD[key];
            return req;
        });
        return useSWRNext(key_, fetcher, config);
    };

const BUILT_IN_MIDDLEWARE = use.concat(middleware);

// It's tricky to pass generic types as parameters, so we just directly override
// the types here.
const withArgs = (hook)=>{
    return function useSWRArgs(...args) {
        // Get the default and inherited configuration.
        const fallbackConfig = useSWRConfig();
        // Normalize arguments.
        const [key, fn, _config] = normalize(args);
        // Merge configurations.
        const config = mergeConfigs(fallbackConfig, _config);
        // Apply middleware
        let next = hook;
        const { use } = config;
        const middleware = (use || []).concat(BUILT_IN_MIDDLEWARE);
        for(let i = middleware.length; i--;){
            next = middleware[i](next);
        }
        return next(key, fn || config.fetcher || null, config);
    };
};

// Add a callback function to a list of keyed callback functions and return
// the unsubscribe function.
const subscribeCallback = (key, callbacks, callback)=>{
    const keyedRevalidators = callbacks[key] || (callbacks[key] = []);
    keyedRevalidators.push(callback);
    return ()=>{
        const index = keyedRevalidators.indexOf(callback);
        if (index >= 0) {
            // O(1): faster than splice
            keyedRevalidators[index] = keyedRevalidators[keyedRevalidators.length - 1];
            keyedRevalidators.pop();
        }
    };
};

// Create a custom hook with a middleware
const withMiddleware = (useSWR, middleware)=>{
    return (...args)=>{
        const [key, fn, config] = normalize(args);
        const uses = (config.use || []).concat(middleware);
        return useSWR(key, fn, {
            ...config,
            use: uses
        });
    };
};

setupDevTools();

export { INFINITE_PREFIX, IS_SERVER, SWRGlobalState, cache, defaultConfig, isFunction, isUndefined, isWindowDefined, mergeConfigs, mergeObjects, normalize, preload, serialize, subscribeCallback, useSWRConfig, withArgs, withMiddleware };
