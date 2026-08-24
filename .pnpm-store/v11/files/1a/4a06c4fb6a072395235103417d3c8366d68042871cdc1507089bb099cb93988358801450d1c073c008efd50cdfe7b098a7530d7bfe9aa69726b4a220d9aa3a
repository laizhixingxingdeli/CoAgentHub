Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

const core = require('@sentry/core');
const eventbuilder = require('./eventbuilder.js');
const helpers = require('./helpers.js');

const DEFAULT_FLUSH_INTERVAL = 5000;

/**
 * Configuration options for the Sentry Browser SDK.
 * @see @sentry/core Options for more information.
 */

/**
 * The Sentry Browser SDK Client.
 *
 * @see BrowserOptions for documentation on configuration options.
 * @see SentryClient for usage documentation.
 */
class BrowserClient extends core.Client {

  /**
   * Creates a new Browser SDK instance.
   *
   * @param options Configuration options for this SDK.
   */
   constructor(options) {
    const opts = {
      // We default this to true, as it is the safer scenario
      parentSpanIsAlwaysRootSpan: true,
      ...options,
    };
    const sdkSource = helpers.WINDOW.SENTRY_SDK_SOURCE || core.getSDKSource();
    core.applySdkMetadata(opts, 'browser', ['browser'], sdkSource);

    super(opts);

    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const client = this;
    const { sendDefaultPii, _experiments } = client._options;
    const enableLogs = _experiments?.enableLogs;

    if (opts.sendClientReports && helpers.WINDOW.document) {
      helpers.WINDOW.document.addEventListener('visibilitychange', () => {
        if (helpers.WINDOW.document.visibilityState === 'hidden') {
          this._flushOutcomes();
          if (enableLogs) {
            core._INTERNAL_flushLogsBuffer(client);
          }
        }
      });
    }

    if (enableLogs) {
      client.on('flush', () => {
        core._INTERNAL_flushLogsBuffer(client);
      });

      client.on('afterCaptureLog', () => {
        if (client._logFlushIdleTimeout) {
          clearTimeout(client._logFlushIdleTimeout);
        }

        client._logFlushIdleTimeout = setTimeout(() => {
          core._INTERNAL_flushLogsBuffer(client);
        }, DEFAULT_FLUSH_INTERVAL);
      });
    }

    if (sendDefaultPii) {
      client.on('postprocessEvent', core.addAutoIpAddressToUser);
      client.on('beforeSendSession', core.addAutoIpAddressToSession);
    }
  }

  /**
   * @inheritDoc
   */
   eventFromException(exception, hint) {
    return eventbuilder.eventFromException(this._options.stackParser, exception, hint, this._options.attachStacktrace);
  }

  /**
   * @inheritDoc
   */
   eventFromMessage(
    message,
    level = 'info',
    hint,
  ) {
    return eventbuilder.eventFromMessage(this._options.stackParser, message, level, hint, this._options.attachStacktrace);
  }

  /**
   * @inheritDoc
   */
   _prepareEvent(
    event,
    hint,
    currentScope,
    isolationScope,
  ) {
    event.platform = event.platform || 'javascript';

    return super._prepareEvent(event, hint, currentScope, isolationScope);
  }
}

exports.BrowserClient = BrowserClient;
//# sourceMappingURL=client.js.map
