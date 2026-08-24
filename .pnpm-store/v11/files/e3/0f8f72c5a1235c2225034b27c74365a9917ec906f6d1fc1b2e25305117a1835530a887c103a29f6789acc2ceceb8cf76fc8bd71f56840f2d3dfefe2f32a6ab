/**
 * @module
 * JWK Auth Middleware for Hono.
 */
import type { MiddlewareHandler } from '../../types';
import type { CookiePrefixOptions } from '../../utils/cookie';
import '../../context';
import type { HonoJsonWebKey } from '../../utils/jwt/jws';
/**
 * JWK Auth Middleware for Hono.
 *
 * @see {@link https://hono.dev/docs/middleware/builtin/jwk}
 *
 * @param {object} options - The options for the JWK middleware.
 * @param {HonoJsonWebKey[] | (() => Promise<HonoJsonWebKey[]>)} [options.keys] - The values of your public keys, or a function that returns them.
 * @param {string} [options.jwks_uri] - If this value is set, attempt to fetch JWKs from this URI, expecting a JSON response with `keys` which are added to the provided options.keys
 * @param {string} [options.cookie] - If this value is set, then the value is retrieved from the cookie header using that value as a key, which is then validated as a token.
 * @param {RequestInit} [init] - Optional initialization options for the `fetch` request when retrieving JWKS from a URI.
 * @returns {MiddlewareHandler} The middleware handler function.
 *
 * @example
 * ```ts
 * const app = new Hono()
 *
 * app.use("/auth/*", jwk({ jwks_uri: "https://example-backend.hono.dev/.well-known/jwks.json" }))
 *
 * app.get('/auth/page', (c) => {
 *   return c.text('You are authorized')
 * })
 * ```
 */
export declare const jwk: (options: {
    keys?: HonoJsonWebKey[] | (() => Promise<HonoJsonWebKey[]>);
    jwks_uri?: string;
    cookie?: string | {
        key: string;
        secret?: string | BufferSource;
        prefixOptions?: CookiePrefixOptions;
    };
}, init?: RequestInit) => MiddlewareHandler;
