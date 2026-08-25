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

/** Outcome of a source scan: ok with the newest mtime, or failed/no-result. */
type SourceScanResult = { ok: true; newestMtime: Date } | { ok: false };

/** Roots resolved for scanning: ok with the roots, or failed to resolve. */
type ResolvedRoots = { ok: true; roots: string[] } | { ok: false };

/** Outcome of walking one root: ok (possibly empty), or failed mid-walk. */
type RootScanResult = { ok: true; newestMtime: Date | null } | { ok: false };

let scanCache: { at: number; result: SourceScanResult } | null = null;

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

  const scan = scanSourceTree();
  const buildStale =
    scan.ok &&
    entryMtime !== undefined &&
    scan.newestMtime.getTime() > entryMtime.getTime();

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
  if (scan.ok) {
    status.newestSourceMtime = scan.newestMtime.toISOString();
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
 * Scan the packaged source trees for the newest file mtime. The outcome is
 * cached for SCAN_TTL_MS — successful, failed and empty scans alike — so
 * consecutive probes never rescan within the TTL. Any failure (unreadable
 * dir, unresolvable dep) yields { ok: false }, which the caller treats as
 * "not build stale" rather than an error.
 */
function scanSourceTree(): SourceScanResult {
  const now = Date.now();
  if (scanCache !== null && now - scanCache.at < SCAN_TTL_MS) {
    return scanCache.result;
  }

  const result = performSourceScan();
  scanCache = { at: now, result };
  return result;
}

/** Walk the resolved source trees; the caller owns caching. */
function performSourceScan(): SourceScanResult {
  const roots = resolveScanRoots();
  if (!roots.ok) return { ok: false };

  let newest: Date | null = null;
  for (const root of roots.roots) {
    const rootScan = newestFileMtime(root);
    if (!rootScan.ok) return { ok: false };
    if (
      rootScan.newestMtime !== null &&
      (newest === null || rootScan.newestMtime.getTime() > newest.getTime())
    ) {
      newest = rootScan.newestMtime;
    }
  }
  if (newest === null) return { ok: false };
  return { ok: true, newestMtime: newest };
}

/** Server src plus the src of direct workspace dependencies. */
function resolveScanRoots(): ResolvedRoots {
  if (scanRootsOverride !== undefined && scanRootsOverride !== null) {
    return { ok: true, roots: scanRootsOverride };
  }

  const serverRoot = findPackageRoot(dirname(fileURLToPath(import.meta.url)));
  if (serverRoot === null) return { ok: false };

  const roots = [join(serverRoot, "src")];
  const deps = workspaceSrcDeps(serverRoot);
  if (deps === null) return { ok: false };
  for (const dep of deps) {
    const depSrc = resolveWorkspaceDepSrc(serverRoot, dep);
    if (depSrc === null) return { ok: false };
    roots.push(depSrc);
  }
  return { ok: true, roots };
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

/**
 * Names of the server's direct `workspace:` protocol dependencies. Returns
 * null when package.json cannot be read — the dependency list is unknowable,
 * so the scan cannot be complete.
 */
function workspaceSrcDeps(serverRoot: string): string[] | null {
  let pkg: { dependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(readFileSync(join(serverRoot, "package.json"), "utf8"));
  } catch {
    return null;
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

/**
 * Newest file mtime under root, skipping excluded dirs and symlinks. Any
 * unreadable directory or failed stat fails the whole scan ({ ok: false })
 * so staleness is never derived from a partial tree.
 */
function newestFileMtime(root: string): RootScanResult {
  let newest: Date | null = null;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      // Unreadable subtree → fail the scan, not a partial result.
      return { ok: false };
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
        stack.push(join(current, entry.name));
      } else if (entry.isFile()) {
        let mtime: Date;
        try {
          mtime = statSync(join(current, entry.name)).mtime;
        } catch {
          // Unreadable file → fail the scan, not a partial result.
          return { ok: false };
        }
        if (newest === null || mtime.getTime() > newest.getTime()) {
          newest = mtime;
        }
      }
      // Symlinks are ignored: they can point outside the tree or form cycles.
    }
  }
  return { ok: true, newestMtime: newest };
}
