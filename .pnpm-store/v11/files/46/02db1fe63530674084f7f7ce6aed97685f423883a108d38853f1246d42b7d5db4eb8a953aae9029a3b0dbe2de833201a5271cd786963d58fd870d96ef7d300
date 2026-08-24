Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

const currentScopes = require('../currentScopes.js');
const debugBuild = require('../debug-build.js');
const integration = require('../integration.js');
const semanticAttributes = require('../semanticAttributes.js');
const console = require('../utils-hoist/instrument/console.js');
const logger = require('../utils-hoist/logger.js');
const string = require('../utils-hoist/string.js');
const worldwide = require('../utils-hoist/worldwide.js');
const exports$1 = require('./exports.js');

const INTEGRATION_NAME = 'ConsoleLogs';

const DEFAULT_ATTRIBUTES = {
  [semanticAttributes.SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN]: 'auto.console.logging',
};

const _consoleLoggingIntegration = ((options = {}) => {
  const levels = options.levels || logger.CONSOLE_LEVELS;

  return {
    name: INTEGRATION_NAME,
    setup(client) {
      if (!client.getOptions()._experiments?.enableLogs) {
        debugBuild.DEBUG_BUILD && logger.logger.warn('`_experiments.enableLogs` is not enabled, ConsoleLogs integration disabled');
        return;
      }

      console.addConsoleInstrumentationHandler(({ args, level }) => {
        if (currentScopes.getClient() !== client || !levels.includes(level)) {
          return;
        }

        if (level === 'assert') {
          if (!args[0]) {
            const followingArgs = args.slice(1);
            const message =
              followingArgs.length > 0 ? `Assertion failed: ${formatConsoleArgs(followingArgs)}` : 'Assertion failed';
            exports$1._INTERNAL_captureLog({ level: 'error', message, attributes: DEFAULT_ATTRIBUTES });
          }
          return;
        }

        const isLevelLog = level === 'log';
        exports$1._INTERNAL_captureLog({
          level: isLevelLog ? 'info' : level,
          message: formatConsoleArgs(args),
          severityNumber: isLevelLog ? 10 : undefined,
          attributes: DEFAULT_ATTRIBUTES,
        });
      });
    },
  };
}) ;

/**
 * Captures calls to the `console` API as logs in Sentry. Requires `_experiments.enableLogs` to be enabled.
 *
 * @experimental This feature is experimental and may be changed or removed in future versions.
 *
 * By default the integration instruments `console.debug`, `console.info`, `console.warn`, `console.error`,
 * `console.log`, `console.trace`, and `console.assert`. You can use the `levels` option to customize which
 * levels are captured.
 *
 * @example
 *
 * ```ts
 * import * as Sentry from '@sentry/browser';
 *
 * Sentry.init({
 *   integrations: [Sentry.consoleLoggingIntegration({ levels: ['error', 'warn'] })],
 * });
 * ```
 */
const consoleLoggingIntegration = integration.defineIntegration(_consoleLoggingIntegration);

function formatConsoleArgs(values) {
  return 'util' in worldwide.GLOBAL_OBJ && typeof (worldwide.GLOBAL_OBJ ).util.format === 'function'
    ? (worldwide.GLOBAL_OBJ ).util.format(...values)
    : string.safeJoin(values, ' ');
}

exports.consoleLoggingIntegration = consoleLoggingIntegration;
//# sourceMappingURL=console-integration.js.map
