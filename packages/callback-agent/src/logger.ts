/**
 * Minimal logger interface — compatible with console and winston.
 */
export interface Logger {
  info?: (message?: string, ...meta: unknown[]) => void;
  warn?: (message?: string, ...meta: unknown[]) => void;
  error?: (message?: string, ...meta: unknown[]) => void;
}
