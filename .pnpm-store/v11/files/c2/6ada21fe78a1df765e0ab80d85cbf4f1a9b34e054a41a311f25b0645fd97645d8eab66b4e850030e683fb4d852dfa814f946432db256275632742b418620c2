/**
 * Handler for Service Worker
 * @module
 */
import type { Hono } from '../../hono';
import type { FetchEvent } from './types';
type Handler = (evt: FetchEvent) => void;
/**
 * Adapter for Service Worker
 */
export declare const handle: (app: Hono, opts?: {
    fetch?: typeof fetch;
}) => Handler;
export {};
