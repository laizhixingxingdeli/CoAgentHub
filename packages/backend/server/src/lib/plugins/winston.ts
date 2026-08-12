import * as Sentry from "@sentry/node";
import winston from "winston";
import LokiTransport from "winston-loki";
import Transport from "winston-transport";

const SentryWinstonTransport = Sentry.createSentryWinstonTransport(Transport);

const consoleFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.printf(
    (info) =>
      `${info.timestamp} [${info.level}] ${info.method ?? "-"} ${info.path ?? "-"} ${info.message}`,
  ),
);

/**
 * Build a winston logger for one app.
 * - Sentry transport when SENTRY_DSN is set
 * - Loki transport when LOKI_URL is set (production)
 * - a console fallback so logging never silently disappears
 */
export function getLogger(
  appName: string,
  labels: Record<string, string> = {},
): winston.Logger {
  const transports: winston.transport[] = [];

  if (process.env.SENTRY_DSN) {
    transports.push(
      new SentryWinstonTransport({ level: process.env.LOG_LEVEL ?? "info" }),
    );
  }

  if (process.env.LOKI_URL) {
    transports.push(
      new LokiTransport({
        host: process.env.LOKI_URL,
        labels: { app: appName, ...labels },
        json: true,
        format: winston.format.json(),
        replaceTimestamp: true,
        onConnectionError: (err) => console.error("[logger] loki error", err),
      }),
    );
  }

  transports.push(
    new winston.transports.Console({
      format: consoleFormat,
      level: process.env.LOG_LEVEL ?? "info",
    }),
  );

  return winston.createLogger({
    level: process.env.LOG_LEVEL ?? "info",
    transports,
  });
}
