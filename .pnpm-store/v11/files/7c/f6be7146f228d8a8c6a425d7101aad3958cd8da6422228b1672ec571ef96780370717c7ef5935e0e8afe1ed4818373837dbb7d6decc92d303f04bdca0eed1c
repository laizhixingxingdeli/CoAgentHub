import { InstrumentationConfig, InstrumentationModuleDefinition } from '@opentelemetry/instrumentation';
import { InstrumentationBase } from '@opentelemetry/instrumentation';
/**
 * This detects is added by the Sentry Vercel AI Integration to detect if the integration should
 * be enabled.
 *
 * It also patches the `ai` module to enable Vercel AI telemetry automatically for all methods.
 */
export declare class SentryVercelAiInstrumentation extends InstrumentationBase {
    private _isPatched;
    private _callbacks;
    constructor(config?: InstrumentationConfig);
    /**
     * Initializes the instrumentation by defining the modules to be patched.
     */
    init(): InstrumentationModuleDefinition;
    /**
     * Call the provided callback when the module is patched.
     * If it has already been patched, the callback will be called immediately.
     */
    callWhenPatched(callback: () => void): void;
    /**
     * Patches module exports to enable Vercel AI telemetry.
     */
    private _patch;
}
//# sourceMappingURL=instrumentation.d.ts.map
