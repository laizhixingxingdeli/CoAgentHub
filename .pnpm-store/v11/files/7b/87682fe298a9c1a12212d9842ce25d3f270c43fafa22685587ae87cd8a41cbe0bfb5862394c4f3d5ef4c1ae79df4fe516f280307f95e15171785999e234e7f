import type { Event, EventHint, Exception, SeverityLevel, StackFrame, StackParser } from '@sentry/types';
import type { Toucan } from './sdk';
/**
 * Extracts stack frames from the error.stack string
 */
export declare function parseStackFrames(stackParser: StackParser, error: Error): StackFrame[];
/**
 * Extracts stack frames from the error and builds a Sentry Exception
 */
export declare function exceptionFromError(stackParser: StackParser, error: Error): Exception;
/**
 * Builds and Event from a Exception
 */
export declare function eventFromUnknownInput(sdk: Toucan | null, stackParser: StackParser, exception: unknown, hint?: EventHint): Event;
/**
 * Builds and Event from a Message
 */
export declare function eventFromMessage(stackParser: StackParser, message: string, level?: SeverityLevel, hint?: EventHint, attachStacktrace?: boolean): Event;
//# sourceMappingURL=eventBuilder.d.ts.map