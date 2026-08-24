import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import type { TransactionEvent } from '@sentry/core';
/**
 * A Sentry-specific exporter that converts OpenTelemetry Spans to Sentry Spans & Transactions.
 */
export declare class SentrySpanExporter {
    private _flushTimeout;
    private _finishedSpanBuckets;
    private _finishedSpanBucketSize;
    private _spansToBucketEntry;
    private _lastCleanupTimestampInS;
    constructor(options?: {
        /** Lower bound of time in seconds until spans that are buffered but have not been sent as part of a transaction get cleared from memory. */
        timeout?: number;
    });
    /** Export a single span. */
    export(span: ReadableSpan): void;
    /** Try to flush any pending spans immediately. */
    flush(): void;
    /** Clear the exporter. */
    clear(): void;
    /** Clear the flush timeout. */
    private _clearTimeout;
}
/** Exported only for tests. */
export declare function createTransactionForOtelSpan(span: ReadableSpan): TransactionEvent;
//# sourceMappingURL=spanExporter.d.ts.map