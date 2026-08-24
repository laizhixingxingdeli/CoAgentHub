Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

const instrumentationKoa = require('@opentelemetry/instrumentation-koa');
const semanticConventions = require('@opentelemetry/semantic-conventions');
const core = require('@sentry/core');
const debugBuild = require('../../debug-build.js');
const instrument = require('../../otel/instrument.js');
const ensureIsWrapped = require('../../utils/ensureIsWrapped.js');

const INTEGRATION_NAME = 'Koa';

const instrumentKoa = instrument.generateInstrumentOnce(
  INTEGRATION_NAME,
  () =>
    new instrumentationKoa.KoaInstrumentation({
      requestHook(span, info) {
        addKoaSpanAttributes(span);

        if (core.getIsolationScope() === core.getDefaultIsolationScope()) {
          debugBuild.DEBUG_BUILD && core.logger.warn('Isolation scope is default isolation scope - skipping setting transactionName');
          return;
        }
        const attributes = core.spanToJSON(span).data;
        const route = attributes[semanticConventions.ATTR_HTTP_ROUTE];
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        const method = info.context?.request?.method?.toUpperCase() || 'GET';
        if (route) {
          core.getIsolationScope().setTransactionName(`${method} ${route}`);
        }
      },
    }),
);

const _koaIntegration = (() => {
  return {
    name: INTEGRATION_NAME,
    setupOnce() {
      instrumentKoa();
    },
  };
}) ;

/**
 * Adds Sentry tracing instrumentation for [Koa](https://koajs.com/).
 *
 * If you also want to capture errors, you need to call `setupKoaErrorHandler(app)` after you set up your Koa server.
 *
 * For more information, see the [koa documentation](https://docs.sentry.io/platforms/javascript/guides/koa/).
 *
 * @example
 * ```javascript
 * const Sentry = require('@sentry/node');
 *
 * Sentry.init({
 *   integrations: [Sentry.koaIntegration()],
 * })
 * ```
 */
const koaIntegration = core.defineIntegration(_koaIntegration);

/**
 * Add an Koa error handler to capture errors to Sentry.
 *
 * The error handler must be before any other middleware and after all controllers.
 *
 * @param app The Express instances
 * @param options {ExpressHandlerOptions} Configuration options for the handler
 *
 * @example
 * ```javascript
 * const Sentry = require('@sentry/node');
 * const Koa = require("koa");
 *
 * const app = new Koa();
 *
 * Sentry.setupKoaErrorHandler(app);
 *
 * // Add your routes, etc.
 *
 * app.listen(3000);
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const setupKoaErrorHandler = (app) => {
  app.use(async (ctx, next) => {
    try {
      await next();
    } catch (error) {
      core.captureException(error);
      throw error;
    }
  });

  ensureIsWrapped.ensureIsWrapped(app.use, 'koa');
};

function addKoaSpanAttributes(span) {
  span.setAttribute(core.SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN, 'auto.http.otel.koa');

  const attributes = core.spanToJSON(span).data;

  // this is one of: middleware, router
  const type = attributes['koa.type'];

  if (type) {
    span.setAttribute(core.SEMANTIC_ATTRIBUTE_SENTRY_OP, `${type}.koa`);
  }

  // Also update the name
  const name = attributes['koa.name'];
  if (typeof name === 'string') {
    // Somehow, name is sometimes `''` for middleware spans
    // See: https://github.com/open-telemetry/opentelemetry-js-contrib/issues/2220
    span.updateName(name || '< unknown >');
  }
}

exports.instrumentKoa = instrumentKoa;
exports.koaIntegration = koaIntegration;
exports.setupKoaErrorHandler = setupKoaErrorHandler;
//# sourceMappingURL=koa.js.map
