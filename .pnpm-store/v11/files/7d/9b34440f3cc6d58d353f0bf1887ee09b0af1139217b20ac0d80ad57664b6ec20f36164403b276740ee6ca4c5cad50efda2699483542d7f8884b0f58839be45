import { a as Cache, P as ProviderConfiguration, b as ScopedMutator, U as Unloader, G as GlobalState, c as State, d as FullConfiguration, A as Arguments, M as MutatorCallback, e as MutatorOptions, K as Key, f as Fetcher, g as SWRConfiguration, h as SWRHook, i as Middleware } from '../types-m1fld6v2.js';
export { B as BareFetcher, j as BlockingData, k as Broadcaster, C as CacheData, F as FetcherResponse, I as InternalConfiguration, l as IsLoadingResponse, m as KeyLoader, n as KeyedMutator, o as Mutator, p as MutatorConfig, q as MutatorFn, r as MutatorWrapper, s as PublicConfiguration, R as RevalidateCallback, t as RevalidateEvent, u as Revalidator, v as RevalidatorOptions, S as SWRConfig, w as SWRConfigValue, x as SWRResponse, y as StateDependencies, z as StrictTupleKey, D as UnloadOptions, E as cache, H as compare, J as defaultConfig, L as mutate, N as preload, O as unload, Q as useSWRConfig } from '../types-m1fld6v2.js';
export { e as revalidateEvents } from '../events-ny18dyc2.js';
export { INFINITE_PREFIX } from './constants.js';
import react from 'react';
export { s as serialize } from '../serialize-f94ud86v.js';

declare const initCache: <Data = any>(provider: Cache<Data>, options?: Partial<ProviderConfiguration>) => [Cache<Data>, ScopedMutator, () => void, () => void, Unloader] | [Cache<Data>, ScopedMutator, undefined, undefined, Unloader] | undefined;

declare const IS_REACT_LEGACY = false;
declare const IS_SERVER: boolean;
declare const rAF: (f: (...args: any[]) => void) => number | ReturnType<typeof setTimeout>;
declare const useIsomorphicLayoutEffect: typeof react.useEffect;
declare const slowConnection: boolean | undefined;

declare const SWRGlobalState: WeakMap<Cache<any>, GlobalState>;

declare const stableHash: (arg: any) => string;

declare const isWindowDefined: boolean;
declare const isDocumentDefined: boolean;
declare const isLegacyDeno: boolean;
declare const hasRequestAnimationFrame: () => boolean;
declare const createCacheHelper: <Data = any, T = State<Data, any>>(cache: Cache, key: string | undefined) => readonly [() => T, (info: T) => void, (key: string, callback: (current: any, prev: any) => void) => () => void, () => any];

declare const noop: () => void;
declare const UNDEFINED: undefined;
declare const OBJECT: ObjectConstructor;
declare const isUndefined: (v: any) => v is undefined;
declare const isFunction: <T extends (...args: any[]) => any = (...args: any[]) => any>(v: unknown) => v is T;
declare const mergeObjects: (a: any, b?: any) => any;
declare const isPromiseLike: (x: unknown) => x is PromiseLike<unknown>;

declare const mergeConfigs: (a: Partial<FullConfiguration>, b?: Partial<FullConfiguration>) => Partial<FullConfiguration>;

type KeyFilter = (key?: Arguments) => boolean;
declare function internalMutate<Data>(cache: Cache, _key: KeyFilter, _data?: Data | Promise<Data | undefined> | MutatorCallback<Data>, _opts?: boolean | MutatorOptions<Data>): Promise<Array<Data | undefined>>;
declare function internalMutate<Data>(cache: Cache, _key: Arguments, _data?: Data | Promise<Data | undefined> | MutatorCallback<Data>, _opts?: boolean | MutatorOptions<Data>): Promise<Data | undefined>;

declare const normalize: <KeyType = Key, Data = any>(args: [KeyType] | [KeyType, Fetcher<Data> | null] | [KeyType, SWRConfiguration | undefined] | [KeyType, Fetcher<Data> | null, SWRConfiguration | undefined]) => [KeyType, Fetcher<Data> | null, Partial<SWRConfiguration<Data>>];

declare const withArgs: <SWRType>(hook: any) => SWRType;

type Callback = (...args: any[]) => any;
declare const subscribeCallback: (key: string, callbacks: Record<string, Callback[]>, callback: Callback) => () => void;

declare const getTimestamp: () => number;

declare const preset: {
    readonly isOnline: () => boolean;
    readonly isVisible: () => boolean;
};
declare const defaultConfigOptions: ProviderConfiguration;

declare const withMiddleware: (useSWR: SWRHook, middleware: Middleware) => SWRHook;

export { Arguments, Cache, Fetcher, FullConfiguration, GlobalState, IS_REACT_LEGACY, IS_SERVER, Key, Middleware, MutatorCallback, MutatorOptions, OBJECT, ProviderConfiguration, SWRConfiguration, SWRGlobalState, SWRHook, ScopedMutator, State, UNDEFINED, Unloader, createCacheHelper, defaultConfigOptions, getTimestamp, hasRequestAnimationFrame, initCache, internalMutate, isDocumentDefined, isFunction, isLegacyDeno, isPromiseLike, isUndefined, isWindowDefined, mergeConfigs, mergeObjects, noop, normalize, preset, rAF, slowConnection, stableHash, subscribeCallback, useIsomorphicLayoutEffect, withArgs, withMiddleware };
