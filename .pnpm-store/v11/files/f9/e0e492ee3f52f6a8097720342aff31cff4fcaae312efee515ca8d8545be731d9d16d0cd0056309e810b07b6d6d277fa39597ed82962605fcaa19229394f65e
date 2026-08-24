import type { Context, Env, MiddlewareHandler } from 'hono';
import type { ApiReferenceConfiguration } from './types.js';
type Configuration<E extends Env> = Partial<ApiReferenceConfiguration> | ((c: Context<E>) => Partial<ApiReferenceConfiguration> | Promise<Partial<ApiReferenceConfiguration>>);
/**
 * The Hono middleware for the Scalar API Reference.
 */
export declare const Scalar: <E extends Env>(configOrResolver: Configuration<E>) => MiddlewareHandler<E>;
export {};
//# sourceMappingURL=scalar.d.ts.map