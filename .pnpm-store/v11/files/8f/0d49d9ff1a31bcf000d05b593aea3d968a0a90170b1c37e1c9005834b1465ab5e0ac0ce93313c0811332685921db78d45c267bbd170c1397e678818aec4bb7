Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

const core = require('@sentry/core');
const featureFlags = require('../../../utils/featureFlags.js');

const openFeatureIntegration = core.defineIntegration(() => {
  return {
    name: 'OpenFeature',

    processEvent(event, _hint, _client) {
      return featureFlags.copyFlagsFromScopeToEvent(event);
    },
  };
}) ;

/**
 * OpenFeature Hook class implementation.
 */
class OpenFeatureIntegrationHook  {
  /**
   * Successful evaluation result.
   */
   after(_hookContext, evaluationDetails) {
    featureFlags.insertFlagToScope(evaluationDetails.flagKey, evaluationDetails.value);
  }

  /**
   * On error evaluation result.
   */
   error(hookContext, _error, _hookHints) {
    featureFlags.insertFlagToScope(hookContext.flagKey, hookContext.defaultValue);
  }
}

exports.OpenFeatureIntegrationHook = OpenFeatureIntegrationHook;
exports.openFeatureIntegration = openFeatureIntegration;
//# sourceMappingURL=integration.js.map
