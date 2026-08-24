import { logger, consoleSandbox, getCurrentScope, stackParserFromStackParserOptions, getIntegrationsToSetup, propagationContextFromHeaders, hasSpansEnabled, inboundFiltersIntegration, functionToStringIntegration, linkedErrorsIntegration, requestDataIntegration, consoleIntegration } from '@sentry/core';
import { setOpenTelemetryContextAsyncContextStrategy, enhanceDscWithOpenTelemetryRootSpanName, setupEventContextTrace, openTelemetrySetupCheck } from '@sentry/opentelemetry';
import { DEBUG_BUILD } from '../debug-build.js';
import { childProcessIntegration } from '../integrations/childProcess.js';
import { nodeContextIntegration } from '../integrations/context.js';
import { contextLinesIntegration } from '../integrations/contextlines.js';
import { httpIntegration } from '../integrations/http/index.js';
import { localVariablesIntegration } from '../integrations/local-variables/index.js';
import { modulesIntegration } from '../integrations/modules.js';
import { nativeNodeFetchIntegration } from '../integrations/node-fetch/index.js';
import { onUncaughtExceptionIntegration } from '../integrations/onuncaughtexception.js';
import { onUnhandledRejectionIntegration } from '../integrations/onunhandledrejection.js';
import { processSessionIntegration } from '../integrations/processSession.js';
import { INTEGRATION_NAME, spotlightIntegration } from '../integrations/spotlight.js';
import { getAutoPerformanceIntegrations } from '../integrations/tracing/index.js';
import { makeNodeTransport } from '../transports/http.js';
import { isCjs } from '../utils/commonjs.js';
import { envToBool } from '../utils/envToBool.js';
import { defaultStackParser, getSentryRelease } from './api.js';
import { NodeClient } from './client.js';
import { maybeInitializeEsmLoader, initOpenTelemetry } from './initOtel.js';

function getCjsOnlyIntegrations() {
  return isCjs() ? [modulesIntegration()] : [];
}

/**
 * Get default integrations, excluding performance.
 */
function getDefaultIntegrationsWithoutPerformance() {
  return [
    // Common
    // TODO(v10): Replace with `eventFiltersIntegration` once we remove the deprecated `inboundFiltersIntegration`
    // eslint-disable-next-line deprecation/deprecation
    inboundFiltersIntegration(),
    functionToStringIntegration(),
    linkedErrorsIntegration(),
    requestDataIntegration(),
    // Native Wrappers
    consoleIntegration(),
    httpIntegration(),
    nativeNodeFetchIntegration(),
    // Global Handlers
    onUncaughtExceptionIntegration(),
    onUnhandledRejectionIntegration(),
    // Event Info
    contextLinesIntegration(),
    localVariablesIntegration(),
    nodeContextIntegration(),
    childProcessIntegration(),
    processSessionIntegration(),
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
    ...(hasSpansEnabled(options) ? getAutoPerformanceIntegrations() : []),
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
    if (DEBUG_BUILD) {
      logger.enable();
    } else {
      // use `console.warn` rather than `logger.warn` since by non-debug bundles have all `logger.x` statements stripped
      consoleSandbox(() => {
        // eslint-disable-next-line no-console
        console.warn('[Sentry] Cannot initialize SDK with `debug` option using a non-debug bundle.');
      });
    }
  }

  if (!isCjs() && options.registerEsmLoaderHooks !== false) {
    maybeInitializeEsmLoader();
  }

  setOpenTelemetryContextAsyncContextStrategy();

  const scope = getCurrentScope();
  scope.update(options.initialScope);

  if (options.spotlight && !options.integrations.some(({ name }) => name === INTEGRATION_NAME)) {
    options.integrations.push(
      spotlightIntegration({
        sidecarUrl: typeof options.spotlight === 'string' ? options.spotlight : undefined,
      }),
    );
  }

  const client = new NodeClient(options);
  // The client is on the current scope, from where it generally is inherited
  getCurrentScope().setClient(client);

  client.init();

  logger.log(`Running in ${isCjs() ? 'CommonJS' : 'ESM'} mode.`);

  client.startClientReportTracking();

  updateScopeFromEnvVariables();

  // If users opt-out of this, they _have_ to set up OpenTelemetry themselves
  // There is no way to use this SDK without OpenTelemetry!
  if (!options.skipOpenTelemetrySetup) {
    initOpenTelemetry(client, {
      spanProcessors: options.openTelemetrySpanProcessors,
    });
    validateOpenTelemetrySetup();
  }

  enhanceDscWithOpenTelemetryRootSpanName(client);
  setupEventContextTrace(client);

  return client;
}

/**
 * Validate that your OpenTelemetry setup is correct.
 */
function validateOpenTelemetrySetup() {
  if (!DEBUG_BUILD) {
    return;
  }

  const setup = openTelemetrySetupCheck();

  const required = ['SentryContextManager', 'SentryPropagator'];

  if (hasSpansEnabled()) {
    required.push('SentrySpanProcessor');
  }

  for (const k of required) {
    if (!setup.includes(k)) {
      logger.error(
        `You have to set up the ${k}. Without this, the OpenTelemetry & Sentry integration will not work properly.`,
      );
    }
  }

  if (!setup.includes('SentrySampler')) {
    logger.warn(
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
    options.spotlight ?? envToBool(process.env.SENTRY_SPOTLIGHT, { strict: true }) ?? process.env.SENTRY_SPOTLIGHT;
  const tracesSampleRate = getTracesSampleRate(options.tracesSampleRate);

  const mergedOptions = {
    ...options,
    dsn: options.dsn ?? process.env.SENTRY_DSN,
    environment: options.environment ?? process.env.SENTRY_ENVIRONMENT,
    sendClientReports: options.sendClientReports ?? true,
    transport: options.transport ?? makeNodeTransport,
    stackParser: stackParserFromStackParserOptions(options.stackParser || defaultStackParser),
    release,
    tracesSampleRate,
    spotlight,
    debug: envToBool(options.debug ?? process.env.SENTRY_DEBUG),
  };

  const integrations = options.integrations;
  const defaultIntegrations = options.defaultIntegrations ?? getDefaultIntegrationsImpl(mergedOptions);

  return {
    ...mergedOptions,
    integrations: getIntegrationsToSetup({
      defaultIntegrations,
      integrations,
    }),
  };
}

function getRelease(release) {
  if (release !== undefined) {
    return release;
  }

  const detectedRelease = getSentryRelease();
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
  if (envToBool(process.env.SENTRY_USE_ENVIRONMENT) !== false) {
    const sentryTraceEnv = process.env.SENTRY_TRACE;
    const baggageEnv = process.env.SENTRY_BAGGAGE;
    const propagationContext = propagationContextFromHeaders(sentryTraceEnv, baggageEnv);
    getCurrentScope().setPropagationContext(propagationContext);
  }
}

export { getDefaultIntegrations, getDefaultIntegrationsWithoutPerformance, init, initWithoutDefaultIntegrations, validateOpenTelemetrySetup };
//# sourceMappingURL=index.js.map
