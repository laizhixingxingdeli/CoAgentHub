import type { Event, FeatureFlag } from '@sentry/core';
/**
 * Ordered LRU cache for storing feature flags in the scope context. The name
 * of each flag in the buffer is unique, and the output of getAll() is ordered
 * from oldest to newest.
 */
/**
 * Max size of the LRU flag buffer stored in Sentry scope and event contexts.
 */
export declare const FLAG_BUFFER_SIZE = 100;
/**
 * Copies feature flags that are in current scope context to the event context
 */
export declare function copyFlagsFromScopeToEvent(event: Event): Event;
/**
 * Creates a feature flags values array in current context if it does not exist
 * and inserts the flag into a FeatureFlag array while maintaining ordered LRU
 * properties. Not thread-safe. After inserting:
 * - `flags` is sorted in order of recency, with the newest flag at the end.
 * - No other flags with the same name exist in `flags`.
 * - The length of `flags` does not exceed `maxSize`. The oldest flag is evicted
 *  as needed.
 *
 * @param name     Name of the feature flag to insert.
 * @param value    Value of the feature flag.
 * @param maxSize  Max number of flags the buffer should store. It's recommended
 *   to keep this consistent across insertions. Default is FLAG_BUFFER_SIZE
 */
export declare function insertFlagToScope(name: string, value: unknown, maxSize?: number): void;
/**
 * Exported for tests. Currently only accepts boolean values (otherwise no-op).
 */
export declare function insertToFlagBuffer(flags: FeatureFlag[], name: string, value: unknown, maxSize: number): void;
//# sourceMappingURL=featureFlags.d.ts.map