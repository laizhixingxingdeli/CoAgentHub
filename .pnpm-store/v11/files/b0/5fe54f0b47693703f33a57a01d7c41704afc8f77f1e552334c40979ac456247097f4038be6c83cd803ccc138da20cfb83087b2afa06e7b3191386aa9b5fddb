Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

const core = require('@sentry/core');
const opentelemetry = require('@sentry/opentelemetry');
const debugBuild = require('../debug-build.js');
const childProcess = require('../integrations/childProcess.js');
const context = require('../integrations/context.js');
const contextlines = require('../integrations/contextlines.js');
const index$1 = require('../integrations/http/index.js');
const index$3 = require('../integrations/local-variables/index.js');
const modules = require('../integrations/modules.js');
const index$2 = require('../integrations/node-fetch/index.js');
const onuncaughtexception = require('../integrations/onuncaughtexception.js');
const onunhandledrejection = require('../integrations/onunhandledrejection.js');
const processSession = require('../integrations/processSession.js');
const spotlight = require('../integrations/spotlight.js');
const index = require('../integrations/tracing/index.js');
const http = require('../transports/http.js');
const commonjs = require('../utils/commonjs.js');
const envToBool = require('../utils/envToBool.js');
const api = require('./api.js');
const client = require('./client.js');
const initOtel = require('./initOtel.js');

function getCjsOnlyIntegrations() {
  return commonjs.isCjs() ? [modules.modulesIntegration()] : [];
}

/**
 * Get default integrations, excluding performance.
 */
function getDefaultIntegrationsWithoutPerformance() {
  return [
    // Common
    // TODO(v10): Replace with `eventFiltersIntegration` once we remove the deprecated `inboundFiltersIntegration`
    // eslint-disable-next-line deprecation/deprecation
    core.inboundFiltersIntegration(),
    core.functionToStringIntegration(),
    core.linkedErrorsIntegration(),
    core.requestDataIntegration(),
    // Native Wrappers
    core.consoleIntegration(),
    index$1.httpIntegration(),
    index$2.nativeNodeFetchIntegration(),
    // Global Handlers
    onuncaughtexception.onUncaughtExceptionIntegration(),
    onunhandledrejection.onUnhandledRejectionIntegration(),
    // Event Info
    contextlines.contextLinesIntegration(),
    index$3.localVariablesIntegration(),
    context.nodeContextIntegration(),
    childProcess.childProcessIntegration(),
    processSession.processSessionIntegration(),
    ...getCjsOnlyIntegrations(),
  ];
}

/** Get the default integrations for the Node SDK. */
function getDefaultIntegrations(options) {
  return [
    ...getDefaultIntegrationsWithoutPerformance(),
    // We only add performance integrations if tracing is enabled
    // Note that this means that without tracing enabled, e.g. `expressIntegration()` will not be added
    // This means that generally request isolation will work (because that is done by httpIntegration)
    // But `transactionName` will not be set automatically
    ...(core.hasSpansEnabled(options) ? index.getAutoPerformanceIntegrations() : []),
  ];
}

/**
 * Initialize Sentry for Node.
 */
function init(options = {}) {
  return _init(options, getDefaultIntegrations);
}

/**
 * Initialize Sentry for Node, without any integrations added by default.
 */
function initWithoutDefaultIntegrations(options = {}) {
  return _init(options, () => []);
}

/**
 * Initialize Sentry for Node, without performance instrumentation.
 */
function _init(
  _options = {},
  getDefaultIntegrationsImpl,
) {
  const options = getClientOptions(_options, getDefaultIntegrationsImpl);

  if (options.debug === true) {
    if (debugBuild.DEBUG_BUILD) {
      core.logger.enable();
    } else {
      // use `console.warn` rather than `logger.warn` since by non-debug bundles have all `logger.x` statements stripped
      core.consoleSandbox(() => {
        // eslint-disable-next-line no-console
        console.warn('[Sentry] Cannot initialize SDK with `debug` option using a non-debug bundle.');
      });
    }
  }

  if (!commonjs.isCjs() && options.registerEsmLoaderHooks !== false) {
    initOtel.maybeInitializeEsmLoader();
  }

  opentelemetry.setOpenTelemetryContextAsyncContextStrategy();

  const scope = core.getCurrentScope();
  scope.update(options.initialScope);

  if (options.spotlight && !options.integrations.some(({ name }) => name === spotlight.INTEGRATION_NAME)) {
    options.integrations.push(
      spotlight.spotlightIntegration({
        sidecarUrl: typeof options.spotlight === 'string' ? options.spotlight : undefined,
      }),
    );
  }

  const client$1 = new client.NodeClient(options);
  // The client is on the current scope, from where it generally is inherited
  core.getCurrentScope().setClient(client$1);

  client$1.init();

  core.logger.log(`Running in ${commonjs.isCjs() ? 'CommonJS' : 'ESM'} mode.`);

  client$1.startClientReportTracking();

  updateScopeFromEnvVariables();

  // If users opt-out of this, they _have_ to set up OpenTelemetry themselves
  // There is no way to use this SDK without OpenTelemetry!
  if (!options.skipOpenTelemetrySetup) {
    initOtel.initOpenTelemetry(client$1, {
      spanProcessors: options.openTelemetrySpanProcessors,
    });
    validateOpenTelemetrySetup();
  }

  opentelemetry.enhanceDscWithOpenTelemetryRootSpanName(client$1);
  opentelemetry.setupEventContextTrace(client$1);

  return client$1;
}

