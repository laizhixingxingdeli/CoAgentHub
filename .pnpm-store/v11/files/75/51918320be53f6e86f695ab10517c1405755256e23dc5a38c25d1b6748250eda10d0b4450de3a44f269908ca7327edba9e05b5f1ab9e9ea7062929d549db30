Object.defineProperty(exports, '__esModule', { value: true });

var bunchee_group_0 = require('../config-context-s960zqob.js');
var _internal_constants = require('./constants.js');
var React = require('react');

function _interopDefault (e) { return e && e.__esModule ? e : { default: e }; }

var React__default = /*#__PURE__*/_interopDefault(React);

// @ts-expect-error
const enableDevtools = bunchee_group_0.isWindowDefined && window.__SWR_DEVTOOLS_USE__;
const use = enableDevtools ? window.__SWR_DEVTOOLS_USE__ : [];
const setupDevTools = ()=>{
    if (enableDevtools) {
        // @ts-expect-error
        window.__SWR_DEVTOOLS_REACT__ = React__default.default;
    }
};

const normalize = (args)=>{
    return bunchee_group_0.isFunction(args[1]) ? [
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
    const parentConfig = React.useContext(bunchee_group_0.SWRConfigContext);
    const mergedConfig = React.useMemo(()=>bunchee_group_0.mergeObjects(bunchee_group_0.defaultConfig, parentConfig), [
        parentConfig
    ]);
    return mergedConfig;
};

const preload = (key_, fetcher)=>{
    // preload should be a no-op on the server
    if (bunchee_group_0.IS_SERVER) {
        return undefined;
    }
    const [key, fnArg] = bunchee_group_0.serialize(key_);
    const [, , , PRELOAD] = bunchee_group_0.SWRGlobalState.get(bunchee_group_0.cache);
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
            const [key] = bunchee_group_0.serialize(key_);
            const [, , , PRELOAD] = bunchee_group_0.SWRGlobalState.get(bunchee_group_0.cache);
            if (key.startsWith(_internal_constants.INFINITE_PREFIX)) {
                // we want the infinite fetcher to be called.
                // handling of the PRELOAD cache happens there.
                return fetcher_(...args);
            }
            const req = PRELOAD[key];
            if (bunchee_group_0.isUndefined(req)) return fetcher_(...args);
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
        const config = bunchee_group_0.mergeConfigs(fallbackConfig, _config);
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

exports.IS_REACT_LEGACY = bunchee_group_0.IS_REACT_LEGACY;
exports.IS_SERVER = bunchee_group_0.IS_SERVER;
exports.OBJECT = bunchee_group_0.OBJECT;
exports.SWRConfig = bunchee_group_0.SWRConfig;
exports.SWRGlobalState = bunchee_group_0.SWRGlobalState;
exports.UNDEFINED = bunchee_group_0.UNDEFINED;
exports.cache = bunchee_group_0.cache;
exports.compare = bunchee_group_0.compare;
exports.createCacheHelper = bunchee_group_0.createCacheHelper;
exports.defaultConfig = bunchee_group_0.defaultConfig;
exports.defaultConfigOptions = bunchee_group_0.defaultConfigOptions;
exports.getTimestamp = bunchee_group_0.getTimestamp;
exports.hasRequestAnimationFrame = bunchee_group_0.hasRequestAnimationFrame;
exports.initCache = bunchee_group_0.initCache;
exports.internalMutate = bunchee_group_0.internalMutate;
exports.isDocumentDefined = bunchee_group_0.isDocumentDefined;
exports.isFunction = bunchee_group_0.isFunction;
exports.isLegacyDeno = bunchee_group_0.isLegacyDeno;
exports.isPromiseLike = bunchee_group_0.isPromiseLike;
exports.isUndefined = bunchee_group_0.isUndefined;
exports.isWindowDefined = bunchee_group_0.isWindowDefined;
exports.mergeConfigs = bunchee_group_0.mergeConfigs;
exports.mergeObjects = bunchee_group_0.mergeObjects;
exports.mutate = bunchee_group_0.mutate;
exports.noop = bunchee_group_0.noop;
exports.preset = bunchee_group_0.preset;
exports.rAF = bunchee_group_0.rAF;
exports.revalidateEvents = bunchee_group_0.events;
exports.serialize = bunchee_group_0.serialize;
exports.slowConnection = bunchee_group_0.slowConnection;
exports.stableHash = bunchee_group_0.stableHash;
exports.unload = bunchee_group_0.unload;
exports.useIsomorphicLayoutEffect = bunchee_group_0.useIsomorphicLayoutEffect;
exports.INFINITE_PREFIX = _internal_constants.INFINITE_PREFIX;
exports.normalize = normalize;
exports.preload = preload;
exports.subscribeCallback = subscribeCallback;
exports.useSWRConfig = useSWRConfig;
exports.withArgs = withArgs;
exports.withMiddleware = withMiddleware;
