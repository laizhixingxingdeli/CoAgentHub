import { Scope } from '@sentry/core';
import type { Options } from './types';
import type { Breadcrumb, CheckIn, MonitorConfig } from '@sentry/types';
/**
 * The Cloudflare Workers SDK.
 */
export declare class Toucan extends Scope {
    #private;
    constructor(options: Options);
    /**
     * Creates new ToucanClient and links it to this instance.
     */
    protected attachNewClient(): void;
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
    /**
     * Create a cron monitor check in and send it to Sentry.
     *
     * @param checkIn An object that describes a check in.
     * @param upsertMonitorConfig An optional object that describes a monitor config. Use this if you want
     * to create a monitor automatically when sending a check in.
     */
    captureCheckIn(checkIn: CheckIn, monitorConfig?: MonitorConfig, scope?: Scope): string;
    /**
     * Add a breadcrumb to the current scope.
     */
    addBreadcrumb(breadcrumb: Breadcrumb, maxBreadcrumbs?: number): this;
    /**
     * Clone all data from this instance into a new Toucan instance.
     *
     * @override
     * @returns New Toucan instance.
     */
    clone(): Toucan;
    /**
     * Creates a new scope with and executes the given operation within.
     * The scope is automatically removed once the operation
     * finishes or throws.
     */
    withScope<T>(callback: (scope: Toucan) => T): T;
}
//# sourceMappingURL=sdk.d.ts.map