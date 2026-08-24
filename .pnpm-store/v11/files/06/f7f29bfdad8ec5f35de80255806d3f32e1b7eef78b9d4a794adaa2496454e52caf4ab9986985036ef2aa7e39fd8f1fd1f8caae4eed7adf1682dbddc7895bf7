/**
 * @module
 * This module enables JSX to supports streaming Response.
 */
import type { HtmlEscapedString } from '../utils/html';
import { JSXNode } from './base';
import type { FC, PropsWithChildren } from './';
/**
 * @experimental
 * `Suspense` is an experimental feature.
 * The API might be changed.
 */
export declare const Suspense: FC<PropsWithChildren<{
    fallback: any;
}>>;
/**
 * @experimental
 * `renderToReadableStream()` is an experimental feature.
 * The API might be changed.
 */
export declare const renderToReadableStream: (content: HtmlEscapedString | JSXNode | Promise<HtmlEscapedString>, onError?: (e: unknown) => string | void) => ReadableStream<Uint8Array>;
