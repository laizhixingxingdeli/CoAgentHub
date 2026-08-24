import { defineIntegration, getClient, captureException, consoleSandbox } from '@sentry/core';
import { logAndExitProcess } from '../utils/errorhandling.js';

const INTEGRATION_NAME = 'OnUnhandledRejection';

const _onUnhandledRejectionIntegration = ((options = {}) => {
  const opts = {
    mode: 'warn',
    ...options,
  } ;

  return {
    name: INTEGRATION_NAME,
    setup(client) {
      global.process.on('unhandledRejection', makeUnhandledPromiseHandler(client, opts));
    },
  };
}) ;

/**
 * Add a global promise rejection handler.
 */
const onUnhandledRejectionIntegration = defineIntegration(_onUnhandledRejectionIntegration);

/**
 * Send an exception with reason
 * @param reason string
 * @param promise promise
 *
 * Exported only for tests.
 */
function makeUnhandledPromiseHandler(
  client,
  options,
) {
  return function sendUnhandledPromise(reason, promise) {
    if (getClient() !== client) {
      return;
    }

    const level = options.mode === 'strict' ? 'fatal' : 'error';

    captureException(reason, {
      originalException: promise,
      captureContext: {
        extra: { unhandledPromiseRejection: true },
        level,
      },
      mechanism: {
        handled: false,
        type: 'onunhandledrejection',
      },
    });

    handleRejection(reason, options.mode);
  };
}

/**
 * Handler for `mode` option
 */
function handleRejection(reason, mode) {
  // https://github.com/nodejs/node/blob/7cf6f9e964aa00772965391c23acda6d71972a9a/lib/internal/process/promises.js#L234-L240
  const rejectionWarning =
    'This error originated either by ' +
    'throwing inside of an async function without a catch block, ' +
    'or by rejecting a promise which was not handled with .catch().' +
    ' The promise rejected with the reason:';

  /* eslint-disable no-console */
  if (mode === 'warn') {
    consoleSandbox(() => {
      console.warn(rejectionWarning);
      console.error(reason && typeof reason === 'object' && 'stack' in reason ? reason.stack : reason);
    });
  } else if (mode === 'strict') {
    consoleSandbox(() => {
      console.warn(rejectionWarning);
    });
    logAndExitProcess(reason);
  }
  /* eslint-enable no-console */
}

export { makeUnhandledPromiseHandler, onUnhandledRejectionIntegration };
//# sourceMappingURL=onunhandledrejection.js.map
