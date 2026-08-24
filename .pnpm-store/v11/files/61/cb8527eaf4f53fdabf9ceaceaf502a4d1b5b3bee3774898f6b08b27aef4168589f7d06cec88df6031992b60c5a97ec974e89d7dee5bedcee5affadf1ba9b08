import type { Integration } from '@sentry/core';
import type { AnrIntegrationOptions } from './common';
export declare const base64WorkerScript = "###AnrWorkerScript###";
type AnrInternal = {
    startWorker: () => void;
    stopWorker: () => void;
};
type AnrReturn = (options?: Partial<AnrIntegrationOptions>) => Integration & AnrInternal;
export declare const anrIntegration: AnrReturn;
export declare function disableAnrDetectionForCallback<T>(callback: () => T): T;
export declare function disableAnrDetectionForCallback<T>(callback: () => Promise<T>): Promise<T>;
export {};
//# sourceMappingURL=index.d.ts.map