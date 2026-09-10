/**
 * test-perf-reporter.mjs — custom vitest reporter for the test-perf-baseline
 * spec. Captures per-test-file staged timing (setup / exec / teardown) with a
 * monotonic clock and writes an isolated per-run, per-process JSON file.
 *
 * This is invoked only by `scripts/test-perf-timing.mjs` via `--reporter`,
 * never wired into the committed vitest config or CI. It does not change test
 * behavior — it only observes timings. vitest requires a class default export.
 *
 * IMPORTANT: vitest instantiates the reporter in BOTH the main process and each
 * worker pool process. Hook/module callbacks fire only in the worker that runs
 * the tests, so only the worker's instance holds real data. To avoid the main
 * process clobbering the worker's file, each instance writes to a PID-specific
 * file `perf-<pid>.json`; `test-perf-timing.mjs` merges them after the run.
 *
 * Run id is supplied through PERF_RUN_ID; output dir is `.perf-runs/<runId>/`.
 *
 * Phase definitions (monotonic `performance.now()`, all ms):
 *   fileTotalMs = onTestModuleStart -> onTestModuleEnd (module execution window)
 *   setupMs     = SUM(beforeAll hook durations for the file)
 *                ≈ per-file beforeAll: PGlite create+migrate / Git init / etc.
 *   teardownMs  = SUM(afterAll hook durations for the file)
 *                ≈ afterAll: drain / DB close / temp-file cleanup.
 *   execMs      = fileTotalMs - setupMs - teardownMs
 *                ≈ actual test execution + beforeEach/afterEach overhead.
 *   (Pre-module collection/transform/import and PGlite-instance creation happen
 *    during vitest's collect phase, BEFORE onTestModuleStart, and are reported
 *    by the harness as collectionOverheadMs = wallMs - SUM(fileTotalMs).)
 *
 * Hooks are paired with a LIFO stack because a hook completes before the next
 * starts, so nested/multiple beforeAll/afterAll are matched correctly.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
// biome-ignore lint/suspicious/noUndeclaredEnvVars: standalone measurement script invoked directly via node, not a turbo task
const runId = process.env.PERF_RUN_ID || "unknown";
const GLOBAL = "__global_setup__";

export default class TestPerfReporter {
  constructor() {
    /** @type {Map<string, {fileStart:number, fileEnd:number|null, setupMs:number, teardownMs:number}>} */
    this.files = new Map();
    /** @type {Array<{file:string, name:string, t0:number}>} */
    this.hookStack = [];
    this.current = null;
    this.globalSetupMs = 0;
  }

  onInit() {}
  onTestRunStart() {}

  onTestModuleStart(mod) {
    const k = mod?.task?.filepath || mod?.filepath || mod?.name || "(unknown)";
    this.current = k;
    if (!this.files.has(k)) {
      this.files.set(k, {
        fileStart: performance.now(),
        fileEnd: null,
        setupMs: 0,
        teardownMs: 0,
      });
    }
  }

  onHookStart(h) {
    const k = this.current || GLOBAL;
    this.hookStack.push({ file: k, name: h.name, t0: performance.now() });
  }

  onHookEnd(_h) {
    const top = this.hookStack.pop();
    if (!top) return;
    const dur = performance.now() - top.t0;
    if (top.file === GLOBAL) {
      this.globalSetupMs += dur;
      return;
    }
    const rec = this.files.get(top.file);
    if (!rec) return;
    if (top.name === "beforeAll") rec.setupMs += dur;
    else if (top.name === "afterAll") rec.teardownMs += dur;
  }

  onTestCaseResult() {}
  onTestModuleEnd(mod) {
    const k = mod?.task?.filepath || mod?.filepath || mod?.name || "(unknown)";
    const rec = this.files.get(k);
    if (rec) rec.fileEnd = performance.now();
    this.current = null;
  }

  onTestRunEnd() {
    const dir = join(repoRoot, ".perf-runs", runId);
    mkdirSync(dir, { recursive: true });
    const files = [];
    for (const [name, rec] of this.files) {
      const fileTotalMs =
        rec.fileEnd != null ? Math.round(rec.fileEnd - rec.fileStart) : null;
      const setupMs = Math.round(rec.setupMs);
      const teardownMs = Math.round(rec.teardownMs);
      const execMs =
        fileTotalMs != null
          ? Math.max(0, fileTotalMs - setupMs - teardownMs)
          : null;
      files.push({ name, fileTotalMs, setupMs, teardownMs, execMs });
    }
    files.sort((a, b) => (b.fileTotalMs ?? 0) - (a.fileTotalMs ?? 0));
    const payload = {
      pid: process.pid,
      monotonic: "performance.now()",
      globalSetupMs: Math.round(this.globalSetupMs),
      fileCount: files.length,
      files,
    };
    writeFileSync(
      join(dir, `perf-${process.pid}.json`),
      JSON.stringify(payload, null, 2),
    );
  }
}
