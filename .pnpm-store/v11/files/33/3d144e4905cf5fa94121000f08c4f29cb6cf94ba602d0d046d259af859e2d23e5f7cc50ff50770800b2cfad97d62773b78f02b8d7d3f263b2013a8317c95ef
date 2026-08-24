import { getClient } from '../currentScopes.js';

// Treeshakable guard to remove all code related to tracing

/**
 * Determines if tracing is currently enabled.
 *
 * Tracing is enabled when at least one of `tracesSampleRate` and `tracesSampler` is defined in the SDK config.
 */
function hasTracingEnabled(
  maybeOptions,
) {
  if (typeof __SENTRY_TRACING__ === 'boolean' && !__SENTRY_TRACING__) {
    return false;
  }

  const options = maybeOptions || getClientOptions();
  return !!options && (options.enableTracing || 'tracesSampleRate' in options || 'tracesSampler' in options);
}

function getClientOptions() {
  const client = getClient();
  return client && client.getOptions();
}

export { hasTracingEnabled };
//# sourceMappingURL=hasTracingEnabled.js.map
