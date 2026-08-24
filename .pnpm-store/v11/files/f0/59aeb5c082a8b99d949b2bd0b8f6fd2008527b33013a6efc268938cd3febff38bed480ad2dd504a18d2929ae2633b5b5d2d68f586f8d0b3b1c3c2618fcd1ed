import * as diagnosticsChannel from 'node:diagnostics_channel';
import { defineIntegration, captureException, logger, getClient, getIsolationScope, spanToJSON, SEMANTIC_ATTRIBUTE_SENTRY_OP, SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN } from '@sentry/core';
import { DEBUG_BUILD } from '../../../debug-build.js';
import { generateInstrumentOnce } from '../../../otel/instrument.js';
import { FastifyOtelInstrumentation } from './fastify-otel/index.js';
import { FastifyInstrumentationV3 } from './v3/instrumentation.js';

const INTEGRATION_NAME = 'Fastify';
const INTEGRATION_NAME_V3 = 'Fastify-V3';

const instrumentFastifyV3 = generateInstrumentOnce(INTEGRATION_NAME_V3, () => new FastifyInstrumentationV3());

const instrumentFastify = generateInstrumentOnce(INTEGRATION_NAME, () => {
  const fastifyOtelInstrumentationInstance = new FastifyOtelInstrumentation();
  const plugin = fastifyOtelInstrumentationInstance.plugin();

  // This message handler works for Fastify versions 3, 4 and 5
  diagnosticsChannel.subscribe('fastify.initialization', message => {
    const fastifyInstance = (message ).fastify;

    fastifyInstance?.register(plugin).after(err => {
      if (err) {
        DEBUG_BUILD && logger.error('Failed to setup Fastify instrumentation', err);
      } else {
        instrumentClient();

        if (fastifyInstance) {
          instrumentOnRequest(fastifyInstance);
        }
      }
    });
  });

  // Returning this as unknown not to deal with the internal types of the FastifyOtelInstrumentation
  return fastifyOtelInstrumentationInstance ;
});

const _fastifyIntegration = (() => {
  return {
    name: INTEGRATION_NAME,
    setupOnce() {
      instrumentFastifyV3();
      instrumentFastify();
    },
  };
}) ;

/**
 * Adds Sentry tracing instrumentation for [Fastify](https://fastify.dev/).
 *
 * If you also want to capture errors, you need to call `setupFastifyErrorHandler(app)` after you set up your Fastify server.
 *
 * For more information, see the [fastify documentation](https://docs.sentry.io/platforms/javascript/guides/fastify/).
 *
 * @example
 * ```javascript
 * const Sentry = require('@sentry/node');
 *
 * Sentry.init({
 *   integrations: [Sentry.fastifyIntegration()],
 * })
 * ```
 */
const fastifyIntegration = defineIntegration(_fastifyIntegration);

/**
 * Default function to determine if an error should be sent to Sentry
 *
 * 3xx and 4xx errors are not sent by default.
 */
function defaultShouldHandleError(_error, _request, reply) {
  const statusCode = reply.statusCode;
  // 3xx and 4xx errors are not sent by default.
  return statusCode >= 500 || statusCode <= 299;
}

/**
 * Add an Fastify error handler to capture errors to Sentry.
 *
 * @param fastify The Fastify instance to which to add the error handler
 * @param options Configuration options for the handler
 *
 * @example
 * ```javascript
 * const Sentry = require('@sentry/node');
 * const Fastify = require("fastify");
 *
 * const app = Fastify();
 *
 * Sentry.setupFastifyErrorHandler(app);
 *
 * // Add your routes, etc.
 *
 * app.listen({ port: 3000 });
 * ```
 */
function setupFastifyErrorHandler(fastify, options) {
  const shouldHandleError = options?.shouldHandleError || defaultShouldHandleError;

  const plugin = Object.assign(
    function (fastify, _options, done) {
      fastify.addHook('onError', async (request, reply, error) => {
        if (shouldHandleError(error, request, reply)) {
          captureException(error);
        }
      });

      done();
    },
    {
      [Symbol.for('skip-override')]: true,
      [Symbol.for('fastify.display-name')]: 'sentry-fastify-error-handler',
    },
  );

  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  fastify.register(plugin);
}

function addFastifySpanAttributes(span) {
  const spanJSON = spanToJSON(span);
  const spanName = spanJSON.description;
  const attributes = spanJSON.data;

  const type = attributes['fastify.type'];

  const isHook = type === 'hook';
  const isHandler = type === spanName?.startsWith('handler -');
  // In @fastify/otel `request-handler` is separated by dash, not underscore
  const isRequestHandler = spanName === 'request' || type === 'request-handler';

  // If this is already set, or we have no fastify span, no need to process again...
  if (attributes[SEMANTIC_ATTRIBUTE_SENTRY_OP] || (!isHandler && !isRequestHandler && !isHook)) {
    return;
  }

  const opPrefix = isHook ? 'hook' : isHandler ? 'middleware' : isRequestHandler ? 'request-handler' : '<unknown>';

  span.setAttributes({
    [SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN]: 'auto.http.otel.fastify',
    [SEMANTIC_ATTRIBUTE_SENTRY_OP]: `${opPrefix}.fastify`,
  });

  const attrName = attributes['fastify.name'] || attributes['plugin.name'] || attributes['hook.name'];
  if (typeof attrName === 'string') {
    // Try removing `fastify -> ` and `@fastify/otel -> ` prefixes
    // This is a bit of a hack, and not always working for all spans
    // But it's the best we can do without a proper API
    const updatedName = attrName.replace(/^fastify -> /, '').replace(/^@fastify\/otel -> /, '');

    span.updateName(updatedName);
  }
}

function instrumentClient() {
  const client = getClient();
  if (client) {
    client.on('spanStart', (span) => {
      addFastifySpanAttributes(span);
    });
  }
}

function instrumentOnRequest(fastify) {
  fastify.addHook('onRequest', async (request, _reply) => {
    if (request.opentelemetry) {
      const { span } = request.opentelemetry();

      if (span) {
        addFastifySpanAttributes(span);
      }
    }

    const routeName = request.routeOptions?.url;
    const method = request.method || 'GET';

    getIsolationScope().setTransactionName(`${method} ${routeName}`);
  });
}

export { fastifyIntegration, instrumentFastify, instrumentFastifyV3, setupFastifyErrorHandler };
//# sourceMappingURL=index.js.map
