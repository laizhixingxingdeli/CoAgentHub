Object.defineProperty(exports, '__esModule', { value: true });

const currentScopes = require('../currentScopes.js');

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
  const client = currentScopes.getClient();
  return client && client.getOptions();
}

exports.hasTracingEnabled = hasTracingEnabled;
//# sourceMappingURL=hasTracingEnabled.js.map
