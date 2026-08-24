export { s as serialize } from '../serialize-f94ud86v.js';
import { K as Key, B as BareFetcher, F as FetcherResponse, C as CacheData } from '../types-m1fld6v2.js';
export { S as SWRConfig } from '../types-m1fld6v2.js';
export { INFINITE_PREFIX } from './constants.js';

type PreloadFetcher<Data = unknown, SWRKey extends Key = Key> = SWRKey extends () => infer Arg ? (arg: Arg) => FetcherResponse<Data> : SWRKey extends infer Arg ? (arg: Arg) => FetcherResponse<Data> : never;
declare const preload: <Data = any, SWRKey extends Key = Key, Fetcher extends BareFetcher = PreloadFetcher<Data, SWRKey>>(key_: SWRKey, fetcher: Fetcher) => CacheData<Data>;

export { preload };