/**
 * Validate that your OpenTelemetry setup is correct.
 */
function validateOpenTelemetrySetup() {
  if (!debugBuild.DEBUG_BUILD) {
    return;
  }

  const setup = opentelemetry.openTelemetrySetupCheck();

  const required = ['SentryContextManager', 'SentryPropagator'];

  if (core.hasSpansEnabled()) {
    required.push('SentrySpanProcessor');
  }

  for (const k of required) {
    if (!setup.includes(k)) {
      core.logger.error(
        `You have to set up the ${k}. Without this, the OpenTelemetry & Sentry integration will not work properly.`,
      );
    }
  }

  if (!setup.includes('SentrySampler')) {
    core.logger.warn(
      'You have to set up the SentrySampler. Without this, the OpenTelemetry & Sentry integration may still work, but sample rates set for the Sentry SDK will not be respected. If you use a custom sampler, make sure to use `wrapSamplingDecision`.',
    );
  }
}

function getClientOptions(
  options,
  getDefaultIntegrationsImpl,
) {
  const release = getRelease(options.release);
  const spotlight =
    options.spotlight ?? envToBool.envToBool(process.env.SENTRY_SPOTLIGHT, { strict: true }) ?? process.env.SENTRY_SPOTLIGHT;
  const tracesSampleRate = getTracesSampleRate(options.tracesSampleRate);

  const mergedOptions = {
    ...options,
    dsn: options.dsn ?? process.env.SENTRY_DSN,
    environment: options.environment ?? process.env.SENTRY_ENVIRONMENT,
    sendClientReports: options.sendClientReports ?? true,
    transport: options.transport ?? http.makeNodeTransport,
    stackParser: core.stackParserFromStackParserOptions(options.stackParser || api.defaultStackParser),
    release,
    tracesSampleRate,
    spotlight,
    debug: envToBool.envToBool(options.debug ?? process.env.SENTRY_DEBUG),
  };

  const integrations = options.integrations;
  const defaultIntegrations = options.defaultIntegrations ?? getDefaultIntegrationsImpl(mergedOptions);

  return {
    ...mergedOptions,
    integrations: core.getIntegrationsToSetup({
      defaultIntegrations,
      integrations,
    }),
  };
}

function getRelease(release) {
  if (release !== undefined) {
    return release;
  }

  const detectedRelease = api.getSentryRelease();
  if (detectedRelease !== undefined) {
    return detectedRelease;
  }

  return undefined;
}

function getTracesSampleRate(tracesSampleRate) {
  if (tracesSampleRate !== undefined) {
    return tracesSampleRate;
  }

  const sampleRateFromEnv = process.env.SENTRY_TRACES_SAMPLE_RATE;
  if (!sampleRateFromEnv) {
    return undefined;
  }

  const parsed = parseFloat(sampleRateFromEnv);
  return isFinite(parsed) ? parsed : undefined;
}

/**
 * Update scope and propagation context based on environmental variables.
 *
 * See https://github.com/getsentry/rfcs/blob/main/text/0071-continue-trace-over-process-boundaries.md
 * for more details.
 */
function updateScopeFromEnvVariables() {
  if (envToBool.envToBool(process.env.SENTRY_USE_ENVIRONMENT) !== false) {
    const sentryTraceEnv = process.env.SENTRY_TRACE;
    const baggageEnv = process.env.SENTRY_BAGGAGE;
    const propagationContext = core.propagationContextFromHeaders(sentryTraceEnv, baggageEnv);
    core.getCurrentScope().setPropagationContext(propagationContext);
  }
}

exports.getDefaultIntegrations = getDefaultIntegrations;
exports.getDefaultIntegrationsWithoutPerformance = getDefaultIntegrationsWithoutPerformance;
exports.init = init;
exports.initWithoutDefaultIntegrations = initWithoutDefaultIntegrations;
exports.validateOpenTelemetrySetup = validateOpenTelemetrySetup;
//# sourceMappingURL=index.js.map
