import { defineIntegration } from '@sentry/core';
import { copyFlagsFromScopeToEvent, insertFlagToScope } from '../../../utils/featureFlags.js';

const openFeatureIntegration = defineIntegration(() => {
  return {
    name: 'OpenFeature',

    processEvent(event, _hint, _client) {
      return copyFlagsFromScopeToEvent(event);
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
    insertFlagToScope(evaluationDetails.flagKey, evaluationDetails.value);
  }

  /**
   * On error evaluation result.
   */
   error(hookContext, _error, _hookHints) {
    insertFlagToScope(hookContext.flagKey, hookContext.defaultValue);
  }
}

export { OpenFeatureIntegrationHook, openFeatureIntegration };
//# sourceMappingURL=integration.js.map
