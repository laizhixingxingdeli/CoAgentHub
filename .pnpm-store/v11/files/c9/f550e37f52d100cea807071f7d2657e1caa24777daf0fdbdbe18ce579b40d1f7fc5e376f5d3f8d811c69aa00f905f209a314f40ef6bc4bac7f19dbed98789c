import { getClient } from '../currentScopes.js';
import { DEBUG_BUILD } from '../debug-build.js';
import { defineIntegration } from '../integration.js';
import { SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN } from '../semanticAttributes.js';
import { addConsoleInstrumentationHandler } from '../utils-hoist/instrument/console.js';
import { CONSOLE_LEVELS, logger } from '../utils-hoist/logger.js';
import { safeJoin } from '../utils-hoist/string.js';
import { GLOBAL_OBJ } from '../utils-hoist/worldwide.js';
import { _INTERNAL_captureLog } from './exports.js';

const INTEGRATION_NAME = 'ConsoleLogs';

const DEFAULT_ATTRIBUTES = {
  [SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN]: 'auto.console.logging',
};

const _consoleLoggingIntegration = ((options = {}) => {
  const levels = options.levels || CONSOLE_LEVELS;

  return {
    name: INTEGRATION_NAME,
    setup(client) {
      if (!client.getOptions()._experiments?.enableLogs) {
        DEBUG_BUILD && logger.warn('`_experiments.enableLogs` is not enabled, ConsoleLogs integration disabled');
        return;
      }

      addConsoleInstrumentationHandler(({ args, level }) => {
        if (getClient() !== client || !levels.includes(level)) {
          return;
        }

        if (level === 'assert') {
          if (!args[0]) {
            const followingArgs = args.slice(1);
            const message =
              followingArgs.length > 0 ? `Assertion failed: ${formatConsoleArgs(followingArgs)}` : 'Assertion failed';
            _INTERNAL_captureLog({ level: 'error', message, attributes: DEFAULT_ATTRIBUTES });
          }
          return;
        }

        const isLevelLog = level === 'log';
        _INTERNAL_captureLog({
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
const consoleLoggingIntegration = defineIntegration(_consoleLoggingIntegration);

function formatConsoleArgs(values) {
  return 'util' in GLOBAL_OBJ && typeof (GLOBAL_OBJ ).util.format === 'function'
    ? (GLOBAL_OBJ ).util.format(...values)
    : safeJoin(values, ' ');
}

export { consoleLoggingIntegration };
//# sourceMappingURL=console-integration.js.map
