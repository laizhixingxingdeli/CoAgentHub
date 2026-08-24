import { SentryVercelAiInstrumentation } from './instrumentation';
export declare const instrumentVercelAi: ((options?: unknown) => SentryVercelAiInstrumentation) & {
    id: string;
};
/**
 * Adds Sentry tracing instrumentation for the [ai](https://www.npmjs.com/package/ai) library.
 *
 * For more information, see the [`ai` documentation](https://sdk.vercel.ai/docs/ai-sdk-core/telemetry).
 *
 * @example
 * ```javascript
 * const Sentry = require('@sentry/node');
 *
 * Sentry.init({
 *  integrations: [Sentry.vercelAIIntegration()],
 * });
 * ```
 *
 * By default this integration adds tracing support to all `ai` function calls. If you need to disable
 * collecting spans for a specific call, you can do so by setting `experimental_telemetry.isEnabled` to
 * `false` in the first argument of the function call.
 *
 * ```javascript
 * const result = await generateText({
 *   model: openai('gpt-4-turbo'),
 *   experimental_telemetry: { isEnabled: false },
 * });
 * ```
 *
 * If you want to collect inputs and outputs for a specific call, you must specifically opt-in to each
 * function call by setting `experimental_telemetry.recordInputs` and `experimental_telemetry.recordOutputs`
 * to `true`.
 *
 * ```javascript
 * const result = await generateText({
 *  model: openai('gpt-4-turbo'),
 *  experimental_telemetry: { isEnabled: true, recordInputs: true, recordOutputs: true },
 * });
 */
export declare const vercelAIIntegration: () => import("@sentry/core").Integration;
//# sourceMappingURL=index.d.ts.map
