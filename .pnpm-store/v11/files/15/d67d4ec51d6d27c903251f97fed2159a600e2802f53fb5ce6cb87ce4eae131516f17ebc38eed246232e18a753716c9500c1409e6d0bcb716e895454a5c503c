import { defineIntegration } from '@sentry/core';
import { copyFlagsFromScopeToEvent, insertFlagToScope } from '../../../utils/featureFlags.js';

/**
 * Sentry integration for capturing feature flags from LaunchDarkly.
 *
 * See the [feature flag documentation](https://develop.sentry.dev/sdk/expected-features/#feature-flags) for more information.
 *
 * @example
 * ```
 * import * as Sentry from '@sentry/browser';
 * import {launchDarklyIntegration, buildLaunchDarklyFlagUsedInspector} from '@sentry/browser';
 * import * as LaunchDarkly from 'launchdarkly-js-client-sdk';
 *
 * Sentry.init(..., integrations: [launchDarklyIntegration()])
 * const ldClient = LaunchDarkly.initialize(..., {inspectors: [buildLaunchDarklyFlagUsedHandler()]});
 * ```
 */
const launchDarklyIntegration = defineIntegration(() => {
  return {
    name: 'LaunchDarkly',

    processEvent(event, _hint, _client) {
      return copyFlagsFromScopeToEvent(event);
    },
  };
}) ;

/**
 * LaunchDarkly hook that listens for flag evaluations and updates the `flags`
 * context in our Sentry scope. This needs to be registered as an
 * 'inspector' in LaunchDarkly initialize() options, separately from
 * `launchDarklyIntegration`. Both are needed to collect feature flags on error.
 */
function buildLaunchDarklyFlagUsedHandler() {
  return {
    name: 'sentry-flag-auditor',
    type: 'flag-used',

    synchronous: true,

    /**
     * Handle a flag evaluation by storing its name and value on the current scope.
     */
    method: (flagKey, flagDetail, _context) => {
      insertFlagToScope(flagKey, flagDetail.value);
    },
  };
}

export { buildLaunchDarklyFlagUsedHandler, launchDarklyIntegration };
//# sourceMappingURL=integration.js.map
