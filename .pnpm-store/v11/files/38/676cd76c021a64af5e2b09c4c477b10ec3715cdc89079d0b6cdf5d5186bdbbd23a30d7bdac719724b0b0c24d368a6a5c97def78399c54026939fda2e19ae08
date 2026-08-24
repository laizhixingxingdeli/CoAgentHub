Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

const client = require('../client.js');
const currentScopes = require('../currentScopes.js');
const debugBuild = require('../debug-build.js');
const spanOnScope = require('../utils/spanOnScope.js');
const is = require('../utils-hoist/is.js');
const logger = require('../utils-hoist/logger.js');
const time = require('../utils-hoist/time.js');
const worldwide = require('../utils-hoist/worldwide.js');
const constants = require('./constants.js');
const envelope = require('./envelope.js');

const MAX_LOG_BUFFER_SIZE = 100;

// The reference to the Client <> LogBuffer map is stored to ensure it's always the same
worldwide.GLOBAL_OBJ._sentryClientToLogBufferMap = new WeakMap();

/**
 * Converts a log attribute to a serialized log attribute.
 *
 * @param key - The key of the log attribute.
 * @param value - The value of the log attribute.
 * @returns The serialized log attribute.
 */
function logAttributeToSerializedLogAttribute(value) {
  switch (typeof value) {
    case 'number':
      if (Number.isInteger(value)) {
        return {
          value,
          type: 'integer',
        };
      }
      return {
        value,
        type: 'double',
      };
    case 'boolean':
      return {
        value,
        type: 'boolean',
      };
    case 'string':
      return {
        value,
        type: 'string',
      };
    default: {
      let stringValue = '';
      try {
        stringValue = JSON.stringify(value) ?? '';
      } catch {
        // Do nothing
      }
      return {
        value: stringValue,
        type: 'string',
      };
    }
  }
}

/**
 * Captures a log event and sends it to Sentry.
 *
 * @param log - The log event to capture.
 * @param scope - A scope. Uses the current scope if not provided.
 * @param client - A client. Uses the current client if not provided.
 *
 * @experimental This method will experience breaking changes. This is not yet part of
 * the stable Sentry SDK API and can be changed or removed without warning.
 */
function _INTERNAL_captureLog(
  beforeLog,
  client$1 = currentScopes.getClient(),
  scope = currentScopes.getCurrentScope(),
) {
  if (!client$1) {
    debugBuild.DEBUG_BUILD && logger.logger.warn('No client available to capture log.');
    return;
  }

  const { _experiments, release, environment } = client$1.getOptions();
  const { enableLogs = false, beforeSendLog } = _experiments ?? {};
  if (!enableLogs) {
    debugBuild.DEBUG_BUILD && logger.logger.warn('logging option not enabled, log will not be captured.');
    return;
  }

  const [, traceContext] = client._getTraceInfoFromScope(client$1, scope);

  const processedLogAttributes = {
    ...beforeLog.attributes,
  };

  if (release) {
    processedLogAttributes['sentry.release'] = release;
  }

  if (environment) {
    processedLogAttributes['sentry.environment'] = environment;
  }

  const { sdk } = client$1.getSdkMetadata() ?? {};
  if (sdk) {
    processedLogAttributes['sentry.sdk.name'] = sdk.name;
    processedLogAttributes['sentry.sdk.version'] = sdk.version;
  }

  const beforeLogMessage = beforeLog.message;
  if (is.isParameterizedString(beforeLogMessage)) {
    const { __sentry_template_string__, __sentry_template_values__ = [] } = beforeLogMessage;
    processedLogAttributes['sentry.message.template'] = __sentry_template_string__;
    __sentry_template_values__.forEach((param, index) => {
      processedLogAttributes[`sentry.message.parameter.${index}`] = param;
    });
  }

  const span = spanOnScope._getSpanForScope(scope);
  if (span) {
    // Add the parent span ID to the log attributes for trace context
    processedLogAttributes['sentry.trace.parent_span_id'] = span.spanContext().spanId;
  }

  const processedLog = { ...beforeLog, attributes: processedLogAttributes };

  client$1.emit('beforeCaptureLog', processedLog);

  const log = beforeSendLog ? beforeSendLog(processedLog) : processedLog;
  if (!log) {
    client$1.recordDroppedEvent('before_send', 'log_item', 1);
    debugBuild.DEBUG_BUILD && logger.logger.warn('beforeSendLog returned null, log will not be captured.');
    return;
  }

  const { level, message, attributes = {}, severityNumber } = log;

  const serializedLog = {
    timestamp: time.timestampInSeconds(),
    level,
    body: message,
    trace_id: traceContext?.trace_id,
    severity_number: severityNumber ?? constants.SEVERITY_TEXT_TO_SEVERITY_NUMBER[level],
    attributes: Object.keys(attributes).reduce(
      (acc, key) => {
        acc[key] = logAttributeToSerializedLogAttribute(attributes[key]);
        return acc;
      },
      {} ,
    ),
  };

  const logBuffer = _INTERNAL_getLogBuffer(client$1);
  if (logBuffer === undefined) {
    worldwide.GLOBAL_OBJ._sentryClientToLogBufferMap?.set(client$1, [serializedLog]);
  } else {
    worldwide.GLOBAL_OBJ._sentryClientToLogBufferMap?.set(client$1, [...logBuffer, serializedLog]);
    if (logBuffer.length >= MAX_LOG_BUFFER_SIZE) {
      _INTERNAL_flushLogsBuffer(client$1, logBuffer);
    }
  }

  client$1.emit('afterCaptureLog', log);
}

/**
 * Flushes the logs buffer to Sentry.
 *
 * @param client - A client.
 * @param maybeLogBuffer - A log buffer. Uses the log buffer for the given client if not provided.
 *
 * @experimental This method will experience breaking changes. This is not yet part of
 * the stable Sentry SDK API and can be changed or removed without warning.
 */
function _INTERNAL_flushLogsBuffer(client, maybeLogBuffer) {
  const logBuffer = maybeLogBuffer ?? _INTERNAL_getLogBuffer(client) ?? [];
  if (logBuffer.length === 0) {
    return;
  }

  const clientOptions = client.getOptions();
  const envelope$1 = envelope.createLogEnvelope(logBuffer, clientOptions._metadata, clientOptions.tunnel, client.getDsn());

  // Clear the log buffer after envelopes have been constructed.
  worldwide.GLOBAL_OBJ._sentryClientToLogBufferMap?.set(client, []);

  client.emit('flushLogs');

  // sendEnvelope should not throw
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  client.sendEnvelope(envelope$1);
}

/**
 * Returns the log buffer for a given client.
 *
 * Exported for testing purposes.
 *
 * @param client - The client to get the log buffer for.
 * @returns The log buffer for the given client.
 */
function _INTERNAL_getLogBuffer(client) {
  return worldwide.GLOBAL_OBJ._sentryClientToLogBufferMap?.get(client);
}

exports._INTERNAL_captureLog = _INTERNAL_captureLog;
exports._INTERNAL_flushLogsBuffer = _INTERNAL_flushLogsBuffer;
exports._INTERNAL_getLogBuffer = _INTERNAL_getLogBuffer;
exports.logAttributeToSerializedLogAttribute = logAttributeToSerializedLogAttribute;
//# sourceMappingURL=exports.js.map
