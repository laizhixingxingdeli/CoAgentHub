import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  pluginDataDir,
  pluginDataPointerPath,
  writePluginDataPointer,
} from "./l3-state.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "coagenthub-pointer-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("plugin data dir pointer", () => {
  // Only CODEX_HOME is passed, so a regression would otherwise fall back to the
  // real ~/.codex of whoever runs the suite.
  it("reads the pointer written by the SessionStart hook when no env var is set", () => {
    const codexHome = tempDir();
    const dataDir = join(codexHome, "plugin-data");
    const env = { CODEX_HOME: codexHome };

    writePluginDataPointer(dataDir, env);

    expect(pluginDataDir(env)).toBe(resolve(dataDir));
    expect(pluginDataPointerPath(env)).toBe(
      join(codexHome, "coagenthub-v5", "plugin-data-dir.json"),
    );

    const raw = JSON.parse(
      readFileSync(pluginDataPointerPath(env), "utf8"),
    ) as unknown;
    expect(raw).toBe(resolve(dataDir));
    expect(typeof raw).toBe("string");

    // Guards the hook wiring: the pointer is useless unless SessionStart writes it.
    const hookSource = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "session-hook.ts"),
      "utf8",
    );
    expect(hookSource).toContain("writePluginDataPointer");
  });
});
