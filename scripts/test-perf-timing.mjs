#!/usr/bin/env node
/**
 * test-perf-timing.mjs — standalone test-suite timing harness.
 *
 * Purpose: produce the local-column measurements for the
 * `test-perf-baseline-ci-and-local` spec (R2/R3/R5): per-file staged timing
 * (setup / exec / teardown) under a monotonic clock, plus a monotonic wall
 * time for the whole invocation.
 *
 * This is intentionally SEPARATE from `scripts/test-baseline.mjs` (which counts
 * pass/fail for ticket-level regression). It is a measurement tool, not a
 * judgement tool, and it is NOT wired into any CI workflow.
 *
 * Usage:
 *   node scripts/test-perf-timing.mjs <runId> [--] [<vitest args...>]
 *
 * It spawns `vitest run --reporter=<test-perf-reporter.mjs>
 * --no-file-parallelism <args>` from the repo root. The custom reporter writes
 * a per-PID `perf-<pid>.json`; this harness merges them and writes
 * `.perf-runs/<runId>/run.json`.
 *
 * Why a custom reporter: vitest's built-in json reporter exposes file-level
 * startTime/endTime that, in this repo, measure only the in-file assertion
 * window (a few ms) and exclude the collection/transform/import/PGlite window
 * that dominates per-file cost. The custom reporter hooks module-start/end
 * (performance.now) and beforeAll/afterAll to capture the real per-file wall
 * and the setup/teardown split.
 *
 * Phase model (monotonic `performance.now()`, all ms; `Date.now()` is never
 * subtracted for duration):
 *   fileTotalMs       = onTestModuleStart -> onTestModuleEnd (module window)
 *   setupMs           = SUM(beforeAll)          ≈ PGlite create+migrate / Git init
 *   teardownMs        = SUM(afterAll)           ≈ drain / DB close / cleanup
 *   execMs            = fileTotalMs - setupMs - teardownMs
 *   collectionOverheadMs = wallMs - SUM(fileTotalMs)
 *                        (vitest cold start + per-file collect/transform/import +
 *                         PGlite-instance creation, which run BEFORE onTestModuleStart)
 *
 * Output isolation: one run dir per runId under `.perf-runs/`. Each worker
 * writes its own `perf-<pid>.json`, so restoring --no-file-parallelism would
 * not clobber a shared file.
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const reporterPath = join(__dirname, "test-perf-reporter.mjs");

function usageAndExit(msg) {
  if (msg) console.error(`error: ${msg}`);
  console.error(
    "usage: node scripts/test-perf-timing.mjs <runId> [--] [<vitest args...>]",
  );
  process.exit(1);
}

function parseArgs(argv) {
  if (argv.length < 1) usageAndExit("missing <runId>");
  const [runId, ...rest] = argv;
  let vitestArgs = rest;
  if (vitestArgs[0] === "--") vitestArgs = vitestArgs.slice(1);
  return { runId, vitestArgs };
}

function main() {
  const { runId, vitestArgs } = parseArgs(process.argv.slice(2));
  const args = [
    "run",
    `--reporter=${reporterPath}`,
    "--no-file-parallelism",
    ...vitestArgs,
  ];

  const outDir = join(repoRoot, ".perf-runs", runId);
  mkdirSync(outDir, { recursive: true });

  const t0 = performance.now();
  const vitestBin = join(repoRoot, "node_modules", "vitest", "vitest.mjs");
  const child = spawn(process.execPath, [vitestBin, ...args], {
    cwd: repoRoot,
    env: { ...process.env, PERF_RUN_ID: runId },
    stdio: ["ignore", "ignore", "inherit"],
  });

  child.on("close", (code) => {
    const wallMs = performance.now() - t0;
    // Merge per-PID perf-<pid>.json files written by the reporter instances.
    // The worker process(es) hold the real hook/module data; the main process
    // writes an empty one. Keep files from any non-empty instance.
    const merged = new Map();
    let globalSetupMs = 0;
    let reporterFileCount = 0;
    if (existsSync(outDir)) {
      for (const fn of readdirSync(outDir)) {
        if (!fn.startsWith("perf-") || !fn.endsWith(".json")) continue;
        try {
          const p = JSON.parse(readFileSync(join(outDir, fn), "utf8"));
          globalSetupMs += p.globalSetupMs ?? 0;
          for (const f of p.files ?? []) {
            if (f.fileTotalMs == null) continue;
            merged.set(f.name, f);
          }
          reporterFileCount += p.fileCount ?? 0;
        } catch {
          /* ignore partial */
        }
      }
    }
    const parsed = [...merged.values()].sort(
      (a, b) => (b.fileTotalMs ?? 0) - (a.fileTotalMs ?? 0),
    );
    const fileTotalSum = parsed.reduce((s, f) => s + (f.fileTotalMs ?? 0), 0);
    const totals = {
      fileTotalMs: Math.round(fileTotalSum),
      setupMs: parsed.reduce((s, f) => s + f.setupMs, 0),
      teardownMs: parsed.reduce((s, f) => s + f.teardownMs, 0),
      execMs: parsed.reduce((s, f) => s + (f.execMs ?? 0), 0),
      globalSetupMs,
      collectionOverheadMs: Math.max(0, Math.round(wallMs - fileTotalSum)),
      fileCount: parsed.length,
    };
    const summary = {
      runId,
      wallMs: Math.round(wallMs),
      wallClockMonotonic: "performance.now()",
      vitestArgs: args,
      reporterFileCount,
      fileCount: parsed.length,
      exitCode: code ?? null,
      totals,
      files: parsed,
    };
    writeFileSync(join(outDir, "run.json"), JSON.stringify(summary, null, 2));
    console.log(
      `run ${runId}: wall=${Math.round(wallMs)}ms files=${parsed.length} ` +
        `(sum fileTotal=${Math.round(fileTotalSum)}ms, collectOverhead=${totals.collectionOverheadMs}ms)`,
    );
  });
}

main();
