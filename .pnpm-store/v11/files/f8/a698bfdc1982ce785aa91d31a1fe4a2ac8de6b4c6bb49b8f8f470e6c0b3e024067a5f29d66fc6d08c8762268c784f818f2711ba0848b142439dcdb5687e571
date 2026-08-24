import { MiddlewareHandler, Context } from 'hono';
import { Toucan, Options as Options$1 } from 'toucan-js';

declare module 'hono' {
    interface ContextVariableMap {
        sentry: Toucan;
    }
}
type Options = Omit<Options$1, 'request' | 'context'>;
declare const sentry: (options?: Options, callback?: (sentry: Toucan) => void) => MiddlewareHandler;
declare const getSentry: (c: Context) => Toucan;

export { type Options, getSentry, sentry };
