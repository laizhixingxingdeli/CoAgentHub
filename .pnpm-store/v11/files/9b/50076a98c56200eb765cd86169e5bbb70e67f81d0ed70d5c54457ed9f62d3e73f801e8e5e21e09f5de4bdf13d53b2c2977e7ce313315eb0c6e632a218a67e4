import type { Scope } from '@sentry/core';
import { ServerRuntimeClient } from '@sentry/core';
import type { Event, EventHint, SeverityLevel } from '@sentry/types';
import type { Toucan } from './sdk';
import type { ToucanClientOptions } from './types';
/**
 * The Cloudflare Workers SDK Client.
 */
export declare class ToucanClient extends ServerRuntimeClient<ToucanClientOptions> {
    #private;
    /**
     * Creates a new Toucan SDK instance.
     * @param options Configuration options for this SDK.
     */
    constructor(options: ToucanClientOptions);
    /**
     * By default, integrations are stored in a global. We want to store them in a local instance because they may have contextual data, such as event request.
     */
    setupIntegrations(): void;
    eventFromException(exception: unknown, hint?: EventHint): PromiseLike<Event>;
    eventFromMessage(message: string, level?: SeverityLevel, hint?: EventHint): PromiseLike<Event>;
    protected _prepareEvent(event: Event, hint: EventHint, scope?: Scope): PromiseLike<Event | null>;
    getSdk(): Toucan | null;
    setSdk(sdk: Toucan): void;
    /**
     * Sets the request body context on all future events.
     *
     * @param body Request body.
     * @example
     * const body = await request.text();
     * toucan.setRequestBody(body);
     */
    setRequestBody(body: unknown): void;
    /**
     * Enable/disable the SDK.
     *
     * @param enabled
     */
    setEnabled(enabled: boolean): void;
}
//# sourceMappingURL=client.d.ts.map