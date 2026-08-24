import * as http from 'node:http';
import { defineIntegration, logger, serializeEnvelope } from '@sentry/core';

const INTEGRATION_NAME = 'Spotlight';

const _spotlightIntegration = ((options = {}) => {
  const _options = {
    sidecarUrl: options.sidecarUrl || 'http://localhost:8969/stream',
  };

  return {
    name: INTEGRATION_NAME,
    setup(client) {
      if (typeof process === 'object' && process.env && process.env.NODE_ENV !== 'development') {
        logger.warn("[Spotlight] It seems you're not in dev mode. Do you really want to have Spotlight enabled?");
      }
      connectToSpotlight(client, _options);
    },
  };
}) ;

/**
 * Use this integration to send errors and transactions to Spotlight.
 *
 * Learn more about spotlight at https://spotlightjs.com
 *
 * Important: This integration only works with Node 18 or newer.
 */
const spotlightIntegration = defineIntegration(_spotlightIntegration);

function connectToSpotlight(client, options) {
  const spotlightUrl = parseSidecarUrl(options.sidecarUrl);
  if (!spotlightUrl) {
    return;
  }

  let failedRequests = 0;

  client.on('beforeEnvelope', (envelope) => {
    if (failedRequests > 3) {
      logger.warn('[Spotlight] Disabled Sentry -> Spotlight integration due to too many failed requests');
      return;
    }

    const serializedEnvelope = serializeEnvelope(envelope);

    const request = getNativeHttpRequest();
    const req = request(
      {
        method: 'POST',
        path: spotlightUrl.pathname,
        hostname: spotlightUrl.hostname,
        port: spotlightUrl.port,
        headers: {
          'Content-Type': 'application/x-sentry-envelope',
        },
      },
      res => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 400) {
          // Reset failed requests counter on success
          failedRequests = 0;
        }
        res.on('data', () => {
          // Drain socket
        });

        res.on('end', () => {
          // Drain socket
        });
        res.setEncoding('utf8');
      },
    );

    req.on('error', () => {
      failedRequests++;
      logger.warn('[Spotlight] Failed to send envelope to Spotlight Sidecar');
    });
    req.write(serializedEnvelope);
    req.end();
  });
}

function parseSidecarUrl(url) {
  try {
    return new URL(`${url}`);
  } catch {
    logger.warn(`[Spotlight] Invalid sidecar URL: ${url}`);
    return undefined;
  }
}

/**
 * We want to get an unpatched http request implementation to avoid capturing our own calls.
 */
function getNativeHttpRequest() {
  const { request } = http;
  if (isWrapped(request)) {
    return request.__sentry_original__;
  }

  return request;
}

function isWrapped(impl) {
  return '__sentry_original__' in impl;
}

export { INTEGRATION_NAME, getNativeHttpRequest, spotlightIntegration };
//# sourceMappingURL=spotlight.js.map
