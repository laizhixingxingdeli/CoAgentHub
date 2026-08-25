import {
  type Dirent,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type StaleReason = "process" | "build" | "both" | null;

export interface RuntimeStatus {
  startedAt: string;
  entryMtime: string | null;
  stale: boolean;
  staleReason: StaleReason;
  /** Newest mtime across the scanned source trees; present only when a scan ran. */
  newestSourceMtime?: string;
}

const startedAt = new Date();
let entryPath = fileURLToPath(import.meta.url);

/** Source-scan cache TTL (env `RUNTIME_SOURCE_SCAN_TTL_MS`, default 10s). */
const DEFAULT_SCAN_TTL_MS = 10_000;
const SCAN_TTL_MS = readScanTtlMs();

/** Directories never scanned for build staleness (spec R1). */
const EXCLUDED_DIR_NAMES = new Set(["node_modules", "test", "dist"]);

// undefined = auto-resolve from the module location; [] = no scan; else roots.
let scanRootsOverride: string[] | null | undefined;
let scanCache: { at: number; newestMtime: Date } | null = null;

function readScanTtlMs(): number {
  const raw = process.env.RUNTIME_SOURCE_SCAN_TTL_MS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SCAN_TTL_MS;
}

/**
 * Use the importing server entry module in production and dev. The bundled
 * index module's import.meta.url points at dist/server.mjs, while tsx keeps
 * it pointed at src/index.ts.
 */
export function configureRuntimeEntry(entryUrl: string): void {
  entryPath = fileURLToPath(entryUrl);
}

/**
 * Override the source trees scanned for build staleness. Pass an empty array
 * to disable scanning; pass null to restore automatic resolution. Tests only.
 */
export function configureSourceScanRoots(roots: string[] | null): void {
  scanRootsOverride = roots ?? undefined;
  scanCache = null;
}

/** Clear the cached scan result so the next probe rescans. Tests only. */
export function resetSourceScanCache(): void {
  scanCache = null;
}

/**
 * Read runtime freshness at call time. The process half keeps the original
 * single-stat rule (stale means the entry was rebuilt after boot); the build
 * half adds a low-cost, cached source scan (spec R1): the runtime is build
 * stale when the newest packaged source file is newer than the entry.
 */
export function getRuntimeStatus(): RuntimeStatus {
  let entryMtime: Date | undefined;
  try {
    entryMtime = statSync(entryPath).mtime;
  } catch {
    // An unavailable entry is not evidence that the runtime is stale.
  }

  const processStale =
    entryMtime !== undefined && entryMtime.getTime() > startedAt.getTime();

  const scanned = scanSourceTree();
  const buildStale =
    scanned !== null &&
    entryMtime !== undefined &&
    scanned.newestMtime.getTime() > entryMtime.getTime();

  const staleReason: StaleReason =
    processStale && buildStale
      ? "both"
      : processStale
        ? "process"
        : buildStale
          ? "build"
          : null;

  const status: RuntimeStatus = {
    startedAt: startedAt.toISOString(),
    entryMtime: entryMtime?.toISOString() ?? null,
    stale: processStale || buildStale,
    staleReason,
  };
  if (scanned !== null) {
    status.newestSourceMtime = scanned.newestMtime.toISOString();
  }
  return status;
}

/** Log an informational hint when the runtime is stale at boot. */
export function logRuntimeStartup(): void {
  const runtime = getRuntimeStatus();
  if (!runtime.stale) return;
  const processPart =
    runtime.staleReason === "process" || runtime.staleReason === "both"
      ? `entry ${runtime.entryMtime} is newer than process start ${runtime.startedAt}`
      : null;
  const buildPart =
    runtime.staleReason === "build" || runtime.staleReason === "both"
      ? `source is newer than entry ${runtime.entryMtime}`
      : null;
  console.info(
    `[runtime] stale (${runtime.staleReason}): ${[processPart, buildPart]
      .filter(Boolean)
      .join("; ")}`,
  );
}

/**
 * Scan the packaged source trees for the newest file mtime. The scan is
 * cached for SCAN_TTL_MS; any failure (unreadable dir, unresolvable dep) is
 * treated as "not build stale" rather than an error.
 */
function scanSourceTree(): { newestMtime: Date } | null {
  const now = Date.now();
  if (scanCache !== null && now - scanCache.at < SCAN_TTL_MS) {
    return scanCache;
  }

  const roots = resolveScanRoots();
  if (roots === null || roots.length === 0) return null;

  let newest: Date | null = null;
  for (const root of roots) {
    const rootNewest = newestFileMtime(root);
    if (
      rootNewest !== null &&
      (newest === null || rootNewest.getTime() > newest.getTime())
    ) {
      newest = rootNewest;
    }
  }
  if (newest === null) return null;

  scanCache = { at: now, newestMtime: newest };
  return scanCache;
}

/** Server src plus the src of direct workspace dependencies. */
function resolveScanRoots(): string[] | null {
  if (scanRootsOverride !== undefined) return scanRootsOverride;

  const serverRoot = findPackageRoot(dirname(fileURLToPath(import.meta.url)));
  if (serverRoot === null) return null;

  const roots = [join(serverRoot, "src")];
  for (const dep of workspaceSrcDeps(serverRoot)) {
    const depSrc = resolveWorkspaceDepSrc(serverRoot, dep);
    if (depSrc !== null) roots.push(depSrc);
  }
  return roots;
}

/** Walk up from a module dir until a package.json is found (server root). */
function findPackageRoot(fromDir: string): string | null {
  let dir = fromDir;
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Names of the server's direct `workspace:` protocol dependencies. */
function workspaceSrcDeps(serverRoot: string): string[] {
  let pkg: { dependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(readFileSync(join(serverRoot, "package.json"), "utf8"));
  } catch {
    return [];
  }
  return Object.entries(pkg.dependencies ?? {})
    .filter(([, spec]) => spec.startsWith("workspace:"))
    .map(([name]) => name);
}

/** Resolve a workspace dep to its real src dir via the pnpm node_modules link. */
function resolveWorkspaceDepSrc(
  serverRoot: string,
  name: string,
): string | null {
  try {
    const real = realpathSync(join(serverRoot, "node_modules", name));
    return join(real, "src");
  } catch {
    // Unresolvable dep → skip, not an error.
    return null;
  }
}

/** Newest file mtime under root, skipping excluded dirs and symlinks. */
function newestFileMtime(root: string): Date | null {
  let newest: Date | null = null;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      // Unreadable subtree → skip, not an error.
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
        stack.push(join(current, entry.name));
      } else if (entry.isFile()) {
        try {
          const mtime = statSync(join(current, entry.name)).mtime;
          if (newest === null || mtime.getTime() > newest.getTime()) {
            newest = mtime;
          }
        } catch {
          // Unreadable file → skip.
        }
      }
      // Symlinks are ignored: they can point outside the tree or form cycles.
    }
  }
  return newest;
}
