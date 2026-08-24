import { defineIntegration } from '@sentry/core';
import { insertFlagToScope, copyFlagsFromScopeToEvent } from '../../utils/featureFlags.js';

/**
 * Sentry integration for buffering feature flags manually with an API, and
 * capturing them on error events. We recommend you do this on each flag
 * evaluation. Flags are buffered per Sentry scope and limited to 100 per event.
 *
 * See the [feature flag documentation](https://develop.sentry.dev/sdk/expected-features/#feature-flags) for more information.
 *
 * @example
 * ```
 * import * as Sentry from '@sentry/browser';
 * import { type FeatureFlagsIntegration } from '@sentry/browser';
 *
 * // Setup
 * Sentry.init(..., integrations: [Sentry.featureFlagsIntegration()])
 *
 * // Verify
 * const flagsIntegration = Sentry.getClient()?.getIntegrationByName<FeatureFlagsIntegration>('FeatureFlags');
 * if (flagsIntegration) {
 *   flagsIntegration.addFeatureFlag('my-flag', true);
 * } else {
 *   // check your setup
 * }
 * Sentry.captureException(Exception('broke')); // 'my-flag' should be captured to this Sentry event.
 * ```
 */
const featureFlagsIntegration = defineIntegration(() => {
  return {
    name: 'FeatureFlags',

    processEvent(event, _hint, _client) {
      return copyFlagsFromScopeToEvent(event);
    },

    addFeatureFlag(name, value) {
      insertFlagToScope(name, value);
    },
  };
}) ;

export { featureFlagsIntegration };
//# sourceMappingURL=featureFlagsIntegration.js.map
