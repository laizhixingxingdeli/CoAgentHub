Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

const core$1 = require('@opentelemetry/core');
const core = require('@sentry/core');
const commonjs = require('./commonjs.js');
const createMissingInstrumentationContext = require('./createMissingInstrumentationContext.js');

/**
 * Checks and warns if a framework isn't wrapped by opentelemetry.
 */
function ensureIsWrapped(
  maybeWrappedFunction,
  name,
) {
  const clientOptions = core.getClient()?.getOptions();
  if (
    !clientOptions?.disableInstrumentationWarnings &&
    !core$1.isWrapped(maybeWrappedFunction) &&
    core.isEnabled() &&
    core.hasSpansEnabled(clientOptions)
  ) {
    core.consoleSandbox(() => {
      if (commonjs.isCjs()) {
        // eslint-disable-next-line no-console
        console.warn(
          `[Sentry] ${name} is not instrumented. This is likely because you required/imported ${name} before calling \`Sentry.init()\`.`,
        );
      } else {
        // eslint-disable-next-line no-console
        console.warn(
          `[Sentry] ${name} is not instrumented. Please make sure to initialize Sentry in a separate file that you \`--import\` when running node, see: https://docs.sentry.io/platforms/javascript/guides/${name}/install/esm/.`,
        );
      }
    });

    core.getGlobalScope().setContext('missing_instrumentation', createMissingInstrumentationContext.createMissingInstrumentationContext(name));
  }
}

exports.ensureIsWrapped = ensureIsWrapped;
//# sourceMappingURL=ensureIsWrapped.js.map
