import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Create a fake executable (Node script) that records its argv and exits
 * with a configurable code. Used to verify command-driver behavior without
 * spawning real external processes.
 *
 * Uses a Node script (with shebang) to avoid shell quoting issues — args
 * are recorded verbatim separated by NUL bytes, so multiline JSON args
 * (like the completion message) are preserved exactly.
 */
export function createFakeExecutable(name = "fake-codex"): {
  path: string;
  getArgv: () => string[];
  getStdin: () => string;
  cleanup: () => void;
} {
  const dir = join(tmpdir(), `coagenthub-test-bin-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const binPath = join(dir, `${name}.mjs`);
  const argvPath = join(dir, `${name}.argv`);
  const stdinPath = join(dir, `${name}.stdin`);

  writeFileSync(
    binPath,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { argv, stdin } from "node:process";
// argv[0] = node, argv[1] = script, argv[2:] = actual args
const args = argv.slice(2);
// Use JSON array to preserve empty strings and multiline content exactly
writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(args));
// Record stdin
let stdinData = "";
stdin.setEncoding("utf-8");
stdin.on("data", (chunk) => (stdinData += chunk));
stdin.on("end", () => {
  writeFileSync(${JSON.stringify(stdinPath)}, stdinData);
});
if (process.env.FAKE_EXIT_CODE) {
  process.exit(parseInt(process.env.FAKE_EXIT_CODE, 10));
}
process.exit(0);
`,
  );
  chmodSync(binPath, 0o755);

  return {
    path: binPath,
    getArgv: () => {
      try {
        const content = readFileSync(argvPath, "utf-8");
        return content ? JSON.parse(content) : [];
      } catch {
        return [];
      }
    },
    getStdin: () => {
      try {
        return readFileSync(stdinPath, "utf-8");
      } catch {
        return "";
      }
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Create a fake executable that always fails with a given code.
 */
export function createFailingExecutable(
  exitCode: number,
  name = "fake-fail",
): {
  path: string;
  cleanup: () => void;
} {
  const dir = join(tmpdir(), `coagenthub-test-bin-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const binPath = join(dir, `${name}.mjs`);

  writeFileSync(binPath, `#!/usr/bin/env node\nprocess.exit(${exitCode});\n`);
  chmodSync(binPath, 0o755);

  return {
    path: binPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Create a fake executable that sleeps longer than any test timeout.
 */
export function createSlowExecutable(name = "fake-slow"): {
  path: string;
  cleanup: () => void;
} {
  const dir = join(tmpdir(), `coagenthub-test-bin-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const binPath = join(dir, `${name}.mjs`);

  writeFileSync(binPath, `#!/usr/bin/env node\nsetTimeout(() => {}, 10000);\n`);
  chmodSync(binPath, 0o755);

  return {
    path: binPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
