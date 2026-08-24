import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface RuntimeStatus {
  startedAt: string;
  entryMtime: string | null;
  stale: boolean;
}

const startedAt = new Date();
let entryPath = fileURLToPath(import.meta.url);

/**
 * Use the importing server entry module in production and dev. The bundled
 * index module's import.meta.url points at dist/server.mjs, while tsx keeps
 * it pointed at src/index.ts.
 */
export function configureRuntimeEntry(entryUrl: string): void {
  entryPath = fileURLToPath(entryUrl);
}

/**
 * Read runtime freshness at call time. The single stat is intentionally the
 * only filesystem inspection: stale means the entry was rebuilt after boot.
 */
export function getRuntimeStatus(): RuntimeStatus {
  let entryMtime: Date | undefined;
  try {
    entryMtime = statSync(entryPath).mtime;
  } catch {
    // An unavailable entry is not evidence that the runtime is stale.
  }

  return {
    startedAt: startedAt.toISOString(),
    entryMtime: entryMtime?.toISOString() ?? null,
    stale:
      entryMtime !== undefined && entryMtime.getTime() > startedAt.getTime(),
  };
}

/** Log an informational hint when the entry mtime is already newer at boot. */
export function logRuntimeStartup(): void {
  const runtime = getRuntimeStatus();
  if (runtime.stale) {
    console.info(
      `[runtime] entry ${runtime.entryMtime} is newer than process start ${runtime.startedAt}`,
    );
  }
}
