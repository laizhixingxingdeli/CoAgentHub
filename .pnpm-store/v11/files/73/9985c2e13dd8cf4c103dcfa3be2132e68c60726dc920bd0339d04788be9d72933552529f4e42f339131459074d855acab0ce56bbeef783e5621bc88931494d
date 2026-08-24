import type { Mechanism } from '@sentry/types';
export declare function isObject(value: unknown): value is object;
export declare function isMechanism(value: unknown): value is Mechanism;
export declare function containsMechanism(value: unknown): value is {
    mechanism: Mechanism;
};
/**
 * Tries to find release in a global
 */
export declare function getSentryRelease(): string | undefined;
/**
 * Creates an entry on existing object and returns it, or creates a new object with the entry if it doesn't exist.
 *
 * @param target
 * @param entry
 * @returns Object with new entry.
 */
export declare function setOnOptional<Target extends {
    [key: string | number | symbol]: unknown;
}, Key extends keyof Target>(target: Target | undefined, entry: [Key, Target[Key]]): Target;
//# sourceMappingURL=utils.d.ts.map