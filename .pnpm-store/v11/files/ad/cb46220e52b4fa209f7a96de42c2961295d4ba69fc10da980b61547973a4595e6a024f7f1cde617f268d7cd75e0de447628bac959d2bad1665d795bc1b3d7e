import { defineIntegration } from '@sentry/core';
import { insertFlagToScope, copyFlagsFromScopeToEvent } from '../../../utils/featureFlags.js';

/**
 * Sentry integration for capturing feature flag evaluations from the Statsig js-client SDK.
 *
 * See the [feature flag documentation](https://develop.sentry.dev/sdk/expected-features/#feature-flags) for more information.
 *
 * @example
 * ```
 * import { StatsigClient } from '@statsig/js-client';
 * import * as Sentry from '@sentry/browser';
 *
 * const statsigClient = new StatsigClient();
 *
 * Sentry.init({
 *   dsn: '___PUBLIC_DSN___',
 *   integrations: [Sentry.statsigIntegration({featureFlagClient: statsigClient})],
 * });
 *
 * await statsigClient.initializeAsync();  // or statsigClient.initializeSync();
 *
 * const result = statsigClient.checkGate('my-feature-gate');
 * Sentry.captureException(new Error('something went wrong'));
 * ```
 */
const statsigIntegration = defineIntegration(
  ({ featureFlagClient: statsigClient }) => {
    return {
      name: 'Statsig',

      processEvent(event, _hint, _client) {
        return copyFlagsFromScopeToEvent(event);
      },

      setup() {
        statsigClient.on('gate_evaluation', (event) => {
          insertFlagToScope(event.gate.name, event.gate.value);
        });
      },
    };
  },
) ;

export { statsigIntegration };
//# sourceMappingURL=integration.js.map
